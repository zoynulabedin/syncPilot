import "@shopify/shopify-api/adapters/node";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "@shopify/shopify-api";
import prisma from "../../app/db.server";
import { EncryptedSessionStorage } from "../../app/services/session-storage.server";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("encrypted PostgreSQL session storage", () => {
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await prisma.$disconnect();
  });
  it("round-trips online authority and offline refresh data without storing bearer tokens in plaintext", async () => {
    vi.stubEnv(
      "SESSION_ENCRYPTION_KEY",
      Buffer.alloc(32, 25).toString("base64"),
    );
    const storage = new EncryptedSessionStorage(prisma);
    const session = new Session({
      id: "encrypted-test-online",
      shop: "crypto-test.myshopify.com",
      state: "test",
      isOnline: true,
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expires: new Date(Date.now() + 3600000),
      refreshTokenExpires: new Date(Date.now() + 86400000),
      onlineAccessInfo: {
        expires_in: 3600,
        associated_user_scope: "read_products",
        associated_user: {
          id: 101,
          first_name: "Test",
          last_name: "Owner",
          email: "fixture@example.invalid",
          email_verified: true,
          account_owner: true,
          locale: "en",
          collaborator: false,
        },
      },
    });
    await storage.storeSession(session);
    expect(session.accessToken).toBe("synthetic-access");
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.accessToken).toMatch(/^enc:v1:/);
    expect(row.refreshToken).toMatch(/^enc:v1:/);
    const loaded = await storage.loadSession(session.id);
    expect(loaded?.accessToken).toBe("synthetic-access");
    expect(loaded?.refreshToken).toBe("synthetic-refresh");
    expect(loaded?.onlineAccessInfo?.associated_user.account_owner).toBe(true);
    expect(
      (await storage.findSessionsByShop(session.shop))[0].accessToken,
    ).toBe("synthetic-access");
    await prisma.session.update({
      where: { id: session.id },
      data: { shop: "different-test.myshopify.com" },
    });
    await expect(storage.loadSession(session.id)).rejects.toThrow();
    await storage.deleteSession(session.id);
  });
});
