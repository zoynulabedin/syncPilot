import type { Prisma, ShopConnection } from "@prisma/client";
import prisma from "../db.server";
import { normalizeShop } from "../domain/guards";
import { databaseNow } from "./database-clock.server";
import { rejectWebhook } from "./webhook-verification.server";

type Tx = Prisma.TransactionClient;
const WEBHOOK_ACTOR = "shopify:webhook";
const SIGN_IN_ACTOR = "shopify:sign-in";
/**
 * Shopify's signature on a link or a sign-in stays valid for 90 seconds, so a signed
 * visit can follow a real uninstall by that long. Later ones show the app was
 * installed again.
 */
const SIGNED_VISIT_TOLERANCE_MS = 2 * 60_000;
/** Shopify retries for four hours and documents deliveries up to a day late. */
const MAX_UNINSTALL_AGE_MS = 48 * 3_600_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Standing automatic consent ends with the authority it was granted under.
 * HELD rows are revoked too, so no leftover row looks reusable or blocks a
 * fresh grant with CONSENT_EXISTS. Call it before cancelling queued jobs: the
 * scheduler skips consent rows locked here, so it cannot queue a run between.
 * Returns the revoked ids, for callers that cancel only the runs they carried.
 */
export async function revokeStandingConsents(
  tx: Prisma.TransactionClient,
  scope: { workspaceId: string; policyId?: string; approvedBy?: string },
  audit: { actor: string; shopDomain: string; reason: string },
) {
  const revoked = await tx.automaticConsent.updateManyAndReturn({
    where: {
      workspaceId: scope.workspaceId,
      ...(scope.policyId ? { policyId: scope.policyId } : {}),
      ...(scope.approvedBy ? { approvedBy: scope.approvedBy } : {}),
      status: { in: ["ACTIVE", "HELD"] },
    },
    data: { status: "REVOKED", revokedAt: new Date() },
    select: { id: true },
  });
  if (revoked.length)
    await tx.auditEvent.createMany({
      data: revoked.map(({ id }) => ({
        workspaceId: scope.workspaceId,
        shopDomain: audit.shopDomain,
        actor: audit.actor,
        action: "AUTOMATIC_CONSENT_REVOKED",
        resourceType: "AutomaticConsent",
        resourceId: id,
        details: { reason: audit.reason },
      })),
    });
  return revoked.map(({ id }) => id);
}

/** Serializes a lifecycle delivery with a reinstall or another delivery. */
async function lockConnection(tx: Tx, shop: string) {
  await tx.$queryRaw`SELECT id FROM "ShopConnection" WHERE "shopDomain" = ${shop} FOR UPDATE`;
  return tx.shopConnection.findUnique({ where: { shopDomain: shop } });
}

/** Stops everything that writes under standing authority; the pair stays. */
async function pauseWriteAuthority(
  tx: Tx,
  workspaceId: string,
  shop: string,
  actor: string,
  reason: string,
  lastError: string,
) {
  await revokeStandingConsents(
    tx,
    { workspaceId },
    { actor, shopDomain: shop, reason },
  );
  await tx.syncPolicy.updateMany({
    where: { workspaceId },
    data: { enabled: false, status: "PAUSED" },
  });
  await tx.syncPreview.updateMany({
    where: { workspaceId, status: { in: ["PENDING", "APPROVED"] } },
    data: { status: "REVOKED" },
  });
  await tx.syncJob.updateMany({
    where: {
      workspaceId,
      operation: { in: ["APPLY_PREVIEW", "AUTO_PREVIEW"] },
      status: { in: ["PENDING", "RETRY", "RUNNING"] },
    },
    data: {
      status: "CANCELLED",
      leaseUntil: null,
      leaseOwner: null,
      lastError,
    },
  });
}

/** One row per event: a repeated delivery of it adds nothing to the trail. */
async function auditIgnoredDelivery(
  tx: Tx,
  connection: ShopConnection,
  actor: string,
  action: string,
  deliveredFor: Date,
  details: Record<string, string | undefined>,
) {
  const iso = deliveredFor.toISOString();
  const seen = await tx.auditEvent.findFirst({
    where: {
      shopDomain: connection.shopDomain,
      action,
      details: { path: ["deliveredFor"], equals: iso },
    },
    select: { id: true },
  });
  if (seen) return;
  await tx.auditEvent.create({
    data: {
      workspaceId: connection.workspaceId,
      shopDomain: connection.shopDomain,
      actor,
      action,
      resourceType: "ShopConnection",
      resourceId: connection.id,
      details: { deliveredFor: iso, ...details },
    },
  });
}

