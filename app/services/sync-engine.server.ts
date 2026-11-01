import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Prisma, PrismaClient, SyncJob, SyncPolicy } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.server";
import { DomainError } from "../domain/guards";
import {
  assertCurrentPlan,
  assertWriteGates,
  buildSyncPreview,
  money,
  mutationErrors,
  retryDelay,
  sameValue,
  stableHash,
  SyncError,
  type CatalogRecords,
  type Json,
  type Mappings,
  type ProductRecord,
  type SyncChange,
  type VariantRecord,
} from "../domain/sync";
import {
  INVENTORY_LEVEL_QUERY,
  INVENTORY_SET,
  PRODUCT_UPDATE,
  RESOURCES_QUERY,
  SHOP_QUERY,
  VARIANT_UPDATE,
} from "../domain/sync-operations";
import {
  executeCatalogImport,
  enqueueSystemImport,
  productSchema,
  variantSchema,
} from "./catalog.server";
import { shopifyRequest } from "./shopify-client.server";
import { logger } from "./logger.server";

type Database = PrismaClient | Prisma.TransactionClient;
const toJson = (value: unknown) => value as Prisma.InputJsonValue;
const LEASE_MS = 120_000;
const workerIdentity = `${hostname()}:${process.pid}:${randomUUID()}`;
const changeSchema = z.object({
  kind: z.enum(["PRODUCT", "PRICE", "INVENTORY", "HOLD"]),
  sourceId: z.string(),
  targetId: z.string().optional(),
  field: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  sourceProductId: z.string().optional(),
  targetProductId: z.string().optional(),
  sourceLocationId: z.string().optional(),
  targetLocationId: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});
const payloadObject = (payload: Prisma.JsonValue | null) =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};

