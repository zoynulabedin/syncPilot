import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const PREFIX = "enc:v1:";

function key(): Buffer | undefined {
  const encoded = process.env.SESSION_ENCRYPTION_KEY;
  if (!encoded) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_ENCRYPTION_KEY is required in production");
    }
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32)
    throw new Error("SESSION_ENCRYPTION_KEY must encode 32 bytes");
  return decoded;
}

export function validateTokenEncryption(): void {
  key();
}

/**
 * Signs what a browser holds about its sign-ins. It belongs to this server rather
 * than to one Shopify app, so several apps on one server can share it, and it is
 * derived so that nothing it signs can help anyone open a stored token. Production
 * always has one, as `key` above refuses to run there without the key behind it.
 */
export function cookieSigningKey(): string | undefined {
  const secret = key();
  return secret
    ? createHmac("sha256", secret)
        .update("syncpilot/sign-in-cookies/v1")
        .digest("base64url")
    : undefined;
}

export function encryptToken(
  value: string | undefined,
  context: string,
): string | undefined {
  if (!value) return value;
  const secret = key();
  if (!secret) return value;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return (
    PREFIX +
    Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url")
  );
}

export function decryptToken(
  value: string | undefined,
  context: string,
): string | undefined {
  if (!value) return value;
  const secret = key();
  if (!value.startsWith(PREFIX)) return value; // Legacy sessions are encrypted on their next save.
  if (!secret)
    throw new Error(
      "SESSION_ENCRYPTION_KEY is required to load encrypted sessions",
    );
  const data = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (data.length < 29) throw new Error("Invalid encrypted session");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    secret,
    data.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([
    decipher.update(data.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
