import { describe, expect, it, vi } from "vitest";
import { createWorkerCycle } from "../scripts/lib/worker-cycle";

describe("worker maintenance isolation", () => {
  it("keeps processing jobs and other maintenance after a persistent housekeeping failure, with bounded retry cadence", async () => {
    let now = 0;
    const broken = vi.fn(async () => {
      throw new Error("sensitive dependency details");
    });
    const healthy = vi.fn(async () => undefined);
    const runJob = vi.fn(async () => ({ processed: true }));
    const deliverAlert = vi.fn(async () => undefined);
    const onMaintenanceFailure = vi.fn();
    const cycle = createWorkerCycle({
      maintenance: [
        { stage: "PRIVACY", run: broken },
        { stage: "RETENTION", run: healthy },
      ],
      runJob,
      deliverAlert,
      onMaintenanceFailure,
      now: () => now,
    });

    await expect(cycle()).resolves.toEqual({ processed: true });
    now = 5_000;
    await cycle();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(deliverAlert).toHaveBeenCalledTimes(2);
    expect(onMaintenanceFailure.mock.calls).toEqual([["PRIVACY"]]);

    now = 60_000;
    await cycle();
    expect(broken).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(runJob).toHaveBeenCalledTimes(3);
  });

  it("isolates alert outbox failures from successful queue work", async () => {
    const runJob = vi.fn(async () => ({ processed: false }));
    const onMaintenanceFailure = vi.fn();
    const cycle = createWorkerCycle({
      maintenance: [],
      runJob,
      deliverAlert: async () => {
        throw new Error("secret receiver data");
      },
      onMaintenanceFailure,
    });
    await expect(cycle()).resolves.toEqual({ processed: false });
    await expect(cycle()).resolves.toEqual({ processed: false });
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(onMaintenanceFailure.mock.calls).toEqual([
      ["ALERT_DELIVERY"],
      ["ALERT_DELIVERY"],
    ]);
  });

  it("preserves queue dependency failures for the worker recovery backoff", async () => {
    const error = new Error("queue unavailable");
    const deliverAlert = vi.fn();
    const onMaintenanceFailure = vi.fn();
    const cycle = createWorkerCycle({
      maintenance: [],
      runJob: async () => {
        throw error;
      },
      deliverAlert,
      onMaintenanceFailure,
    });
    await expect(cycle()).rejects.toBe(error);
    expect(deliverAlert).not.toHaveBeenCalled();
    expect(onMaintenanceFailure).not.toHaveBeenCalled();
  });
});
