import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createEncryptedBackup } from "./lib/backup-tools";

try {
  await mkdir("backups", { recursive: true, mode: 0o700 });
  const path = resolve(
    process.argv[2] || `backups/syncpilot-${Date.now()}-${randomUUID()}.spbk`,
  );
  await createEncryptedBackup(path);
  console.log(`Encrypted backup created: ${path}`);
} catch {
  console.error(
    "Encrypted backup failed. Check the backup key, PostgreSQL tools, connection and output permissions. Credentials were not logged.",
  );
  process.exitCode = 1;
}
