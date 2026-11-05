import prisma from "../db.server";
import {
  databaseClockRemedy,
  readDatabaseClock,
} from "../services/database-clock.server";
import { logger } from "../services/logger.server";

const CLOCK_WARNING_INTERVAL_MS = 60_000;
let lastClockWarning = Number.NEGATIVE_INFINITY;

function unavailable() {
  return Response.json(
    { status: "unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function loader() {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "_prisma_migrations" LIMIT 1`;
    const clock = await readDatabaseClock();
    if (!clock.utc) {
      // Probes repeat every few seconds; one actionable line a minute is enough.
      if (Date.now() - lastClockWarning >= CLOCK_WARNING_INTERVAL_MS) {
        lastClockWarning = Date.now();
        logger.error(
          { code: "DATABASE_TIME_ZONE_NOT_UTC", timeZone: clock.timeZone },
          databaseClockRemedy(clock),
        );
      }
      return unavailable();
    }
    // PostgreSQL is the queue. Nothing reads Redis, so its outage must not take
    // the process that receives webhooks out of the proxy's rotation.
    return Response.json(
      { status: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return unavailable();
  }
}
