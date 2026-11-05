import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import prisma from "../../app/db.server";
import {
  deliverNotification,
  evaluateAlerts,
  operationalCounts,
  scheduleNotifications,
} from "../../app/services/notifications.server";
import {
  HOUR,
  MINUTE,
  SECOND,
  SKEWS,
  fromDatabase,
  remaining,
  restoreProcessClock,
  skewProcessClock,
} from "./clock-skew";

async function fixture(externalEnabled = true) {
  const workspace = await prisma.workspace.create({
    data: {
      name: "Synthetic notification workspace",
      notificationSettings: {
        create: { failureThreshold: 1, externalEnabled },
      },
    },
  });
  const job = await prisma.syncJob.create({
    data: {
      workspaceId: workspace.id,
      policyId: "",
      sourceShop: `alert-${randomUUID()}.myshopify.com`,
      targetShop: "synthetic.myshopify.com",
      operation: "RECONCILE",
      status: "FAILED",
    },
  });
  return { workspace, job };
}
describe.skipIf(!process.env.TEST_DATABASE_URL)("durable opt-in alerts", () => {
  beforeEach(async () => {
    await prisma.notificationDelivery.deleteMany();
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://alerts.example.com/secret-hook");
    vi.stubEnv("ALERT_WEBHOOK_HOSTS", "alerts.example.com");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await prisma.$disconnect();
  });
  it("requires owner opt-in, emits only open/resolved transitions and counts all history", async () => {
    const { workspace, job } = await fixture(false);
    expect(await evaluateAlerts(workspace.id)).toBe(0);
    await prisma.notificationSetting.update({
      where: { workspaceId: workspace.id },
      data: { externalEnabled: true },
    });
    expect(await evaluateAlerts(workspace.id)).toBe(1);
    expect(await evaluateAlerts(workspace.id)).toBe(0);
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "CANCELLED" },
    });
    expect(await evaluateAlerts(workspace.id)).toBe(1);
    expect(await evaluateAlerts(workspace.id)).toBe(0);
    const deliveries = await prisma.notificationDelivery.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    });
    expect(
      deliveries.map((row) => (row.payload as { state: string }).state),
    ).toEqual(["OPEN", "RESOLVED"]);
    await prisma.syncJob.createMany({
      data: Array.from({ length: 61 }, () => ({
        workspaceId: workspace.id,
        policyId: "",
        sourceShop: job.sourceShop,
        targetShop: job.targetShop,
        operation: "RECONCILE",
        status: "FAILED",
      })),
    });
    expect((await operationalCounts(workspace.id, 15)).failed).toBe(61);
  });
  it("leases a delivery once under concurrent workers", async () => {
    const { workspace } = await fixture();
    await evaluateAlerts(workspace.id);
    const send = vi.fn(async () => ({ status: 200 }));
    await Promise.all([deliverNotification(send), deliverNotification(send)]);
    expect(send).toHaveBeenCalledTimes(1);
    const row = await prisma.notificationDelivery.findFirstOrThrow({
      where: { workspaceId: workspace.id },
    });
    expect(row.status).toBe("DELIVERED");
    expect(send.mock.calls[0]).toBeDefined();
  });
  it("rechecks consent before sending and cancels queued delivery after opt-out", async () => {
    const { workspace } = await fixture();
    await evaluateAlerts(workspace.id);
    await prisma.notificationSetting.update({
      where: { workspaceId: workspace.id },
      data: { externalEnabled: false },
    });
    const send = vi.fn(async () => ({ status: 200 }));
    await deliverNotification(send);
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await prisma.notificationDelivery.findFirstOrThrow({
          where: { workspaceId: workspace.id },
        })
      ).status,
    ).toBe("CANCELLED");
  });
  it("retries transient failures with the same delivery ID, bounds attempts and never stores response secrets", async () => {
    const { workspace } = await fixture();
    await evaluateAlerts(workspace.id);
    const ids: string[] = [];
    const send = vi.fn(async (_payload: unknown, id: string) => {
      ids.push(id);
      throw new Error("secret receiver body or URL must not persist");
    });
    const start = Date.now();
    for (let attempt = 0; attempt < 6; attempt++)
      await deliverNotification(send, new Date(start + attempt * 7_200_000));
    expect(send).toHaveBeenCalledTimes(5);
    expect(new Set(ids).size).toBe(1);
    const row = await prisma.notificationDelivery.findFirstOrThrow({
      where: { workspaceId: workspace.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("NETWORK_FAILURE");
    expect(JSON.stringify(row)).not.toContain("secret");
  });
  describe.each(SKEWS)(
    "with this process's clock an hour %s the database's",
    (_, direction) => {
      beforeEach(() => skewProcessClock(direction * HOUR));
      afterEach(restoreProcessClock);
      const queued = async (
        data: Partial<Prisma.NotificationDeliveryUncheckedCreateInput> = {},
      ) => {
        const { workspace } = await fixture();
        return prisma.notificationDelivery.create({
          data: {
            workspaceId: workspace.id,
            dedupKey: randomUUID(),
            payload: {
              kind: "FAILED",
              state: "OPEN",
              value: 1,
              text: "Synthetic alert",
            },
            ...data,
          },
        });
      };
      const reload = (id: string) =>
        prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

      it("sends a delivery as soon as the database has queued it", async () => {
        const delivery = await queued();
        const send = vi.fn(async () => ({ status: 200 }));
        expect(await deliverNotification(send)).toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
        expect((await reload(delivery.id)).status).toBe("DELIVERED");
      });
      it("cancels a queued delivery after opt-out as soon as it is due", async () => {
        const delivery = await queued();
        await prisma.notificationSetting.update({
          where: { workspaceId: delivery.workspaceId },
          data: { externalEnabled: false },
        });
        const send = vi.fn(async () => ({ status: 200 }));
        await deliverNotification(send);
        expect(send).not.toHaveBeenCalled();
        expect((await reload(delivery.id)).status).toBe("CANCELLED");
      });
      it("does not send a retry before its delay has passed", async () => {
        const delivery = await queued({
          status: "RETRY",
          attempts: 1,
          availableAt: await fromDatabase(10 * MINUTE),
        });
        const send = vi.fn(async () => ({ status: 200 }));
        expect(await deliverNotification(send)).toBe(false);
        expect(send).not.toHaveBeenCalled();
        expect((await reload(delivery.id)).status).toBe("RETRY");
      });
      it("leaves a delivery alone while another worker's lease runs", async () => {
        const delivery = await queued({
          status: "SENDING",
          attempts: 1,
          leaseOwner: "other-worker",
          leaseUntil: await fromDatabase(30 * SECOND),
        });
        const send = vi.fn(async () => ({ status: 200 }));
        expect(await deliverNotification(send)).toBe(false);
        expect(send).not.toHaveBeenCalled();
        expect(await reload(delivery.id)).toMatchObject({
          status: "SENDING",
          leaseOwner: "other-worker",
        });
      });
      it("takes over a delivery once its lease has run out", async () => {
        const delivery = await queued({
          status: "SENDING",
          attempts: 1,
          leaseOwner: "dead-worker",
          leaseUntil: await fromDatabase(-SECOND),
        });
        const send = vi.fn(async () => ({ status: 200 }));
        expect(await deliverNotification(send)).toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
        expect((await reload(delivery.id)).status).toBe("DELIVERED");
      });
      it("gives up on a delivery with no attempts left once its lease has run out", async () => {
        const delivery = await queued({
          status: "SENDING",
          attempts: 5,
          leaseOwner: "dead-worker",
          leaseUntil: await fromDatabase(-SECOND),
        });
        await deliverNotification(vi.fn(async () => ({ status: 200 })));
        expect(await reload(delivery.id)).toMatchObject({
          status: "FAILED",
          errorCode: "DELIVERY_OUTCOME_UNKNOWN",
        });
      });
      it("holds its own lease and its retry delay for their full terms", async () => {
        const delivery = await queued();
        let lease = Number.NaN;
        const send = vi.fn(async () => {
          lease = await remaining((await reload(delivery.id)).leaseUntil);
          throw new Error("synthetic network failure");
        });
        await deliverNotification(send);
        expect(lease).toBeGreaterThan(20 * SECOND);
        expect(lease).toBeLessThanOrEqual(30 * SECOND);
        const row = await reload(delivery.id);
        expect(row.status).toBe("RETRY");
        const delay = await remaining(row.availableAt);
        expect(delay).toBeGreaterThan(50 * SECOND);
        expect(delay).toBeLessThanOrEqual(60 * SECOND);
      });
      it("counts a job as lagging by the database's clock", async () => {
        const { workspace, job } = await fixture();
        const waiting = (availableAt: Date) =>
          prisma.syncJob.create({
            data: {
              workspaceId: workspace.id,
              policyId: "",
              sourceShop: job.sourceShop,
              targetShop: job.targetShop,
              operation: "RECONCILE",
              status: "PENDING",
              availableAt,
            },
          });
        const recent = await waiting(await fromDatabase(-5 * MINUTE));
        expect((await operationalCounts(workspace.id, 15)).lagging).toBe(0);
        expect(await evaluateAlerts(workspace.id)).toBe(1); // FAILED only
        await prisma.syncJob.update({
          where: { id: recent.id },
          data: { availableAt: await fromDatabase(-20 * MINUTE) },
        });
        expect((await operationalCounts(workspace.id, 15)).lagging).toBe(1);
        expect(await evaluateAlerts(workspace.id)).toBe(1); // LAGGING opens
      });
      it("evaluates a workspace once a minute by the database's clock", async () => {
        const { workspace } = await fixture();
        const setting = { where: { workspaceId: workspace.id } };
        const queuedNow = () =>
          prisma.notificationDelivery.count({
            where: { workspaceId: workspace.id },
          });
        await prisma.notificationSetting.update({
          ...setting,
          data: { lastEvaluatedAt: await fromDatabase(-10 * SECOND) },
        });
        await scheduleNotifications();
        expect(await queuedNow()).toBe(0);
        await prisma.notificationSetting.update({
          ...setting,
          data: { lastEvaluatedAt: await fromDatabase(-2 * MINUTE) },
        });
        await scheduleNotifications();
        expect(await queuedNow()).toBe(1);
      });
    },
  );
});