async function policyContext(
  policyId: string,
  executing = false,
  db: Database = prisma,
) {
  const policy = await db.syncPolicy.findUnique({ where: { id: policyId } });
  if (!policy)
    throw new SyncError(
      "INVALID_INPUT",
      "The synchronization policy no longer exists.",
    );
  const workspace = await db.workspace.findUnique({
    where: { id: policy.workspaceId },
  });
  const connections = await db.shopConnection.findMany({
    where: {
      workspaceId: policy.workspaceId,
      status: "CONNECTED",
      uninstalledAt: null,
    },
  });
  if (
    workspace?.state !== "ACTIVE" ||
    connections.length !== 2 ||
    !connections.some((c) => c.shopDomain === policy.sourceShopDomain) ||
    !connections.some((c) => c.shopDomain === policy.targetShopDomain)
  )
    throw new SyncError(
      "NOT_PAIRED",
      "Both installations must be active members of this workspace.",
    );
  const pair = await db.storePair.findFirst({
    where: {
      workspaceId: policy.workspaceId,
      status: "VERIFIED",
      OR: [
        {
          sourceShop: policy.sourceShopDomain,
          targetShop: policy.targetShopDomain,
        },
        {
          sourceShop: policy.targetShopDomain,
          targetShop: policy.sourceShopDomain,
        },
      ],
    },
  });
  if (!pair)
    throw new SyncError(
      "NOT_PAIRED",
      "The two-store authorization was revoked.",
    );
  if (executing) {
    if (
      !policy.enabled ||
      policy.status !== "ACTIVE" ||
      !policy.approvedAt ||
      !policy.approvedBy
    )
      throw new SyncError(
        "POLICY_PAUSED",
        "This policy is not approved and active.",
      );
    await assertApprover(
      policy.approvedBy,
      policy.workspaceId,
      [policy.sourceShopDomain, policy.targetShopDomain],
      db,
    );
  }
  return { policy, connections, pair };
}
async function assertApprover(
  actorKey: string,
  workspaceId: string,
  shops: string[],
  db: Database = prisma,
) {
  const colon = actorKey.lastIndexOf(":");
  const shop = actorKey.slice(0, colon),
    userId = actorKey.slice(colon + 1);
  if (colon < 1 || !shops.includes(shop))
    throw new SyncError(
      "TENANT_DENIED",
      "Approval does not belong to this store pair.",
    );
  const member = await db.workspaceMember.findUnique({
    where: {
      workspaceId_shopDomain_userId: { workspaceId, shopDomain: shop, userId },
    },
  });
  if (!member || member.status !== "ACTIVE" || member.role !== "OWNER")
    throw new SyncError(
      "TENANT_DENIED",
      "The approving owner no longer has active workspace access.",
    );
}
async function mappings(
  policy: SyncPolicy,
  db: Database = prisma,
): Promise<Mappings> {
  const where = {
    workspaceId: policy.workspaceId,
    sourceShopDomain: policy.sourceShopDomain,
    targetShopDomain: policy.targetShopDomain,
  };
  const [products, variants, locations] = await Promise.all([
    db.productMapping.findMany({ where }),
    db.variantMapping.findMany({ where }),
    db.locationMapping.findMany({ where }),
  ]);
  return { products, variants, locations };
}
async function importedState(
  shop: string,
  maps: Mappings,
  source: boolean,
): Promise<CatalogRecords> {
  const latest = await prisma.catalogSnapshot.findFirst({
    where: { shopDomain: shop },
    orderBy: { startedAt: "desc" },
  });
  if (latest?.status !== "COMPLETED")
    throw new SyncError(
      "IMPORT_REQUIRED",
      "Complete the latest catalog import for both stores before comparing.",
    );
  const productIds = maps.products.map((m) =>
    source ? m.sourceProductGid : m.targetProductGid,
  );
  const variantIds = maps.variants.map((m) =>
    source ? m.sourceVariantGid : m.targetVariantGid,
  );
  const locationIds = maps.locations.map((m) =>
    source ? m.sourceLocationGid : m.targetLocationGid,
  );
  const itemIds = maps.variants
    .map((m) => (source ? m.sourceInventoryGid : m.targetInventoryGid))
    .filter((id): id is string => !!id);
  const [connection, products, variants, locations, inventory] =
    await Promise.all([
      prisma.shopConnection.findUnique({ where: { shopDomain: shop } }),
      prisma.productSnapshot.findMany({
        where: { shopDomain: shop, productGid: { in: productIds } },
      }),
      prisma.variantSnapshot.findMany({
        where: { shopDomain: shop, variantGid: { in: variantIds } },
      }),
      prisma.locationSnapshot.findMany({
        where: { shopDomain: shop, locationGid: { in: locationIds } },
      }),
      prisma.inventorySnapshot.findMany({
        where: {
          shopDomain: shop,
          inventoryItemGid: { in: itemIds },
          locationGid: { in: locationIds },
        },
      }),
    ]);
  return {
    currency: connection?.currency ?? products[0]?.currency ?? null,
    products: products.map((p) => ({
      id: p.productGid,
      title: p.title,
      status: p.status,
      handle: p.handle,
      descriptionHtml: p.descriptionHtml,
      vendor: p.vendor,
      productType: p.productType,
      tags: p.tags,
    })),
    variants: variants.map((v) => ({
      id: v.variantGid,
      product: { id: v.productGid },
      sku: v.sku,
      barcode: v.barcode,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      selectedOptions: Array.isArray(v.options)
        ? (v.options as { name: string; value: string }[])
        : [],
      inventoryItem: v.inventoryItemGid
        ? { id: v.inventoryItemGid, tracked: v.tracked }
        : null,
    })),
    locations: locations.map((l) => ({
      id: l.locationGid,
      name: l.name,
      isActive: l.isActive,
    })),
    inventory: inventory.map((l) => ({
      inventoryItemGid: l.inventoryItemGid,
      locationGid: l.locationGid,
      quantity: l.quantity,
    })),
  };
}
async function liveState(
  shop: string,
  maps: Mappings,
  source: boolean,
  inventoryEnabled: boolean,
  progress: () => Promise<void> = async () => {},
): Promise<CatalogRecords> {
  const { shop: info } = await shopifyRequest<{
    shop: { id: string; currencyCode: string };
  }>(shop, SHOP_QUERY);
  const records: CatalogRecords = {
    currency: info.currencyCode,
    products: [],
    variants: [],
    locations: [],
    inventory: [],
  };
  const ids = [
    ...new Set([
      ...maps.products.map((m) =>
        source ? m.sourceProductGid : m.targetProductGid,
      ),
      ...maps.variants.map((m) =>
        source ? m.sourceVariantGid : m.targetVariantGid,
      ),
      ...maps.locations.map((m) =>
        source ? m.sourceLocationGid : m.targetLocationGid,
      ),
    ]),
  ];
  for (let at = 0; at < ids.length; at += 100) {
    await progress();
    const { nodes } = await shopifyRequest<{ nodes: unknown[] }>(
      shop,
      RESOURCES_QUERY,
      { ids: ids.slice(at, at + 100) },
    );
    if (!Array.isArray(nodes))
      throw new SyncError(
        "PARTIAL_GRAPHQL_ERROR",
        "Shopify did not return resource nodes.",
      );
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if ("descriptionHtml" in node)
        records.products.push(productSchema.parse(node));
      else if ("selectedOptions" in node)
        records.variants.push(variantSchema.parse(node));
      else if ("isActive" in node)
        records.locations.push(
          z
            .object({ id: z.string(), name: z.string(), isActive: z.boolean() })
            .parse(node),
        );
    }
  }
  if (inventoryEnabled) {
    const itemIds = [
      ...new Set(
        maps.variants
          .map((m) => (source ? m.sourceInventoryGid : m.targetInventoryGid))
          .filter((id): id is string => !!id),
      ),
    ];
    const locationIds = maps.locations.map((m) =>
      source ? m.sourceLocationGid : m.targetLocationGid,
    );
    for (const id of itemIds)
      for (const locationId of locationIds) {
        await progress();
        const level = await readLevel(shop, id, locationId);
        if (level)
          records.inventory.push({
            inventoryItemGid: id,
            locationGid: locationId,
            quantity: level.quantity,
          });
      }
  }
  return records;
}
async function readLevel(shop: string, id: string, locationId: string) {
  type Level = {
    inventoryItem: {
      id: string;
      tracked: boolean;
      inventoryLevel: {
        location: { id: string; isActive: boolean };
        quantities: { name: string; quantity: number }[];
      } | null;
    } | null;
  };
  const body = await shopifyRequest<Level>(shop, INVENTORY_LEVEL_QUERY, {
    id,
    locationId,
  });
  const item = body.inventoryItem,
    level = item?.inventoryLevel;
  const value = level?.quantities.find((q) => q.name === "available");
  if (
    !item?.tracked ||
    !level?.location.isActive ||
    !value ||
    !Number.isSafeInteger(value.quantity)
  )
    return null;
  return { quantity: value.quantity };
}

