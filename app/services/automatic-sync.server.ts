import { Prisma, type SyncJob } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.server";
import { DomainError, assertSafePreview } from "../domain/guards";
import { AUTOMATIC_FIELDS, assertAutomaticChanges, automationFingerprint } from "../domain/automation";
import { assertCurrentPlan, assertWriteGates, stableHash, SyncError, type SyncChange } from "../domain/sync";
import { requireOwner, requireWorkspace, type Actor } from "./authorization.server";

type Tx = Prisma.TransactionClient;
const actorKey = (actor: Actor) => `${actor.shop}:${actor.userId}`;
function enabled() {
  assertWriteGates();
  if (process.env.AUTOMATIC_SYNC_ENABLED !== "true")
    throw new SyncError("AUTOMATIC_DISABLED", "Automatic synchronization is disabled by the deployment gate.");
}
async function serial<T>(run: (tx: Tx) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(run, { isolationLevel: "Serializable", timeout: 30_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 3) continue;
      throw error;
    }
  }
}

async function configuration(policyId: string, db: Tx = prisma) {
  const policy = await db.syncPolicy.findUniqueOrThrow({ where: { id: policyId } });
  if (!policy.enabled || policy.status !== "ACTIVE" || !policy.approvedAt || !policy.approvedBy ||
    policy.direction !== "ONE_WAY" || policy.syncInventory || policy.syncPrices || policy.syncVariants ||
    !policy.syncProduct || !policy.fields.length ||
    policy.fields.some((f) => !(AUTOMATIC_FIELDS as readonly string[]).includes(f)))
    throw new SyncError("CONSENT_SCOPE", "Automatic consent supports active one-way descriptive product fields only.");
  const context = await requireWorkspace({
    shop: policy.sourceShopDomain, userId: "automatic-system", role: "OWNER",
  }, db);
  if (context.workspaceId !== policy.workspaceId || !context.connections.some((c) => c.shopDomain === policy.targetShopDomain))
    throw new SyncError("TENANT_DENIED", "The approved store pair changed.");
  const maps = await db.productMapping.findMany({
    where: { workspaceId: policy.workspaceId, sourceShopDomain: policy.sourceShopDomain, targetShopDomain: policy.targetShopDomain },
    orderBy: { id: "asc" },
  });
  if (!maps.length || maps.some((m) => !m.verifiedAt))
    throw new SyncError("MAPPING_MISSING", "Verify every product mapping before granting automatic consent.");
  const fingerprint = automationFingerprint({
    id: policy.id, workspaceId: policy.workspaceId, source: policy.sourceShopDomain,
    target: policy.targetShopDomain, fields: [...policy.fields].sort(), updatedAt: policy.updatedAt.toISOString(),
    pair: context.pair.id,
  }, maps.map((m) => ({ id: m.id, source: m.sourceProductGid, target: m.targetProductGid, verifiedAt: m.verifiedAt?.toISOString() })));
  return { policy, fingerprint };
}

