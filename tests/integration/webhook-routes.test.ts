import { createHmac, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import type { ActionFunctionArgs } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The real routes, the real Shopify library and PostgreSQL run here. Only
// outbound fetch is replaced, and it answers every token request the way
// Shopify documents for an uninstalled app, so a refresh attempt cannot pass.
const stub = vi.hoisted(() => {
  process.env.SHOPIFY_API_KEY = "synthetic-webhook-key";
  process.env.SHOPIFY_API_SECRET = "synthetic-webhook-secret";
  process.env.SHOPIFY_APP_URL = "https://app.example.invalid";
  process.env.SCOPES = "read_products";
  process.env.LOG_LEVEL = "silent";
  const outbound: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    outbound.push(String(url));
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "This request requires an active refresh_token",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { outbound };
});

import prisma from "../../app/db.server";
import {
  acceptPairing,
  confirmPairing,
  ensureInstallation,
  initiatePairing,
} from "../../app/services/control-plane.server";
import { recordSignedVisit } from "../../app/services/installation.server";
import { processPrivacyRequests } from "../../app/services/privacy.server";
import { requireWorkspace } from "../../app/services/authorization.server";
import type { Actor } from "../../app/services/authorization.server";
import {
  RATE_LIMITS,
  rateLimitKey,
} from "../../app/services/rate-limit.server";
import { logger } from "../../app/services/logger.server";
import { anonymousBodies } from "../../app/services/request-body.server";
import {
  SKEWS,
  fromDatabase,
  remaining,
  restoreProcessClock,
  skewProcessClock,
} from "./clock-skew";

const HOUR = 3_600_000;
const MiB = 1024 * 1024;
const ORIGIN = "https://app.example.invalid";
const sign = (raw: string) =>
  createHmac("sha256", "synthetic-webhook-secret").update(raw).digest("base64");

/** A delivery shaped the way Shopify documents it, signed over its exact body. */
function delivery(
  path: string,
  topic: string,
  shop: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-Topic": topic,
      "X-Shopify-Webhook-Id": randomUUID(),
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Triggered-At": new Date().toISOString(),
      "X-Shopify-Event-Id": randomUUID(),
      "X-Shopify-Hmac-Sha256": sign(raw),
      ...headers,
    },
    body: raw,
  });
}
const uninstall = (
  shop: string,
  headers: Record<string, string> = {},
  body: unknown = { id: 1, domain: shop, myshopify_domain: shop },
) =>
  delivery("/webhooks/app/uninstalled", "app/uninstalled", shop, body, headers);
const redact = (shop: string, body?: unknown) =>
  delivery(
    "/webhooks/privacy",
    "shop/redact",
    shop,
    body ?? { shop_id: 1, shop_domain: shop },
  );
const scopes = (
  shop: string,
  current: string[],
  updatedAt: Date,
  extra: Record<string, unknown> = {},
) =>
  delivery("/webhooks/app/scopes_update", "app/scopes_update", shop, {
    id: 1,
    shop_id: "gid://shopify/Shop/1",
    previous: [],
    current,
    updated_at: updatedAt.toISOString(),
    ...extra,
  });
const at = (time: number | Date) => ({
  "X-Shopify-Triggered-At": new Date(time).toISOString(),
});

type Action = (args: ActionFunctionArgs) => Promise<unknown>;
// Loaded only with a database: the real session storage starts polling for its
// table as soon as it is created, which a run without PostgreSQL cannot answer.
let uninstalled: Action,
  scopesUpdate: Action,
  privacy: Action,
  products: Action,
  inventory: Action,
  login: Action,
  sessionStorage: Awaited<
    typeof import("../../app/shopify.server")
  >["sessionStorage"];
