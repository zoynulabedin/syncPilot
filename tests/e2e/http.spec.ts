import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";

test("public liveness and readiness reveal no configuration", async ({
  request,
}) => {
  const health = await request.get("/health");
  expect(health.status()).toBe(200);
  expect(await health.text()).toBe("ok");
  const ready = await request.get("/ready");
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toEqual({ status: "ready" });
});

test("signed privacy deliveries are accepted and the data handling page is public", async ({
  request,
}) => {
  const body = JSON.stringify({
    shop_id: 1,
    shop_domain: "privacy-http.myshopify.com",
    customer: { id: 10 },
  });
  const hmac = createHmac(
    "sha256",
    "synthetic-contract-test-secret-for-local-verification-only",
  )
    .update(body)
    .digest("base64");
  const response = await request.post("/webhooks/privacy", {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Shop-Domain": "privacy-http.myshopify.com",
      "X-Shopify-Topic": "customers/data_request",
      "X-Shopify-Webhook-Id": "synthetic-privacy-delivery",
      "X-Shopify-Api-Version": "2026-10",
      "X-Shopify-Hmac-Sha256": hmac,
    },
    data: body,
  });
  expect(response.status()).toBe(200);
  expect((await request.get("/privacy")).status()).toBe(200);
});

test("landing page serves the real product and protects embedded routes", async ({
  request,
}) => {
  const home = await request.get("/");
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain("Verified store connections");
  const app = await request.get("/app/activity?shop=untrusted.myshopify.com", {
    maxRedirects: 0,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
      Authorization: "Bearer invalid-local-fixture",
    },
  });
  expect([400, 401]).toContain(app.status());
  expect(await app.text()).not.toContain("synthetic-contract-test-secret");
});

test("forged product and inventory webhooks are rejected before persistence", async ({
  request,
}) => {
  for (const route of [
    "/webhooks/products/update",
    "/webhooks/inventory/levels/update",
    "/webhooks/app/uninstalled",
    "/webhooks/privacy",
  ]) {
    const result = await request.post(route, {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Shop-Domain": "forged.myshopify.com",
        "X-Shopify-Topic": "PRODUCTS_UPDATE",
        "X-Shopify-Webhook-Id": "forged-local-verification",
        "X-Shopify-Hmac-Sha256": "invalid-hmac",
      },
      data: { id: 1 },
      maxRedirects: 0,
    });
    expect([400, 401]).toContain(result.status());
  }
});
