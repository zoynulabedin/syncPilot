import { randomUUID } from "node:crypto";
import { z } from "zod";
import prisma from "../db.server";
import {
  AlertTransportError,
  alertDestination,
  sendAlert,
  type DeliveryResult,
} from "./alert-transport.server";

export async function operationalCounts(
  workspaceId: string,
  lagMinutes: number,
  now = new Date(),
) {
  const [failed, held, lagging] = await Promise.all([
    prisma.syncJob.count({
      where: { workspaceId, status: { in: ["FAILED", "DEAD_LETTER"] } },
    }),
    prisma.syncJob.count({ where: { workspaceId, status: "HELD" } }),
    prisma.syncJob.count({
      where: {
        workspaceId,
        status: { in: ["PENDING", "RETRY"] },
        availableAt: { lt: new Date(now.getTime() - lagMinutes * 60_000) },
      },
    }),
  ]);
  return { failed, held, lagging };
}

const payloadSchema = z.object({
  kind: z.enum(["FAILED", "HELD", "LAGGING"]),
  state: z.enum(["OPEN", "RESOLVED"]),
  value: z.number().int().nonnegative(),
  text: z.string().max(1000),
});

/** Notify once when a threshold opens and once when it resolves. An unchanged condition stays quiet. */
export async function evaluateAlerts(workspaceId: string, now = new Date()) {
  if (!alertDestination()) return 0;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`alerts:${workspaceId}`}))::text`;
    const setting = await tx.notificationSetting.findUnique({
      where: { workspaceId },
      include: { workspace: true },
    });
    if (
      !setting?.enabled ||
      !setting.externalEnabled ||
      setting.workspace.state !== "ACTIVE"
    )
      return 0;
    const [failed, held, lagging] = await Promise.all([
      tx.syncJob.count({
        where: { workspaceId, status: { in: ["FAILED", "DEAD_LETTER"] } },
      }),
      tx.syncJob.count({ where: { workspaceId, status: "HELD" } }),
      tx.syncJob.count({
        where: {
          workspaceId,
          status: { in: ["PENDING", "RETRY"] },
          availableAt: {
            lt: new Date(now.getTime() - setting.lagMinutes * 60_000),
          },
        },
      }),
    ]);
    let queued = 0;
    for (const [kind, value, threshold] of [
      ["FAILED", failed, setting.failureThreshold],
      ["HELD", held, 1],
      ["LAGGING", lagging, 1],
    ] as const) {
      const previous = await tx.operationalAlert.upsert({
        where: { workspaceId_kind: { workspaceId, kind } },
        create: { workspaceId, kind },
        update: {},
      });
      const active = value >= threshold;
      if (active !== previous.active) {
        const next = await tx.operationalAlert.update({
          where: { id: previous.id },
          data: { active, observedValue: value, revision: { increment: 1 } },
        });
        const payload = payloadSchema.parse({
          kind,
          state: active ? "OPEN" : "RESOLVED",
          value,
          text: active
            ? `SyncPilot: ${value} ${kind.toLowerCase()} jobs need attention.`
            : `SyncPilot: the ${kind.toLowerCase()} job alert has resolved.`,
        });
        await tx.notificationDelivery.create({
          data: {
            workspaceId,
            dedupKey: `${next.id}:${next.revision}`,
            payload,
          },
        });
        queued++;
      }
    }
    await tx.notificationSetting.update({
      where: { workspaceId },
      data: { lastEvaluatedAt: now },
    });
    return queued;
  });
}

export async function scheduleNotifications(now = new Date()) {
  if (!alertDestination()) return 0;
  const settings = await prisma.notificationSetting.findMany({
    where: {
      enabled: true,
      externalEnabled: true,
      workspace: { state: "ACTIVE" },
      OR: [
        { lastEvaluatedAt: null },
        { lastEvaluatedAt: { lt: new Date(now.getTime() - 60_000) } },
      ],
    },
    orderBy: [
      { lastEvaluatedAt: { sort: "asc", nulls: "first" } },
      { id: "asc" },
    ],
    take: 25,
    select: { workspaceId: true },
  });
  let queued = 0;
  for (const setting of settings)
    queued += await evaluateAlerts(setting.workspaceId, now);
  return queued;
}

type Sender = (payload: unknown, id: string) => Promise<DeliveryResult>;
/** A stable delivery ID is reused after a timeout; receivers should deduplicate Idempotency-Key. */
export async function deliverNotification(
  send: Sender = sendAlert,
  now = new Date(),
) {
  const owner = randomUUID();
  const delivery = await prisma.$transaction(async (tx) => {
    await tx.notificationDelivery.updateMany({
      where: {
        status: "SENDING",
        leaseUntil: { lt: now },
        attempts: { gte: 5 },
      },
      data: {
        status: "FAILED",
        errorCode: "DELIVERY_OUTCOME_UNKNOWN",
        leaseOwner: null,
        leaseUntil: null,
      },
    });
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "NotificationDelivery" WHERE attempts < 5 AND ((status IN ('PENDING', 'RETRY') AND "availableAt" <= ${now}) OR (status = 'SENDING' AND "leaseUntil" < ${now})) ORDER BY "availableAt", "createdAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows.length) return null;
    return tx.notificationDelivery.update({
      where: { id: rows[0].id },
      data: {
        status: "SENDING",
        attempts: { increment: 1 },
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + 30_000),
      },
    });
  });
  if (!delivery) return false;
  const fence = { id: delivery.id, status: "SENDING", leaseOwner: owner };
  const setting = await prisma.notificationSetting.findUnique({
    where: { workspaceId: delivery.workspaceId },
    include: { workspace: true },
  });
  if (
    !setting?.enabled ||
    !setting.externalEnabled ||
    setting.workspace.state !== "ACTIVE"
  ) {
    await prisma.notificationDelivery.updateMany({
      where: fence,
      data: {
        status: "CANCELLED",
        leaseOwner: null,
        leaseUntil: null,
        errorCode: "CONSENT_REVOKED",
      },
    });
    return true;
  }
  let errorCode = "NETWORK_FAILURE",
    retryable = true,
    retryAfter = 0;
  try {
    const payload = payloadSchema.parse(delivery.payload);
    const result = await send(
      {
        ...payload,
        deliveryId: delivery.id,
        workspaceId: delivery.workspaceId,
      },
      delivery.id,
    );
    if (result.status >= 200 && result.status < 300) {
      await prisma.notificationDelivery.updateMany({
        where: fence,
        data: {
          status: "DELIVERED",
          deliveredAt: now,
          leaseOwner: null,
          leaseUntil: null,
          errorCode: null,
        },
      });
      return true;
    }
    errorCode = `HTTP_${result.status}`;
    retryable =
      result.status === 408 || result.status === 429 || result.status >= 500;
    retryAfter = result.retryAfter || 0;
  } catch (error) {
    if (error instanceof AlertTransportError) {
      errorCode = error.code;
      retryable = ["DNS_FAILURE", "NETWORK_FAILURE"].includes(error.code);
    } else if (error instanceof z.ZodError) {
      errorCode = "INVALID_PAYLOAD";
      retryable = false;
    }
  }
  await prisma.notificationDelivery.updateMany({
    where: fence,
    data: {
      status: retryable && delivery.attempts < 5 ? "RETRY" : "FAILED",
      errorCode,
      leaseOwner: null,
      leaseUntil: null,
      availableAt: new Date(
        now.getTime() +
          Math.min(3600, Math.max(retryAfter, 30 * 2 ** delivery.attempts)) *
            1000,
      ),
    },
  });
  return true;
}
