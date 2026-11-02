import { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import type { PrismaClient } from "@prisma/client";
import {
  decryptToken,
  encryptToken,
  validateTokenEncryption,
} from "./token-crypto.server";

export class EncryptedSessionStorage extends PrismaSessionStorage<PrismaClient> {
  constructor(client: PrismaClient) {
    validateTokenEncryption();
    super(client);
  }
  async storeSession(session: Session): Promise<boolean> {
    const encrypted = new Session(session.toObject());
    encrypted.accessToken = encryptToken(
      session.accessToken,
      `${session.shop}:${session.id}:access`,
    );
    encrypted.refreshToken = encryptToken(
      session.refreshToken,
      `${session.shop}:${session.id}:refresh`,
    );
    return super.storeSession(encrypted);
  }

  private decrypt(session: Session): Session {
    session.accessToken = decryptToken(
      session.accessToken,
      `${session.shop}:${session.id}:access`,
    );
    session.refreshToken = decryptToken(
      session.refreshToken,
      `${session.shop}:${session.id}:refresh`,
    );
    return session;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await super.loadSession(id);
    return session ? this.decrypt(session) : undefined;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return (await super.findSessionsByShop(shop)).map((session) =>
      this.decrypt(session),
    );
  }
}