/** Used by authenticated control-plane services. Never grants caller authorization itself. */
export async function buildPreview(policyId: string) {
  const { policy } = await policyContext(policyId);
  const maps = await mappings(policy);
  const [source, target] = await Promise.all([
    importedState(policy.sourceShopDomain, maps, true),
    importedState(policy.targetShopDomain, maps, false),
  ]);
  return buildSyncPreview(policy, maps, source, target);
}
async function buildLivePreview(
  policyId: string,
  progress: () => Promise<void> = async () => {},
) {
  const { policy } = await policyContext(policyId);
  const maps = await mappings(policy);
  const source = await liveState(
    policy.sourceShopDomain,
    maps,
    true,
    policy.syncInventory,
    progress,
  );
  const target = await liveState(
    policy.targetShopDomain,
    maps,
    false,
    policy.syncInventory,
    progress,
  );
  return buildSyncPreview(policy, maps, source, target);
}

async function renew(job: SyncJob, workerId: string) {
  const result = await prisma.syncJob.updateMany({
    where: {
      id: job.id,
      status: "RUNNING",
      leaseOwner: workerId,
      leaseUntil: { gt: new Date() },
    },
    data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
  });
  if (result.count !== 1)
    throw new SyncError(
      "LEASE_LOST",
      "This job was cancelled or its worker lease expired.",
    );
  await prisma.workerHeartbeat.updateMany({
    where: { id: workerId },
    data: { seenAt: new Date(), status: "RUNNING" },
  });
}
function groups(changes: SyncChange[]) {
  const grouped = new Map<string, SyncChange[]>();
  for (const change of changes) {
    if (!change.targetId || !change.field || change.kind === "HOLD")
      throw new SyncError(
        "INVALID_INPUT",
        "The approved plan contains an invalid or held change.",
      );
    const key = `${change.kind}:${change.targetId}:${change.targetLocationId ?? ""}`;
    grouped.set(key, [...(grouped.get(key) ?? []), change]);
  }
  return [...grouped.entries()];
}
async function readResource<T extends ProductRecord | VariantRecord>(
  shop: string,
  id: string,
  kind: "PRODUCT" | "PRICE",
) {
  const { nodes } = await shopifyRequest<{ nodes: unknown[] }>(
    shop,
    RESOURCES_QUERY,
    { ids: [id] },
  );
  const node = nodes?.[0];
  if (!node)
    throw new SyncError(
      "PRODUCT_NOT_FOUND",
      "A mapped resource was deleted or is no longer accessible.",
    );
  return (
    kind === "PRODUCT" ? productSchema.parse(node) : variantSchema.parse(node)
  ) as T;
}
function resourceValue(
  record: ProductRecord | VariantRecord,
  field: string,
): Json {
  if (!(field in record))
    throw new SyncError(
      "INVALID_INPUT",
      "The selected field is not supported by this writer.",
    );
  const value = (record as unknown as Record<string, Json>)[field];
  if (field === "price" || field === "compareAtPrice")
    return money(value as string | null);
  return field === "tags" && Array.isArray(value) ? [...value].sort() : value;
}
async function executeGroup(
  policy: SyncPolicy,
  changes: SyncChange[],
  job: SyncJob,
  key: string,
  workerId: string,
) {
  const first = changes[0];
  if (!first || first.kind === "HOLD")
    throw new SyncError("INVALID_INPUT", "A held change cannot be executed.");
  const kind = first.kind;
  await renew(job, workerId);
  await prisma.$transaction(
    async (tx) => {
      const lock = await tx.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtext(${`stock:${policy.targetShopDomain}:${first.targetId}:${first.targetLocationId ?? ""}`})) AS locked`;
      if (!lock[0]?.locked)
        throw new SyncError(
          "RESOURCE_BUSY",
          "Another worker is changing this resource.",
          true,
        );
      const current = await tx.syncJob.findFirst({
        where: {
          id: job.id,
          status: "RUNNING",
          leaseOwner: workerId,
          leaseUntil: { gt: new Date() },
        },
      });
      if (!current)
        throw new SyncError(
          "LEASE_LOST",
          "This job was cancelled or its worker lease expired.",
        );
      await policyContext(policy.id, true, tx);
      const approval = await tx.syncPreview.findFirst({
        where: {
          id: job.previewId ?? "",
          policyId: policy.id,
          workspaceId: policy.workspaceId,
          status: "APPROVED",
          expiresAt: { gt: new Date() },
        },
      });
      if (!approval?.approvedBy)
        throw new SyncError(
          "APPROVAL_REQUIRED",
          "The exact write approval expired or was revoked before this resource.",
        );
      await assertApprover(
        approval.approvedBy,
        policy.workspaceId,
        [policy.sourceShopDomain, policy.targetShopDomain],
        tx,
      );
      assertWriteGates(first.kind === "INVENTORY");
      // Check the exact mapping again after obtaining the single-writer resource lock.
      const maps = await mappings(policy, tx);
      if (
        first.kind === "PRODUCT" &&
        !maps.products.some(
          (m) =>
            m.verifiedAt &&
            m.sourceProductGid === first.sourceId &&
            m.targetProductGid === first.targetId,
        )
      )
        throw new SyncError(
          "MAPPING_MISSING",
          "Product mapping changed after preview.",
        );
      if (
        first.kind === "PRICE" &&
        !maps.variants.some(
          (m) =>
            m.verifiedAt &&
            m.sourceVariantGid === first.sourceId &&
            m.targetVariantGid === first.targetId,
        )
      )
        throw new SyncError(
          "MAPPING_MISSING",
          "Variant mapping changed after preview.",
        );
      if (
        first.kind === "INVENTORY" &&
        (!maps.variants.some(
          (m) =>
            m.verifiedAt &&
            m.sourceInventoryGid === first.sourceId &&
            m.targetInventoryGid === first.targetId,
        ) ||
          !maps.locations.some(
            (m) =>
              m.verifiedAt &&
              m.sourceLocationGid === first.sourceLocationId &&
              m.targetLocationGid === first.targetLocationId,
          ))
      )
        throw new SyncError(
          "MAPPING_MISSING",
          "Inventory or location mapping changed after preview.",
        );
      const verifyConsent = async () => {
        const active = await tx.syncJob.findFirst({
          where: {
            id: job.id,
            status: "RUNNING",
            leaseOwner: workerId,
            leaseUntil: { gt: new Date() },
          },
        });
        if (!active)
          throw new SyncError(
            "LEASE_LOST",
            "The job was cancelled or its worker lease expired.",
          );
        await policyContext(policy.id, true, tx);
        const exactApproval = await tx.syncPreview.findFirst({
          where: {
            id: job.previewId ?? "",
            policyId: policy.id,
            workspaceId: policy.workspaceId,
            status: "APPROVED",
            expiresAt: { gt: new Date() },
          },
        });
        if (!exactApproval?.approvedBy)
          throw new SyncError(
            "APPROVAL_REQUIRED",
            "Approval was revoked or expired while reading Shopify state.",
          );
        await assertApprover(
          exactApproval.approvedBy,
          policy.workspaceId,
          [policy.sourceShopDomain, policy.targetShopDomain],
          tx,
        );
        assertWriteGates(kind === "INVENTORY");
      };
      let mutationStarted = false;
      try {
        if (kind === "INVENTORY") {
          const from = await readLevel(
            policy.sourceShopDomain,
            first.sourceId,
            first.sourceLocationId!,
          );
          const to = await readLevel(
            policy.targetShopDomain,
            first.targetId!,
            first.targetLocationId!,
          );
          if (!from || !to)
            throw new SyncError(
              "LOCATION_MISSING",
              "Both inventory items must remain tracked and stocked at active mapped locations.",
            );
          const desired = policy.allowNegative
            ? from.quantity - policy.buffer
            : Math.max(0, from.quantity - policy.buffer);
          if (desired !== first.after || to.quantity !== first.before)
            throw new SyncError(
              "STALE_QUANTITY",
              "Quantity changed after preview. Review a new comparison.",
            );
          const input = {
            name: "available",
            reason: "correction",
            referenceDocumentUri: `syncpilot://jobs/${job.id}`,
            quantities: [
              {
                inventoryItemId: first.targetId,
                locationId: first.targetLocationId,
                quantity: first.after,
                changeFromQuantity: first.before,
              },
            ],
          };
          await verifyConsent();
          mutationStarted = true;
          const result = await shopifyRequest<{
            inventorySetQuantities: unknown;
          }>(
            policy.targetShopDomain,
            INVENTORY_SET,
            { input, idempotencyKey: `syncpilot:${job.id}:${key}` },
            { write: true, inventory: true },
          );
          mutationErrors(result.inventorySetQuantities);
          const observed = await readLevel(
            policy.targetShopDomain,
            first.targetId!,
            first.targetLocationId!,
          );
          if (observed?.quantity !== first.after)
            throw new SyncError(
              "VERIFICATION_FAILED",
              "Inventory changed during verification. Review live stock before any repair.",
              false,
              true,
            );
        } else {
          const source = await readResource(
            policy.sourceShopDomain,
            first.sourceId,
            kind,
          );
          const target = await readResource(
            policy.targetShopDomain,
            first.targetId!,
            kind,
          );
          for (const change of changes)
            if (
              !sameValue(resourceValue(source, change.field!), change.after) ||
              !sameValue(resourceValue(target, change.field!), change.before)
            )
              throw new SyncError(
                "STALE_PREVIEW",
                "A selected source or destination field changed after preview.",
              );
          const fields = Object.fromEntries(
            changes.map((c) => [c.field!, c.after]),
          );
          await verifyConsent();
          mutationStarted = true;
          if (kind === "PRODUCT") {
            const result = await shopifyRequest<{ productUpdate: unknown }>(
              policy.targetShopDomain,
              PRODUCT_UPDATE,
              { product: { id: first.targetId, ...fields } },
              { write: true },
            );
            mutationErrors(result.productUpdate);
          } else {
            if (
              (source as VariantRecord).product.id !== first.sourceProductId ||
              (target as VariantRecord).product.id !== first.targetProductId
            )
              throw new SyncError(
                "VARIANT_MISMATCH",
                "Variant parent identity changed.",
              );
            const result = await shopifyRequest<{
              productVariantsBulkUpdate: unknown;
            }>(
              policy.targetShopDomain,
              VARIANT_UPDATE,
              {
                productId: first.targetProductId,
                variants: [{ id: first.targetId, ...fields }],
              },
              { write: true },
            );
            mutationErrors(result.productVariantsBulkUpdate);
          }
          const observed = await readResource(
            policy.targetShopDomain,
            first.targetId!,
            kind,
          );
          if (
            changes.some(
              (change) =>
                !sameValue(
                  resourceValue(observed, change.field!),
                  change.after,
                ),
            )
          )
            throw new SyncError(
              "VERIFICATION_FAILED",
              "Shopify did not retain the approved field values. Review the current destination.",
              false,
              true,
            );
        }
        const payload = payloadObject(current.payload);
        const completed = Array.isArray(payload.completedGroups)
          ? payload.completedGroups.filter(
              (s): s is string => typeof s === "string",
            )
          : [];
        const fenced = await tx.syncJob.updateMany({
          where: { id: job.id, status: "RUNNING", leaseOwner: workerId },
          data: {
            payload: toJson({
              ...payload,
              completedGroups: [...new Set([...completed, key])],
            }),
            leaseUntil: new Date(Date.now() + LEASE_MS),
          },
        });
        if (fenced.count !== 1)
          throw new SyncError(
            "LEASE_LOST",
            "The job was cancelled while Shopify was processing it.",
            false,
            true,
          );
        await tx.auditEvent.create({
          data: {
            workspaceId: policy.workspaceId,
            shopDomain: policy.targetShopDomain,
            actor: `worker:${workerId}`,
            action: "SYNC_RESOURCE_APPLIED",
            resourceType: first.kind,
            resourceId: first.targetId,
            details: {
              jobId: job.id,
              fields: changes.map((c) => c.field!),
              idempotencyKey: job.idempotencyKey,
            },
          },
        });
      } catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError(
          mutationStarted ? "UNKNOWN_OUTCOME" : "INVALID_INPUT",
          mutationStarted
            ? "A write may have completed before persistence failed. Inspect live state and approve a fresh comparison."
            : "The resource could not be validated.",
          false,
          mutationStarted,
        );
      }
    },
    { timeout: 90_000, maxWait: 5000 },
  );
}

