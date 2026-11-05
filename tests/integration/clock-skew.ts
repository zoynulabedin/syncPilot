import { vi } from "vitest";
import prisma from "../../app/db.server";

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
 * Moves this process's clock and nothing else, as separate machines would:
 * PostgreSQL keeps the real time, and so does whatever it stamps for itself.
 */
export function skewProcessClock(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms });
}
export const restoreProcessClock = () => vi.useRealTimers();

/** The database's own reading, in the precision its columns store. */
export async function databaseTime() {
  const [row] = await prisma.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp()::timestamp(3) AS "now"`;
  return row.now;
}
/** A time this far from the database's clock, whatever this process believes. */
export const fromDatabase = async (ms: number) =>
  new Date((await databaseTime()).getTime() + ms);
/** How long is left of a stored window, read on the database's clock. */
export const remaining = async (until: Date | null | undefined) =>
  (until?.getTime() ?? Number.NaN) - (await databaseTime()).getTime();
