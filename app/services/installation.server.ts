import prisma from "../db.server";
import { normalizeShop } from "../domain/guards";

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
          operation: "APPLY_PREVIEW",
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
