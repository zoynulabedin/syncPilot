import { randomUUID } from "node:crypto";
import { createWorkerCycle } from "./lib/worker-cycle";
import prisma from "../app/db.server";
import { logger } from "../app/services/logger.server";
import { scheduleAutomaticSync } from "../app/services/automatic-sync.server";
import { cleanHistory } from "../app/services/retention.server";
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
try {
  while (!stopping) {
    try {
      const result = await runCycle();
      if (!result.processed) await pause(1000);
    } catch {
      logger.error(
        { workerId, code: "WORKER_DEPENDENCY_FAILURE" },
        "Worker dependency unavailable; persisted jobs will be recovered",
      );
      await pause(5000);
    }
  }
} finally {
  await prisma.workerHeartbeat
    .updateMany({
      where: { id: workerId },
      data: { status: "STOPPED", seenAt: new Date() },
    })
    .catch(() => undefined);
  await prisma.$disconnect();
  logger.info({ workerId }, "SyncPilot worker stopped");
}
