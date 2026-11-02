export type MaintenanceStage =
  "RECONCILIATION" | "AUTOMATIC_SYNC" | "PRIVACY" | "RETENTION" | "ALERT_SCHEDULING";

type MaintenanceTask = {
  stage: MaintenanceStage;
  run: () => Promise<unknown>;
};

/** Optional housekeeping failures must not prevent durable jobs from running. */
export function createWorkerCycle<T>({
  maintenance,
  runJob,
  deliverAlert,
  onMaintenanceFailure,
  now = Date.now,
}: {
  maintenance: readonly MaintenanceTask[];
  runJob: () => Promise<T>;
  deliverAlert: () => Promise<unknown>;
  onMaintenanceFailure: (stage: MaintenanceStage | "ALERT_DELIVERY") => void;
  now?: () => number;
}) {
  const tasks = maintenance.map((task) => ({ ...task, nextRun: 0 }));
  return async () => {
    for (const task of tasks) {
      if (now() < task.nextRun) continue;
      // Advance before execution, including failed attempts, to avoid a retry loop
      // which monopolizes the worker whenever one maintenance dependency fails.
      task.nextRun = now() + 60_000;
      try {
        await task.run();
      } catch {
        onMaintenanceFailure(task.stage);
      }
    }
    // Queue failures still propagate to the worker's existing recovery backoff.
    const result = await runJob();
    try {
      await deliverAlert();
    } catch {
      onMaintenanceFailure("ALERT_DELIVERY");
    }
    return result;
  };
}
