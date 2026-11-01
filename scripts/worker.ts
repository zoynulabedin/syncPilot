import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import { logger } from "../app/services/logger.server";
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
let lastScheduled = 0;
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
      if (Date.now() - lastScheduled > 60_000) {
        await scheduleReconciliations();
        lastScheduled = Date.now();
      }
      const result = await runWorkerOnce(workerId);
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
