import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import {
  alertDestination,
  isPublicAddress,
  sendAlert,
} from "../app/services/alert-transport.server";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ALERT_WEBHOOK_URL", "https://alerts.example.com/secret-hook");
  vi.stubEnv("ALERT_WEBHOOK_HOSTS", "alerts.example.com");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("operator alert transport", () => {
  it.each([
    "127.0.0.1",
    "10.1.1.1",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])("rejects private/reserved destination %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it("requires an explicitly allowlisted HTTPS host without credentials or custom ports", () => {
    for (const url of [
      "http://alerts.example.com",
      "https://other.example.com",
      "https://user:secret@alerts.example.com",
      "https://alerts.example.com:8443",
      "https://alerts.example.com/#fragment",
    ]) {
      expect(
        alertDestination({
          ALERT_WEBHOOK_URL: url,
          ALERT_WEBHOOK_HOSTS: "alerts.example.com",
        }),
      ).toBeNull();
    }
    expect(alertDestination()?.hostname).toBe("alerts.example.com");
  });
  it("blocks mixed public/private DNS before any connection", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(sendAlert({}, "delivery")).rejects.toMatchObject({
      code: "PRIVATE_ADDRESS_BLOCKED",
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("times out stalled DNS and never connects after a late lookup completes", async () => {
    vi.useFakeTimers();
    let completeLookup!: (rows: { address: string; family: number }[]) => void;
    mocks.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeLookup = resolve;
        }),
    );
    const result = sendAlert({}, "dns-timeout");
    const rejected = expect(result).rejects.toMatchObject({
      code: "DNS_FAILURE",
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(mocks.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    completeLookup([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the remaining total deadline for HTTPS after a slow lookup", async () => {
    vi.useFakeTimers();
    mocks.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([{ address: "8.8.8.8", family: 4 }]), 9_000);
        }),
    );
    mocks.request.mockImplementation((_url, options) => ({
      on: (_event: string, callback: (error: Error) => void) => {
        options.signal.addEventListener(
          "abort",
          () => callback(new Error("timeout")),
          { once: true },
        );
      },
      end: vi.fn(),
    }));
    const result = sendAlert({}, "shared-deadline");
    const rejected = expect(result).rejects.toMatchObject({
      code: "NETWORK_FAILURE",
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pins the vetted address, preserves TLS hostname verification and returns redirects without following them", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const destroy = vi.fn();
    mocks.request.mockImplementation((_url, options, callback) => {
      const pinned = vi.fn();
      options.lookup("alerts.example.com", {}, pinned);
      expect(pinned).toHaveBeenCalledWith(null, "8.8.8.8", 4);
      expect(options.servername).toBe("alerts.example.com");
      expect(options.rejectUnauthorized).not.toBe(false);
      expect(options.headers["Idempotency-Key"]).toBe("stable-delivery");
      return {
        on: vi.fn(),
        end: () =>
          callback({
            statusCode: 302,
            headers: { location: "http://127.0.0.1" },
            destroy,
          }),
      };
    });
    expect(
      await sendAlert({ text: "Synthetic alert" }, "stable-delivery"),
    ).toEqual({ status: 302 });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