/**
 * Arrival order means nothing: Shopify retries a failed delivery for hours. The
 * first check mirrors the reinstall guard in privacy.server.ts. The second is
 * for an uninstall the app never processed, which leaves no reinstall to see:
 * the delivery failed, the merchant reinstalled and opened the app, and only
 * then did the retry arrive. Either way this store is live and keeps its sessions.
 */
function staleUninstall(connection: ShopConnection, triggeredAt: Date) {
  if (connection.status !== "CONNECTED" || connection.uninstalledAt)
    return null;
  if (triggeredAt < connection.installedAt) return "OLDER_THAN_INSTALLATION";
  return triggeredAt.getTime() <
    connection.lastSeenAt.getTime() - SIGNED_VISIT_TOLERANCE_MS
    ? "OLDER_THAN_SIGNED_IN_ACTIVITY"
    : null;
}

/**
 * Shopify just vouched for this store: it signed a link to the app or a sign-in,
 * and it does neither for an app that is not installed. This time decides whether
 * a late uninstall is older than the store's current installation, so a page
 * opened on a session cookie must not move it: that cookie outlives an uninstall
 * until the delivery arrives, and would make the delivery look stale.
 */
export async function recordSignedVisit(shop: string) {
  await prisma.shopConnection.updateMany({
    where: { shopDomain: shop, status: "CONNECTED", uninstalledAt: null },
    data: { lastSeenAt: await databaseNow() },
  });
}

/**
 * Shopify says who owns a store only when it grants a sign-in, and an owner's
 * WorkspaceMember row, made at pairing, changes for nothing else. So a grant saying
 * this person is not the owner ends what that row carried: the consents they gave
 * here, and through the row itself the plans they approved, which the write path
 * rechecks against it. The other store's owner keeps theirs. The row stops being
 * OWNER, or setMember could not give this person staff access later.
 */
export async function endFormerOwnerAuthority(shop: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const ended = await tx.workspaceMember.updateManyAndReturn({
      where: { shopDomain: shop, userId, role: "OWNER", status: "ACTIVE" },
      data: { role: "VIEWER", status: "REVOKED" },
      select: { id: true, workspaceId: true },
    });
    for (const { id, workspaceId } of ended) {
      const revoked = await revokeStandingConsents(
        tx,
        { workspaceId, approvedBy: `${shop}:${userId}` },
        { actor: SIGN_IN_ACTOR, shopDomain: shop, reason: "OWNER_ROLE_ENDED" },
      );
      if (revoked.length)
        await tx.syncJob.updateMany({
          where: {
            workspaceId,
            status: { in: ["PENDING", "RETRY", "RUNNING"] },
            OR: revoked.map((consentId) => ({
              payload: { path: ["consentId"], equals: consentId },
            })),
          },
          data: {
            status: "CANCELLED",
            leaseUntil: null,
            leaseOwner: null,
            lastError: "AUTOMATIC_CONSENT_REVOKED",
          },
        });
      await tx.auditEvent.create({
        data: {
          workspaceId,
          shopDomain: shop,
          actor: SIGN_IN_ACTOR,
          action: "OWNER_ROLE_ENDED",
          resourceType: "WorkspaceMember",
          resourceId: id,
          details: { userId },
        },
      });
    }
    return ended.length;
  });
}

