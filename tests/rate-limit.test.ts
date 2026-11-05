import type { PrismaClient } from "@prisma/client";
import "@shopify/shopify-api/adapters/web-api";
import { ApiVersion, shopifyApi } from "@shopify/shopify-api";
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  admin: vi.fn(),
  webhook: vi.fn(),
  login: vi.fn(),
}));
vi.mock("../app/db.server", () => ({
  default: { $queryRaw: mocks.query, $executeRaw: mocks.execute },
}));
vi.mock("@shopify/shopify-app-react-router/adapters/node", () => ({}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  ApiVersion: { October26: "2026-10" },
  AppDistribution: { SingleMerchant: "single_merchant" },
  shopifyApp: () => ({
    authenticate: { admin: mocks.admin, webhook: mocks.webhook },
    login: mocks.login,
  }),
}));
vi.mock("../app/services/session-storage.server", () => ({
  EncryptedSessionStorage: class {},
}));
vi.mock("../app/services/environment.server", () => ({
  resolveShopifyAppUrl: () => "https://app.test",
}));
import { authenticate, login } from "../app/shopify.server";
import {
  RATE_LIMITS,
  LIMITED_WEBHOOK_TOPICS,
  cleanExpiredRateLimits,
  consumeRateLimit,
  enforceActorLimit,
  enforceWebhookLimit,
  rateLimitKey,
} from "../app/services/rate-limit.server";

const lifecycleTopics = [
  "APP_UNINSTALLED",
  "APP_SCOPES_UPDATE",
  "CUSTOMERS_DATA_REQUEST",
  "CUSTOMERS_REDACT",
  "SHOP_REDACT",
];

function database(rows: Array<{ count: number }> = [{ count: 1 }]) {
  const query = vi.fn().mockResolvedValue(rows);
  return { query, db: { $queryRaw: query } as unknown as PrismaClient };
}

/** Mirrors the atomic upsert: accepts while a key's count is below its limit. */
function budgetDatabase() {
  const counts = new Map<string, number>();
  const query = vi.fn(
    async (_sql: TemplateStringsArray, key: string, limit: number) => {
      const count = counts.get(key) ?? 0;
      if (count >= limit) return [];
      counts.set(key, count + 1);
      return [{ count: count + 1 }];
    },
  );
  return { query, db: { $queryRaw: query } as unknown as PrismaClient };
}

function status(error: unknown) {
  return error instanceof Response ? error.status : error;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([{ count: 1 }]);
  mocks.execute.mockResolvedValue(0);
});

