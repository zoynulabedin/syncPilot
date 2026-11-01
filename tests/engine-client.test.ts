import { afterEach, describe, expect, it, vi } from "vitest";
import {
  shopifyRequest,
  type GraphQLExecutor,
} from "../app/services/shopify-client.server";
const shop = "client-test.myshopify.com";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
describe("Shopify client response semantics", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("does not invoke Shopify when the write release gate is off", async () => {
    vi.stubEnv("SYNC_WRITE_ENABLED", "false");
    const execute = vi.fn<GraphQLExecutor>();
    await expect(
      shopifyRequest(shop, "mutation {}", {}, { write: true, execute }),
    ).rejects.toMatchObject({ code: "WRITES_DISABLED" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("treats HTTP 200 GraphQL errors as failure and never returns partial data", async () => {
    const execute = vi
      .fn<GraphQLExecutor>()
      .mockResolvedValue(
        json({
          data: { product: { id: "partial" } },
          errors: [{ extensions: { code: "ACCESS_DENIED" } }],
        }),
      );
    await expect(
      shopifyRequest(shop, "query {}", {}, { execute }),
    ).rejects.toMatchObject({ code: "PARTIAL_GRAPHQL_ERROR" });
  });
  it("retries pre-execution throttles but quarantines ambiguous mutation transport failures", async () => {
    const throttled = vi
      .fn<GraphQLExecutor>()
      .mockResolvedValue(
        json({ errors: [{ extensions: { code: "THROTTLED" } }] }),
      );
    await expect(
      shopifyRequest(shop, "query {}", {}, { execute: throttled }),
    ).rejects.toMatchObject({
      code: "THROTTLED",
      retryable: true,
      uncertain: false,
    });
    vi.stubEnv("SYNC_WRITE_ENABLED", "true");
    const lost = vi
      .fn<GraphQLExecutor>()
      .mockRejectedValue(new Error("transport interrupted"));
    await expect(
      shopifyRequest(shop, "mutation {}", {}, { write: true, execute: lost }),
    ).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME",
      retryable: false,
      uncertain: true,
    });
  });
  it("distinguishes expired authorization from a retryable read timeout", async () => {
    const denied = vi.fn<GraphQLExecutor>().mockResolvedValue(json({}, 401));
    await expect(
      shopifyRequest(shop, "query {}", {}, { execute: denied }),
    ).rejects.toMatchObject({ code: "AUTH_FAILURE", retryable: false });
    const timeout = vi
      .fn<GraphQLExecutor>()
      .mockRejectedValue(new Error("timeout"));
    await expect(
      shopifyRequest(shop, "query {}", {}, { execute: timeout }),
    ).rejects.toMatchObject({ code: "NETWORK_TIMEOUT", retryable: true });
  });
  it("requires complete JSON data and supplies a bounded abort signal", async () => {
    const execute = vi
      .fn<GraphQLExecutor>()
      .mockResolvedValue(json({ data: { shop: { currencyCode: "USD" } } }));
    await expect(
      shopifyRequest(shop, "query {}", { id: "fixture" }, { execute }),
    ).resolves.toEqual({ shop: { currencyCode: "USD" } });
    expect(execute.mock.calls[0][1]).toMatchObject({
      variables: { id: "fixture" },
      signal: expect.any(AbortSignal),
    });
  });
});