/** Called only after Shopify's webhook authenticator verifies the body. */
export async function revokeInstallation(
  shopDomain: string,
  delivery: { triggeredAt?: Date; webhookId?: string; eventId?: string } = {},
) {
  const shop = normalizeShop(shopDomain);
  const { triggeredAt, webhookId, eventId } = delivery;
  return prisma.$transaction(async (tx) => {
    const connection = await lockConnection(tx, shop);
    const now = await databaseNow(tx);
    if (connection && triggeredAt) {
      // A repeat of the uninstall already handled. Moving uninstalledAt would
      // also make the erasure guard hold a redaction it has already received.
      if (connection.uninstalledAt && triggeredAt <= connection.uninstalledAt)
        return { revoked: false, reason: "ALREADY_UNINSTALLED" };
      const stale = staleUninstall(connection, triggeredAt);
      if (stale) {
        // Authority granted before an uninstall the app never saw ends with it.
        if (stale === "OLDER_THAN_SIGNED_IN_ACTIVITY" && connection.workspaceId)
          await pauseWriteAuthority(
            tx,
            connection.workspaceId,
            shop,
            WEBHOOK_ACTOR,
            "APP_UNINSTALLED",
            "UNINSTALLED: The store was uninstalled and reinstalled. Review and approve a new plan.",
          );
        await auditIgnoredDelivery(
          tx,
          connection,
          WEBHOOK_ACTOR,
          "APP_UNINSTALL_IGNORED",
          triggeredAt,
          { reason: stale, webhookId, eventId },
        );
        return { revoked: false, reason: stale };
      }
    }
    if (
      triggeredAt &&
      (now.getTime() - triggeredAt.getTime() > MAX_UNINSTALL_AGE_MS ||
        triggeredAt.getTime() - now.getTime() > MAX_CLOCK_SKEW_MS)
    )
      throw rejectWebhook("WEBHOOK_DELIVERY_TIME_INVALID", {
        topic: "APP_UNINSTALLED",
        shop,
      });
    const workspaceId = connection?.workspaceId;
    // Lifecycle cleanup is independent of the presence of an offline session:
    // Shopify may deliver an uninstall again after tokens have been removed.
    await tx.session.deleteMany({ where: { shop } });
    await tx.shopConnection.updateMany({
      where: { shopDomain: shop },
      data: {
        status: "UNINSTALLED",
        // Not before the event, so a repeat of it is always recognized above.
        uninstalledAt: triggeredAt && triggeredAt > now ? triggeredAt : now,
        workspaceId: null,
      },
    });
    if (workspaceId)
      await revokeStandingConsents(
        tx,
        { workspaceId },
        {
          actor: WEBHOOK_ACTOR,
          shopDomain: shop,
          reason: "APP_UNINSTALLED",
        },
      );
    await tx.syncJob.updateMany({
      where: {
        OR: [
          { sourceShop: shop },
          { targetShop: shop },
          ...(workspaceId ? [{ workspaceId }] : []),
        ],
        status: { in: ["PENDING", "RETRY", "RUNNING", "HELD"] },
      },
      data: {
        status: "CANCELLED",
        leaseUntil: null,
        leaseOwner: null,
        lastError: "UNINSTALLED: A participating installation was removed.",
      },
    });
    await tx.storePairingRequest.updateMany({
      where: {
        OR: [{ initiatingShop: shop }, { destinationShop: shop }],
        state: { in: ["PENDING", "ACCEPTED"] },
      },
      data: { state: "REVOKED", challengeHash: null },
    });
    if (workspaceId) {
      await tx.syncPolicy.updateMany({
        where: { workspaceId },
        data: { enabled: false, status: "PAUSED" },
      });
      await tx.syncPreview.updateMany({
        where: { workspaceId, status: { in: ["PENDING", "APPROVED"] } },
        data: { status: "REVOKED" },
      });
      await tx.storePair.updateMany({
        where: { workspaceId, status: "VERIFIED" },
        data: { status: "REVOKED", revokedAt: now },
      });
      await tx.shopConnection.updateMany({
        where: { workspaceId },
        data: { workspaceId: null },
      });
      await tx.workspaceMember.updateMany({
        where: { workspaceId },
        data: { status: "REVOKED" },
      });
      await tx.workspace.update({
        where: { id: workspaceId },
        data: { state: "REVOKED" },
      });
    }
    if (connection?.status !== "UNINSTALLED")
      await tx.auditEvent.create({
        data: {
          workspaceId,
          shopDomain: shop,
          actor: WEBHOOK_ACTOR,
          action: "APP_UNINSTALLED",
          resourceType: "ShopConnection",
          resourceId: connection?.id,
          details: {
            triggeredAt: triggeredAt?.toISOString(),
            webhookId,
            eventId,
          },
        },
      });
    return { revoked: true };
  });
}

