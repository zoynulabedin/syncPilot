import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupKey,
  decryptBackup,
  encryptBackup,
} from "../app/services/backup-crypto.server";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "syncpilot-crypto-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
describe("authenticated backup files", () => {
  it("round trips a streamed binary dump with private permissions and never stores plaintext ciphertext", async () => {
    const key = randomBytes(32),
      input = randomBytes(1024 * 1024);
    const encrypted = join(directory, "backup.spbk"),
      restored = join(directory, "restored.dump");
    await encryptBackup(
      Readable.from([input.subarray(0, 4096), input.subarray(4096)]),
      encrypted,
      key,
    );
    // Windows has no POSIX mode bits; backups run on Linux operator hosts.
    if (process.platform !== "win32")
      expect((await stat(encrypted)).mode & 0o777).toBe(0o600);
    expect((await readFile(encrypted)).equals(input)).toBe(false);
    await decryptBackup(encrypted, restored, key);
    expect((await readFile(restored)).equals(input)).toBe(true);
  });
  it("rejects wrong keys and tampering before exposing a restorable dump, removing partial plaintext", async () => {
    const key = randomBytes(32),
      encrypted = join(directory, "backup.spbk"),
      restored = join(directory, "restored.dump");
    await encryptBackup(
      Readable.from([Buffer.from("synthetic database dump")]),
      encrypted,
      key,
    );
    await expect(
      decryptBackup(encrypted, restored, randomBytes(32)),
    ).rejects.toThrow();
    const bytes = await readFile(encrypted);
    bytes[25] ^= 1;
    await writeFile(encrypted, bytes);
    await expect(decryptBackup(encrypted, restored, key)).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["backup.spbk"]);
  });
  it("never overwrites an existing backup or restore target", async () => {
    const key = randomBytes(32),
      encrypted = join(directory, "backup.spbk"),
      restored = join(directory, "restored.dump");
    await encryptBackup(
      Readable.from([Buffer.from("first backup")]),
      encrypted,
      key,
    );
    const first = await readFile(encrypted);
    await expect(
      encryptBackup(
        Readable.from([Buffer.from("second backup")]),
        encrypted,
        key,
      ),
    ).rejects.toThrow();
    expect((await readFile(encrypted)).equals(first)).toBe(true);
    await writeFile(restored, "keep existing file");
    await expect(decryptBackup(encrypted, restored, key)).rejects.toThrow();
    expect(await readFile(restored, "utf8")).toBe("keep existing file");
  });
  it("rejects invalid backup key lengths", () => {
    expect(() => backupKey("short")).toThrow("32 bytes");
  });
});
