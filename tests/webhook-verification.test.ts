import "@shopify/shopify-api/adapters/web-api";
import { ApiVersion, LogSeverity, shopifyApi } from "@shopify/shopify-api";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  parseShopifyTime,
  requireSignedShop,
  requireUninstallShop,
  verifyWebhook,
} from "../app/services/webhook-verification.server";

const secret = "test-secret";
const api = shopifyApi({
  apiKey: "test-key",
  apiSecretKey: secret,
  apiVersion: ApiVersion.October26,
  hostName: "app.test",
  isEmbeddedApp: true,
  logger: { level: LogSeverity.Error },
});
const shop = "verified.myshopify.com";
function delivery(
  body: string,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Request("https://app.test/webhooks", {
    method,
    body,
    headers: {
      "X-Shopify-Hmac-Sha256": createHmac("sha256", secret)
        .update(body)
        .digest("base64"),
      "X-Shopify-Topic": "products/update",
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": "delivery-1",
      ...headers,
    },
  });
}
const verify = (request: Request, topics = ["PRODUCTS_UPDATE"]) =>
  verifyWebhook(api.webhooks, request, topics);
const statusOf = (request: Request, topics?: string[]) =>
  verify(request, topics).then(
    () => 200,
    (error: unknown) => (error as Response).status,
  );

describe("webhook verification", () => {
  it("returns the delivery in the library's form with its headers", async () => {
    const webhook = await verify(
      delivery('{"id":1}', {
        "X-Shopify-Shop-Domain": "VERIFIED.myshopify.com",
        "X-Shopify-Triggered-At": "2026-03-30T14:30:00.000000000Z",
        "X-Shopify-Event-Id": "event-1",
        "X-Shopify-Name": "catalog",
      }),
    );
    expect(webhook).toEqual({
      apiVersion: "2026-10",
      shop,
      topic: "PRODUCTS_UPDATE",
      webhookId: "delivery-1",
      name: "catalog",
      eventId: "event-1",
      triggeredAt: new Date("2026-03-30T14:30:00.000Z"),
      payload: { id: 1 },
    });
    // Nothing a route could use to reach stored tokens.
    expect(webhook).not.toHaveProperty("session");
    expect(webhook).not.toHaveProperty("admin");
  });

  it("verifies against the exact bytes the sender signed", async () => {
    const body = '{"title":"產品 — café"}';
    await expect(verify(delivery(body))).resolves.toMatchObject({
      payload: { title: "產品 — café" },
    });
  });

  it("uses the library's status codes for a wrong method, a bad signature and missing headers", async () => {
    expect(await statusOf(delivery("{}", {}, "PUT"))).toBe(405);
    expect(
      await statusOf(delivery("{}", { "X-Shopify-Hmac-Sha256": "forged" })),
    ).toBe(401);
    for (const name of [
      "X-Shopify-Topic",
      "X-Shopify-Shop-Domain",
      "X-Shopify-API-Version",
      "X-Shopify-Webhook-Id",
    ]) {
      const request = delivery("{}");
      request.headers.delete(name);
      expect(await statusOf(request)).toBe(400);
    }
    const unsigned = delivery("{}");
    unsigned.headers.delete("X-Shopify-Hmac-Sha256");
    expect(await statusOf(unsigned)).toBe(400);
    expect(await statusOf(delivery(""))).toBe(400);
  });

  it("checks the signature before anything else in the request can matter", async () => {
    const validate = vi.spyOn(api.webhooks, "validate");
    expect(
      await statusOf(
        delivery("not json", {
          "X-Shopify-Hmac-Sha256": "forged",
          "X-Shopify-Topic": "some/other_topic",
          "X-Shopify-Shop-Domain": "not a shop",
          "X-Shopify-Triggered-At": "yesterday",
        }),
      ),
    ).toBe(401);
    expect(validate).toHaveBeenCalledOnce();
    validate.mockRestore();
  });

  it("refuses signed deliveries for another route's topic, a bad shop, bad headers or a body that is not JSON", async () => {
    expect(await statusOf(delivery("{}"), ["APP_UNINSTALLED"])).toBe(400);
    expect(
      await statusOf(
        delivery("{}", { "X-Shopify-Shop-Domain": "shop.example.com" }),
      ),
    ).toBe(400);
    expect(
      await statusOf(delivery("{}", { "X-Shopify-Triggered-At": "yesterday" })),
    ).toBe(400);
    expect(
      await statusOf(
        delivery("{}", { "X-Shopify-Webhook-Id": "x".repeat(201) }),
      ),
    ).toBe(400);
    expect(
      await statusOf(delivery("{}", { "X-Shopify-Event-Id": "x".repeat(201) })),
    ).toBe(400);
    expect(await statusOf(delivery("not json"))).toBe(400);
  });

  it("refuses an Events delivery, which no subscription here produces", async () => {
    const body = "{}";
    const request = new Request("https://app.test/webhooks", {
      method: "POST",
      body,
      headers: {
        "Shopify-Hmac-Sha256": createHmac("sha256", secret)
          .update(body)
          .digest("base64"),
        "Shopify-Topic": "products/update",
        "Shopify-Shop-Domain": shop,
        "Shopify-Api-Version": "2026-10",
        "Shopify-Webhook-Id": "delivery-1",
      },
    });
    expect(await statusOf(request)).toBe(400);
  });

  it("accepts a missing delivery time, which only the destructive routes weigh", async () => {
    const webhook = await verify(delivery("{}"));
    expect(webhook.triggeredAt).toBeUndefined();
    expect(webhook.eventId).toBeUndefined();
  });
});

