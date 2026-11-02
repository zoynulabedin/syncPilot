import { describe, expect, it } from "vitest";
import {
  assertPairingUsable,
  assertSafePreview,
  assertWriteGates,
  challengeHash,
  createChallenge,
  normalizeShop,
  validChallenge,
  validateGid,
} from "../app/domain/guards";
import {
  requireActor,
  requireOwner,
} from "../app/services/authorization.server";

describe("store and resource boundaries", () => {
  it("accepts only canonical Shopify domains and expected resource types", () => {
    expect(normalizeShop(" Store-A.myshopify.com ")).toBe(
      "store-a.myshopify.com",
    );
    for (const value of [
      "https://a.myshopify.com",
      "a.myshopify.com.evil.test",
      "localhost",
      "a.myshopify.com/path",
      "a.myshopify.com:443",
      "-a.myshopify.com",
    ])
      expect(() => normalizeShop(value)).toThrow();
    expect(() =>
      validateGid("gid://shopify/Product/123", "Product"),
    ).not.toThrow();
    expect(() =>
      validateGid("gid://shopify/ProductVariant/123", "Product"),
    ).toThrow();
  });
  it("stores high-entropy challenges as hashes with constant-time verification", () => {
    const challenge = createChallenge();
    expect(challenge.length).toBeGreaterThanOrEqual(40);
    expect(createChallenge()).not.toBe(challenge);
    expect(challengeHash(challenge)).not.toContain(challenge);
    expect(validChallenge(challenge, challengeHash(challenge))).toBe(true);
    expect(validChallenge("wrong", challengeHash(challenge))).toBe(false);
    expect(validChallenge(challenge, null)).toBe(false);
    expect(validChallenge(challenge, "invalid")).toBe(false);
  });
  it("rejects expired, locked and already-consumed requests", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const usable = {
      state: "PENDING",
      expiresAt: new Date(now.getTime() + 1000),
      attempts: 0,
    };
    expect(() => assertPairingUsable(usable, now)).not.toThrow();
    expect(() =>
      assertPairingUsable({ ...usable, expiresAt: now }, now),
    ).toThrow();
    expect(() =>
      assertPairingUsable({ ...usable, attempts: 5 }, now),
    ).toThrow();
    expect(() =>
      assertPairingUsable({ ...usable, state: "VERIFIED" }, now),
    ).toThrow();
  });
});
describe("owner authority and write switches", () => {
  it("does not promote staff or unknown sessions from a subject identity", () => {
    const owner = requireActor({
      session: {
        shop: "a.myshopify.com",
        onlineAccessInfo: { associated_user: { id: 123, account_owner: true } },
      },
    });
    expect(owner).toEqual({
      shop: "a.myshopify.com",
      userId: "123",
      role: "OWNER",
    });
    expect(() => requireOwner(owner)).not.toThrow();
    const staff = requireActor({
      session: {
        shop: "a.myshopify.com",
        onlineAccessInfo: {
          associated_user: { id: 456, account_owner: false },
        },
      },
    });
    expect(() => requireOwner(staff)).toThrow();
    expect(() =>
      requireOwner(requireActor({ session: { shop: "a.myshopify.com" } })),
    ).toThrow();
    expect(() =>
      requireOwner(
        requireActor({
          session: { shop: "a.myshopify.com", userId: 999, accountOwner: true },
        }),
      ),
    ).toThrow();
  });
  it("requires both explicit inventory and general write gates", () => {
    expect(() => assertWriteGates(false, {})).toThrow();
    expect(() =>
      assertWriteGates(false, { SYNC_WRITE_ENABLED: "TRUE" }),
    ).toThrow();
    expect(() =>
      assertWriteGates(false, { SYNC_WRITE_ENABLED: "true" }),
    ).not.toThrow();
    expect(() =>
      assertWriteGates(true, { SYNC_WRITE_ENABLED: "true" }),
    ).toThrow();
    expect(() =>
      assertWriteGates(true, {
        SYNC_WRITE_ENABLED: "true",
        INVENTORY_WRITE_ENABLED: "true",
      }),
    ).not.toThrow();
  });
  it("rejects held, malformed, empty and excessive previews", () => {
    for (const changes of [
      null,
      [],
      [{ kind: "HOLD", code: "MISSING_MAPPING" }],
      [null],
      [{ kind: "UNKNOWN" }],
      Array.from({ length: 1001 }, () => ({ kind: "PRODUCT" })),
    ])
      expect(() => assertSafePreview(changes)).toThrow();
    expect(() =>
      assertSafePreview([{ kind: "PRODUCT", before: "A", after: "B" }]),
    ).not.toThrow();
  });
});
