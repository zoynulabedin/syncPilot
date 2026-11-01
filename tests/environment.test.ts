import { describe, expect, it } from "vitest";
import { resolveShopifyAppUrl } from "../app/services/environment.server";
describe("Shopify web and worker URL configuration", () => {
  it("supports the legacy CLI HOST injection outside Vite", () => {
    expect(
      resolveShopifyAppUrl({
        NODE_ENV: "development",
        HOST: "https://legacy.trycloudflare.com",
      }),
    ).toBe("https://legacy.trycloudflare.com");
  });
  it("prefers the explicit app URL and removes a trailing slash", () => {
    expect(
      resolveShopifyAppUrl({
        SHOPIFY_APP_URL: "https://explicit.example/",
        HOST: "https://other.example",
      }),
    ).toBe("https://explicit.example");
  });
  it("requires explicit secure production configuration", () => {
    expect(() =>
      resolveShopifyAppUrl({
        NODE_ENV: "production",
        HOST: "https://legacy.example",
      }),
    ).toThrow();
    expect(() =>
      resolveShopifyAppUrl({
        NODE_ENV: "production",
        SHOPIFY_APP_URL: "http://remote.example",
      }),
    ).toThrow();
    expect(
      resolveShopifyAppUrl({
        NODE_ENV: "production",
        SHOPIFY_APP_URL: "http://127.0.0.1:3210",
      }),
    ).toBe("http://127.0.0.1:3210");
  });
  it("rejects missing, malformed and credential-bearing URLs without reflecting their values", () => {
    for (const value of [
      undefined,
      "machine-name",
      "file:///tmp/app",
      "https://user:secret@example.com",
    ]) {
      expect(() => resolveShopifyAppUrl({ SHOPIFY_APP_URL: value })).toThrow();
    }
  });
});
