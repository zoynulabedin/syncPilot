import {
  Prisma,
  type AutomaticConsent,
  type SyncJob,
  type SyncPolicy,
  type SyncPreview,
} from "@prisma/client";
import { z } from "zod";
import prisma from "../db.server";
import { DomainError, assertSafePreview } from "../domain/guards";
import {
  AUTOMATIC_FIELDS,
  assertAutomaticChanges,
  automationFingerprint,
  consentExhausted,
  nextAutomaticRun,
} from "../domain/automation";
import {
  assertCurrentPlan,
  assertWriteGates,
  stableHash,
  SyncError,
} from "../domain/sync";
import {
  requireOwner,
  requireWorkspace,
  type Actor,
} from "./authorization.server";
import { getWorkspace } from "./control-plane.server";
import { databaseNow } from "./database-clock.server";

type Tx = Prisma.TransactionClient;
const actorKey = (actor: Actor) => `${actor.shop}:${actor.userId}`;
function enabled() {
  assertWriteGates();
  if (process.env.AUTOMATIC_SYNC_ENABLED !== "true")
    throw new SyncError(
      "AUTOMATIC_DISABLED",
      "Automatic synchronization is disabled by the deployment gate.",
    );
}
async function serial<T>(run: (tx: Tx) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(run, {
        isolationLevel: "Serializable",
        timeout: 30_000,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 3
      )
        continue;
      throw error;
    }
  }
}

// The only policies standing consent can cover. Mappings and the pair are
// checked separately when consent is granted and before every automatic write.
function automaticScope(policy: SyncPolicy) {
  return (
    policy.enabled &&
    policy.status === "ACTIVE" &&
    Boolean(policy.approvedAt) &&
    Boolean(policy.approvedBy) &&
    policy.direction === "ONE_WAY" &&
    !policy.syncInventory &&
    !policy.syncPrices &&
    !policy.syncVariants &&
    policy.syncProduct &&
    policy.fields.length > 0 &&
    policy.fields.every((f) =>
      (AUTOMATIC_FIELDS as readonly string[]).includes(f),
    )
  );
}

async function configuration(policyId: string, db: Tx = prisma) {
  const policy = await db.syncPolicy.findUniqueOrThrow({
    where: { id: policyId },
  });
  if (!automaticScope(policy))
    throw new SyncError(
      "CONSENT_SCOPE",
      "Automatic consent supports active one-way descriptive product fields only.",
    );
  const context = await requireWorkspace(
    {
      shop: policy.sourceShopDomain,
      userId: "automatic-system",
      role: "OWNER",
    },
    db,
  );
  if (
    context.workspaceId !== policy.workspaceId ||
    !context.connections.some((c) => c.shopDomain === policy.targetShopDomain)
  )
    throw new SyncError("TENANT_DENIED", "The approved store pair changed.");
  const maps = await db.productMapping.findMany({
    where: {
      workspaceId: policy.workspaceId,
      sourceShopDomain: policy.sourceShopDomain,
      targetShopDomain: policy.targetShopDomain,
    },
    orderBy: { id: "asc" },
  });
  if (!maps.length || maps.some((m) => !m.verifiedAt))
    throw new SyncError(
      "MAPPING_MISSING",
      "Verify every product mapping before granting automatic consent.",
    );
  const fingerprint = automationFingerprint(
    {
      id: policy.id,
      workspaceId: policy.workspaceId,
      source: policy.sourceShopDomain,
      target: policy.targetShopDomain,
      fields: [...policy.fields].sort(),
      updatedAt: policy.updatedAt.toISOString(),
      pair: context.pair.id,
    },
    maps.map((m) => ({
      id: m.id,
      source: m.sourceProductGid,
      target: m.targetProductGid,
      verifiedAt: m.verifiedAt?.toISOString(),
    })),
  );
  return { policy, fingerprint };
}

type ConsentPage = {
  automaticFields: string[];
  canManage: boolean;
  enabled: boolean;
  paired: boolean;
  consents: (AutomaticConsent & { exhausted: boolean })[];
  policies: (SyncPolicy & { eligible: boolean })[];
  previews: SyncPreview[];
};

