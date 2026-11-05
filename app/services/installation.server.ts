import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { normalizeShop } from "../domain/guards";

/**
 * Standing automatic consent ends with the authority it was granted under.
 * HELD rows are revoked too, so no leftover row looks reusable or blocks a
 * fresh grant with CONSENT_EXISTS. Call it before cancelling queued jobs: the
 * scheduler skips consent rows locked here, so it cannot queue a run between.
 * Returns the revoked ids, for callers that cancel only the runs they carried.
 */
export async function revokeStandingConsents(
  tx: Prisma.TransactionClient,
  scope: { workspaceId: string; policyId?: string },
  audit: { actor: string; shopDomain: string; reason: string },
) {
  const revoked = await tx.automaticConsent.updateManyAndReturn({
    where: {
      workspaceId: scope.workspaceId,
      ...(scope.policyId ? { policyId: scope.policyId } : {}),
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

/** Called only after Shopify's webhook authenticator verifies the body. */
export async function revokeInstallation(shopDomain: string) {
  const shop = normalizeShop(shopDomain);
  return prisma.$transaction(async (tx) => {
    const connection = await tx.shopConnection.findUnique({
      where: { shopDomain: shop },
    });
    const workspaceId = connection?.workspaceId;
    // Lifecycle cleanup is independent of the presence of an offline session:
    // Shopify may deliver an uninstall again after tokens have been removed.
    await tx.session.deleteMany({ where: { shop } });
    await tx.shopConnection.updateMany({
      where: { shopDomain: shop },
      data: {
        status: "UNINSTALLED",
        uninstalledAt: new Date(),
        workspaceId: null,
      },
    });
    if (workspaceId)
      await revokeStandingConsents(
        tx,
        { workspaceId },
        {
          actor: "shopify:webhook",
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
        data: { status: "REVOKED", revokedAt: new Date() },
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
          actor: "shopify:webhook",
          action: "APP_UNINSTALLED",
          resourceType: "ShopConnection",
          resourceId: connection?.id,
        },
      });
  });
}

export async function updateInstallationScopes(
  shopDomain: string,
  current: string[],
) {
  const shop = normalizeShop(shopDomain);
  return prisma.$transaction(async (tx) => {
    const scope = [...new Set(current)].sort().join(",");
    await tx.session.updateMany({ where: { shop }, data: { scope } });
    await tx.shopConnection.updateMany({
      where: { shopDomain: shop },
      data: { scopes: scope },
    });
    const connection = await tx.shopConnection.findUnique({
      where: { shopDomain: shop },
    });
    if (connection?.workspaceId) {
      await revokeStandingConsents(
        tx,
        { workspaceId: connection.workspaceId },
        {
          actor: "shopify:webhook",
          shopDomain: shop,
          reason: "SCOPES_CHANGED",
        },
      );
      await tx.syncPolicy.updateMany({
        where: { workspaceId: connection.workspaceId },
        data: { enabled: false, status: "PAUSED" },
      });
      await tx.syncPreview.updateMany({
        where: {
          workspaceId: connection.workspaceId,
          status: { in: ["PENDING", "APPROVED"] },
        },
        data: { status: "REVOKED" },
      });
      await tx.syncJob.updateMany({
        where: {
          workspaceId: connection.workspaceId,
          operation: { in: ["APPLY_PREVIEW", "AUTO_PREVIEW"] },
          status: { in: ["PENDING", "RETRY", "RUNNING"] },
        },
        data: {
          status: "CANCELLED",
          leaseUntil: null,
          leaseOwner: null,
          lastError:
            "SCOPES_CHANGED: Revalidate permissions and approve a new plan.",
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        workspaceId: connection?.workspaceId,
        shopDomain: shop,
        actor: "shopify:webhook",
        action: "SCOPES_CHANGED",
        resourceType: "ShopConnection",
        resourceId: connection?.id,
        details: { scopes: current },
      },
    });
  });
}
