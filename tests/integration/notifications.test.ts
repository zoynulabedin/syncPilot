import { randomUUID } from "node:crypto";
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
} from "../../app/services/notifications.server";

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
});
