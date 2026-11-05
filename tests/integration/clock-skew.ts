import { afterAll, beforeAll, vi } from "vitest";
import prisma from "../../app/db.server";
import { readDatabaseClock } from "../../app/services/database-clock.server";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Both ways a web or worker machine can disagree with the hosted database. */
export const SKEWS = [
  ["ahead of", 1],
  ["behind", -1],
] as const;

/**
 * Moves JavaScript's Date in this process and nothing else, which shows what time
 * a service chooses to read. Prisma's engine keeps the operating system's clock, so
 * what it stamps for @default(now()) and @updatedAt does not move, as it would on a
 * machine that really was skewed. withMachineClockSkewed covers those stamps.
 */
export function skewProcessClock(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms });
}
export const restoreProcessClock = () => vi.useRealTimers();

/**
 * Really moves this disposable database's clock for the enclosing describe, so this
 * machine, Node and Prisma's engine alike, reads `ms` ahead of PostgreSQL and of all
 * it stamps. A hosted database is the same picture. Function bodies live in each
 * database, so no other database sees this. CURRENT_TIMESTAMP does not move; only
 * the rate limiter uses it, and only against itself.
 */
export function withMachineClockSkewed(ms: number) {
  const run = async (statements: string[]) => {
    const { database } = await readDatabaseClock();
    if (!/^syncpilot_test_[a-f0-9]+$/.test(database))
      throw new Error("Only a disposable test database's clock may be moved");
    for (const statement of statements)
      await prisma.$executeRawUnsafe(statement);
    // PostgreSQL does not replan a statement for a change to a built-in function,
    // and a session's prepared statements would keep the clock they were planned with.
    await prisma.$disconnect();
  };
  const internal = (name: string, volatility: string) =>
    `CREATE OR REPLACE FUNCTION pg_catalog.${name}() RETURNS timestamptz LANGUAGE internal ${volatility} AS '${name}'`;
  const moved = (name: string, volatility: string) =>
    `CREATE OR REPLACE FUNCTION pg_catalog.${name}() RETURNS timestamptz LANGUAGE sql ${volatility} AS $$SELECT pg_catalog.machine_${name}() - interval '${ms} milliseconds'$$`;
  const machine = (name: string, volatility: string) =>
    `CREATE OR REPLACE FUNCTION pg_catalog.machine_${name}() RETURNS timestamptz LANGUAGE internal ${volatility} AS '${name}'`;
  beforeAll(() =>
    run([
      machine("clock_timestamp", "VOLATILE"),
      machine("now", "STABLE"),
      moved("clock_timestamp", "VOLATILE"),
      moved("now", "STABLE"),
    ]),
  );
  afterAll(() =>
    run([
      internal("clock_timestamp", "VOLATILE"),
      internal("now", "STABLE"),
      "DROP FUNCTION pg_catalog.machine_clock_timestamp()",
      "DROP FUNCTION pg_catalog.machine_now()",
    ]),
  );
}

/** The database's own reading, in the precision its columns store. */
export async function databaseTime() {
  const [row] = await prisma.$queryRaw<{ now: Date }[]>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"`;
  return row.now;
}
/** A time this far from the database's clock, whatever this process believes. */
export const fromDatabase = async (ms: number) =>
  new Date((await databaseTime()).getTime() + ms);
/** How long is left of a stored window, read on the database's clock. */
export const remaining = async (until: Date | null | undefined) =>
  (until?.getTime() ?? Number.NaN) - (await databaseTime()).getTime();
