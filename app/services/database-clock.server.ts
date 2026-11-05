import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../db.server";

type Database = Pick<PrismaClient | Prisma.TransactionClient, "$queryRaw">;

/**
 * Prisma stores DateTime values as UTC wall-clock time in TIMESTAMP(3) columns,
 * while raw SQL compares those columns with NOW() and timestamptz parameters.
 * PostgreSQL converts between the two with the session TimeZone, so leases,
 * schedules and expiries are only correct when that zone is UTC. Zones are
 * matched by name: an offset check would accept Europe/London in winter only.
 */
export const UTC_TIME_ZONE_NAMES: readonly string[] = [
  "UTC",
  "Etc/UTC",
  "UCT",
  "Etc/UCT",
  "Universal",
  "Etc/Universal",
  "Zulu",
  "Etc/Zulu",
  "GMT",
  "Etc/GMT",
  "GMT0",
  "Etc/GMT0",
  "GMT+0",
  "Etc/GMT+0",
  "GMT-0",
  "Etc/GMT-0",
  "Greenwich",
  "Etc/Greenwich",
];
const utcNames: ReadonlySet<string> = new Set(
  UTC_TIME_ZONE_NAMES.map((name) => name.toLowerCase()),
);

export type DatabaseClock = {
  database: string;
  timeZone: string;
  utc: boolean;
};

export function isUtcTimeZone(name: string) {
  return utcNames.has(name.trim().toLowerCase());
}

/**
 * The one clock every process shares. The web process, the workers and a hosted
 * database are different machines whose clocks can differ by any amount, either
 * way, so a time another process will compare, or one compared with a stored
 * time, comes from here. The cast gives what the columns store, rounded as they
 * round, so this never reads earlier than a now() default written before it.
 */
export async function databaseNow(db: Database = prisma) {
  const [row] = await db.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp()::timestamp(3) AS "now"`;
  if (!row) throw new Error("The database clock is unavailable");
  return row.now;
}

/** Reads the zone of the pooled session; every pooled session shares its defaults. */
export async function readDatabaseClock(
  db: Database = prisma,
): Promise<DatabaseClock> {
  const [row] = await db.$queryRaw<
    Array<{ database: string; timeZone: string }>
  >`SELECT current_database() AS "database", current_setting('TimeZone') AS "timeZone"`;
  if (!row) throw new Error("Database session settings are unavailable");
  return { ...row, utc: isUtcTimeZone(row.timeZone) };
}

/** Operator log text only; it names the database, so never return it to a client. */
export function databaseClockRemedy({
  database,
  timeZone,
}: Pick<DatabaseClock, "database" | "timeZone">) {
  const identifier = `"${database.replaceAll('"', '""')}"`;
  return (
    `PostgreSQL session TimeZone is '${timeZone}', not UTC; SyncPilot leases, ` +
    `schedules and expiries would be computed incorrectly. Run ALTER DATABASE ` +
    `${identifier} SET timezone TO 'UTC' (or set timezone = 'UTC' in ` +
    `postgresql.conf and reload, and remove any ALTER ROLE ... SET timezone ` +
    `override), then restart the web and worker processes.`
  );
}
