import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { normalizeShop } from "../domain/guards";
import { databaseNow } from "./database-clock.server";

export const PRIVACY_TOPICS = [
  "SHOP_REDACT",
  "CUSTOMERS_REDACT",
  "CUSTOMERS_DATA_REQUEST",
];
/**
 * Shopify sends shop/redact 48 hours after an uninstall and allows 30 days to act
 * on it. Erasure cannot be undone, and neither delivery's headers are signed, so
 * captured bodies replayed together must not erase a live store in one worker
 * cycle. A request waits out the same 48 hours from the uninstall recorded here,
 * and a reinstall in that time holds it for review.
 */
const ERASURE_HOLD_MS = 48 * 3_600_000;
const erasureCutoff = (now: Date) => new Date(now.getTime() - ERASURE_HOLD_MS);

/** Call only with the topic/shop returned by Shopify's webhook authenticator. Never persist its payload. */
export async function receivePrivacyRequest(
  shopDomain: string,
  topic: string,
  deliveryId: string,
) {
  const shop = normalizeShop(shopDomain);
  if (!PRIVACY_TOPICS.includes(topic) || !deliveryId || deliveryId.length > 200)
    throw new Response("Invalid privacy delivery", { status: 400 });
  const customerRequest = topic !== "SHOP_REDACT";
  const deliveryKey = createHash("sha256")
    .update(`${shop}:${deliveryId}`)
    .digest("hex");
  await prisma.privacyRequest.createMany({
    data: {
      deliveryKey,
      shopDomain: shop,
      topic,
      ...(customerRequest
        ? {
            status: "COMPLETED",
            outcome: "NO_CUSTOMER_DATA_STORED",
            completedAt: new Date(),
          }
        : {}),
    },
    skipDuplicates: true,
  });
  return prisma.privacyRequest.findUniqueOrThrow({ where: { deliveryKey } });
}

