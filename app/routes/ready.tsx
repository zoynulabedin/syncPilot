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
    if (process.env.REDIS_URL) {
      const { default: Redis } = await import("ioredis");
      const redis = new Redis(process.env.REDIS_URL, {
        connectTimeout: 1500,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      redis.on("error", () => undefined);
      try {
        await redis.connect();
        await redis.ping();
      } finally {
        redis.disconnect();
      }
    }
    return Response.json(
      { status: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return unavailable();
  }
}
