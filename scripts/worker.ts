import { randomUUID } from "node:crypto";
import { createWorkerCycle } from "./lib/worker-cycle";
import prisma from "../app/db.server";
import { logger } from "../app/services/logger.server";
import {
  databaseClockRemedy,
  databaseNow,
  readDatabaseClock,
} from "../app/services/database-clock.server";
import { scheduleAutomaticSync } from "../app/services/automatic-sync.server";
import {
  cleanHistory,
  cleanLapsedSignIns,
} from "../app/services/retention.server";
import { cleanExpiredRateLimits } from "../app/services/rate-limit.server";
import { processPrivacyRequests } from "../app/services/privacy.server";
import {
  scheduleNotifications,
  deliverNotification,
} from "../app/services/notifications.server";
import {
  runWorkerOnce,
  scheduleReconciliations,
} from "../app/services/sync-engine.server";

const workerId = `worker:${randomUUID()}`;
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const runCycle = createWorkerCycle({
  maintenance: [
    { stage: "RECONCILIATION", run: scheduleReconciliations },
    { stage: "AUTOMATIC_SYNC", run: scheduleAutomaticSync },
    { stage: "PRIVACY", run: processPrivacyRequests },
    { stage: "RETENTION", run: cleanHistory },
    { stage: "SIGN_IN_CLEANUP", run: cleanLapsedSignIns },
    { stage: "RATE_LIMIT_CLEANUP", run: () => cleanExpiredRateLimits() },
    { stage: "ALERT_SCHEDULING", run: scheduleNotifications },
  ],
  runJob: () => runWorkerOnce(workerId),
  deliverAlert: deliverNotification,
  onMaintenanceFailure: (stage) => {
    logger.error(
      { workerId, code: "WORKER_MAINTENANCE_FAILURE", stage },
      "Worker maintenance failed; job processing will continue",
    );
  },
});
logger.info(
  {
    workerId,
    writesEnabled: process.env.SYNC_WRITE_ENABLED === "true",
    inventoryWritesEnabled: process.env.INVENTORY_WRITE_ENABLED === "true",
  },
  "SyncPilot worker starting",
);
const dependencyUnavailable = () =>
  logger.error(
    { workerId, code: "WORKER_DEPENDENCY_FAILURE" },
    "Worker dependency unavailable; persisted jobs will be recovered",
  );
/** Waits out an unreachable database; undefined only when stopped first. */
async function waitForDatabaseClock() {
  while (!stopping) {
    try {
      return await readDatabaseClock();
    } catch {
      dependencyUnavailable();
      await pause(5000);
    }
  }
}
try {
  // Raw SQL leases and schedules compare timestamps in the session zone, so no
  // maintenance or job may run until that zone is known to be UTC.
  const clock = await waitForDatabaseClock();
  if (clock && !clock.utc) {
    logger.fatal(
      {
        workerId,
        code: "DATABASE_TIME_ZONE_NOT_UTC",
        timeZone: clock.timeZone,
      },
      databaseClockRemedy(clock),
    );
    process.exitCode = 1;
    stopping = true;
  }
  while (!stopping) {
    try {
      const result = await runCycle();
      if (!result.processed) await pause(1000);
    } catch {
      dependencyUnavailable();
      await pause(5000);
    }
  }
} finally {
  await databaseNow()
    .then((seenAt) =>
      prisma.workerHeartbeat.updateMany({
        where: { id: workerId },
        data: { status: "STOPPED", seenAt },
      }),
    )
    .catch(() => undefined);
  await prisma.$disconnect();
  logger.info({ workerId }, "SyncPilot worker stopped");
}