async function applyPreview(job: SyncJob, workerId: string) {
  const previewId = job.previewId ?? payloadObject(job.payload).previewId;
  if (typeof previewId !== "string")
    throw new SyncError(
      "INVALID_INPUT",
      "Write job has no approved comparison.",
    );
  const preview = await prisma.syncPreview.findUnique({
    where: { id: previewId },
  });
  const { policy } = await policyContext(job.policyId, true);
  if (
    !preview ||
    preview.policyId !== policy.id ||
    preview.workspaceId !== job.workspaceId ||
    preview.status !== "APPROVED" ||
    !preview.approvedBy ||
    !preview.approvedAt ||
    preview.expiresAt <= new Date()
  )
    throw new SyncError(
      "APPROVAL_REQUIRED",
      "This comparison has expired or its approval was revoked.",
    );
  await assertApprover(preview.approvedBy, policy.workspaceId, [
    policy.sourceShopDomain,
    policy.targetShopDomain,
  ]);
  const changes = z
    .array(changeSchema)
    .min(1)
    .max(1000)
    .parse(preview.changes) as SyncChange[];
  if (changes.some((c) => c.kind === "HOLD"))
    throw new SyncError(
      "APPROVAL_REQUIRED",
      "Held changes cannot be executed.",
    );
  assertWriteGates(changes.some((c) => c.kind === "INVENTORY"));
  const live = await buildLivePreview(policy.id, () => renew(job, workerId));
  assertCurrentPlan(preview, live);
  if (stableHash(preview.changes) !== stableHash(live.changes))
    throw new SyncError(
      "STALE_PREVIEW",
      "The exact proposed changes no longer match live Shopify state.",
    );
  for (const [key, batch] of groups(changes))
    await executeGroup(policy, batch, job, key, workerId);
  await prisma.syncPreview.update({
    where: { id: preview.id },
    data: { status: "APPLIED" },
  });
  await enqueueSystemImport(policy.targetShopDomain, `applied:${job.id}`);
}

