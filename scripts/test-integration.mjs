import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL)
  throw new Error(
    "Set DATABASE_URL to a local PostgreSQL administrator database",
  );
const mode = process.argv[2];
if (mode && !["--http", "--backup"].includes(mode))
  throw new Error("Supported modes: --http, --backup");
const base = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "postgres"].includes(base.hostname))
  throw new Error("Integration runner requires a local database");
// Windows only runs npm.cmd through a shell; every npm argument below is a fixed literal.
function npmExec(args, options) {
  return process.platform === "win32"
    ? spawnSync(["npm", "exec", ...args].join(" "), { ...options, shell: true })
    : spawnSync("npm", ["exec", ...args], options);
}
const database = `syncpilot_test_${randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(base);
testUrl.pathname = `/${database}`;
const admin = new PrismaClient();
const env = {
  ...process.env,
  DATABASE_URL: testUrl.toString(),
  TEST_DATABASE_URL: testUrl.toString(),
  SYNC_WRITE_ENABLED: "false",
  INVENTORY_WRITE_ENABLED: "false",
  SESSION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
};
let code = 1;
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  const migrate = npmExec(["prisma", "migrate", "deploy"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (migrate.status !== 0)
    throw new Error(
      "Disposable database migration failed; no application database was modified",
    );
  console.log("Fresh PostgreSQL migration: PASS");
  const parity = npmExec(
    [
      "--",
      "prisma",
      "migrate",
      "diff",
      "--from-schema-datasource",
      "prisma/schema.prisma",
      "--to-schema-datamodel",
      "prisma/schema.prisma",
      "--exit-code",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (parity.status !== 0) {
    console.error(parity.stdout.toString());
    throw new Error("Prisma schema and fresh migrations differ");
  }
  console.log("Prisma schema/migration parity: PASS");
  const test =
    mode === "--backup"
      ? spawnSync(
          process.execPath,
          ["--import", "tsx", "scripts/verify-backup-restore.ts"],
          { env, stdio: "inherit" },
        )
      : npmExec(
          mode === "--http"
            ? ["playwright", "test"]
            : ["vitest", "run", "tests/integration"],
          { env, stdio: "inherit" },
        );
  code = test.status ?? 1;
} finally {
  // Name is generated here and cannot select the configured application database.
  await admin.$executeRawUnsafe(
    `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
  );
  await admin.$disconnect();
}
process.exitCode = code;
