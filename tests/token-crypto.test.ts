import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptToken,
  encryptToken,
} from "../app/services/token-crypto.server";

afterEach(() => vi.unstubAllEnvs());
describe("session token encryption", () => {
  it("authenticates the session context and detects tampering", () => {
    vi.stubEnv(
      "SESSION_ENCRYPTION_KEY",
      Buffer.alloc(32, 17).toString("base64"),
    );
    const encrypted = encryptToken(
      "synthetic-token",
      "store-a:session-a:access",
    )!;
    expect(encrypted).not.toContain("synthetic-token");
    expect(decryptToken(encrypted, "store-a:session-a:access")).toBe(
      "synthetic-token",
    );
    expect(() => decryptToken(encrypted, "store-b:session-b:access")).toThrow();
    const damaged = encrypted.slice(0, -6) + "AAAAAA";
    expect(() => decryptToken(damaged, "store-a:session-a:access")).toThrow();
  });
  it("fails closed in production when encryption configuration is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_ENCRYPTION_KEY", "");
    expect(() => encryptToken("token", "context")).toThrow(
      "required in production",
    );
  });
  it("preserves missing tokens and can read legacy sessions during migration", () => {
    vi.stubEnv(
      "SESSION_ENCRYPTION_KEY",
      Buffer.alloc(32, 17).toString("base64"),
    );
    expect(encryptToken(undefined, "context")).toBeUndefined();
    expect(decryptToken("legacy-token", "context")).toBe("legacy-token");
    expect(encryptToken("same", "context")).not.toBe(
      encryptToken("same", "context"),
    );
  });
});