async function reconcile(job: SyncJob, workerId: string) {
  const { policy } = await policyContext(job.policyId);
  const payload = payloadObject(job.payload);
  let runId = typeof payload.runId === "string" ? payload.runId : undefined;
  if (!runId) {
    const run = await prisma.reconciliationRun.create({
      data: {
        workspaceId: policy.workspaceId,
        policyId: policy.id,
        createdBy: "system",
      },
    });
    runId = run.id;
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { payload: toJson({ ...payload, runId }) },
    });
  }
  const run = await prisma.reconciliationRun.findUnique({
    where: { id: runId },
  });
  if (
    !run ||
    run.workspaceId !== policy.workspaceId ||
    run.policyId !== policy.id
  )
    throw new SyncError(
      "TENANT_DENIED",
      "Reconciliation run does not belong to this policy.",
    );
  await prisma.reconciliationRun.update({
    where: { id: runId },
    data: { status: "RUNNING" },
  });
  const preview = await buildLivePreview(policy.id, () => renew(job, workerId));
  await prisma.$transaction(async (tx) => {
    await tx.reconciliationRun.update({
      where: { id: runId },
      data: {
        status: "COMPLETED",
        findings: toJson(preview.changes),
        total: preview.changes.length,
        drifted: preview.changes.filter((c) => c.kind !== "HOLD").length,
        completedAt: new Date(),
      },
    });
    const existing = await tx.syncPreview.findFirst({
      where: {
        policyId: policy.id,
        workspaceId: policy.workspaceId,
        status: "PENDING",
        sourceHash: preview.sourceHash,
        targetHash: preview.targetHash,
        expiresAt: { gt: new Date() },
      },
    });
    if (preview.changes.length && !existing)
      await tx.syncPreview.create({
        data: {
          workspaceId: policy.workspaceId,
          policyId: policy.id,
          createdBy: "system",
          sourceHash: preview.sourceHash,
          targetHash: preview.targetHash,
          changes: toJson(preview.changes),
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });
    for (const hold of preview.changes.filter((c) => c.kind === "HOLD")) {
      const conflict = await tx.syncConflict.findFirst({
        where: {
          workspaceId: policy.workspaceId,
          policyId: policy.id,
          resourceId: hold.sourceId,
          code: hold.code,
          status: "OPEN",
        },
      });
      if (!conflict)
        await tx.syncConflict.create({
          data: {
            workspaceId: policy.workspaceId,
            policyId: policy.id,
            jobId: job.id,
            code: hold.code ?? "INVALID_INPUT",
            resourceId: hold.sourceId,
            field: hold.field,
            details: toJson({
              message:
                hold.message ?? "Review this mapping before synchronizing.",
            }),
          },
        });
    }
  });
}

