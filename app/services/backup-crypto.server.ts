import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, link, open, stat, unlink } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const magic = Buffer.from("SYNCBKP1");
export function backupKey(encoded = process.env.BACKUP_ENCRYPTION_KEY) {
  const key = Buffer.from(encoded || "", "base64");
  if (key.length !== 32)
    throw new Error("BACKUP_ENCRYPTION_KEY must encode 32 bytes");
  return key;
}

/** Stream the dump straight into authenticated ciphertext; never write an unencrypted backup. */
export async function encryptBackup(
  input: Readable,
  output: string,
  key: Buffer,
) {
  if (key.length !== 32) throw new Error("Invalid backup key");
  const partial = `${output}.partial-${randomUUID()}`;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(magic);
  try {
    const writer = createWriteStream(partial, { flags: "wx", mode: 0o600 });
    writer.write(Buffer.concat([magic, nonce]));
    await pipeline(input, cipher, writer);
    await appendFile(partial, cipher.getAuthTag());
    await link(partial, output); // Fails rather than replacing an existing backup.
  } finally {
    await unlink(partial).catch(() => undefined);
  }
}

/** Authenticate the entire file before making a plaintext dump available for a disposable restore. */
export async function decryptBackup(
  input: string,
  output: string,
  key: Buffer,
) {
  if (key.length !== 32) throw new Error("Invalid backup key");
  const partial = `${output}.partial-${randomUUID()}`;
  const file = await open(input, "r");
  try {
    const size = (await stat(input)).size;
    if (size <= magic.length + 12 + 16)
      throw new Error("Invalid encrypted backup");
    const header = Buffer.alloc(magic.length + 12),
      tag = Buffer.alloc(16);
    await file.read(header, 0, header.length, 0);
    await file.read(tag, 0, tag.length, size - tag.length);
    if (!header.subarray(0, magic.length).equals(magic))
      throw new Error("Unknown encrypted backup format");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      header.subarray(magic.length),
    );
    decipher.setAAD(magic);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(input, {
        start: header.length,
        end: size - tag.length - 1,
      }),
      decipher,
      createWriteStream(partial, { flags: "wx", mode: 0o600 }),
    );
    await link(partial, output);
  } finally {
    await file.close();
    await unlink(partial).catch(() => undefined);
  }
}