describe("shared request budgets", () => {
  it("returns retryable 429 and fails closed when protection is unavailable", async () => {
    const denied = database([]);
    const response = await consumeRateLimit(
      "user:write",
      "staff",
      1,
      denied.db,
    ).catch((error: unknown) => error);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(429);
    expect((response as Response).headers.get("Retry-After")).toBe("60");
    const broken = database();
    broken.query.mockRejectedValue(new Error("database connection secret"));
    const unavailable = await consumeRateLimit(
      "user:write",
      "staff",
      1,
      broken.db,
    ).catch((error: unknown) => error);
    expect((unavailable as Response).status).toBe(503);
    expect(await (unavailable as Response).text()).not.toContain("secret");
  });

  it("uses verified shop and user identity with separate read and action budgets", async () => {
    const { query, db } = database();
    const actor = {
      shop: "a.myshopify.com",
      userId: "123",
      role: "VIEWER" as const,
    };
    const request = new Request("https://app.test/app/settings", {
      method: "POST",
    });
    await Promise.all([
      enforceActorLimit(request, actor, db),
      enforceActorLimit(request, actor, db),
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toBe(rateLimitKey("shop:write", actor.shop));
    expect(query.mock.calls[1][1]).toBe(
      rateLimitKey("user:write", JSON.stringify([actor.shop, actor.userId])),
    );
    expect(query.mock.calls[1][2]).toBe(30);
    await enforceActorLimit(new Request("https://app.test/app"), actor, db);
    expect(query.mock.calls[3][1]).toBe(
      rateLimitKey("user:read", JSON.stringify([actor.shop, actor.userId])),
    );
    expect(query.mock.calls[3][2]).toBe(180);
    expect(rateLimitKey("user:read", "123")).not.toBe(
      rateLimitKey("user:write", "123"),
    );
  });

  it("isolates verified shops' catalog webhook budgets and never limits lifecycle or compliance topics", async () => {
    const { query, db } = budgetDatabase();
    const busy = "busy.myshopify.com";
    for (let i = 0; i < RATE_LIMITS.shopCatalogWebhook; i++)
      await enforceWebhookLimit({ shop: busy, topic: "PRODUCTS_UPDATE" }, db);
    const limited = await enforceWebhookLimit(
      { shop: busy, topic: "INVENTORY_LEVELS_UPDATE" },
      db,
    ).catch((error: unknown) => error);
    expect(status(limited)).toBe(429);
    expect((limited as Response).headers.get("Retry-After")).toBe("60");
    await expect(
      enforceWebhookLimit(
        { shop: "quiet.myshopify.com", topic: "PRODUCTS_DELETE" },
        db,
      ),
    ).resolves.toBeUndefined();
    const consumed = query.mock.calls.length;
    for (const topic of lifecycleTopics)
      await expect(
        enforceWebhookLimit({ shop: busy, topic }, db),
      ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(consumed);
  });

  it("keys the unsigned webhook shop header as requireActor normalizes it", async () => {
    const { query, db } = database();
    for (const shop of [
      "a.myshopify.com",
      "A.MyShopify.com",
      " a.myshopify.com ",
    ])
      await enforceWebhookLimit({ shop, topic: "PRODUCTS_UPDATE" }, db);
    expect(new Set(query.mock.calls.map((args) => args[1]))).toEqual(
      new Set([rateLimitKey("webhook:catalog", "a.myshopify.com")]),
    );
  });

  it("classifies topics in the exact form Shopify's webhook verifier returns", async () => {
    const secret = "test-secret";
    const api = shopifyApi({
      apiKey: "test-key",
      apiSecretKey: secret,
      apiVersion: ApiVersion.October26,
      hostName: "app.test",
      isEmbeddedApp: true,
      logger: { log: async () => undefined },
    });
    const verifiedTopic = async (header: string) => {
      const rawBody = "{}";
      const check = await api.webhooks.validate({
        rawBody,
        rawRequest: new Request("https://app.test/webhooks", {
          method: "POST",
          body: rawBody,
          headers: {
            "X-Shopify-Hmac-Sha256": createHmac("sha256", secret)
              .update(rawBody)
              .digest("base64"),
            "X-Shopify-Topic": header,
            "X-Shopify-Shop-Domain": "a.myshopify.com",
            "X-Shopify-API-Version": "2026-10",
            "X-Shopify-Webhook-Id": "delivery",
          },
        }),
      });
      if (!check.valid) throw new Error("Fixture webhook was not verified");
      return check.topic;
    };
    for (const header of [
      "products/create",
      "products/update",
      "products/delete",
      "inventory_levels/update",
    ])
      expect(LIMITED_WEBHOOK_TOPICS.has(await verifiedTopic(header))).toBe(
        true,
      );
    for (const header of [
      "app/uninstalled",
      "app/scopes_update",
      "customers/data_request",
      "customers/redact",
      "shop/redact",
    ]) {
      const topic = await verifiedTopic(header);
      expect(lifecycleTopics).toContain(topic);
      expect(LIMITED_WEBHOOK_TOPICS.has(topic)).toBe(false);
    }
  });

  it("cleans long-expired windows in one bounded batch", async () => {
    const execute = vi.fn().mockResolvedValue(3);
    await expect(
      cleanExpiredRateLimits({
        $executeRaw: execute,
      } as unknown as PrismaClient),
    ).resolves.toBe(3);
    const [sql, ...values] = execute.mock.calls[0];
    expect(values).toEqual([1000]);
    // Selected and rechecked on delete, so a concurrently reset window is kept.
    expect((sql as string[]).join("?").match(/INTERVAL '1 day'/g)).toHaveLength(
      2,
    );
  });
});

describe("Shopify request wrappers", () => {
  const shop = "verified.myshopify.com";
  const forged = (path: string, init: RequestInit = {}) =>
    new Request(`https://app.test${path}?shop=attacker.myshopify.com`, {
      ...init,
      headers: {
        "X-Forwarded-For": "203.0.113.9",
        Authorization: "Bearer forged",
        "X-Shopify-Hmac-Sha256": "forged",
        "X-Shopify-Topic": "products/update",
        "X-Shopify-Shop-Domain": "attacker.myshopify.com",
      },
    });

  it("spends no budget and makes no limiter database call for forged or unauthenticated traffic", async () => {
    mocks.admin.mockRejectedValue(new Response(null, { status: 401 }));
    mocks.webhook.mockRejectedValue(new Response(null, { status: 401 }));
    mocks.login.mockResolvedValue({});
    for (let i = 0; i < 25; i++) {
      expect(await authenticate.admin(forged("/app")).catch(status)).toBe(401);
      expect(
        await authenticate
          .webhook(
            forged("/webhooks/products/update", { method: "POST", body: "{}" }),
          )
          .catch(status),
      ).toBe(401);
      await login(forged("/auth/login"));
    }
    expect(mocks.admin).toHaveBeenCalledTimes(25);
    expect(mocks.webhook).toHaveBeenCalledTimes(25);
    expect(login).toBe(mocks.login);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("limits only after Shopify verifies the shop and fails closed when the limiter is unavailable", async () => {
    mocks.admin.mockResolvedValue({ session: { shop, userId: 7 } });
    await authenticate.admin(new Request("https://app.test/app"));
    expect(mocks.query.mock.calls.map((args) => args[1])).toEqual([
      rateLimitKey("shop:read", shop),
      rateLimitKey("user:read", JSON.stringify([shop, "7"])),
    ]);
    const delivery = () =>
      new Request("https://app.test/webhooks", { method: "POST" });
    mocks.webhook
      .mockResolvedValueOnce({ shop, topic: "PRODUCTS_UPDATE" })
      .mockResolvedValueOnce({ shop, topic: "APP_UNINSTALLED" });
    await authenticate.webhook(delivery());
    await authenticate.webhook(delivery());
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.query.mock.calls[2][1]).toBe(
      rateLimitKey("webhook:catalog", shop),
    );
    expect(mocks.query.mock.calls[2][2]).toBe(RATE_LIMITS.shopCatalogWebhook);
    expect(mocks.execute).not.toHaveBeenCalled();

    mocks.query.mockRejectedValue(new Error("database unavailable"));
    expect(
      await authenticate
        .admin(new Request("https://app.test/app"))
        .catch(status),
    ).toBe(503);
    mocks.webhook.mockResolvedValueOnce({ shop, topic: "PRODUCTS_UPDATE" });
    expect(await authenticate.webhook(delivery()).catch(status)).toBe(503);
    mocks.webhook.mockResolvedValueOnce({ shop, topic: "SHOP_REDACT" });
    await expect(authenticate.webhook(delivery())).resolves.toMatchObject({
      topic: "SHOP_REDACT",
    });
  });
});