/** Durable inbox delivery creates an idempotent job in the same DB transaction. */
export async function dispatchInbox(limit = 25) {
  let dispatched = 0;
  for (let index = 0; index < Math.min(limit, 100); index++) {
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "WebhookEvent" WHERE status = 'RECEIVED' ORDER BY "receivedAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!rows[0]) return false;
      const event = await tx.webhookEvent.findUniqueOrThrow({
        where: { id: rows[0].id },
      });
      const connection = await tx.shopConnection.findUnique({
        where: { shopDomain: event.shopDomain },
      });
      if (
        !connection ||
        connection.status !== "CONNECTED" ||
        connection.uninstalledAt
      ) {
        await tx.webhookEvent.update({
          where: { id: event.id },
          data: {
            status: "IGNORED",
            processedAt: new Date(),
            lastError: "UNINSTALLED",
          },
        });
        return true;
      }
      await tx.syncJob.upsert({
        where: { idempotencyKey: `webhook:${event.id}` },
        create: {
          workspaceId: connection.workspaceId ?? "",
          policyId: "",
          sourceShop: event.shopDomain,
          targetShop: event.shopDomain,
          eventId: event.id,
          operation: "WEBHOOK_REFRESH",
          payload: { topic: event.topic, resourceId: event.resourceId },
          idempotencyKey: `webhook:${event.id}`,
        },
        update: {},
      });
      await tx.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: "DISPATCHED",
          attempts: { increment: 1 },
          processedAt: new Date(),
        },
      });
      return true;
    });
    if (!result) break;
    dispatched++;
  }
  return dispatched;
}

async function refreshWebhook(job: SyncJob, workerId: string) {
  const payload = payloadObject(job.payload);
  let snapshotId =
    typeof payload.snapshotId === "string" ? payload.snapshotId : undefined;
  if (!snapshotId) {
    const snapshot = await prisma.catalogSnapshot.create({
      data: { shopDomain: job.sourceShop, status: "QUEUED" },
    });
    snapshotId = snapshot.id;
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { payload: toJson({ ...payload, snapshotId }) },
    });
  }
  await executeCatalogImport(snapshotId, job.sourceShop, () =>
    renew(job, workerId),
  );
  const policies = await prisma.syncPolicy.findMany({
    where: {
      sourceShopDomain: job.sourceShop,
      workspaceId: job.workspaceId,
      enabled: true,
      status: "ACTIVE",
    },
  });
  for (const policy of policies)
    await prisma.syncJob.upsert({
      where: { idempotencyKey: `reconcile-event:${policy.id}:${job.eventId}` },
      create: {
        workspaceId: policy.workspaceId,
        policyId: policy.id,
        sourceShop: policy.sourceShopDomain,
        targetShop: policy.targetShopDomain,
        operation: "RECONCILE",
        eventId: job.eventId,
        idempotencyKey: `reconcile-event:${policy.id}:${job.eventId}`,
      },
      update: {},
    });
  if (job.eventId)
    await prisma.webhookEvent.update({
      where: { id: job.eventId },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    });
}

