import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prisma from "../app/db.server";
import { encryptToken } from "../app/services/token-crypto.server";
import {
  createEncryptedBackup,
  restoreEncryptedDrill,
} from "./lib/backup-tools";

const url = new URL(process.env.TEST_DATABASE_URL || "");
if (
  url.toString() !== process.env.DATABASE_URL ||
  !["localhost", "127.0.0.1", "postgres"].includes(url.hostname) ||
  !/^\/syncpilot_test_[a-f0-9]+$/.test(url.pathname)
)
  throw new Error("Use npm run test:backup with a disposable local database");
const directory = await mkdtemp(join(tmpdir(), "syncpilot-backup-check-"));
const sessionKey = process.env.SESSION_ENCRYPTION_KEY;
try {
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const shop = "synthetic-restore.myshopify.com",
    id = `offline_${shop}`;
  await prisma.session.create({
    data: {
      id,
      shop,
      state: "synthetic",
      accessToken: encryptToken(
        "synthetic-access-token",
        `${shop}:${id}:access`,
      )!,
      refreshToken: encryptToken(
        "synthetic-refresh-token",
        `${shop}:${id}:refresh`,
      ),
    },
  });
  const path = join(directory, "synthetic.spbk");
  await createEncryptedBackup(path);
  const result = await restoreEncryptedDrill(path);
  if (!result.migrations || result.encryptedSessionsVerified !== 1)
    throw new Error("Restore verification incomplete");
  process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  let wrongKeyRejected = false;
  try {
    await restoreEncryptedDrill(path);
  } catch {
    wrongKeyRejected = true;
  }
  if (!wrongKeyRejected) throw new Error("Wrong session key was accepted");
  console.log(
    JSON.stringify({
      status: "PASS",
      ...result,
      wrongSessionKeyRejected: true,
      applicationDatabaseModified: false,
    }),
  );
} finally {
  if (sessionKey === undefined) delete process.env.SESSION_ENCRYPTION_KEY;
  else process.env.SESSION_ENCRYPTION_KEY = sessionKey;
  await prisma.$disconnect();
  await rm(directory, { recursive: true, force: true });
}