/** Erase store-specific data and revoke shared state, preserving every other shop's private catalog and sessions. */
export async function processPrivacyRequest(id: string) {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "PrivacyRequest" WHERE id = ${id} AND status = 'PENDING' FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return false;
      const request = await tx.privacyRequest.findUniqueOrThrow({
        where: { id },
      });
      if (!request.shopDomain || request.topic !== "SHOP_REDACT") return false;
      const shop = request.shopDomain;
      const connection = await tx.shopConnection.findUnique({
        where: { shopDomain: shop },
      });
      if (
        connection &&
        (connection.status !== "UNINSTALLED" ||
          !connection.uninstalledAt ||
          connection.uninstalledAt > request.receivedAt)
      ) {
        await tx.privacyRequest.update({
          where: { id },
          data: {
            status: "HELD",
            outcome: "INSTALLATION_CHANGED_REVIEW_REQUIRED",
          },
        });
        return false;
      }
      if (
        connection?.uninstalledAt &&
        connection.uninstalledAt > erasureCutoff(await databaseNow(tx))
      )
        return false;
      // Uninstall detaches connections, so discover historical workspace references too.
      const [
        members,
        pairs,
        policies,
        products,
        variants,
        locations,
        jobs,
        audits,
      ] = await Promise.all([
        tx.workspaceMember.findMany({
          where: { shopDomain: shop },
          select: { workspaceId: true },
        }),
        tx.storePair.findMany({
          where: { OR: [{ sourceShop: shop }, { targetShop: shop }] },
          select: { workspaceId: true },
        }),
        tx.syncPolicy.findMany({
          where: {
            OR: [{ sourceShopDomain: shop }, { targetShopDomain: shop }],
          },
          select: { workspaceId: true },
        }),
        tx.productMapping.findMany({
          where: {
            OR: [{ sourceShopDomain: shop }, { targetShopDomain: shop }],
          },
          select: { workspaceId: true },
          distinct: ["workspaceId"],
        }),
        tx.variantMapping.findMany({
          where: {
            OR: [{ sourceShopDomain: shop }, { targetShopDomain: shop }],
          },
          select: { workspaceId: true },
          distinct: ["workspaceId"],
        }),
        tx.locationMapping.findMany({
          where: {
            OR: [{ sourceShopDomain: shop }, { targetShopDomain: shop }],
          },
          select: { workspaceId: true },
          distinct: ["workspaceId"],
        }),
        tx.syncJob.findMany({
          where: { OR: [{ sourceShop: shop }, { targetShop: shop }] },
          select: { workspaceId: true },
          distinct: ["workspaceId"],
        }),
        tx.auditEvent.findMany({
          where: { shopDomain: shop, workspaceId: { not: null } },
          select: { workspaceId: true },
          distinct: ["workspaceId"],
        }),
      ]);
      const ids = [
        ...new Set(
          [
            connection?.workspaceId,
            ...[
              ...members,
              ...pairs,
              ...policies,
              ...products,
              ...variants,
              ...locations,
              ...jobs,
              ...audits,
            ].map((row) => row.workspaceId),
          ].filter((value): value is string => !!value),
        ),
      ];
      const workspace = { workspaceId: { in: ids } };
      await tx.shopConnection.updateMany({
        where: workspace,
        data: { workspaceId: null },
      });
      await tx.syncJob.deleteMany({
        where: { OR: [workspace, { sourceShop: shop }, { targetShop: shop }] },
      });
      await tx.syncConflict.deleteMany({ where: workspace });
      await tx.syncPreview.deleteMany({ where: workspace });
      await tx.reconciliationRun.deleteMany({ where: workspace });
      await tx.notificationSetting.deleteMany({ where: workspace });
      await tx.productMapping.deleteMany({ where: workspace });
      await tx.variantMapping.deleteMany({ where: workspace });
      await tx.locationMapping.deleteMany({ where: workspace });
      await tx.automaticConsent.deleteMany({ where: workspace });
      await tx.stockPool.deleteMany({ where: workspace });
      await tx.syncPolicy.deleteMany({ where: workspace });
      await tx.storePair.deleteMany({ where: workspace });
      await tx.workspaceMember.deleteMany({ where: workspace });
      await tx.auditEvent.deleteMany({
        where: { OR: [workspace, { shopDomain: shop }] },
      });
      await tx.storePairingRequest.deleteMany({
        where: { OR: [{ initiatingShop: shop }, { destinationShop: shop }] },
      });
      await tx.workspace.deleteMany({ where: { id: { in: ids } } });
      await tx.inventorySnapshot.deleteMany({ where: { shopDomain: shop } });
      await tx.variantSnapshot.deleteMany({ where: { shopDomain: shop } });
      await tx.productSnapshot.deleteMany({ where: { shopDomain: shop } });
      await tx.locationSnapshot.deleteMany({ where: { shopDomain: shop } });
      await tx.catalogSnapshot.deleteMany({ where: { shopDomain: shop } });
      await tx.catalogOperation.deleteMany({ where: { shopDomain: shop } });
      await tx.webhookEvent.deleteMany({ where: { shopDomain: shop } });
      await tx.session.deleteMany({ where: { shop } });
      await tx.shopConnection.deleteMany({ where: { shopDomain: shop } });
      await tx.privacyRequest.updateMany({
        where: { shopDomain: shop },
        data: {
          shopDomain: null,
          status: "COMPLETED",
          outcome: "SHOP_DATA_ERASED",
          completedAt: new Date(),
        },
      });
      return true;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 30_000,
    },
  );
}

export async function processPrivacyRequests() {
  // A request inside the hold stays PENDING. Left in the batch, ten of them would
  // keep any request that is due from ever being reached.
  const cutoff = erasureCutoff(await databaseNow());
  const requests = await prisma.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM "PrivacyRequest" r
    LEFT JOIN "ShopConnection" c ON c."shopDomain" = r."shopDomain"
    WHERE r.status = 'PENDING'
      AND (c."uninstalledAt" IS NULL OR c."uninstalledAt" <= ${cutoff})
    ORDER BY r."receivedAt", r.id
    LIMIT 10`;
  let completed = 0;
  for (const request of requests)
    if (await processPrivacyRequest(request.id)) completed++;
  return completed;
}