async function recoverExpiredLeases() {
  const expired = await prisma.syncJob.findMany({
    where: { status: "RUNNING", leaseUntil: { lt: new Date() } },
    take: 50,
  });
  for (const job of expired) {
    const writes = job.operation === "APPLY_PREVIEW";
    await prisma.$transaction(async (tx) => {
      const changed = await tx.syncJob.updateMany({
        where: {
          id: job.id,
          status: "RUNNING",
          leaseUntil: { lt: new Date() },
        },
        data: {
          status: writes ? "HELD" : "RETRY",
          leaseUntil: null,
          leaseOwner: null,
          availableAt: new Date(),
          lastError: writes
            ? "UNKNOWN_OUTCOME: Worker stopped during an approved write. Inspect current state and approve a fresh comparison."
            : "WORKER_RESTART: Resuming the last persisted checkpoint.",
        },
      });
      if (!changed.count) return;
      if (writes) {
        if (job.previewId)
          await tx.syncPreview.updateMany({
            where: { id: job.previewId, status: "APPROVED" },
            data: { status: "HELD" },
          });
        await tx.syncConflict.create({
          data: {
            workspaceId: job.workspaceId,
            policyId: job.policyId,
            jobId: job.id,
            code: "UNKNOWN_OUTCOME",
            details: {
              message:
                "Worker stopped during a write. Compare live state before creating a new approval.",
            },
          },
        });
      }
      await tx.syncAttempt.updateMany({
        where: { jobId: job.id, status: "RUNNING" },
        data: {
          status: writes ? "HELD" : "INTERRUPTED",
          errorCode: "WORKER_RESTART",
          completedAt: new Date(),
        },
      });
    });
  }
}
async function claimJob(workerId: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string; sourceShop: string }[]
    >`SELECT j.id, j."sourceShop" FROM "SyncJob" j WHERE j.status IN ('PENDING','RETRY') AND j."availableAt" <= NOW() AND j.attempts < j."maxAttempts" AND NOT EXISTS (SELECT 1 FROM "SyncJob" running WHERE running.status = 'RUNNING' AND running."sourceShop" = j."sourceShop" AND running."leaseUntil" > NOW()) ORDER BY j."availableAt", j."createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows[0]) return null;
    const locked = await tx.$queryRaw<
      { locked: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtext(${`claim:${rows[0].sourceShop}`})) AS locked`;
    if (!locked[0]?.locked) return null;
    if (
      await tx.syncJob.count({
        where: {
          sourceShop: rows[0].sourceShop,
          status: "RUNNING",
          leaseUntil: { gt: new Date() },
        },
      })
    )
      return null;
    const job = await tx.syncJob.update({
      where: { id: rows[0].id },
      data: {
        status: "RUNNING",
        attempts: { increment: 1 },
        leaseOwner: workerId,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        startedAt: new Date(),
        lastError: null,
      },
    });
    await tx.syncAttempt.create({
      data: { jobId: job.id, attempt: job.attempts, status: "RUNNING" },
    });
    return job;
  });
}
function safeFailure(error: unknown) {
  if (error instanceof SyncError) return error;
  if (error instanceof DomainError)
    return new SyncError(error.code, error.message);
  if (error instanceof z.ZodError)
    return new SyncError(
      "INVALID_INPUT",
      "The saved job or Shopify response did not match its required schema.",
    );
  return new SyncError(
    "UNKNOWN",
    "The worker could not safely complete this operation. Review diagnostics before retrying.",
  );
}
async function failJob(job: SyncJob, workerId: string, error: unknown) {
  const failure = safeFailure(error);
  const retry =
    failure.retryable && !failure.uncertain && job.attempts < job.maxAttempts;
  const held =
    failure.uncertain ||
    (!failure.retryable && job.operation === "APPLY_PREVIEW");
  const status = retry ? "RETRY" : held ? "HELD" : "DEAD_LETTER";
  const message = `${failure.code}: ${failure.message}`;
  await prisma.$transaction(async (tx) => {
    const fenced = await tx.syncJob.updateMany({
      where: { id: job.id, status: "RUNNING", leaseOwner: workerId },
      data: {
        status,
        lastError: message,
        leaseOwner: null,
        leaseUntil: null,
        availableAt: new Date(Date.now() + retryDelay(job.attempts)),
        ...(retry ? {} : { completedAt: new Date() }),
      },
    });
    if (!fenced.count) return;
    await tx.syncAttempt.updateMany({
      where: { jobId: job.id, attempt: job.attempts, status: "RUNNING" },
      data: {
        status,
        errorCode: failure.code,
        details: { message: failure.message },
        completedAt: new Date(),
      },
    });
    if (
      job.operation === "CATALOG_IMPORT" ||
      job.operation === "WEBHOOK_REFRESH"
    ) {
      const current = await tx.syncJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      const snapshotId = payloadObject(current.payload).snapshotId;
      if (typeof snapshotId === "string")
        await tx.catalogSnapshot.updateMany({
          where: { id: snapshotId, shopDomain: job.sourceShop },
          data: { status: retry ? "RUNNING" : "FAILED", lastError: message },
        });
    }
    if (job.operation === "RECONCILE") {
      const current = await tx.syncJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      const runId = payloadObject(current.payload).runId;
      if (typeof runId === "string")
        await tx.reconciliationRun.updateMany({
          where: { id: runId, workspaceId: job.workspaceId },
          data: {
            status: retry ? "PENDING" : "FAILED",
            findings: { code: failure.code, message: failure.message },
          },
        });
    }
    if (held) {
      if (job.previewId)
        await tx.syncPreview.updateMany({
          where: { id: job.previewId, status: "APPROVED" },
          data: { status: "HELD" },
        });
      await tx.syncConflict.create({
        data: {
          workspaceId: job.workspaceId,
          policyId: job.policyId,
          jobId: job.id,
          code: failure.code,
          details: { message: failure.message },
        },
      });
    }
    if (job.eventId)
      await tx.webhookEvent.updateMany({
        where: { id: job.eventId },
        data: { status: retry ? "DISPATCHED" : "FAILED", lastError: message },
      });
  });
  logger.warn(
    { jobId: job.id, code: failure.code, status, attempt: job.attempts },
    "Sync worker operation did not complete",
  );
}