export async function getAutomaticConsents(actor: Actor): Promise<ConsentPage> {
  const page = {
    automaticFields: [...AUTOMATIC_FIELDS],
    canManage: actor.role === "OWNER",
    enabled:
      process.env.AUTOMATIC_SYNC_ENABLED === "true" &&
      process.env.SYNC_WRITE_ENABLED === "true",
  };
  // Reactivates a reinstalled store, as every other page's loader does. Staff
  // roles exist only inside a paired workspace, so an unpaired store shows the
  // empty page to everyone instead of failing.
  const { workspaceId } = await getWorkspace(actor);
  if (!workspaceId)
    return { ...page, paired: false, consents: [], policies: [], previews: [] };
  const [consents, policies] = await Promise.all([
    prisma.automaticConsent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    // Every policy, so consents on a paused or edited policy still show its stores.
    prisma.syncPolicy.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
    }),
  ]);
  const eligible = policies.filter(automaticScope).map((policy) => policy.id);
  const previews = await prisma.syncPreview.findMany({
    where: {
      workspaceId,
      policyId: { in: eligible },
      status: { in: ["PENDING", "APPLIED"] },
      expiresAt: { gt: await databaseNow() },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return {
    ...page,
    paired: true,
    consents: consents.map((consent) => ({
      ...consent,
      exhausted: consentExhausted(consent),
    })),
    policies: policies.map((policy) => ({
      ...policy,
      eligible: eligible.includes(policy.id),
    })),
    previews,
  };
}

export async function grantAutomaticConsent(actor: Actor, input: unknown) {
  requireOwner(actor);
  enabled();
  const data = z
    .object({
      policyId: z.string().min(1).max(100),
      previewId: z.string().min(1).max(100),
      durationMinutes: z.number().int().min(5).max(1440),
      intervalMinutes: z.number().int().min(5).max(1440),
      maxJobs: z.number().int().min(1).max(100),
      maxChanges: z.number().int().min(1).max(1000),
      perRunChanges: z.number().int().min(1).max(100),
      confirmed: z.literal(true),
    })
    .strict()
    .parse(input);
  const context = await requireWorkspace(actor);
  const reviewed = await prisma.syncPreview.findFirst({
    where: {
      id: data.previewId,
      policyId: data.policyId,
      workspaceId: context.workspaceId,
      status: { in: ["PENDING", "APPLIED"] },
      expiresAt: { gt: await databaseNow() },
    },
  });
  if (!reviewed)
    throw new DomainError(
      "PREVIEW_REQUIRED",
      "Review a fresh exact preview for this policy before granting consent.",
      409,
    );
  assertSafePreview(reviewed.changes);
  const beforeConfig = await configuration(data.policyId);
  const { buildPreview } = await import("./sync-engine.server");
  const current = await buildPreview(data.policyId);
  assertCurrentPlan(reviewed, current);
  if (stableHash(reviewed.changes) !== stableHash(current.changes))
    throw new DomainError(
      "PREVIEW_STALE",
      "Review a fresh comparison before granting consent.",
      409,
    );
  return serial(async (tx) => {
    enabled();
    const fresh = await requireWorkspace(actor, tx);
    const { policy, fingerprint } = await configuration(data.policyId, tx);
    if (fingerprint !== beforeConfig.fingerprint)
      throw new DomainError(
        "CONSENT_CHANGED",
        "Policy or mappings changed while granting consent.",
        409,
      );
    if (policy.workspaceId !== fresh.workspaceId)
      throw new DomainError("POLICY_NOT_FOUND", "Policy not found.", 404);
    const now = await databaseNow(tx);
    const preview = await tx.syncPreview.findFirst({
      where: {
        id: reviewed.id,
        workspaceId: fresh.workspaceId,
        expiresAt: { gt: now },
        status: { in: ["PENDING", "APPLIED"] },
      },
    });
    if (!preview)
      throw new DomainError(
        "PREVIEW_EXPIRED",
        "The reviewed preview expired.",
        409,
      );
    assertAutomaticChanges(
      current.changes,
      policy.fields,
      data.maxChanges,
      data.perRunChanges,
    );
    const owner = await tx.workspaceMember.findUnique({
      where: {
        workspaceId_shopDomain_userId: {
          workspaceId: fresh.workspaceId,
          shopDomain: actor.shop,
          userId: actor.userId,
        },
      },
    });
    if (owner?.status !== "ACTIVE" || owner.role !== "OWNER")
      throw new DomainError(
        "OWNER_REQUIRED",
        "Active workspace owner membership is required.",
        403,
      );
    // The scheduler marks lapsed consents EXPIRED only while both switches are
    // on, so a lapsed row can still read ACTIVE; it must not block this grant.
    await tx.automaticConsent.updateMany({
      where: {
        policyId: policy.id,
        status: "ACTIVE",
        expiresAt: { lte: now },
      },
      data: { status: "EXPIRED" },
    });
    if (
      await tx.automaticConsent.count({
        where: { policyId: policy.id, status: "ACTIVE" },
      })
    )
      throw new DomainError(
        "CONSENT_EXISTS",
        "Revoke the current consent before replacing it.",
        409,
      );
    const consent = await tx.automaticConsent.create({
      data: {
        workspaceId: fresh.workspaceId,
        policyId: policy.id,
        fingerprint,
        approvedBy: actorKey(actor),
        fields: policy.fields,
        expiresAt: new Date(now.getTime() + data.durationMinutes * 60_000),
        intervalMinutes: data.intervalMinutes,
        maxJobs: data.maxJobs,
        maxChanges: data.maxChanges,
        perRunChanges: data.perRunChanges,
      },
    });
    await tx.auditEvent.create({
      data: {
        workspaceId: fresh.workspaceId,
        shopDomain: actor.shop,
        actor: actorKey(actor),
        action: "AUTOMATIC_CONSENT_GRANTED",
        resourceType: "AutomaticConsent",
        resourceId: consent.id,
        details: {
          previewId: reviewed.id,
          fingerprint,
          maxJobs: data.maxJobs,
          maxChanges: data.maxChanges,
          perRunChanges: data.perRunChanges,
          expiresAt: consent.expiresAt.toISOString(),
          fields: consent.fields,
        },
      },
    });
    return consent;
  });
}

export async function revokeAutomaticConsent(actor: Actor, id: string) {
  requireOwner(actor);
  return serial(async (tx) => {
    const { workspaceId } = await requireWorkspace(actor, tx);
    // This short transaction makes no Shopify calls, so it may lock the row: a
    // run spending this budget either sees the revocation, or queued its write
    // first and the cancellation below covers it. The write path never locks
    // the row, so this never waits for an in-flight Shopify mutation.
    await tx.$queryRaw`SELECT id FROM "AutomaticConsent" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const consent = await tx.automaticConsent.findFirst({
      where: { id, workspaceId },
    });
    if (!consent)
      throw new DomainError("CONSENT_NOT_FOUND", "Consent not found.", 404);
    // A repeated submit, or a consent that already ended, keeps its record.
    if (consent.status !== "ACTIVE" && consent.status !== "HELD")
      return consent;
    const revoked = await tx.automaticConsent.update({
      where: { id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await tx.syncJob.updateMany({
      where: {
        workspaceId,
        payload: { path: ["consentId"], equals: id },
        status: { in: ["PENDING", "RETRY", "RUNNING"] },
      },
      data: {
        status: "CANCELLED",
        leaseOwner: null,
        leaseUntil: null,
        lastError: "AUTOMATIC_CONSENT_REVOKED",
      },
    });
    await tx.auditEvent.create({
      data: {
        workspaceId,
        shopDomain: actor.shop,
        actor: actorKey(actor),
        action: "AUTOMATIC_CONSENT_REVOKED",
        resourceType: "AutomaticConsent",
        resourceId: id,
        details: { reason: "OWNER_REVOKED" },
      },
    });
    return revoked;
  });
}

// The write path runs this inside its long resource transaction, and again
// right before each Shopify mutation, as it re-reads the policy, pair, approval
// and lease. It takes no row lock: under Read Committed a committed pause,
// disconnect, uninstall, scope loss or revocation fails the next check, where a
// lock would make those emergency stops wait for the in-flight Shopify call.
// A mutation that already passed its last check may still complete after a
// revocation commits, the same gap a pause leaves for an owner-approved plan.
// Only a short transaction with no Shopify calls may pass `lock`.
export async function assertJobConsent(
  job: SyncJob,
  db: Tx = prisma,
  { lock = false } = {},
) {
  const payload = job.payload as { consentId?: string } | null;
  if (!payload?.consentId) return;
  enabled();
  if (lock)
    await db.$queryRaw`SELECT id FROM "AutomaticConsent" WHERE id = ${payload.consentId} FOR UPDATE`;
  const consent = await db.automaticConsent.findUnique({
    where: { id: payload.consentId },
  });
  if (
    !consent ||
    consent.workspaceId !== job.workspaceId ||
    consent.policyId !== job.policyId ||
    consent.status !== "ACTIVE" ||
    consent.expiresAt <= (await databaseNow(db))
  )
    throw new SyncError(
      "CONSENT_REVOKED",
      "Automatic consent expired, was held, or was revoked.",
    );
  const { policy, fingerprint } = await configuration(job.policyId, db);
  if (fingerprint !== consent.fingerprint)
    throw new SyncError(
      "CONSENT_CHANGED",
      "Policy or mappings changed after automatic consent.",
    );
  const colon = consent.approvedBy.lastIndexOf(":"),
    shopDomain = consent.approvedBy.slice(0, colon),
    userId = consent.approvedBy.slice(colon + 1);
  if (![policy.sourceShopDomain, policy.targetShopDomain].includes(shopDomain))
    throw new SyncError(
      "TENANT_DENIED",
      "Consent owner does not belong to this pair.",
    );
  const member = await db.workspaceMember.findUnique({
    where: {
      workspaceId_shopDomain_userId: {
        workspaceId: job.workspaceId,
        shopDomain,
        userId,
      },
    },
  });
  if (member?.status !== "ACTIVE" || member.role !== "OWNER")
    throw new SyncError(
      "CONSENT_REVOKED",
      "The consenting owner no longer has access.",
    );
  return consent;
}

export async function scheduleAutomaticSync(at?: Date) {
  if (
    process.env.AUTOMATIC_SYNC_ENABLED !== "true" ||
    process.env.SYNC_WRITE_ENABLED !== "true"
  )
    return 0;
  const now = at ?? (await databaseNow());
  await prisma.automaticConsent.updateMany({
    where: { status: "ACTIVE", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  return prisma.$transaction(async (tx) => {
    const due = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "AutomaticConsent" WHERE status = 'ACTIVE' AND "nextRunAt" <= ${now} AND "expiresAt" > ${now} ORDER BY "nextRunAt" LIMIT 25 FOR UPDATE SKIP LOCKED`;
    let queued = 0;
    for (const { id } of due) {
      const consent = await tx.automaticConsent.findUniqueOrThrow({
        where: { id },
      });
      // Advance even when skipped below, or 25 blocked rows keep the oldest
      // nextRunAt and starve every other due consent.
      await tx.automaticConsent.update({
        where: { id },
        data: { nextRunAt: nextAutomaticRun(consent, now) },
      });
      // Keep ACTIVE until the last already-budgeted write finishes or expires.
      if (consentExhausted(consent)) continue;
      if (
        await tx.syncJob.count({
          where: {
            policyId: consent.policyId,
            status: { in: ["PENDING", "RETRY", "RUNNING"] },
            operation: { in: ["AUTO_PREVIEW", "APPLY_PREVIEW"] },
          },
        })
      )
        continue;
      const policy = await tx.syncPolicy.findUnique({
        where: { id: consent.policyId },
      });
      if (!policy?.enabled || policy.status !== "ACTIVE") continue;
      await tx.syncJob.create({
        data: {
          workspaceId: consent.workspaceId,
          policyId: consent.policyId,
          sourceShop: policy.sourceShopDomain,
          targetShop: policy.targetShopDomain,
          operation: "AUTO_PREVIEW",
          idempotencyKey: `automatic:${id}:${consent.nextRunAt.getTime()}`,
          payload: { consentId: id },
        },
      });
      queued++;
    }
    return queued;
  });
}

// The fingerprint covers policy.updatedAt, so a consent that a pause and
// re-activation left ACTIVE can never pass again. Hold it so the scheduler stops
// queueing runs that dead-letter every interval and the owner can grant afresh.
async function holdChangedConsent(
  job: SyncJob,
  error: unknown,
): Promise<never> {
  const consentId = (job.payload as { consentId?: string } | null)?.consentId;
  if (
    error instanceof SyncError &&
    error.code === "CONSENT_CHANGED" &&
    consentId
  )
    await serial(async (tx) => {
      const held = await tx.automaticConsent.updateMany({
        where: {
          id: consentId,
          workspaceId: job.workspaceId,
          status: "ACTIVE",
        },
        data: { status: "HELD" },
      });
      if (held.count)
        await tx.auditEvent.create({
          data: {
            workspaceId: job.workspaceId,
            actor: "system:automatic-sync",
            action: "AUTOMATIC_CONSENT_HELD",
            resourceType: "AutomaticConsent",
            resourceId: consentId,
            details: { code: "CONSENT_CHANGED", jobId: job.id },
          },
        });
    });
  throw error;
}

export async function processAutomaticPreview(
  job: SyncJob,
  progress: () => Promise<void>,
) {
  await assertJobConsent(job).catch((error: unknown) =>
    holdChangedConsent(job, error),
  );
  const { buildLivePreview } = await import("./sync-engine.server");
  const live = await buildLivePreview(job.policyId, progress);
  await progress();
  return serial(async (tx) => {
    // The live comparison is already read, so this transaction is short and
    // makes no Shopify calls. Lock the consent while spending its budget: a
    // revocation then lands before this run (which refuses) or after it (and
    // cancels the write queued here).
    const consent = await assertJobConsent(job, tx, { lock: true });
    if (!consent)
      throw new SyncError(
        "CONSENT_REQUIRED",
        "An automatic job requires bounded consent.",
      );
    const now = await databaseNow(tx);
    const lease = await tx.syncJob.findFirst({
      where: {
        id: job.id,
        status: "RUNNING",
        leaseOwner: job.leaseOwner,
        leaseUntil: { gt: now },
      },
    });
    if (!lease)
      throw new SyncError(
        "LEASE_LOST",
        "The automatic preview lease was revoked.",
      );
    if (!live.changes.length) return;
    try {
      if (consent.usedJobs >= consent.maxJobs)
        throw new SyncError(
          "CONSENT_BUDGET",
          "Automatic job budget is exhausted.",
        );
      assertAutomaticChanges(
        live.changes,
        consent.fields,
        consent.maxChanges - consent.usedChanges,
        consent.perRunChanges,
      );
    } catch (error) {
      if (!(error instanceof SyncError)) throw error;
      await tx.automaticConsent.update({
        where: { id: consent.id },
        data: { status: "HELD" },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: job.workspaceId,
          actor: "system:automatic-sync",
          action: "AUTOMATIC_CONSENT_HELD",
          resourceType: "AutomaticConsent",
          resourceId: consent.id,
          details: { code: error.code, changes: live.changes.length },
        },
      });
      return;
    }
    const preview = await tx.syncPreview.create({
      data: {
        workspaceId: job.workspaceId,
        policyId: job.policyId,
        createdBy: "system:automatic-sync",
        approvedBy: consent.approvedBy,
        approvedAt: now,
        status: "APPROVED",
        sourceHash: live.sourceHash,
        targetHash: live.targetHash,
        changes: live.changes as Prisma.InputJsonValue,
        expiresAt: new Date(
          Math.min(consent.expiresAt.getTime(), now.getTime() + 15 * 60_000),
        ),
      },
    });
    await tx.syncJob.create({
      data: {
        workspaceId: job.workspaceId,
        policyId: job.policyId,
        sourceShop: job.sourceShop,
        targetShop: job.targetShop,
        previewId: preview.id,
        operation: "APPLY_PREVIEW",
        idempotencyKey: `automatic-apply:${job.id}`,
        payload: { previewId: preview.id, consentId: consent.id },
      },
    });
    await tx.automaticConsent.update({
      where: { id: consent.id },
      data: {
        usedJobs: { increment: 1 },
        usedChanges: { increment: live.changes.length },
      },
    });
    await tx.auditEvent.create({
      data: {
        workspaceId: job.workspaceId,
        actor: consent.approvedBy,
        action: "AUTOMATIC_PLAN_APPROVED",
        resourceType: "SyncPreview",
        resourceId: preview.id,
        details: { consentId: consent.id, changes: live.changes.length },
      },
    });
  });
}