describe("parsing Shopify's timestamps", () => {
  it.each([
    ["2026-03-30T14:30:00.000000000Z", "2026-03-30T14:30:00.000Z"],
    ["2025-07-10T16:15:47.000000Z", "2025-07-10T16:15:47.000Z"],
    ["2024-06-25T00:00:00.000Z", "2024-06-25T00:00:00.000Z"],
    ["2021-12-31T19:00:00-05:00", "2022-01-01T00:00:00.000Z"],
  ])("reads %s", (value, expected) => {
    expect(parseShopifyTime(value)?.toISOString()).toBe(expected);
  });
  it.each([
    "yesterday",
    "",
    "2026-13-45T14:30:00Z",
    "+275760-09-13T00:00:00.000Z",
    "1793862257",
    1793862257,
    null,
    undefined,
  ])("refuses %s", (value) => {
    expect(parseShopifyTime(value)).toBeUndefined();
  });
});

describe("proving the store from the signed body", () => {
  const webhook = (payload: unknown) => ({
    apiVersion: "2026-10",
    shop,
    topic: "APP_UNINSTALLED",
    webhookId: "delivery-1",
    payload,
  });
  it("accepts the same store in any case", () => {
    expect(() =>
      requireSignedShop(
        webhook({ myshopify_domain: "Verified.MyShopify.com" }),
        "myshopify_domain",
      ),
    ).not.toThrow();
    expect(() =>
      requireSignedShop(webhook({ shop_domain: shop }), "shop_domain"),
    ).not.toThrow();
  });
  it.each([
    [{ myshopify_domain: "other.myshopify.com" }],
    [{ myshopify_domain: null }],
    [{ myshopify_domain: 7 }],
    [{ shop_domain: shop }],
    [{}],
    [null],
    [[]],
    ["verified.myshopify.com"],
  ])("rejects %j", (payload) => {
    let thrown: unknown;
    try {
      requireSignedShop(webhook(payload), "myshopify_domain");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Response).status).toBe(400);
  });
  it.each([[{ myshopify_domain: null }], [{}], [{ id: 1 }]])(
    "takes an uninstall body of %j, which names no store",
    (payload) => {
      expect(() => requireUninstallShop(webhook(payload))).not.toThrow();
    },
  );
  it("takes an uninstall body naming this store in any case", () => {
    expect(() =>
      requireUninstallShop(
        webhook({ myshopify_domain: "Verified.MyShopify.com" }),
      ),
    ).not.toThrow();
  });
  it.each([
    [{ myshopify_domain: "other.myshopify.com" }],
    [{ myshopify_domain: "not a domain" }],
    [{ myshopify_domain: "" }],
    [{ myshopify_domain: 7 }],
    [null],
    [[]],
    ["verified.myshopify.com"],
  ])("still rejects an uninstall body of %j", (payload) => {
    let thrown: unknown;
    try {
      requireUninstallShop(webhook(payload));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Response).status).toBe(400);
  });
});