/** One bounded polling iteration. PostgreSQL remains the durable source of truth if Redis is unavailable. */
export async function runWorkerOnce(workerId = workerIdentity) {
  await prisma.workerHeartbeat.upsert({
    where: { id: workerId },
    create: { id: workerId, status: "RUNNING" },
    update: { seenAt: new Date(), status: "RUNNING" },
  });
  await recoverExpiredLeases();
  await dispatchInbox();
  const job = await claimJob(workerId);
  if (!job) return { processed: false };
  try {
    if (job.operation === "CATALOG_IMPORT") {
      const payload = payloadObject(job.payload),
        id = payload.snapshotId;
      if (typeof id !== "string" || job.sourceShop !== job.targetShop)
        throw new SyncError(
          "INVALID_INPUT",
          "Catalog job identity is invalid.",
        );
      if (
        typeof payload.requestedShop === "string" &&
        payload.requestedShop !== job.sourceShop
      ) {
        const connection = await prisma.shopConnection.findUnique({
          where: { shopDomain: payload.requestedShop },
        });
        if (
          !connection?.workspaceId ||
          connection.workspaceId !== job.workspaceId
        )
          throw new SyncError(
            "TENANT_DENIED",
            "The requesting shop is no longer paired.",
          );
        const target = await prisma.shopConnection.findUnique({
          where: { shopDomain: job.sourceShop },
        });
        const pair = await prisma.storePair.findFirst({
          where: {
            workspaceId: job.workspaceId,
            status: "VERIFIED",
            OR: [
              { sourceShop: payload.requestedShop, targetShop: job.sourceShop },
              { sourceShop: job.sourceShop, targetShop: payload.requestedShop },
            ],
          },
        });
        if (target?.workspaceId !== job.workspaceId || !pair)
          throw new SyncError(
            "NOT_PAIRED",
            "Catalog authorization was revoked.",
          );
      }
      await executeCatalogImport(id, job.sourceShop, () =>
        renew(job, workerId),
      );
    } else if (job.operation === "APPLY_PREVIEW")
      await applyPreview(job, workerId);
    else if (job.operation === "RECONCILE") await reconcile(job, workerId);
    else if (job.operation === "WEBHOOK_REFRESH")
      await refreshWebhook(job, workerId);
    else
      throw new SyncError(
        "INVALID_INPUT",
        "This job operation is not supported.",
      );
    await prisma.$transaction(async (tx) => {
      const fenced = await tx.syncJob.updateMany({
        where: { id: job.id, status: "RUNNING", leaseOwner: workerId },
        data: {
          status: "SUCCEEDED",
          completedAt: new Date(),
          leaseOwner: null,
          leaseUntil: null,
          lastError: null,
        },
      });
      if (!fenced.count)
        throw new SyncError(
          "LEASE_LOST",
          "Job lease changed before completion.",
        );
      await tx.syncAttempt.updateMany({
        where: { jobId: job.id, attempt: job.attempts, status: "RUNNING" },
        data: { status: "SUCCEEDED", completedAt: new Date() },
      });
    });
    return { processed: true, jobId: job.id, status: "SUCCEEDED" };
  } catch (error) {
    await failJob(job, workerId, error);
    return { processed: true, jobId: job.id, status: "FAILED" };
  }
}

/** Schedule comparisons only. Repair always requires a separate, exact preview approval. */
export async function scheduleReconciliations(now = new Date()) {
  const policies = await prisma.syncPolicy.findMany({
    where: { enabled: true, status: "ACTIVE" },
    take: 1000,
  });
  let queued = 0;
  for (const policy of policies) {
    const slot = Math.floor(
      now.getTime() / (Math.max(5, policy.reconciliationMinutes) * 60_000),
    );
    const key = `scheduled:${policy.id}:${slot}`;
    try {
      await policyContext(policy.id);
      await prisma.syncJob.upsert({
        where: { idempotencyKey: key },
        create: {
          workspaceId: policy.workspaceId,
          policyId: policy.id,
          sourceShop: policy.sourceShopDomain,
          targetShop: policy.targetShopDomain,
          operation: "RECONCILE",
          idempotencyKey: key,
        },
        update: {},
      });
      queued++;
    } catch (error) {
      const failure = safeFailure(error);
      logger.warn(
        { policyId: policy.id, code: failure.code },
        "Scheduled comparison is paused",
      );
    }
  }
  await prisma.syncPreview.updateMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  return queued;
}