/**
 * A store comes back when Shopify has issued it new sessions. A page that
 * authenticated just before an uninstall committed finds them deleted and must
 * not bring the store back. Reinstalling starts a new installation, which is
 * what older lifecycle deliveries are compared with, and nothing checked or
 * granted for the previous one still holds.
 */
export async function reactivateInstallation(shop: string) {
  return prisma.$transaction(async (tx) => {
    const connection = await lockConnection(tx, shop);
    if (!connection) return null;
    if (
      (connection.status === "CONNECTED" && !connection.uninstalledAt) ||
      !(await tx.session.count({ where: { shop } }))
    )
      return connection;
    const now = await databaseNow(tx);
    await tx.auditEvent.create({
      data: {
        shopDomain: shop,
        actor: "shopify:session",
        action: "APP_REINSTALLED",
        resourceType: "ShopConnection",
        resourceId: connection.id,
      },
    });
    return tx.shopConnection.update({
      where: { shopDomain: shop },
      data: {
        status: "CONNECTED",
        uninstalledAt: null,
        installedAt: now,
        lastSeenAt: now,
        verifiedAt: null,
        scopes: null,
        scopesUpdatedAt: null,
        lastError: null,
      },
    });
  });
}

const shopGidOf = (id: string | number | undefined) =>
  id === undefined || String(id).startsWith("gid://")
    ? id
    : `gid://shopify/Shop/${id}`;

/**
 * Shopify documents no ordering, so the payload's signed updated_at decides. The
 * body names the store only by shop_id: it is checked once a catalog import or
 * verification has recorded this store's ID, and cannot be before that. `actor`
 * is who found the change, for a caller that is not Shopify's webhook.
 */
export async function updateInstallationScopes(
  shopDomain: string,
  current: string[],
  delivery: {
    updatedAt?: Date;
    shopId?: string | number;
    webhookId?: string;
    actor?: string;
  } = {},
) {
  const shop = normalizeShop(shopDomain);
  const { updatedAt, webhookId, actor = WEBHOOK_ACTOR } = delivery;
  const signedShop = shopGidOf(delivery.shopId);
  return prisma.$transaction(async (tx) => {
    const scope = [...new Set(current)].sort().join(",");
    const connection = await lockConnection(tx, shop);
    if (connection?.shopGid && signedShop && signedShop !== connection.shopGid)
      throw rejectWebhook("WEBHOOK_SHOP_MISMATCH", {
        topic: "APP_SCOPES_UPDATE",
        shop,
      });
    if (connection && updatedAt) {
      const applied = connection.scopesUpdatedAt;
      if (
        applied?.getTime() === updatedAt.getTime() &&
        connection.scopes === scope
      )
        return { applied: false, reason: "DUPLICATE" };
      const stale =
        updatedAt < connection.installedAt
          ? "OLDER_THAN_INSTALLATION"
          : applied && updatedAt < applied
            ? "OLDER_THAN_LAST_APPLIED"
            : null;
      if (stale) {
        await auditIgnoredDelivery(
          tx,
          connection,
          actor,
          "SCOPES_UPDATE_IGNORED",
          updatedAt,
          { reason: stale, webhookId },
        );
        return { applied: false, reason: stale };
      }
    }
    await tx.session.updateMany({ where: { shop }, data: { scope } });
    await tx.shopConnection.updateMany({
      where: { shopDomain: shop },
      data: {
        scopes: scope,
        scopesUpdatedAt: updatedAt ?? (await databaseNow(tx)),
      },
    });
    if (connection?.workspaceId)
      await pauseWriteAuthority(
        tx,
        connection.workspaceId,
        shop,
        actor,
        "SCOPES_CHANGED",
        "SCOPES_CHANGED: Revalidate permissions and approve a new plan.",
      );
    await tx.auditEvent.create({
      data: {
        workspaceId: connection?.workspaceId,
        shopDomain: shop,
        actor,
        action: "SCOPES_CHANGED",
        resourceType: "ShopConnection",
        resourceId: connection?.id,
        details: {
          scopes: current,
          updatedAt: updatedAt?.toISOString(),
          webhookId,
        },
      },
    });
    return { applied: true };
  });
}