export async function getAutomaticConsents(actor: Actor) {
  const connection = await prisma.shopConnection.findUnique({ where: { shopDomain: actor.shop } });
  const context = connection?.workspaceId ? await requireWorkspace(actor) : null;
  const workspaceId = context?.workspaceId ?? "__unpaired__";
  const [consents, policies, previews] = await Promise.all([
    prisma.automaticConsent.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.syncPolicy.findMany({ where: { workspaceId, enabled: true, status: "ACTIVE", syncProduct: true, syncInventory: false, syncPrices: false, syncVariants: false }, orderBy: { id: "asc" } }),
    prisma.syncPreview.findMany({ where: { workspaceId, status: { in: ["PENDING", "APPLIED"] }, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return { consents, policies, previews, canManage: actor.role === "OWNER", enabled: process.env.AUTOMATIC_SYNC_ENABLED === "true" && process.env.SYNC_WRITE_ENABLED === "true" };
}

export async function grantAutomaticConsent(actor: Actor, input: unknown) {
  requireOwner(actor);
  enabled();
  const data = z.object({
    policyId: z.string().min(1).max(100), previewId: z.string().min(1).max(100),
    durationMinutes: z.number().int().min(5).max(1440), intervalMinutes: z.number().int().min(5).max(1440),
    maxJobs: z.number().int().min(1).max(100), maxChanges: z.number().int().min(1).max(1000),
    perRunChanges: z.number().int().min(1).max(100), confirmed: z.literal(true),
  }).strict().parse(input);
  const context = await requireWorkspace(actor);
  const reviewed = await prisma.syncPreview.findFirst({ where: { id: data.previewId, policyId: data.policyId, workspaceId: context.workspaceId, status: { in: ["PENDING", "APPLIED"] }, expiresAt: { gt: new Date() } } });
  if (!reviewed) throw new DomainError("PREVIEW_REQUIRED", "Review a fresh exact preview for this policy before granting consent.", 409);
  assertSafePreview(reviewed.changes);
  const beforeConfig = await configuration(data.policyId);
  const { buildPreview } = await import("./sync-engine.server");
  const current = await buildPreview(data.policyId);
  assertCurrentPlan(reviewed, current);
  if (stableHash(reviewed.changes) !== stableHash(current.changes))
    throw new DomainError("PREVIEW_STALE", "Review a fresh comparison before granting consent.", 409);
  return serial(async (tx) => {
    enabled();
    const fresh = await requireWorkspace(actor, tx);
    const { policy, fingerprint } = await configuration(data.policyId, tx);
    if (fingerprint !== beforeConfig.fingerprint) throw new DomainError("CONSENT_CHANGED", "Policy or mappings changed while granting consent.", 409);
    if (policy.workspaceId !== fresh.workspaceId) throw new DomainError("POLICY_NOT_FOUND", "Policy not found.", 404);
    const preview = await tx.syncPreview.findFirst({ where: { id: reviewed.id, workspaceId: fresh.workspaceId, expiresAt: { gt: new Date() }, status: { in: ["PENDING", "APPLIED"] } } });
    if (!preview) throw new DomainError("PREVIEW_EXPIRED", "The reviewed preview expired.", 409);
    assertAutomaticChanges(current.changes, policy.fields, data.maxChanges, data.perRunChanges);
    const owner = await tx.workspaceMember.findUnique({ where: { workspaceId_shopDomain_userId: { workspaceId: fresh.workspaceId, shopDomain: actor.shop, userId: actor.userId } } });
    if (owner?.status !== "ACTIVE" || owner.role !== "OWNER") throw new DomainError("OWNER_REQUIRED", "Active workspace owner membership is required.", 403);
    if (await tx.automaticConsent.count({ where: { policyId: policy.id, status: "ACTIVE" } }))
      throw new DomainError("CONSENT_EXISTS", "Revoke the current consent before replacing it.", 409);
    const consent = await tx.automaticConsent.create({ data: {
      workspaceId: fresh.workspaceId, policyId: policy.id, fingerprint, approvedBy: actorKey(actor), fields: policy.fields,
      expiresAt: new Date(Date.now() + data.durationMinutes * 60_000), intervalMinutes: data.intervalMinutes,
      maxJobs: data.maxJobs, maxChanges: data.maxChanges, perRunChanges: data.perRunChanges,
    } });
    await tx.auditEvent.create({ data: { workspaceId: fresh.workspaceId, shopDomain: actor.shop, actor: actorKey(actor), action: "AUTOMATIC_CONSENT_GRANTED", resourceType: "AutomaticConsent", resourceId: consent.id, details: { previewId: reviewed.id, fingerprint, maxJobs: data.maxJobs, maxChanges: data.maxChanges, perRunChanges: data.perRunChanges, expiresAt: consent.expiresAt.toISOString(), fields: consent.fields } } });
    return consent;
  });
}

export async function revokeAutomaticConsent(actor: Actor, id: string) {
  requireOwner(actor);
  return serial(async (tx) => {
    const { workspaceId } = await requireWorkspace(actor, tx);
    await tx.$queryRaw`SELECT id FROM "AutomaticConsent" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const consent = await tx.automaticConsent.findFirst({ where: { id, workspaceId } });
    if (!consent) throw new DomainError("CONSENT_NOT_FOUND", "Consent not found.", 404);
    await tx.automaticConsent.update({ where: { id }, data: { status: "REVOKED", revokedAt: new Date() } });
    await tx.syncJob.updateMany({ where: { workspaceId, payload: { path: ["consentId"], equals: id }, status: { in: ["PENDING", "RETRY", "RUNNING"] } }, data: { status: "CANCELLED", leaseOwner: null, leaseUntil: null, lastError: "AUTOMATIC_CONSENT_REVOKED" } });
    await tx.auditEvent.create({ data: { workspaceId, shopDomain: actor.shop, actor: actorKey(actor), action: "AUTOMATIC_CONSENT_REVOKED", resourceType: "AutomaticConsent", resourceId: id } });
  });
}

// Called inside the resource write transaction, holding this row until the mutation completes.
export async function assertJobConsent(job: SyncJob, db: Tx = prisma) {
  const payload = job.payload as { consentId?: string } | null;
  if (!payload?.consentId) return;
  enabled();
  await db.$queryRaw`SELECT id FROM "AutomaticConsent" WHERE id = ${payload.consentId} FOR UPDATE`;
  const consent = await db.automaticConsent.findUnique({ where: { id: payload.consentId } });
  if (!consent || consent.workspaceId !== job.workspaceId || consent.policyId !== job.policyId ||
    consent.status !== "ACTIVE" || consent.expiresAt <= new Date())
    throw new SyncError("CONSENT_REVOKED", "Automatic consent expired, was held, or was revoked.");
  const { policy, fingerprint } = await configuration(job.policyId, db);
  if (fingerprint !== consent.fingerprint) throw new SyncError("CONSENT_CHANGED", "Policy or mappings changed after automatic consent.");
  const colon = consent.approvedBy.lastIndexOf(":"), shopDomain = consent.approvedBy.slice(0, colon), userId = consent.approvedBy.slice(colon + 1);
  if (![policy.sourceShopDomain, policy.targetShopDomain].includes(shopDomain)) throw new SyncError("TENANT_DENIED", "Consent owner does not belong to this pair.");
  const member = await db.workspaceMember.findUnique({ where: { workspaceId_shopDomain_userId: { workspaceId: job.workspaceId, shopDomain, userId } } });
  if (member?.status !== "ACTIVE" || member.role !== "OWNER") throw new SyncError("CONSENT_REVOKED", "The consenting owner no longer has access.");
  return consent;
}

export async function scheduleAutomaticSync(now = new Date()) {
  if (process.env.AUTOMATIC_SYNC_ENABLED !== "true" || process.env.SYNC_WRITE_ENABLED !== "true") return 0;
  await prisma.automaticConsent.updateMany({ where: { status: "ACTIVE", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
  return prisma.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "AutomaticConsent" WHERE status = 'ACTIVE' AND "nextRunAt" <= ${now} AND "expiresAt" > ${now} ORDER BY "nextRunAt" LIMIT 25 FOR UPDATE SKIP LOCKED`;
    let queued = 0;
    for (const { id } of due) {
      const consent = await tx.automaticConsent.findUniqueOrThrow({ where: { id } });
      if (consent.usedJobs >= consent.maxJobs || consent.usedChanges >= consent.maxChanges) {
        // Keep ACTIVE until the last already-budgeted write finishes or expires.
        continue;
      }
      if (await tx.syncJob.count({ where: { policyId: consent.policyId, status: { in: ["PENDING", "RETRY", "RUNNING"] }, operation: { in: ["AUTO_PREVIEW", "APPLY_PREVIEW"] } } })) continue;
      const policy = await tx.syncPolicy.findUnique({ where: { id: consent.policyId } });
      if (!policy?.enabled || policy.status !== "ACTIVE") continue;
      await tx.syncJob.create({ data: { workspaceId: consent.workspaceId, policyId: consent.policyId, sourceShop: policy.sourceShopDomain, targetShop: policy.targetShopDomain, operation: "AUTO_PREVIEW", idempotencyKey: `automatic:${id}:${consent.nextRunAt.getTime()}`, payload: { consentId: id } } });
      await tx.automaticConsent.update({ where: { id }, data: { nextRunAt: new Date(now.getTime() + consent.intervalMinutes * 60_000) } });
      queued++;
    }
    return queued;
  });
}

export async function processAutomaticPreview(job: SyncJob, progress: () => Promise<void>) {
  await assertJobConsent(job);
  const { buildLivePreview } = await import("./sync-engine.server");
  const live = await buildLivePreview(job.policyId, progress);
  await progress();
  return serial(async (tx) => {
    const consent = await assertJobConsent(job, tx);
    if (!consent) throw new SyncError("CONSENT_REQUIRED", "An automatic job requires bounded consent.");
    const lease = await tx.syncJob.findFirst({ where: { id: job.id, status: "RUNNING", leaseOwner: job.leaseOwner, leaseUntil: { gt: new Date() } } });
    if (!lease) throw new SyncError("LEASE_LOST", "The automatic preview lease was revoked.");
    if (!live.changes.length) return;
    try {
      if (consent.usedJobs >= consent.maxJobs) throw new SyncError("CONSENT_BUDGET", "Automatic job budget is exhausted.");
      assertAutomaticChanges(live.changes, consent.fields, consent.maxChanges - consent.usedChanges, consent.perRunChanges);
    } catch (error) {
      if (!(error instanceof SyncError)) throw error;
      await tx.automaticConsent.update({ where: { id: consent.id }, data: { status: "HELD" } });
      await tx.auditEvent.create({ data: { workspaceId: job.workspaceId, actor: "system:automatic-sync", action: "AUTOMATIC_CONSENT_HELD", resourceType: "AutomaticConsent", resourceId: consent.id, details: { code: error.code, changes: live.changes.length } } });
      return;
    }
    const preview = await tx.syncPreview.create({ data: { workspaceId: job.workspaceId, policyId: job.policyId, createdBy: "system:automatic-sync", approvedBy: consent.approvedBy, approvedAt: new Date(), status: "APPROVED", sourceHash: live.sourceHash, targetHash: live.targetHash, changes: live.changes as Prisma.InputJsonValue, expiresAt: new Date(Math.min(consent.expiresAt.getTime(), Date.now() + 15 * 60_000)) } });
    await tx.syncJob.create({ data: { workspaceId: job.workspaceId, policyId: job.policyId, sourceShop: job.sourceShop, targetShop: job.targetShop, previewId: preview.id, operation: "APPLY_PREVIEW", idempotencyKey: `automatic-apply:${job.id}`, payload: { previewId: preview.id, consentId: consent.id } } });
    await tx.automaticConsent.update({ where: { id: consent.id }, data: { usedJobs: { increment: 1 }, usedChanges: { increment: live.changes.length } } });
    await tx.auditEvent.create({ data: { workspaceId: job.workspaceId, actor: consent.approvedBy, action: "AUTOMATIC_PLAN_APPROVED", resourceType: "SyncPreview", resourceId: preview.id, details: { consentId: consent.id, changes: live.changes.length } } });
  });
}
