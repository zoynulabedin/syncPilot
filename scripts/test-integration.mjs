import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL)
  throw new Error(
    "Set DATABASE_URL to a local PostgreSQL administrator database",
  );
const base = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "postgres"].includes(base.hostname))
  throw new Error("Integration runner requires a local database");
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
};
let code = 1;
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  const migrate = spawnSync("npm", ["exec", "prisma", "migrate", "deploy"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (migrate.status !== 0)
    throw new Error(
      "Disposable database migration failed; no application database was modified",
    );
  console.log("Fresh PostgreSQL migration: PASS");
  const test = spawnSync(
    "npm",
    ["exec", "vitest", "run", "tests/integration"],
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
