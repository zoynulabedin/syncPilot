import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../app/shopify.server", () => ({
  addDocumentResponseHeaders: vi.fn(),
}));
vi.mock("pino", () => ({
  default: () => ({ error: mocks.error, warn: vi.fn(), info: vi.fn() }),
}));
import { handleError } from "../app/entry.server";
import { safeError, scrubSecrets } from "../app/services/logger.server";

const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl";
const args = (url: string, signal = new AbortController().signal) =>
  ({
    request: new Request(url, { signal }),
    params: {},
    context: {},
  }) as unknown as Parameters<typeof handleError>[1];

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("secrets in log text", () => {
  it.each([
    [`GET /app?shop=x.myshopify.com&id_token=${jwt}&embedded=1`, jwt],
    ["GET /app?hmac=a1b2c3d4e5f6&host=abc", "a1b2c3d4e5f6"],
    [`Authorization: Bearer ${jwt}`, jwt],
    [`token ${jwt} rejected`, jwt],
    ["shpat_0123456789abcdef was refused", "shpat_0123456789abcdef"],
    ["refresh_token=shprt_abc123&x=1", "shprt_abc123"],
    ["code=oauth-code&state=oauth-state", "oauth-code"],
  ])("removes the secret from %s", (text, secret) => {
    const scrubbed = scrubSecrets(text);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain("[REDACTED]");
  });
  it("leaves ordinary text alone", () => {
    const text = "GET /app/settings?shop=x.myshopify.com returned 200";
    expect(scrubSecrets(text)).toBe(text);
  });
  it("cleans thrown errors, and copes with what is not an Error", () => {
    const { name, message, stack } = safeError(
      new TypeError(`Bad URL /app?id_token=${jwt}`),
    );
    expect(name).toBe("TypeError");
    expect(message).toBe("Bad URL /app?[REDACTED]");
    expect(stack).not.toContain(jwt);
    expect(safeError("plain text")).toMatchObject({ message: "plain text" });
  });
});

describe("the server's error handler", () => {
  it("logs through the redacting logger with the path only, never to the console", () => {
    const consoleError = vi.spyOn(console, "error");
    handleError(
      new Error(`Render failed for ${jwt}`),
      args(`https://app.test/app/rules?id_token=${jwt}&hmac=abc123`),
    );
    expect(consoleError).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
    const [fields] = mocks.error.mock.calls[0];
    expect(fields).toMatchObject({ method: "GET", path: "/app/rules" });
    expect(JSON.stringify(mocks.error.mock.calls[0])).not.toContain(jwt);
    expect(JSON.stringify(mocks.error.mock.calls[0])).not.toContain("abc123");
  });
  it("stays quiet about a request the client abandoned", () => {
    const abandoned = new AbortController();
    abandoned.abort();
    handleError(
      new Error("aborted"),
      args("https://app.test/app", abandoned.signal),
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });
  it("names a route error response by its status", () => {
    const response = {
      status: 405,
      statusText: "Method Not Allowed",
      internal: true,
      data: null,
    };
    handleError(response, args("https://app.test/webhooks/privacy"));
    expect(mocks.error.mock.calls[0][0].err.message).toBe(
      "405 Method Not Allowed",
    );
    // React Router keeps the underlying cause on internal responses.
    handleError(
      { ...response, error: new Error(`Bad request for ${jwt}`) },
      args("https://app.test/webhooks/privacy"),
    );
    expect(mocks.error.mock.calls[1][0].err.message).toBe(
      "Bad request for [REDACTED]",
    );
  });
});