/** What the HTTP layer would send: a returned or a thrown Response. */
async function respond(action: Action, request: Request) {
  const args = {
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: new URL(request.url).pathname,
  };
  try {
    const response = await action(args as ActionFunctionArgs);
    return response instanceof Response ? response : new Response();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
const status = async (action: Action, request: Request) =>
  (await respond(action, request)).status;

let sequence = 0;
async function pairedStores() {
  const key = `${Date.now().toString(36)}${++sequence}`;
  const a: Actor = {
    shop: `hook-a-${key}.myshopify.com`,
    userId: "101",
    role: "OWNER",
  };
  const b: Actor = {
    shop: `hook-b-${key}.myshopify.com`,
    userId: "202",
    role: "OWNER",
  };
  await ensureInstallation(a);
  await ensureInstallation(b);
  const pairing = await initiatePairing(a, {
    destinationShop: b.shop,
    organizationConfirmed: true,
  });
  await acceptPairing(b, {
    requestId: pairing.request.id,
    challenge: pairing.challenge,
    organizationConfirmed: true,
  });
  const { workspace } = await confirmPairing(a, {
    requestId: pairing.request.id,
  });
  const policy = await prisma.syncPolicy.create({
    data: {
      workspaceId: workspace.id,
      sourceShopDomain: a.shop,
      targetShopDomain: b.shop,
      fields: ["title"],
      syncProduct: true,
      enabled: true,
      status: "ACTIVE",
      approvedBy: `${a.shop}:101`,
      approvedAt: new Date(),
    },
  });
  // Installed and last opened long ago, unless a test says otherwise. A delivery
  // triggered "now" must not race the database clock that set these.
  await prisma.shopConnection.updateMany({
    where: { shopDomain: { in: [a.shop, b.shop] } },
    data: {
      installedAt: new Date(Date.now() - 24 * HOUR),
      lastSeenAt: new Date(Date.now() - 24 * HOUR),
    },
  });
  return { a, b, workspaceId: workspace.id, policyId: policy.id };
}
const offlineSession = (shop: string, expiresInMs: number) =>
  sessionStorage.storeSession(
    new Session({
      id: `offline_${shop}`,
      shop,
      state: "",
      isOnline: false,
      accessToken: "synthetic-offline-access",
      scope: "read_products",
      expires: new Date(Date.now() + expiresInMs),
      refreshToken: "synthetic-refresh",
      refreshTokenExpires: new Date(Date.now() + 80 * 24 * HOUR),
    }),
  );
/** The state a revocation or erasure would change for this store. */
async function installation(
  shop: string,
  workspaceId: string,
  policyId: string,
) {
  const [connection, sessions, policy, workspace, pair] = await Promise.all([
    prisma.shopConnection.findUnique({ where: { shopDomain: shop } }),
    prisma.session.count({ where: { shop } }),
    prisma.syncPolicy.findUnique({ where: { id: policyId } }),
    prisma.workspace.findUnique({ where: { id: workspaceId } }),
    prisma.storePair.findFirst({ where: { workspaceId } }),
  ]);
  return {
    connection: connection?.status,
    paired: !!connection?.workspaceId,
    sessions,
    policy: policy?.status,
    workspace: workspace?.state,
    pair: pair?.status,
  };
}
const LIVE = {
  connection: "CONNECTED",
  paired: true,
  sessions: 1,
  policy: "ACTIVE",
  workspace: "ACTIVE",
  pair: "VERIFIED",
};
const REVOKED = {
  connection: "UNINSTALLED",
  paired: false,
  sessions: 0,
  policy: "PAUSED",
  workspace: "REVOKED",
  pair: "REVOKED",
};
const audits = (shop: string, action: string) =>
  prisma.auditEvent.count({ where: { shopDomain: shop, action } });

/**
 * Runs `during` while another transaction has already changed this store's row
 * and not committed, which is the moment a concurrent delivery must not read past.
 */
async function whileRowChanges<T>(
  shop: string,
  change: Prisma.ShopConnectionUpdateInput,
  during: () => Promise<T>,
) {
  let result!: Promise<T>;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ShopConnection" WHERE "shopDomain" = ${shop} FOR UPDATE`;
    await tx.shopConnection.update({
      where: { shopDomain: shop },
      data: change,
    });
    result = during();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  return result;
}

/** A body the library would have to buffer: counts how much of it was pulled. */
function streamedBody(totalBytes: number) {
  const chunk = new Uint8Array(64 * 1024).fill(97);
  const progress = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (progress.pulled >= totalBytes) return controller.close();
      progress.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { body, progress };
}
function oversized(
  path: string,
  totalBytes: number,
  headers: Record<string, string>,
) {
  const { body, progress } = streamedBody(totalBytes);
  const request = new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
  return { request, progress };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "webhook routes with real verification against PostgreSQL",
  () => {
    beforeAll(async () => {
      ({ sessionStorage } = await import("../../app/shopify.server"));
      ({ action: uninstalled } =
        await import("../../app/routes/webhooks.app.uninstalled"));
      ({ action: scopesUpdate } =
        await import("../../app/routes/webhooks.app.scopes_update"));
      ({ action: privacy } = await import("../../app/routes/webhooks.privacy"));
      ({ action: products } =
        await import("../../app/routes/webhooks.products.update"));
      ({ action: inventory } =
        await import("../../app/routes/webhooks.inventory.levels.update"));
      ({ action: login } = await import("../../app/routes/auth.login/route"));
    });
    beforeEach(() => {
      stub.outbound.length = 0;
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });

    describe("no dependency on the offline session", () => {
      it("revokes an idle store whose expired token Shopify will not refresh, on the first delivery", async () => {
        const f = await pairedStores();
        await offlineSession(f.a.shop, -2 * HOUR);
        expect(await status(uninstalled, uninstall(f.a.shop))).toBe(200);
        expect(stub.outbound).toEqual([]);
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          REVOKED,
        );
        expect(await audits(f.a.shop, "APP_UNINSTALLED")).toBe(1);
        // The partner loses access as soon as the first delivery is handled.
        await expect(requireWorkspace(f.b)).rejects.toMatchObject({
          code: "PAIRING_REQUIRED",
        });
      });

      it("revokes a store whose token is within the library's five minute refresh window", async () => {
        const f = await pairedStores();
        await offlineSession(f.a.shop, 4 * 60_000);
        expect(await status(uninstalled, uninstall(f.a.shop))).toBe(200);
        expect(stub.outbound).toEqual([]);
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          REVOKED,
        );
      });

      it("records compliance requests with an expired token, so erasure can start", async () => {
        const f = await pairedStores();
        await offlineSession(f.a.shop, -2 * HOUR);
        expect(await status(privacy, redact(f.a.shop))).toBe(200);
        for (const topic of ["customers/data_request", "customers/redact"])
          expect(
            await status(
              privacy,
              delivery("/webhooks/privacy", topic, f.a.shop, {
                shop_id: 1,
                shop_domain: f.a.shop,
                customer: { id: 10 },
              }),
            ),
          ).toBe(200);
        expect(stub.outbound).toEqual([]);
        const requests = await prisma.privacyRequest.findMany({
          where: { shopDomain: f.a.shop },
          orderBy: { topic: "asc" },
        });
        expect(requests.map((row) => [row.topic, row.status])).toEqual([
          ["CUSTOMERS_DATA_REQUEST", "COMPLETED"],
          ["CUSTOMERS_REDACT", "COMPLETED"],
          ["SHOP_REDACT", "PENDING"],
        ]);
      });

      it("stores catalog deliveries with an expired token", async () => {
        const f = await pairedStores();
        await offlineSession(f.a.shop, -2 * HOUR);
        expect(
          await status(
            products,
            delivery("/webhooks/products/update", "products/update", f.a.shop, {
              id: 100,
            }),
          ),
        ).toBe(200);
        expect(
          await status(
            inventory,
            delivery(
              "/webhooks/inventory/levels/update",
              "inventory_levels/update",
              f.a.shop,
              { inventory_item_id: 200 },
            ),
          ),
        ).toBe(200);
        expect(stub.outbound).toEqual([]);
        expect(
          await prisma.webhookEvent.count({
            where: { shopDomain: f.a.shop, status: "RECEIVED" },
          }),
        ).toBe(2);
      });

      it("accepts every topic when the stored session cannot be decrypted", async () => {
        const f = await pairedStores();
        // What a changed SESSION_ENCRYPTION_KEY leaves behind.
        await prisma.session.create({
          data: {
            id: `offline_${f.a.shop}`,
            shop: f.a.shop,
            state: "",
            accessToken: "enc:v1:bm90LWRlY3J5cHRhYmxlLWF0LWFsbA",
          },
        });
        expect(
          await status(
            products,
            delivery("/webhooks/products/update", "products/update", f.a.shop, {
              id: 100,
            }),
          ),
        ).toBe(200);
        expect(await status(privacy, redact(f.a.shop))).toBe(200);
        expect(await status(uninstalled, uninstall(f.a.shop))).toBe(200);
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          REVOKED,
        );
      });
    });

    describe("the library's response codes", () => {
      it("answers bad signatures, missing headers, empty bodies and wrong methods as the library does", async () => {
        const f = await pairedStores();
        const shop = f.a.shop;
        const route = "/webhooks/app/uninstalled";
        const body = JSON.stringify({ myshopify_domain: shop });
        const headers = {
          "X-Shopify-Shop-Domain": shop,
          "X-Shopify-Topic": "app/uninstalled",
          "X-Shopify-Webhook-Id": "codes",
          "X-Shopify-API-Version": "2026-10",
          "X-Shopify-Hmac-Sha256": sign(body),
        };
        const send = (
          sent: Record<string, string>,
          init: RequestInit = { method: "POST", body },
        ) =>
          status(
            uninstalled,
            new Request(`${ORIGIN}${route}`, { ...init, headers: sent }),
          );
        const without = (name: keyof typeof headers) => {
          const copy: Record<string, string> = { ...headers };
          delete copy[name];
          return copy;
        };
        expect(
          await send({ ...headers, "X-Shopify-Hmac-Sha256": "forged" }),
        ).toBe(401);
        expect(await send(without("X-Shopify-Hmac-Sha256"))).toBe(400);
        for (const name of [
          "X-Shopify-Shop-Domain",
          "X-Shopify-Topic",
          "X-Shopify-Webhook-Id",
          "X-Shopify-API-Version",
        ] as const)
          expect(await send(without(name))).toBe(400);
        expect(await send(headers, { method: "POST", body: "" })).toBe(400);
        expect(await send(headers, { method: "PUT", body })).toBe(405);
        expect(
          await installation(shop, f.workspaceId, f.policyId),
        ).toMatchObject({ connection: "CONNECTED", pair: "VERIFIED" });
      });

      it("rejects a correctly signed body that is not JSON instead of failing with a server error", async () => {
        const f = await pairedStores();
        expect(
          await status(uninstalled, uninstall(f.a.shop, {}, "not json")),
        ).toBe(400);
        expect(
          await installation(f.a.shop, f.workspaceId, f.policyId),
        ).toMatchObject({ connection: "CONNECTED", pair: "VERIFIED" });
      });

      it("keeps the catalog budget after verification and never limits lifecycle or compliance topics", async () => {
        const f = await pairedStores();
        const shop = f.a.shop;
        const key = rateLimitKey("webhook:catalog", shop);
        await prisma.$executeRaw`
          INSERT INTO "RequestRateLimit" ("key", "count", "expiresAt")
          VALUES (${key}, ${RATE_LIMITS.shopCatalogWebhook}, CURRENT_TIMESTAMP + INTERVAL '60 seconds')`;
        const catalog = (headers: Record<string, string> = {}) =>
          delivery(
            "/webhooks/products/update",
            "products/update",
            shop,
            { id: 1 },
            headers,
          );
        expect(await status(products, catalog())).toBe(429);
        // A forged delivery is refused by its signature, not by the budget.
        expect(
          await status(
            products,
            catalog({ "X-Shopify-Hmac-Sha256": "forged" }),
          ),
        ).toBe(401);
        expect(await status(privacy, redact(shop))).toBe(200);
        expect(await status(uninstalled, uninstall(shop))).toBe(200);
      });
    });

    describe("bounded bodies", () => {
      it("refuses a declared oversize body without reading it, on every webhook route", async () => {
        const f = await pairedStores();
        const headers = {
          "Content-Type": "application/json",
          "Content-Length": String(11 * MiB),
          "X-Shopify-Shop-Domain": f.a.shop,
          "X-Shopify-Topic": "products/update",
          "X-Shopify-Webhook-Id": randomUUID(),
          "X-Shopify-API-Version": "2026-10",
          "X-Shopify-Hmac-Sha256": "forged",
        };
        for (const [path, route] of [
          ["/webhooks/products/update", products],
          ["/webhooks/inventory/levels/update", inventory],
          ["/webhooks/app/uninstalled", uninstalled],
          ["/webhooks/app/scopes_update", scopesUpdate],
          ["/webhooks/privacy", privacy],
        ] as const) {
          const { request, progress } = oversized(path, 11 * MiB, headers);
          const before = progress.pulled;
          expect(await status(route, request)).toBe(413);
          // The stream's own buffer may hold a chunk; nothing asked for more.
          expect(progress.pulled - before).toBeLessThanOrEqual(64 * 1024);
        }
        expect(
          await prisma.webhookEvent.count({
            where: { shopDomain: f.a.shop },
          }),
        ).toBe(0);
      });

      it("stops counting an undeclared stream at the limit", async () => {
        const f = await pairedStores();
        const { request, progress } = oversized(
          "/webhooks/products/update",
          50 * MiB,
          {
            "Content-Type": "application/json",
            "X-Shopify-Shop-Domain": f.a.shop,
            "X-Shopify-Topic": "products/update",
            "X-Shopify-Webhook-Id": randomUUID(),
            "X-Shopify-API-Version": "2026-10",
            "X-Shopify-Hmac-Sha256": "forged",
          },
        );
        expect(await status(products, request)).toBe(413);
        expect(progress.pulled).toBeLessThan(11 * MiB);
        expect(
          await prisma.webhookEvent.count({
            where: { shopDomain: f.a.shop },
          }),
        ).toBe(0);
      });

      it("accepts a real large product delivery well above Shopify's documented 5 MB channel limit", async () => {
        const f = await pairedStores();
        expect(
          await status(
            products,
            delivery("/webhooks/products/update", "products/update", f.a.shop, {
              id: 300,
              filler: "x".repeat(6 * MiB),
            }),
          ),
        ).toBe(200);
        expect(
          await prisma.webhookEvent.count({
            where: { shopDomain: f.a.shop, resourceId: "300" },
          }),
        ).toBe(1);
      });

      it("caps the anonymous login form far below the webhook limit", async () => {
        const form = "application/x-www-form-urlencoded";
        const declared = oversized("/auth/login", 64 * 1024, {
          Origin: ORIGIN,
          "Content-Type": form,
          "Content-Length": String(64 * 1024),
        });
        expect(await status(login, declared.request)).toBe(413);
        const stream = oversized("/auth/login", 10 * MiB, {
          Origin: ORIGIN,
          "Content-Type": form,
        });
        expect(await status(login, stream.request)).toBe(413);
        expect(stream.progress.pulled).toBeLessThan(MiB);
        // An ordinary submission still reaches the library's own validation.
        const small = new Request(`${ORIGIN}/auth/login`, {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": form },
          body: "shop=not%20a%20shop",
        });
        const args = {
          request: small,
          params: {},
          context: {},
          url: new URL(small.url),
          pattern: "/auth/login",
        } as ActionFunctionArgs;
        await expect(login(args)).resolves.toMatchObject({
          errors: { shop: expect.stringContaining(".myshopify.com") },
        });
        // A valid shop redirects into Shopify's authorization page.
        const valid = new Request(`${ORIGIN}/auth/login`, {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": form },
          body: "shop=valid-store.myshopify.com",
        });
        const redirected = await login({ ...args, request: valid }).catch(
          (thrown: unknown) => thrown,
        );
        expect((redirected as Response).status).toBe(302);
        expect((redirected as Response).headers.get("Location")).toContain(
          "valid-store",
        );
      });

      it("answers a login form in another encoding as a client error", async () => {
        const request = new Request(`${ORIGIN}/auth/login`, {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
          body: "shop=valid-store.myshopify.com",
        });
        expect(await status(login, request)).toBe(415);
      });
    });

    describe("the budget anonymous bodies share", () => {
      const realDeadline = anonymousBodies.readDeadlineMs;
      afterEach(() => {
        anonymousBodies.used = 0;
        anonymousBodies.readDeadlineMs = realDeadline;
      });
      const loginForm = () =>
        new Request(`${ORIGIN}/auth/login`, {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "shop=not%20a%20shop",
        });
      const product = (shop: string, body: unknown = { id: 100 }) =>
        delivery("/webhooks/products/update", "products/update", shop, body);
      /** Every anonymous route, each with a request it would otherwise accept. */
      const everyRoute = (shop: string) =>
        [
          [privacy, redact(shop)],
          [scopesUpdate, scopes(shop, ["read_products"], new Date())],
          [products, product(shop)],
          [
            inventory,
            delivery(
              "/webhooks/inventory/levels/update",
              "inventory_levels/update",
              shop,
              { inventory_item_id: 200 },
            ),
          ],
          [login, loginForm()],
          [uninstalled, uninstall(shop)],
        ] as const;

      it("answers every route with 503 and Retry-After while it is full, and normally once released", async () => {
        const f = await pairedStores();
        anonymousBodies.used = anonymousBodies.max;
        for (const [route, request] of everyRoute(f.a.shop)) {
          const refused = await respond(route, request);
          expect(refused.status).toBe(503);
          expect(refused.headers.get("Retry-After")).toBe("5");
          expect(refused.headers.get("Connection")).toBe("close");
        }
        expect(anonymousBodies.used).toBe(anonymousBodies.max);
        expect(
          await installation(f.a.shop, f.workspaceId, f.policyId),
        ).toMatchObject({ connection: "CONNECTED", policy: "ACTIVE" });
        expect(
          await prisma.privacyRequest.count({
            where: { shopDomain: f.a.shop },
          }),
        ).toBe(0);
        anonymousBodies.used = 0;
        for (const [route, request] of everyRoute(f.a.shop))
          expect(await status(route, request)).toBe(200);
        // Nothing stayed counted against the budget once those were handled.
        expect(anonymousBodies.used).toBe(0);
      });

      it("keeps taking small deliveries and the login form when large uploads hold all they may", async () => {
        const f = await pairedStores();
        const heldByLargeUploads =
          anonymousBodies.max - anonymousBodies.smallReserve;
        anonymousBodies.used = heldByLargeUploads;
        for (const [route, request] of everyRoute(f.a.shop))
          expect(await status(route, request)).toBe(200);
        expect(anonymousBodies.used).toBe(heldByLargeUploads);
        expect(
          await installation(f.a.shop, f.workspaceId, f.policyId),
        ).toMatchObject({ connection: "UNINSTALLED", pair: "REVOKED" });
        // A larger delivery waits for Shopify's retry instead of using the reserve.
        const large = await respond(
          products,
          product(f.a.shop, { id: 400, filler: "x".repeat(MiB) }),
        );
        expect(large.status).toBe(503);
        expect(large.headers.get("Retry-After")).toBe("5");
        expect(
          await prisma.webhookEvent.count({
            where: { shopDomain: f.a.shop, resourceId: "400" },
          }),
        ).toBe(0);
        // The same delivery is accepted once there is room.
        anonymousBodies.used = 0;
        expect(
          await status(
            products,
            product(f.a.shop, { id: 400, filler: "x".repeat(MiB) }),
          ),
        ).toBe(200);
      });

      it("gives up on a stalled body at the deadline on every route, and returns what it held", async () => {
        const f = await pairedStores();
        anonymousBodies.readDeadlineMs = 30;
        for (const [route, request] of everyRoute(f.a.shop)) {
          const stalled = new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(10).fill(97));
              },
            }),
            duplex: "half",
          } as RequestInit);
          const refused = await respond(route, stalled);
          expect(refused.status).toBe(408);
          expect(refused.headers.get("Connection")).toBe("close");
          expect(anonymousBodies.used).toBe(0);
        }
        expect(
          await installation(f.a.shop, f.workspaceId, f.policyId),
        ).toMatchObject({ connection: "CONNECTED", policy: "ACTIVE" });
      });
    });

    describe("deliveries older than the installation", () => {
      it("keeps a reinstalled store when the old uninstall is retried, and leaves one audit row", async () => {
        const f = await pairedStores();
        await prisma.shopConnection.update({
          where: { shopDomain: f.a.shop },
          data: { installedAt: new Date(), lastSeenAt: new Date() },
        });
        await offlineSession(f.a.shop, HOUR);
        const old = at(Date.now() - 3 * HOUR);
        expect(await status(uninstalled, uninstall(f.a.shop, old))).toBe(200);
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          LIVE,
        );
        expect(await audits(f.a.shop, "APP_UNINSTALLED")).toBe(0);
        expect(await audits(f.a.shop, "APP_UNINSTALL_IGNORED")).toBe(1);
        // Shopify can repeat it; the trail shows the one event once.
        expect(await status(uninstalled, uninstall(f.a.shop, old))).toBe(200);
        expect(await audits(f.a.shop, "APP_UNINSTALL_IGNORED")).toBe(1);
        // A real uninstall afterwards still revokes the new installation.
        expect(await status(uninstalled, uninstall(f.a.shop))).toBe(200);
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          REVOKED,
        );
      });

      it("treats an uninstall older than the store's last signed visit as stale even when it was never processed", async () => {
        // The first delivery failed, the merchant reinstalled and opened the app,
        // and only then did Shopify's retry arrive. Nothing marked a reinstall.
        const f = await pairedStores();
        await offlineSession(f.a.shop, HOUR);
        await prisma.shopConnection.update({
          where: { shopDomain: f.a.shop },
          data: {
            installedAt: new Date(Date.now() - 48 * HOUR),
            lastSeenAt: new Date(),
          },
        });
        expect(
          await status(
            uninstalled,
            uninstall(f.a.shop, at(Date.now() - 3 * HOUR)),
          ),
        ).toBe(200);
        // The installation and pair stay, but nothing keeps writing under
        // authority granted before the uninstall.
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          { ...LIVE, policy: "PAUSED" },
        );
        expect(await audits(f.a.shop, "APP_UNINSTALL_IGNORED")).toBe(1);
        await expect(requireWorkspace(f.a)).resolves.toMatchObject({
          workspaceId: f.workspaceId,
        });
      });

      it("still revokes when the signed visit is within a signature's life of the uninstall", async () => {
        const f = await pairedStores();
        await offlineSession(f.a.shop, HOUR);
        await prisma.shopConnection.update({
          where: { shopDomain: f.a.shop },
          data: {
            installedAt: new Date(Date.now() - 48 * HOUR),
            lastSeenAt: new Date(),
          },
        });
        expect(
          await status(
            uninstalled,
            uninstall(f.a.shop, at(Date.now() - 60_000)),
          ),
        ).toBe(200);
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          REVOKED,
        );
      });

      it("revokes on an uninstall delivered with no timestamp, because one cannot be shown to be old", async () => {
        const f = await pairedStores();
        const request = uninstall(f.a.shop);
        request.headers.delete("X-Shopify-Triggered-At");
        expect(await status(uninstalled, request)).toBe(200);
        expect(
          await installation(f.a.shop, f.workspaceId, f.policyId),
        ).toMatchObject({ connection: "UNINSTALLED", pair: "REVOKED" });
      });

      it("refuses an uninstall with an impossible delivery time and changes nothing", async () => {
        const f = await pairedStores();
        await offlineSession(f.a.shop, HOUR);
        await prisma.shopConnection.update({
          where: { shopDomain: f.a.shop },
          data: {
            installedAt: new Date(Date.now() - 30 * 24 * HOUR),
            lastSeenAt: new Date(Date.now() - 30 * 24 * HOUR),
          },
        });
        for (const header of [
          // Older than any retry Shopify documents.
          new Date(Date.now() - 72 * HOUR).toISOString(),
          new Date(Date.now() + HOUR).toISOString(),
          "yesterday",
        ])
          expect(
            await status(
              uninstalled,
              uninstall(f.a.shop, { "X-Shopify-Triggered-At": header }),
            ),
          ).toBe(400);
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          LIVE,
        );
        expect(await audits(f.a.shop, "APP_UNINSTALL_IGNORED")).toBe(0);
      });

      it("reads Shopify's nanosecond timestamp format", async () => {
        const f = await pairedStores();
        const request = delivery(
          "/webhooks/products/update",
          "products/update",
          f.a.shop,
          { id: 5 },
          {
            "X-Shopify-Triggered-At": "2026-03-30T14:30:00.123456789Z",
            "X-Shopify-Event-Id": "7b8c9d0a-1234-5678-90ab-cdef12345678",
            "X-Shopify-Webhook-Id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
          },
        );
        expect(await status(products, request)).toBe(200);
        // Retried delivery keeps its row and correlation.
        const retried = delivery(
          "/webhooks/products/update",
          "products/update",
          f.a.shop,
          { id: 5 },
          {
            "X-Shopify-Triggered-At": "2026-03-30T14:30:00.123456789Z",
            "X-Shopify-Event-Id": "7b8c9d0a-1234-5678-90ab-cdef12345678",
            "X-Shopify-Webhook-Id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
          },
        );
        expect(await status(products, retried)).toBe(200);
        const rows = await prisma.webhookEvent.findMany({
          where: { shopDomain: f.a.shop },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          eventId: "7b8c9d0a-1234-5678-90ab-cdef12345678",
          triggeredAt: new Date("2026-03-30T14:30:00.123Z"),
        });
      });
    });

    describe.each(SKEWS)(
      "with this process's clock %s the database's",
      (_, direction) => {
        afterEach(restoreProcessClock);
        const atDatabase = async (ms = 0) => at(await fromDatabase(ms));

        it("takes a real uninstall stamped now, 49 hours of skew or not", async () => {
          const f = await pairedStores();
          await offlineSession(f.a.shop, HOUR);
          skewProcessClock(direction * 49 * HOUR);
          expect(
            await status(uninstalled, uninstall(f.a.shop, await atDatabase())),
          ).toBe(200);
          expect(
            await installation(f.a.shop, f.workspaceId, f.policyId),
          ).toEqual(REVOKED);
          const connection = await prisma.shopConnection.findUniqueOrThrow({
            where: { shopDomain: f.a.shop },
          });
          expect(
            Math.abs(await remaining(connection.uninstalledAt)),
          ).toBeLessThan(10_000);
        });
        it("refuses a delivery stamped too far from the database's clock", async () => {
          const f = await pairedStores();
          await offlineSession(f.a.shop, HOUR);
          skewProcessClock(direction * 3 * HOUR);
          expect(
            await status(
              uninstalled,
              uninstall(f.a.shop, await atDatabase(10 * 60_000)),
            ),
          ).toBe(400);
          expect(
            await installation(f.a.shop, f.workspaceId, f.policyId),
          ).toEqual(LIVE);
        });
        it("takes an uninstall right after a signed visit, and ignores a retry older than it", async () => {
          const f = await pairedStores();
          await offlineSession(f.a.shop, HOUR);
          skewProcessClock(direction * 4 * HOUR);
          await recordSignedVisit(f.a.shop);
          expect(
            await status(
              uninstalled,
              uninstall(f.a.shop, await atDatabase(-3 * HOUR)),
            ),
          ).toBe(200);
          expect(await audits(f.a.shop, "APP_UNINSTALL_IGNORED")).toBe(1);
          expect(
            await prisma.shopConnection.findUniqueOrThrow({
              where: { shopDomain: f.a.shop },
            }),
          ).toMatchObject({ status: "CONNECTED" });
          expect(
            await status(uninstalled, uninstall(f.a.shop, await atDatabase())),
          ).toBe(200);
          expect(
            await prisma.shopConnection.findUniqueOrThrow({
              where: { shopDomain: f.a.shop },
            }),
          ).toMatchObject({ status: "UNINSTALLED" });
        });
        it("dates a reinstall by the database's clock, so only older deliveries lose to it", async () => {
          const f = await pairedStores();
          await offlineSession(f.a.shop, HOUR);
          expect(await status(uninstalled, uninstall(f.a.shop))).toBe(200);
          await offlineSession(f.a.shop, HOUR);
          skewProcessClock(direction * 4 * HOUR);
          await ensureInstallation(f.a);
          const reinstalled = await prisma.shopConnection.findUniqueOrThrow({
            where: { shopDomain: f.a.shop },
          });
          expect(reinstalled.status).toBe("CONNECTED");
          expect(
            Math.abs(await remaining(reinstalled.installedAt)),
          ).toBeLessThan(10_000);
          expect(
            await status(
              uninstalled,
              uninstall(f.a.shop, await atDatabase(-HOUR)),
            ),
          ).toBe(200);
          expect(await audits(f.a.shop, "APP_UNINSTALL_IGNORED")).toBe(1);
        });
      },
    );

    describe("identity proven from the signed body", () => {
      afterEach(() => vi.restoreAllMocks());

      it("refuses a store X uninstall body sent with store Y's header and changes nothing", async () => {
        const x = await pairedStores();
        const y = await pairedStores();
        await offlineSession(y.a.shop, HOUR);
        const forged = uninstall(
          y.a.shop,
          {},
          { id: 1, myshopify_domain: x.a.shop },
        );
        expect(await status(uninstalled, forged)).toBe(400);
        expect(await installation(y.a.shop, y.workspaceId, y.policyId)).toEqual(
          LIVE,
        );
        expect(await audits(y.a.shop, "APP_UNINSTALLED")).toBe(0);
        expect(await audits(y.a.shop, "APP_UNINSTALL_IGNORED")).toBe(0);
      });

      it("refuses a body that names no valid store, or is no store's body, and changes nothing", async () => {
        const f = await pairedStores();
        await offlineSession(f.a.shop, HOUR);
        const warn = vi.spyOn(logger, "warn");
        for (const body of [
          { id: 1, myshopify_domain: "not a domain" },
          { id: 1, myshopify_domain: "" },
          { id: 1, myshopify_domain: 7 },
          // Another topic's signed body, re-posted as an uninstall with forged headers.
          { id: 1, title: "A product" },
          { shop_id: 1, shop_domain: "somebody-else.myshopify.com" },
          { current: ["read_products"], updated_at: "2026-11-05T00:00:00Z" },
          [],
          7,
        ])
          expect(await status(uninstalled, uninstall(f.a.shop, {}, body))).toBe(
            400,
          );
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          LIVE,
        );
        expect(await audits(f.a.shop, "APP_UNINSTALLED")).toBe(0);
        const codes = warn.mock.calls.map(
          ([fields]) => (fields as unknown as { code: string }).code,
        );
        expect(codes).not.toContain("WEBHOOK_SHOP_NOT_IN_BODY");
        expect(codes).toContain("WEBHOOK_SHOP_MISMATCH");
      });

      it("revokes on an uninstall whose signed store field is null, and warns that it did", async () => {
        const f = await pairedStores();
        await offlineSession(f.a.shop, HOUR);
        const warn = vi.spyOn(logger, "warn");
        expect(
          await status(
            uninstalled,
            uninstall(f.a.shop, {}, { id: 1, myshopify_domain: null }),
          ),
        ).toBe(200);
        expect(warn).toHaveBeenCalledWith(
          {
            code: "WEBHOOK_SHOP_NOT_IN_BODY",
            topic: "APP_UNINSTALLED",
            shop: f.a.shop,
          },
          expect.any(String),
        );
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          REVOKED,
        );
        expect(await audits(f.a.shop, "APP_UNINSTALLED")).toBe(1);
      });

      it("does not warn about a body that names the store", async () => {
        const f = await pairedStores();
        const warn = vi.spyOn(logger, "warn");
        expect(await status(uninstalled, uninstall(f.a.shop))).toBe(200);
        expect(warn).not.toHaveBeenCalled();
      });

      it.each([
        ["shop/redact", "null", { shop_id: 1, shop_domain: null }],
        ["shop/redact", "absent", { shop_id: 1 }],
        ["customers/redact", "null", { shop_id: 1, shop_domain: null }],
        ["customers/data_request", "null", { shop_id: 1, shop_domain: null }],
      ])(
        "keeps the strict check for erasure: %s with a %s store field is refused",
        async (topic, _, body) => {
          const f = await pairedStores();
          await offlineSession(f.a.shop, HOUR);
          expect(
            await status(
              privacy,
              delivery("/webhooks/privacy", topic, f.a.shop, body),
            ),
          ).toBe(400);
          expect(
            await prisma.privacyRequest.count({
              where: { shopDomain: f.a.shop },
            }),
          ).toBe(0);
          expect(
            await installation(f.a.shop, f.workspaceId, f.policyId),
          ).toEqual(LIVE);
        },
      );

      it("compares the domain case-insensitively, as Shopify's domains are", async () => {
        const f = await pairedStores();
        expect(
          await status(
            uninstalled,
            uninstall(
              f.a.shop.toUpperCase(),
              {},
              { id: 1, myshopify_domain: f.a.shop },
            ),
          ),
        ).toBe(200);
        expect(
          await installation(f.a.shop, f.workspaceId, f.policyId),
        ).toMatchObject({ connection: "UNINSTALLED" });
      });

      it("refuses compliance bodies issued for another store, for every compliance topic", async () => {
        const x = await pairedStores();
        const y = await pairedStores();
        for (const topic of [
          "shop/redact",
          "customers/redact",
          "customers/data_request",
        ])
          expect(
            await status(
              privacy,
              delivery("/webhooks/privacy", topic, y.a.shop, {
                shop_id: 1,
                shop_domain: x.a.shop,
                customer: { id: 10 },
              }),
            ),
          ).toBe(400);
        expect(
          await prisma.privacyRequest.count({
            where: { shopDomain: { in: [x.a.shop, y.a.shop] } },
          }),
        ).toBe(0);
      });

      it("stops the captured-delivery route to erasing another store", async () => {
        const attacker = await pairedStores();
        const victim = await pairedStores();
        await offlineSession(victim.a.shop, HOUR);
        const snapshot = await prisma.productSnapshot.create({
          data: {
            shopDomain: victim.a.shop,
            productGid: "gid://shopify/Product/1",
            title: "Victim catalog",
            handle: "victim",
            status: "ACTIVE",
            data: {},
            hash: "victim",
          },
        });
        expect(
          await status(
            uninstalled,
            uninstall(
              victim.a.shop,
              {},
              { id: 1, myshopify_domain: attacker.a.shop },
            ),
          ),
        ).toBe(400);
        expect(
          await status(
            privacy,
            redact(victim.a.shop, {
              shop_id: 1,
              shop_domain: attacker.a.shop,
            }),
          ),
        ).toBe(400);
        await processPrivacyRequests();
        expect(
          await installation(
            victim.a.shop,
            victim.workspaceId,
            victim.policyId,
          ),
        ).toEqual(LIVE);
        expect(
          await prisma.productSnapshot.findUnique({
            where: { id: snapshot.id },
          }),
        ).not.toBeNull();
      });

      it("refuses a signed body sent with a topic its route does not handle", async () => {
        const f = await pairedStores();
        await offlineSession(f.a.shop, HOUR);
        const shop = f.a.shop;
        const sameBody = {
          shop_id: 1,
          shop_domain: shop,
          myshopify_domain: shop,
        };
        // A compliance body cannot pose as an uninstall or the reverse, and a
        // lifecycle topic cannot dodge the catalog budget on the catalog route.
        for (const [route, path, topic] of [
          [uninstalled, "/webhooks/app/uninstalled", "shop/redact"],
          [uninstalled, "/webhooks/app/uninstalled", "products/update"],
          [privacy, "/webhooks/privacy", "app/uninstalled"],
          [privacy, "/webhooks/privacy", "products/update"],
          [products, "/webhooks/products/update", "app/uninstalled"],
          [products, "/webhooks/products/update", "inventory_levels/update"],
          [inventory, "/webhooks/inventory/levels/update", "products/update"],
          [scopesUpdate, "/webhooks/app/scopes_update", "app/uninstalled"],
        ] as const)
          expect(
            await status(route, delivery(path, topic, shop, sameBody)),
          ).toBe(400);
        expect(await installation(shop, f.workspaceId, f.policyId)).toEqual(
          LIVE,
        );
        expect(
          await prisma.privacyRequest.count({ where: { shopDomain: shop } }),
        ).toBe(0);
        expect(
          await prisma.webhookEvent.count({ where: { shopDomain: shop } }),
        ).toBe(0);
      });

      it("refuses a customer request body replayed as a shop erasure", async () => {
        const f = await pairedStores();
        expect(
          await status(
            privacy,
            redact(f.a.shop, {
              shop_id: 1,
              shop_domain: f.a.shop,
              customer: { id: 10 },
              orders_to_redact: [1],
            }),
          ),
        ).toBe(400);
        expect(
          await prisma.privacyRequest.count({
            where: { shopDomain: f.a.shop },
          }),
        ).toBe(0);
      });

      it("refuses a malformed shop header on a correctly signed catalog delivery", async () => {
        expect(
          await status(
            products,
            delivery(
              "/webhooks/products/update",
              "products/update",
              "not-a-shop.example.com",
              { id: 1 },
            ),
          ),
        ).toBe(400);
        expect(
          await prisma.webhookEvent.count({
            where: { shopDomain: "not-a-shop.example.com" },
          }),
        ).toBe(0);
      });
    });

    describe("a captured uninstall and redaction of the same store", () => {
      /** Both bodies are genuine and name this store. Only the headers are fresh. */
      async function replayed() {
        const f = await pairedStores();
        await offlineSession(f.a.shop, HOUR);
        expect(await status(uninstalled, uninstall(f.a.shop))).toBe(200);
        expect(await status(privacy, redact(f.a.shop))).toBe(200);
        const { deliveryKey } = await prisma.privacyRequest.findFirstOrThrow({
          where: { shopDomain: f.a.shop, topic: "SHOP_REDACT" },
        });
        const erasure = () =>
          prisma.privacyRequest.findUniqueOrThrow({ where: { deliveryKey } });
        return { ...f, erasure };
      }
      // Rows other tests in this file left behind are settled by the first pass.
      const workerCycles = async () => {
        for (let pass = 0; pass < 5; pass++) await processPrivacyRequests();
      };

      it("erases nothing for 48 hours, so reopening the app can stop it", async () => {
        const f = await replayed();
        await workerCycles();
        expect(await f.erasure()).toMatchObject({ status: "PENDING" });
        expect(
          await installation(f.a.shop, f.workspaceId, f.policyId),
        ).toMatchObject({
          connection: "UNINSTALLED",
          policy: "PAUSED",
          workspace: "REVOKED",
          pair: "REVOKED",
        });
        // Reinstalling issues new sessions before any page runs.
        await offlineSession(f.a.shop, HOUR);
        await ensureInstallation(f.a);
        await workerCycles();
        expect(await f.erasure()).toMatchObject({
          status: "HELD",
          outcome: "INSTALLATION_CHANGED_REVIEW_REQUIRED",
        });
        expect(
          await prisma.shopConnection.findUnique({
            where: { shopDomain: f.a.shop },
          }),
        ).toMatchObject({ status: "CONNECTED" });
        expect(
          await prisma.workspace.findUnique({ where: { id: f.workspaceId } }),
        ).not.toBeNull();
      });

      it("erases when the 48 hours pass with no reinstall, as it must for a real uninstall", async () => {
        const f = await replayed();
        await prisma.shopConnection.update({
          where: { shopDomain: f.a.shop },
          data: { uninstalledAt: new Date(Date.now() - 49 * HOUR) },
        });
        await workerCycles();
        expect(await f.erasure()).toMatchObject({
          status: "COMPLETED",
          outcome: "SHOP_DATA_ERASED",
          shopDomain: null,
        });
        expect(
          await prisma.shopConnection.findUnique({
            where: { shopDomain: f.a.shop },
          }),
        ).toBeNull();
        expect(
          await prisma.workspace.findUnique({ where: { id: f.workspaceId } }),
        ).toBeNull();
      });
    });

    describe("scope deliveries in any order", () => {
      async function withScopes() {
        const f = await pairedStores();
        await offlineSession(f.a.shop, HOUR);
        return f;
      }
      const stored = async (shop: string) => ({
        connection: (
          await prisma.shopConnection.findUniqueOrThrow({
            where: { shopDomain: shop },
          })
        ).scopes,
        session: (await prisma.session.findFirstOrThrow({ where: { shop } }))
          .scope,
      });

      it("keeps the newer scopes when an older delivery arrives second", async () => {
        const f = await withScopes();
        const newer = new Date(Date.now() - HOUR);
        const older = new Date(Date.now() - 2 * HOUR);
        const three = "read_inventory,read_products,write_products";
        expect(
          await status(
            scopesUpdate,
            scopes(
              f.a.shop,
              ["read_products", "write_products", "read_inventory"],
              newer,
            ),
          ),
        ).toBe(200);
        expect(
          await status(
            scopesUpdate,
            scopes(f.a.shop, ["read_products"], older),
          ),
        ).toBe(200);
        expect(await stored(f.a.shop)).toEqual({
          connection: three,
          session: three,
        });
        expect(await audits(f.a.shop, "SCOPES_CHANGED")).toBe(1);
        expect(await audits(f.a.shop, "SCOPES_UPDATE_IGNORED")).toBe(1);
      });

      it("applies a newer delivery and adds no audit row for a duplicate", async () => {
        const f = await withScopes();
        const first = new Date(Date.now() - 2 * HOUR);
        const second = new Date(Date.now() - HOUR);
        const send = (current: string[], updatedAt: Date) =>
          status(scopesUpdate, scopes(f.a.shop, current, updatedAt));
        expect(await send(["read_products"], first)).toBe(200);
        expect(await send(["read_products"], first)).toBe(200);
        expect(await audits(f.a.shop, "SCOPES_CHANGED")).toBe(1);
        expect(await audits(f.a.shop, "SCOPES_UPDATE_IGNORED")).toBe(0);
        expect(await send(["read_products", "read_inventory"], second)).toBe(
          200,
        );
        expect(await audits(f.a.shop, "SCOPES_CHANGED")).toBe(2);
        expect((await stored(f.a.shop)).connection).toBe(
          "read_inventory,read_products",
        );
      });

      it("ignores a delivery older than the current installation", async () => {
        const f = await withScopes();
        await prisma.shopConnection.update({
          where: { shopDomain: f.a.shop },
          data: { installedAt: new Date() },
        });
        expect(
          await status(
            scopesUpdate,
            scopes(f.a.shop, ["read_orders"], new Date(Date.now() - HOUR)),
          ),
        ).toBe(200);
        expect(await stored(f.a.shop)).toEqual({
          connection: null,
          session: "read_products",
        });
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          LIVE,
        );
        expect(await audits(f.a.shop, "SCOPES_UPDATE_IGNORED")).toBe(1);
      });

      it("ends on the newest scopes whatever order concurrent deliveries commit in", async () => {
        const f = await withScopes();
        const deliveries = Array.from({ length: 8 }, (_, index) =>
          scopes(
            f.a.shop,
            [`scope_${"abcdefgh"[index]}`],
            new Date(Date.now() - (8 - index) * 60_000),
          ),
        );
        const results = await Promise.all(
          deliveries.reverse().map((request) => status(scopesUpdate, request)),
        );
        expect(new Set(results)).toEqual(new Set([200]));
        expect((await stored(f.a.shop)).connection).toBe("scope_h");
      });

      it("waits for a newer delivery still committing instead of overwriting it", async () => {
        const f = await withScopes();
        const newer = new Date(Date.now() - HOUR);
        expect(
          await whileRowChanges(
            f.a.shop,
            { scopes: "read_inventory", scopesUpdatedAt: newer },
            () =>
              status(
                scopesUpdate,
                scopes(
                  f.a.shop,
                  ["read_orders"],
                  new Date(newer.getTime() - HOUR),
                ),
              ),
          ),
        ).toBe(200);
        expect((await stored(f.a.shop)).connection).toBe("read_inventory");
        expect(await audits(f.a.shop, "SCOPES_UPDATE_IGNORED")).toBe(1);
      });

      it("refuses a delivery whose signed shop id is not the one recorded for this store", async () => {
        const f = await withScopes();
        await prisma.shopConnection.update({
          where: { shopDomain: f.a.shop },
          data: { shopGid: "gid://shopify/Shop/777" },
        });
        const when = new Date(Date.now() - HOUR);
        expect(
          await status(
            scopesUpdate,
            scopes(f.a.shop, ["read_orders"], when, {
              shop_id: "gid://shopify/Shop/888",
            }),
          ),
        ).toBe(400);
        expect(await stored(f.a.shop)).toEqual({
          connection: null,
          session: "read_products",
        });
        expect(await installation(f.a.shop, f.workspaceId, f.policyId)).toEqual(
          LIVE,
        );
        expect(await audits(f.a.shop, "SCOPES_CHANGED")).toBe(0);
        expect(
          await status(
            scopesUpdate,
            scopes(f.a.shop, ["read_orders"], when, {
              shop_id: "gid://shopify/Shop/777",
            }),
          ),
        ).toBe(200);
        expect((await stored(f.a.shop)).connection).toBe("read_orders");
      });

      it("rejects a scope delivery that does not match the documented payload", async () => {
        const f = await withScopes();
        for (const body of [
          { current: ["read_products"] },
          { current: ["read_products"], updated_at: "soon" },
          { updated_at: new Date().toISOString() },
          { current: ["NOT A SCOPE"], updated_at: new Date().toISOString() },
        ])
          expect(
            await status(
              scopesUpdate,
              delivery(
                "/webhooks/app/scopes_update",
                "app/scopes_update",
                f.a.shop,
                body,
              ),
            ),
          ).toBe(400);
        expect(await audits(f.a.shop, "SCOPES_CHANGED")).toBe(0);
      });
    });

    describe("reinstalling", () => {
      it("starts a new installation only after Shopify issued new sessions", async () => {
        const f = await pairedStores();
        await offlineSession(f.a.shop, HOUR);
        await prisma.shopConnection.update({
          where: { shopDomain: f.a.shop },
          data: {
            verifiedAt: new Date(),
            scopes: "read_products",
            scopesUpdatedAt: new Date(),
          },
        });
        expect(await status(uninstalled, uninstall(f.a.shop))).toBe(200);
        const revoked = await prisma.shopConnection.findUniqueOrThrow({
          where: { shopDomain: f.a.shop },
        });
        // A page that authenticated just before the uninstall committed: the
        // uninstall deleted its sessions, so it cannot bring the store back.
        const racing = await ensureInstallation(f.a);
        expect(racing).toMatchObject({
          status: "UNINSTALLED",
          installedAt: revoked.installedAt,
        });
        expect(racing.uninstalledAt).not.toBeNull();
        expect(await audits(f.a.shop, "APP_REINSTALLED")).toBe(0);

        await offlineSession(f.a.shop, HOUR);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const reinstalled = await ensureInstallation(f.a);
        expect(reinstalled).toMatchObject({
          status: "CONNECTED",
          uninstalledAt: null,
          workspaceId: null,
          verifiedAt: null,
          scopes: null,
          scopesUpdatedAt: null,
        });
        expect(reinstalled.installedAt.getTime()).toBeGreaterThan(
          revoked.installedAt.getTime(),
        );
        expect(await audits(f.a.shop, "APP_REINSTALLED")).toBe(1);
        // Later page loads do not restart the installation.
        const again = await ensureInstallation(f.a);
        expect(again.installedAt).toEqual(reinstalled.installedAt);
        expect(await audits(f.a.shop, "APP_REINSTALLED")).toBe(1);

        // Shopify's retry of the uninstall that started all this changes nothing.
        expect(
          await status(uninstalled, uninstall(f.a.shop, at(Date.now() - HOUR))),
        ).toBe(200);
        expect(
          await prisma.shopConnection.findUniqueOrThrow({
            where: { shopDomain: f.a.shop },
          }),
        ).toMatchObject({ status: "CONNECTED", uninstalledAt: null });
        expect(await prisma.session.count({ where: { shop: f.a.shop } })).toBe(
          1,
        );
      });

      it("does not move the uninstall time on a repeated delivery, which the erasure guard reads", async () => {
        const f = await pairedStores();
        const when = at(Date.now() - 60_000);
        expect(await status(uninstalled, uninstall(f.a.shop, when))).toBe(200);
        const first = await prisma.shopConnection.findUniqueOrThrow({
          where: { shopDomain: f.a.shop },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(await status(uninstalled, uninstall(f.a.shop, when))).toBe(200);
        expect(
          (
            await prisma.shopConnection.findUniqueOrThrow({
              where: { shopDomain: f.a.shop },
            })
          ).uninstalledAt,
        ).toEqual(first.uninstalledAt);
        expect(await audits(f.a.shop, "APP_UNINSTALLED")).toBe(1);
      });

      it("keeps a reinstall that is still committing when an older uninstall arrives", async () => {
        const f = await pairedStores();
        expect(await status(uninstalled, uninstall(f.a.shop))).toBe(200);
        await offlineSession(f.a.shop, HOUR);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const delivery = uninstall(f.a.shop);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(
          await whileRowChanges(
            f.a.shop,
            {
              status: "CONNECTED",
              uninstalledAt: null,
              installedAt: new Date(),
            },
            () => status(uninstalled, delivery),
          ),
        ).toBe(200);
        expect(
          await prisma.shopConnection.findUniqueOrThrow({
            where: { shopDomain: f.a.shop },
          }),
        ).toMatchObject({ status: "CONNECTED", uninstalledAt: null });
        expect(await prisma.session.count({ where: { shop: f.a.shop } })).toBe(
          1,
        );
        expect(await audits(f.a.shop, "APP_UNINSTALL_IGNORED")).toBe(1);
      });

      it("never leaves a live store without sessions or a dead one with them when a later uninstall races a reinstall", async () => {
        for (let round = 0; round < 8; round++) {
          const f = await pairedStores();
          expect(await status(uninstalled, uninstall(f.a.shop))).toBe(200);
          await offlineSession(f.a.shop, HOUR);
          await new Promise((resolve) => setTimeout(resolve, 5));
          // Newer than the handled uninstall and older than the page load, so
          // the order these commit in decides which one wins, but not the state.
          const request = uninstall(f.a.shop);
          const [delivered] = await Promise.all([
            status(uninstalled, request),
            ensureInstallation(f.a),
          ]);
          expect(delivered).toBe(200);
          const [connection, sessions] = await Promise.all([
            prisma.shopConnection.findUniqueOrThrow({
              where: { shopDomain: f.a.shop },
            }),
            prisma.session.count({ where: { shop: f.a.shop } }),
          ]);
          expect(sessions).toBe(connection.status === "CONNECTED" ? 1 : 0);
        }
      });
    });
  },
);
