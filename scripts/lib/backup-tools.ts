import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  backupKey,
  decryptBackup,
  encryptBackup,
} from "../../app/services/backup-crypto.server";
import { decryptToken } from "../../app/services/token-crypto.server";

function databaseUrl() {
  const url = new URL(process.env.DATABASE_URL || "");
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("PostgreSQL configuration required");
  return url;
}
function pgEnvironment(url: URL) {
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get("sslmode") || "prefer",
  };
}
function pgCommand(command: string, args: string[], url: URL) {
  const child = spawn(command, args, {
    env: pgEnvironment(url),
    stdio: ["ignore", "pipe", "ignore"],
  });
  const completed = new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
  return { child, completed };
}

export async function createEncryptedBackup(output: string) {
  const key = backupKey();
  const { child, completed } = pgCommand(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-privileges"],
    databaseUrl(),
  );
  let created = false;
  try {
    await encryptBackup(child.stdout!, output, key);
    created = true;
    if (await completed) throw new Error("Database backup failed");
  } catch {
    child.kill();
    await completed;
    if (created) await unlink(output).catch(() => undefined);
    throw new Error(
      "Encrypted backup failed; verify PostgreSQL client/configuration and output permissions",
    );
  }
}

export async function restoreEncryptedDrill(input: string) {
  const base = databaseUrl();
  if (!["localhost", "127.0.0.1", "postgres"].includes(base.hostname))
    throw new Error(
      "Restore drills require an isolated local PostgreSQL server",
    );
  if (!process.env.SESSION_ENCRYPTION_KEY)
    throw new Error(
      "The separately stored session encryption key is required for restore verification",
    );
  const name = `syncpilot_restore_test_${randomUUID().replaceAll("-", "")}`;
  const restoredUrl = new URL(base);
  restoredUrl.pathname = `/${name}`;
  const directory = await mkdtemp(join(tmpdir(), "syncpilot-restore-"));
  const dump = join(directory, "authenticated.dump");
  const admin = new PrismaClient({ datasourceUrl: base.toString() });
  const restored = new PrismaClient({ datasourceUrl: restoredUrl.toString() });
  let created = false;
  try {
    await decryptBackup(input, dump, backupKey());
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const { completed } = pgCommand(
      "pg_restore",
      [
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        `--dbname=${name}`,
        dump,
      ],
      restoredUrl,
    );
    if (await completed) throw new Error("Isolated restore failed");
    const migrations = await restored.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    let sessions = 0,
      after: string | undefined;
    for (;;) {
      const rows = await restored.session.findMany({
        where: after ? { id: { gt: after } } : {},
        orderBy: { id: "asc" },
        take: 100,
      });
      if (!rows.length) break;
      for (const row of rows) {
        if (
          !row.accessToken.startsWith("enc:v1:") ||
          (row.refreshToken && !row.refreshToken.startsWith("enc:v1:"))
        )
          throw new Error(
            "Restored sessions contain legacy plaintext credentials",
          );
        decryptToken(row.accessToken, `${row.shop}:${row.id}:access`);
        if (row.refreshToken)
          decryptToken(row.refreshToken, `${row.shop}:${row.id}:refresh`);
        sessions++;
      }
      after = rows.at(-1)!.id;
    }
    return {
      migrations: Number(migrations[0].count),
      encryptedSessionsVerified: sessions,
    };
  } finally {
    try {
      await restored.$disconnect();
      if (created)
        await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      try {
        await admin.$disconnect();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
