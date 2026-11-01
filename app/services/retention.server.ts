import { Prisma } from "@prisma/client";
import prisma from "../db.server";

const batch = 500;
const day = 86_400_000;
const window = { take: batch, select: { id: true } } as const;

/** Bounded daily cleanup; owner consent is persisted and rechecked inside the transaction. */
export async function cleanWorkspaceHistory(
  workspaceId: string,
  now = new Date(),
) {
  return prisma.$transaction(
    async (tx) => {
      const lock = await tx.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtext(${`retention:${workspaceId}`})) AS locked`;
      if (!lock[0]?.locked) return null;
      const workspace = await tx.workspace.findUnique({
        where: { id: workspaceId },
      });
      if (!workspace?.retentionEnabled || workspace.state !== "ACTIVE")
        return null;
      const cutoff = new Date(
        now.getTime() - Math.max(7, workspace.retentionDays) * day,
      );
      const jobWhere = {
        workspaceId,
        status: { in: ["SUCCEEDED", "COMPLETED", "CANCELLED"] },
        updatedAt: { lt: cutoff },
        syncAttempts: { none: { status: "RUNNING" } },
      };
      const jobs = await tx.$queryRaw<
        { id: string }[]
      >`SELECT j.id FROM "SyncJob" j
        WHERE j."workspaceId" = ${workspaceId} AND j.status IN ('SUCCEEDED', 'COMPLETED', 'CANCELLED') AND j."updatedAt" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "SyncConflict" c WHERE c."jobId" = j.id AND c.status = 'OPEN')
        AND NOT EXISTS (SELECT 1 FROM "SyncAttempt" a WHERE a."jobId" = j.id AND a.status = 'RUNNING')
        ORDER BY j."updatedAt", j.id LIMIT ${batch}`;
      const counts: Record<string, number> = {};
      counts.jobs = (
        await tx.syncJob.deleteMany({
          where: { AND: [jobWhere, { id: { in: jobs.map((row) => row.id) } }] },
        })
      ).count;
      const conflictWhere = {
        workspaceId,
        status: "RESOLVED",
        resolvedAt: { lt: cutoff },
      };
      const conflicts = await tx.syncConflict.findMany({
        where: conflictWhere,
        ...window,
      });
      counts.conflicts = (
        await tx.syncConflict.deleteMany({
          where: {
            ...conflictWhere,
            id: { in: conflicts.map((row) => row.id) },
          },
        })
      ).count;
      // Retained jobs may need their exact plans for diagnosis or uncertain-outcome review.
      const previewWhere = {
        workspaceId,
        status: { in: ["EXPIRED", "REVOKED", "STALE", "APPLIED"] },
        expiresAt: { lt: cutoff },
      };
      const previews = await tx.$queryRaw<
        { id: string }[]
      >`SELECT p.id FROM "SyncPreview" p
        WHERE p."workspaceId" = ${workspaceId} AND p.status IN ('EXPIRED', 'REVOKED', 'STALE', 'APPLIED') AND p."expiresAt" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "SyncJob" j WHERE j."previewId" = p.id)
        ORDER BY p."expiresAt", p.id LIMIT ${batch}`;
      counts.previews = (
        await tx.syncPreview.deleteMany({
          where: {
            AND: [previewWhere, { id: { in: previews.map((row) => row.id) } }],
          },
        })
      ).count;
      const runWhere = {
        workspaceId,
        status: "COMPLETED",
        completedAt: { lt: cutoff },
      };
      const runs = await tx.reconciliationRun.findMany({
        where: runWhere,
        ...window,
      });
      counts.reconciliations = (
        await tx.reconciliationRun.deleteMany({
          where: { ...runWhere, id: { in: runs.map((row) => row.id) } },
        })
      ).count;
      const auditWhere = { workspaceId, createdAt: { lt: cutoff } };
      const audits = await tx.auditEvent.findMany({
        where: auditWhere,
        ...window,
      });
      counts.audit = (
        await tx.auditEvent.deleteMany({
          where: { ...auditWhere, id: { in: audits.map((row) => row.id) } },
        })
      ).count;
      const connections = await tx.shopConnection.findMany({
        where: { workspaceId },
        select: { shopDomain: true },
      });
      const eventWhere = {
        shopDomain: { in: connections.map((row) => row.shopDomain) },
        status: { in: ["PROCESSED", "IGNORED"] },
        processedAt: { lt: cutoff },
      };
      const events = await tx.$queryRaw<
        { id: string }[]
      >`SELECT e.id FROM "WebhookEvent" e
        WHERE e."shopDomain" IN (SELECT "shopDomain" FROM "ShopConnection" WHERE "workspaceId" = ${workspaceId})
        AND e.status IN ('PROCESSED', 'IGNORED') AND e."processedAt" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "SyncJob" j WHERE j."eventId" = e.id)
        ORDER BY e."processedAt", e.id LIMIT ${batch}`;
      counts.webhooks = (
        await tx.webhookEvent.deleteMany({
          where: {
            AND: [eventWhere, { id: { in: events.map((row) => row.id) } }],
          },
        })
      ).count;
      const deliveryWhere = {
        workspaceId,
        status: { in: ["DELIVERED", "CANCELLED"] },
        updatedAt: { lt: cutoff },
      };
      const deliveries = await tx.notificationDelivery.findMany({
        where: deliveryWhere,
        ...window,
      });
      counts.notifications = (
        await tx.notificationDelivery.deleteMany({
          where: {
            ...deliveryWhere,
            id: { in: deliveries.map((row) => row.id) },
          },
        })
      ).count;
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { lastRetentionAt: now },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId,
          actor: "system:retention",
          action: "RETENTION_COMPLETED",
          resourceType: "Workspace",
          resourceId: workspaceId,
          details: { cutoff: cutoff.toISOString(), counts, batchLimit: batch },
        },
      });
      return counts;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 30_000,
    },
  );
}

export async function cleanHistory(now = new Date()) {
  const workspaces = await prisma.workspace.findMany({
    where: {
      state: "ACTIVE",
      retentionEnabled: true,
      OR: [
        { lastRetentionAt: null },
        { lastRetentionAt: { lt: new Date(now.getTime() - day) } },
      ],
    },
    orderBy: [
      { lastRetentionAt: { sort: "asc", nulls: "first" } },
      { id: "asc" },
    ],
    take: 25,
    select: { id: true },
  });
  for (const workspace of workspaces)
    await cleanWorkspaceHistory(workspace.id, now);
  return workspaces.length;
}
