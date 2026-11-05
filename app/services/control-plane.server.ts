import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.server";
import {
  type Actor,
  currentConnection,
  requireOwner,
  requireOperator,
  requirePairAccess,
  requireWorkspace,
  canOperate,
} from "./authorization.server";
import {
  DomainError,
  PRODUCT_FIELDS,
  PRICE_FIELDS,
  VARIANT_FIELDS,
  SYNC_FIELDS,
  assertPairingUsable,
  assertSafePreview,
  assertWriteGates,
  challengeHash,
  createChallenge,
  normalizeShop,
  validChallenge,
  validateGid,
} from "../domain/guards";
import { stableHash, SyncError } from "../domain/sync";
import { INSTALLATION_CHECK_QUERY } from "../domain/sync-operations";
import { listPage } from "./listing.server";
import { alertDestination } from "./alert-transport.server";
import {
  reactivateInstallation,
  revokeStandingConsents,
  updateInstallationScopes,
} from "./installation.server";
import { shopifyRequest } from "./shopify-client.server";

export { DomainError } from "../domain/guards";
type Tx = Prisma.TransactionClient;
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const flags = () => ({
  writesEnabled: process.env.SYNC_WRITE_ENABLED === "true",
  inventoryWritesEnabled:
    process.env.SYNC_WRITE_ENABLED === "true" &&
    process.env.INVENTORY_WRITE_ENABLED === "true",
});
const actorKey = (actor: Actor) => `${actor.shop}:${actor.userId}`;
const safePairing = <T extends { challengeHash: string | null }>(
  request: T,
) => {
  const safe = { ...request };
  Reflect.deleteProperty(safe, "challengeHash");
  return safe as Omit<T, "challengeHash">;
};
async function serial<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 2
      )
        continue;
      throw error;
    }
  }
}
async function audit(
  tx: Tx | PrismaClient,
  actor: Actor,
  action: string,
  resourceType: string,
  resourceId?: string,
  workspaceId?: string,
  details?: unknown,
) {
  return tx.auditEvent.create({
    data: {
      actor: actorKey(actor),
      shopDomain: actor.shop,
      workspaceId,
      action,
      resourceType,
      resourceId,
      ...(details === undefined ? {} : { details: json(details) }),
    },
  });
}
/** Records a signed-in page load. It proves nothing about the stored tokens. */
export async function ensureInstallation(actor: Actor) {
  const connection = await prisma.shopConnection.upsert({
    where: { shopDomain: actor.shop },
    create: { shopDomain: actor.shop },
    update: { lastSeenAt: new Date() },
  });
  if (connection.status === "CONNECTED" && !connection.uninstalledAt)
    return connection;
  return (await reactivateInstallation(actor.shop)) ?? connection;
}
export async function getWorkspace(actor: Actor) {
  const connection = await ensureInstallation(actor);
  if (!connection.workspaceId)
    return { workspaceId: null, workspace: null, connections: [connection] };
  const context = await requireWorkspace(actor);
  return {
    workspaceId: context.workspaceId,
    workspace: context.workspace,
    connections: context.connections,
  };
}
export async function getStores(actor: Actor) {
  const current = await ensureInstallation(actor);
  const context = await getWorkspace(actor);
  const pairings = await prisma.storePairingRequest.findMany({
    where: {
      OR: [{ initiatingShop: actor.shop }, { destinationShop: actor.shop }],
    },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  return {
    current,
    connections: context.connections,
    workspace: context.workspace,
    canManage: actor.role === "OWNER",
    canVerify: current.status === "CONNECTED" && (await canOperate(actor)),
    pairings: pairings.map(safePairing),
  };
}
/**
 * The operator's check that a store's stored authorization still works: a live,
 * read-only Shopify call, with the answer recorded either way. The owner of the
 * store or an operator of its verified pair may run it. It writes nothing to
 * Shopify, but scopes that changed end local write authority as a delivery would.
 */
export async function verifyStore(actor: Actor, shopDomain: string) {
  const shop = normalizeShop(shopDomain);
  if (actor.role === "OWNER") requireOwner(actor);
  else await requireOperator(actor);
  await currentConnection(actor);
  if (shop !== actor.shop) await requirePairAccess(actor, shop);
  const connection = await prisma.shopConnection.findUniqueOrThrow({
    where: { shopDomain: shop },
  });
  const workspaceId = connection.workspaceId ?? undefined;
  try {
    const { shop: info, currentAppInstallation } = await shopifyRequest<{
      shop: { id: string; myshopifyDomain: string; currencyCode: string };
      currentAppInstallation: { accessScopes: { handle: string }[] };
    }>(shop, INSTALLATION_CHECK_QUERY);
    if (info.myshopifyDomain !== shop)
      throw new SyncError(
        "TENANT_DENIED",
        "Shopify answered for a different store. Reinstall the app in this store.",
      );
    const granted = currentAppInstallation.accessScopes.map(
      ({ handle }) => handle,
    );
    const scope = [...new Set(granted)].sort().join(",");
    const verifiedAt = new Date();
    // A recorded set that changed is a scope change, with what that revokes.
    if (connection.scopes && connection.scopes !== scope)
      await updateInstallationScopes(shop, granted, {
        updatedAt: verifiedAt,
        actor: actorKey(actor),
      });
    await prisma.$transaction(async (tx) => {
      // A first reading only fills the blank. scopesUpdatedAt marks the last change
      // applied, and moving it here would discard as older a real change whose
      // delivery is still on its way, along with everything that change revokes.
      await tx.shopConnection.updateMany({
        where: { shopDomain: shop, scopes: null },
        data: { scopes: scope },
      });
      await tx.shopConnection.update({
        where: { shopDomain: shop },
        data: {
          shopGid: info.id,
          currency: info.currencyCode,
          verifiedAt,
          lastError: null,
        },
      });
      await audit(
        tx,
        actor,
        "STORE_VERIFIED",
        "ShopConnection",
        connection.id,
        workspaceId,
        { shop, scopes: granted },
      );
    });
    return { verified: true as const, scopes: granted };
  } catch (error) {
    const failure =
      error instanceof SyncError
        ? error
        : new SyncError(
            "UNKNOWN",
            "The check could not be completed. Try again shortly.",
          );
    const lastError = `${failure.code}: ${failure.message}`;
    await prisma.$transaction(async (tx) => {
      await tx.shopConnection.update({
        where: { shopDomain: shop },
        data: { lastError },
      });
      await audit(
        tx,
        actor,
        "STORE_VERIFICATION_FAILED",
        "ShopConnection",
        connection.id,
        workspaceId,
        { shop, code: failure.code },
      );
    });
    return {
      verified: false as const,
      code: failure.code,
      message: failure.message,
    };
  }
}
const pairingInput = z
  .object({
    destinationShop: z.string().max(100),
    organizationConfirmed: z.literal(true),
  })
  .strict();
export async function initiatePairing(actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = pairingInput.parse(input);
  const destinationShop = normalizeShop(data.destinationShop);
  if (destinationShop === actor.shop)
    throw new DomainError("SELF_PAIR", "Select a different store.");
  const challenge = createChallenge();
  const request = await serial(async (tx) => {
    const source = await currentConnection(actor, tx);
    const destination = await tx.shopConnection.findUnique({
      where: { shopDomain: destinationShop },
    });
    if (
      !destination ||
      destination.status !== "CONNECTED" ||
      destination.uninstalledAt
    )
      throw new DomainError(
        "INSTALLATION_REQUIRED",
        "Both stores must have an active SyncPilot installation before pairing.",
        409,
      );
    if (source.workspaceId || destination.workspaceId)
      throw new DomainError(
        "ALREADY_PAIRED",
        "One of these stores is already paired. Disconnect it first.",
        409,
      );
    const pending = await tx.storePairingRequest.findFirst({
      where: {
        state: { in: ["PENDING", "ACCEPTED"] },
        expiresAt: { gt: new Date() },
        OR: [
          { initiatingShop: actor.shop },
          { destinationShop: actor.shop },
          { initiatingShop: destinationShop },
          { destinationShop },
        ],
      },
    });
    if (pending)
      throw new DomainError(
        "PAIRING_PENDING",
        "A pairing request is already pending for one of these stores. Cancel it or wait for expiry.",
        409,
      );
    const result = await tx.storePairingRequest.create({
      data: {
        initiatingShop: actor.shop,
        destinationShop,
        challengeHash: challengeHash(challenge),
        initiatingActor: actor.userId,
        initiatingApprovedAt: new Date(),
        organizationConfirmed: true,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });
    await audit(
      tx,
      actor,
      "PAIRING_REQUESTED",
      "StorePairingRequest",
      result.id,
      undefined,
      { destinationShop },
    );
    return result;
  });
  return { request: safePairing(request), challenge };
}
export async function acceptPairing(actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = z
    .object({
      requestId: z.string().min(1).max(100),
      challenge: z.string().min(1).max(256),
      organizationConfirmed: z.literal(true),
    })
    .strict()
    .parse(input);
  const result = await serial(async (tx) => {
    const request = await tx.storePairingRequest.findFirst({
      where: { id: data.requestId, destinationShop: actor.shop },
    });
    if (!request)
      throw new DomainError(
        "PAIRING_NOT_FOUND",
        "Pairing request not found.",
        404,
      );
    assertPairingUsable(request);
    if (request.state !== "PENDING")
      throw new DomainError(
        "PAIRING_USED",
        "This pairing request has already been accepted.",
        409,
      );
    const destination = await currentConnection(actor, tx);
    if (destination.workspaceId)
      throw new DomainError(
        "ALREADY_PAIRED",
        "This store is already paired.",
        409,
      );
    if (!validChallenge(data.challenge, request.challengeHash)) {
      await tx.storePairingRequest.update({
        where: { id: request.id },
        data: { attempts: { increment: 1 } },
      });
      await audit(
        tx,
        actor,
        "PAIRING_CHALLENGE_REJECTED",
        "StorePairingRequest",
        request.id,
      );
      return { error: true as const };
    }
    const accepted = await tx.storePairingRequest.update({
      where: { id: request.id },
      data: {
        state: "ACCEPTED",
        destinationActor: actor.userId,
        destinationApprovedAt: new Date(),
      },
    });
    await audit(
      tx,
      actor,
      "PAIRING_ACCEPTED",
      "StorePairingRequest",
      request.id,
    );
    return { error: false as const, request: safePairing(accepted) };
  });
  if (result.error)
    throw new DomainError(
      "INVALID_CHALLENGE",
      "The pairing code is incorrect.",
      403,
    );
  return result.request;
}
export async function confirmPairing(actor: Actor, input: unknown) {
  requireOwner(actor);
  const { requestId } = z
    .object({ requestId: z.string().min(1).max(100) })
    .strict()
    .parse(input);
  return serial(async (tx) => {
    const request = await tx.storePairingRequest.findFirst({
      where: { id: requestId, initiatingShop: actor.shop },
    });
    if (!request)
      throw new DomainError(
        "PAIRING_NOT_FOUND",
        "Pairing request not found.",
        404,
      );
    assertPairingUsable(request);
    if (
      request.state !== "ACCEPTED" ||
      !request.destinationApprovedAt ||
      !request.destinationActor ||
      !request.organizationConfirmed ||
      request.initiatingActor !== actor.userId
    )
      throw new DomainError(
        "APPROVAL_REQUIRED",
        "Both store owners must approve, and the initiating owner must confirm.",
        409,
      );
    const connections = await tx.shopConnection.findMany({
      where: {
        shopDomain: { in: [request.initiatingShop, request.destinationShop] },
        status: "CONNECTED",
        uninstalledAt: null,
        workspaceId: null,
      },
    });
    if (connections.length !== 2)
      throw new DomainError(
        "INSTALLATION_CHANGED",
        "A store installation or pairing changed. Start pairing again.",
        409,
      );
    const workspace = await tx.workspace.create({
      data: { name: "SyncPilot workspace" },
    });
    await tx.shopConnection.updateMany({
      where: {
        id: { in: connections.map((connection) => connection.id) },
        workspaceId: null,
      },
      data: { workspaceId: workspace.id },
    });
    await tx.workspaceMember.createMany({
      data: [
        {
          workspaceId: workspace.id,
          shopDomain: request.initiatingShop,
          userId: actor.userId,
          role: "OWNER",
        },
        {
          workspaceId: workspace.id,
          shopDomain: request.destinationShop,
          userId: request.destinationActor,
          role: "OWNER",
        },
      ],
    });
    await tx.storePair.create({
      data: {
        workspaceId: workspace.id,
        sourceShop: request.initiatingShop,
        targetShop: request.destinationShop,
        requestId: request.id,
      },
    });
    const verified = await tx.storePairingRequest.update({
      where: { id: request.id },
      data: {
        state: "VERIFIED",
        challengeHash: null,
        workspaceId: workspace.id,
        verifiedAt: new Date(),
      },
    });
    await audit(
      tx,
      actor,
      "PAIRING_VERIFIED",
      "StorePairingRequest",
      request.id,
      workspace.id,
      {
        sourceShop: request.initiatingShop,
        targetShop: request.destinationShop,
        organizationEligibility: "ATTESTED_BY_BOTH_OWNERS",
      },
    );
    return { workspace, request: safePairing(verified) };
  });
}
export async function rejectPairing(actor: Actor, requestId: string) {
  requireOwner(actor);
  return serial(async (tx) => {
    const request = await tx.storePairingRequest.findFirst({
      where: {
        id: requestId,
        OR: [{ initiatingShop: actor.shop }, { destinationShop: actor.shop }],
      },
    });
    if (!request)
      throw new DomainError(
        "PAIRING_NOT_FOUND",
        "Pairing request not found.",
        404,
      );
    if (!["PENDING", "ACCEPTED"].includes(request.state))
      throw new DomainError(
        "PAIRING_USED",
        "This request is no longer pending.",
        409,
      );
    const cancelled = await tx.storePairingRequest.update({
      where: { id: request.id },
      data: {
        state: actor.shop === request.initiatingShop ? "CANCELLED" : "REJECTED",
        challengeHash: null,
      },
    });
    await audit(
      tx,
      actor,
      "PAIRING_CANCELLED",
      "StorePairingRequest",
      request.id,
    );
    return safePairing(cancelled);
  });
}
export async function disconnectStore(actor: Actor, shop: string) {
  requireOwner(actor);
  return serial(async (tx) => {
    const context = await requirePairAccess(actor, normalizeShop(shop), tx);
    await tx.syncPolicy.updateMany({
      where: { workspaceId: context.workspaceId },
      data: { enabled: false, status: "PAUSED" },
    });
    await revokeStandingConsents(
      tx,
      { workspaceId: context.workspaceId },
      {
        actor: actorKey(actor),
        shopDomain: actor.shop,
        reason: "STORES_DISCONNECTED",
      },
    );
    await tx.syncJob.updateMany({
      where: {
        workspaceId: context.workspaceId,
        status: { in: ["PENDING", "RETRY", "RUNNING", "PROCESSING"] },
      },
      data: { status: "CANCELLED", leaseUntil: null, leaseOwner: null },
    });
    // Automatic plans are stored APPROVED; their writes were just cancelled.
    await tx.syncPreview.updateMany({
      where: {
        workspaceId: context.workspaceId,
        status: { in: ["PENDING", "APPROVED"] },
      },
      data: { status: "REVOKED" },
    });
    await tx.storePair.updateMany({
      where: { workspaceId: context.workspaceId, status: "VERIFIED" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await tx.shopConnection.updateMany({
      where: { workspaceId: context.workspaceId },
      data: { workspaceId: null },
    });
    await tx.workspaceMember.updateMany({
      where: { workspaceId: context.workspaceId },
      data: { status: "REVOKED" },
    });
    await tx.workspace.update({
      where: { id: context.workspaceId },
      data: { state: "REVOKED" },
    });
    await audit(
      tx,
      actor,
      "STORES_DISCONNECTED",
      "Workspace",
      context.workspaceId,
      context.workspaceId,
    );
    return { disconnected: true };
  });
}

async function workspaceOrEmpty(actor: Actor) {
  const connection = await ensureInstallation(actor);
  if (!connection.workspaceId) return null;
  return requireWorkspace(actor);
}
export async function getMappings(
  actor: Actor,
  params = new URLSearchParams(),
) {
  const context = await workspaceOrEmpty(actor);
  const shops = context?.connections.map(
    (connection) => connection.shopDomain,
  ) ?? [actor.shop];
  const workspaceId = context?.workspaceId ?? "__unpaired__";
  const kind = z
    .enum(["PRODUCT", "VARIANT", "LOCATION"])
    .catch("PRODUCT")
    .parse(params.get("kind"));
  const q = (params.get("q") || "").trim().slice(0, 120);
  const resourceQ = (params.get("resourceQ") || "").trim().slice(0, 120);
  const contains = (value: string) => ({
    contains: value,
    mode: "insensitive" as const,
  });
  const mappingWhere = (source: string, target: string) => ({
    workspaceId,
    ...(q
      ? {
          OR: [source, target, "sourceShopDomain", "targetShopDomain"].map(
            (key) => ({ [key]: contains(q) }),
          ),
        }
      : {}),
  });
  const snapshotWhere = (keys: string[]) => ({
    shopDomain: { in: shops },
    ...(resourceQ
      ? { OR: keys.map((key) => ({ [key]: contains(resourceQ) })) }
      : {}),
  });
  const pWhere = mappingWhere("sourceProductGid", "targetProductGid");
  const vWhere = mappingWhere("sourceVariantGid", "targetVariantGid");
  const lWhere = mappingWhere("sourceLocationGid", "targetLocationGid");
  const psWhere = snapshotWhere(["title", "handle", "productGid"]);
  const vsWhere = snapshotWhere(["sku", "barcode", "variantGid", "productGid"]);
  const lsWhere = snapshotWhere(["name", "locationGid"]);
  const empty = { rows: [], pageInfo: { total: 0, page: 1, pageSize: 25 } };
  const [
    products,
    variants,
    locations,
    productSnapshots,
    variantSnapshots,
    locationSnapshots,
  ] = await Promise.all([
    kind === "PRODUCT"
      ? listPage(
          params.get("mappingPage"),
          () => prisma.productMapping.count({ where: pWhere }),
          (window) =>
            prisma.productMapping.findMany({
              where: pWhere,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              ...window,
            }),
        )
      : empty,
    kind === "VARIANT"
      ? listPage(
          params.get("mappingPage"),
          () => prisma.variantMapping.count({ where: vWhere }),
          (window) =>
            prisma.variantMapping.findMany({
              where: vWhere,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              ...window,
            }),
        )
      : empty,
    kind === "LOCATION"
      ? listPage(
          params.get("mappingPage"),
          () => prisma.locationMapping.count({ where: lWhere }),
          (window) =>
            prisma.locationMapping.findMany({
              where: lWhere,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              ...window,
            }),
        )
      : empty,
    kind === "PRODUCT"
      ? listPage(
          params.get("resourcePage"),
          () => prisma.productSnapshot.count({ where: psWhere }),
          (window) =>
            prisma.productSnapshot.findMany({
              where: psWhere,
              orderBy: [{ title: "asc" }, { id: "asc" }],
              ...window,
            }),
        )
      : empty,
    kind === "VARIANT"
      ? listPage(
          params.get("resourcePage"),
          () => prisma.variantSnapshot.count({ where: vsWhere }),
          (window) =>
            prisma.variantSnapshot.findMany({
              where: vsWhere,
              orderBy: [{ sku: "asc" }, { id: "asc" }],
              ...window,
            }),
        )
      : empty,
    kind === "LOCATION"
      ? listPage(
          params.get("resourcePage"),
          () => prisma.locationSnapshot.count({ where: lsWhere }),
          (window) =>
            prisma.locationSnapshot.findMany({
              where: lsWhere,
              orderBy: [{ name: "asc" }, { id: "asc" }],
              ...window,
            }),
        )
      : empty,
  ]);
  return {
    products: products.rows,
    variants: variants.rows,
    locations: locations.rows,
    kind,
    q,
    resourceQ,
    mappingPage: (kind === "PRODUCT"
      ? products
      : kind === "VARIANT"
        ? variants
        : locations
    ).pageInfo,
    resourcePage: (kind === "PRODUCT"
      ? productSnapshots
      : kind === "VARIANT"
        ? variantSnapshots
        : locationSnapshots
    ).pageInfo,
    snapshots: {
      products: productSnapshots.rows,
      variants: variantSnapshots.rows,
      locations: locationSnapshots.rows,
    },
    connections: context?.connections ?? [await currentConnection(actor)],
    canManage: actor.role === "OWNER",
  };
}
async function requirePaused(tx: Tx, workspaceId: string) {
  if (await tx.syncPolicy.count({ where: { workspaceId, enabled: true } }))
    throw new DomainError(
      "PAUSE_REQUIRED",
      "Pause active policies before changing mappings.",
      409,
    );
  if (
    await tx.syncJob.count({
      where: {
        workspaceId,
        status: { in: ["RUNNING", "PROCESSING"] },
        leaseUntil: { gt: new Date() },
      },
    })
  )
    throw new DomainError(
      "JOB_RUNNING",
      "Wait for the running job to finish before changing mappings.",
      409,
    );
}
async function invalidatePlans(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  policyId?: string,
) {
  await revokeStandingConsents(
    tx,
    { workspaceId, policyId },
    {
      actor: actorKey(actor),
      shopDomain: actor.shop,
      reason: "CONFIGURATION_CHANGED",
    },
  );
  await tx.syncPreview.updateMany({
    where: {
      workspaceId,
      ...(policyId ? { policyId } : {}),
      status: { in: ["PENDING", "APPROVED"] },
    },
    data: { status: "STALE" },
  });
  await tx.syncJob.updateMany({
    where: {
      workspaceId,
      ...(policyId ? { policyId } : {}),
      status: { in: ["PENDING", "RETRY"] },
      operation: { in: ["APPLY_PREVIEW", "AUTO_PREVIEW"] },
    },
    data: {
      status: "CANCELLED",
      lastError: "Configuration changed; a fresh preview is required.",
    },
  });
}
export async function saveMapping(actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = z
    .object({
      kind: z.enum(["PRODUCT", "VARIANT", "LOCATION"]),
      sourceShop: z.string(),
      targetShop: z.string(),
      sourceGid: z.string().max(150),
      targetGid: z.string().max(150),
    })
    .strict()
    .parse(input);
  const sourceShop = normalizeShop(data.sourceShop),
    targetShop = normalizeShop(data.targetShop);
  if (sourceShop === targetShop)
    throw new DomainError(
      "SAME_STORE",
      "Mappings must connect different stores.",
    );
  validateGid(
    data.sourceGid,
    data.kind === "PRODUCT"
      ? "Product"
      : data.kind === "VARIANT"
        ? "ProductVariant"
        : "Location",
  );
  validateGid(
    data.targetGid,
    data.kind === "PRODUCT"
      ? "Product"
      : data.kind === "VARIANT"
        ? "ProductVariant"
        : "Location",
  );
  try {
    return await serial(async (tx) => {
      const context = await requirePairAccess(actor, sourceShop, tx);
      await requirePairAccess(actor, targetShop, tx);
      await requirePaused(tx, context.workspaceId);
      const common = {
        workspaceId: context.workspaceId,
        sourceShopDomain: sourceShop,
        targetShopDomain: targetShop,
        verifiedAt: new Date(),
      };
      let mapping;
      if (data.kind === "PRODUCT") {
        const source = await tx.productSnapshot.findUnique({
          where: {
            shopDomain_productGid: {
              shopDomain: sourceShop,
              productGid: data.sourceGid,
            },
          },
        });
        const target = await tx.productSnapshot.findUnique({
          where: {
            shopDomain_productGid: {
              shopDomain: targetShop,
              productGid: data.targetGid,
            },
          },
        });
        if (!source || !target)
          throw new DomainError(
            "IMPORT_REQUIRED",
            "Import both products before verifying a mapping.",
            409,
          );
        mapping = await tx.productMapping.upsert({
          where: {
            sourceShopDomain_sourceProductGid_targetShopDomain: {
              sourceShopDomain: sourceShop,
              sourceProductGid: data.sourceGid,
              targetShopDomain: targetShop,
            },
          },
          create: {
            ...common,
            sourceProductGid: data.sourceGid,
            targetProductGid: data.targetGid,
          },
          update: {
            workspaceId: context.workspaceId,
            targetProductGid: data.targetGid,
            verifiedAt: new Date(),
          },
        });
      } else if (data.kind === "VARIANT") {
        const source = await tx.variantSnapshot.findUnique({
          where: {
            shopDomain_variantGid: {
              shopDomain: sourceShop,
              variantGid: data.sourceGid,
            },
          },
        });
        const target = await tx.variantSnapshot.findUnique({
          where: {
            shopDomain_variantGid: {
              shopDomain: targetShop,
              variantGid: data.targetGid,
            },
          },
        });
        if (!source || !target)
          throw new DomainError(
            "IMPORT_REQUIRED",
            "Import both variants before verifying a mapping.",
            409,
          );
        const productMapping = await tx.productMapping.findFirst({
          where: {
            workspaceId: context.workspaceId,
            sourceShopDomain: sourceShop,
            targetShopDomain: targetShop,
            sourceProductGid: source.productGid,
            targetProductGid: target.productGid,
            verifiedAt: { not: null },
          },
        });
        if (!productMapping)
          throw new DomainError(
            "PRODUCT_MAPPING_REQUIRED",
            "Verify the parent product mapping before mapping its variants.",
            409,
          );
        mapping = await tx.variantMapping.upsert({
          where: {
            sourceShopDomain_sourceVariantGid_targetShopDomain: {
              sourceShopDomain: sourceShop,
              sourceVariantGid: data.sourceGid,
              targetShopDomain: targetShop,
            },
          },
          create: {
            ...common,
            sourceVariantGid: data.sourceGid,
            targetVariantGid: data.targetGid,
            sourceInventoryGid: source.inventoryItemGid,
            targetInventoryGid: target.inventoryItemGid,
          },
          update: {
            workspaceId: context.workspaceId,
            targetVariantGid: data.targetGid,
            sourceInventoryGid: source.inventoryItemGid,
            targetInventoryGid: target.inventoryItemGid,
            verifiedAt: new Date(),
          },
        });
      } else {
        const source = await tx.locationSnapshot.findUnique({
          where: {
            shopDomain_locationGid: {
              shopDomain: sourceShop,
              locationGid: data.sourceGid,
            },
          },
        });
        const target = await tx.locationSnapshot.findUnique({
          where: {
            shopDomain_locationGid: {
              shopDomain: targetShop,
              locationGid: data.targetGid,
            },
          },
        });
        if (!source?.isActive || !target?.isActive)
          throw new DomainError(
            "LOCATION_INACTIVE",
            "Both locations must be imported and active.",
            409,
          );
        mapping = await tx.locationMapping.upsert({
          where: {
            sourceShopDomain_sourceLocationGid_targetShopDomain: {
              sourceShopDomain: sourceShop,
              sourceLocationGid: data.sourceGid,
              targetShopDomain: targetShop,
            },
          },
          create: {
            ...common,
            sourceLocationGid: data.sourceGid,
            targetLocationGid: data.targetGid,
          },
          update: {
            workspaceId: context.workspaceId,
            targetLocationGid: data.targetGid,
            verifiedAt: new Date(),
          },
        });
      }
      await invalidatePlans(tx, actor, context.workspaceId);
      await audit(
        tx,
        actor,
        "MAPPING_VERIFIED",
        `${data.kind}Mapping`,
        mapping.id,
        context.workspaceId,
        data,
      );
      return mapping;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new DomainError(
        "MAPPING_COLLISION",
        "That destination is already mapped. Review the existing mapping first.",
        409,
      );
    throw error;
  }
}
export async function deleteMapping(actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = z
    .object({
      kind: z.enum(["PRODUCT", "VARIANT", "LOCATION"]),
      id: z.string().min(1).max(100),
    })
    .strict()
    .parse(input);
  return serial(async (tx) => {
    const context = await requireWorkspace(actor, tx);
    await requirePaused(tx, context.workspaceId);
    const where = { id: data.id, workspaceId: context.workspaceId };
    const removed =
      data.kind === "PRODUCT"
        ? await tx.productMapping.deleteMany({ where })
        : data.kind === "VARIANT"
          ? await tx.variantMapping.deleteMany({ where })
          : await tx.locationMapping.deleteMany({ where });
    if (!removed.count)
      throw new DomainError("MAPPING_NOT_FOUND", "Mapping not found.", 404);
    await invalidatePlans(tx, actor, context.workspaceId);
    await audit(
      tx,
      actor,
      "MAPPING_REMOVED",
      `${data.kind}Mapping`,
      data.id,
      context.workspaceId,
    );
    return { removed: true };
  });
}
const policyInput = z
  .object({
    id: z.string().max(100).optional(),
    sourceShop: z.string(),
    targetShop: z.string(),
    fields: z.array(z.enum(SYNC_FIELDS)).max(SYNC_FIELDS.length),
    syncInventory: z.boolean(),
    inventoryAuthority: z.string().optional(),
    inventoryMode: z.enum(["DISABLED", "SOURCE"]),
    buffer: z.number().int().min(0).max(1_000_000),
    reconciliationMinutes: z.number().int().min(5).max(10080),
  })
  .strict();
export async function savePolicy(actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = policyInput.parse(input);
  const sourceShop = normalizeShop(data.sourceShop),
    targetShop = normalizeShop(data.targetShop);
  if (sourceShop === targetShop)
    throw new DomainError(
      "SAME_STORE",
      "Choose a different source and destination store.",
    );
  if (!data.fields.length && !data.syncInventory)
    throw new DomainError(
      "EMPTY_POLICY",
      "Select at least one product field or inventory synchronization.",
    );
  if (
    data.syncInventory &&
    (data.inventoryMode !== "SOURCE" || data.inventoryAuthority !== sourceShop)
  )
    throw new DomainError(
      "AUTHORITY_REQUIRED",
      "Inventory requires one authoritative source store. Shared-pool mirroring is not supported.",
    );
  return serial(async (tx) => {
    const context = await requirePairAccess(actor, sourceShop, tx);
    await requirePairAccess(actor, targetShop, tx);
    if (data.id) {
      const existing = await tx.syncPolicy.findFirst({
        where: { id: data.id, workspaceId: context.workspaceId },
      });
      if (!existing)
        throw new DomainError("POLICY_NOT_FOUND", "Policy not found.", 404);
      if (existing.enabled)
        throw new DomainError(
          "PAUSE_REQUIRED",
          "Pause the policy before changing it.",
          409,
        );
    }
    const fields = [...new Set(data.fields)];
    // A field may only have one owner between a pair, even across reverse policies.
    const opposing = await tx.syncPolicy.findMany({
      where: {
        workspaceId: context.workspaceId,
        sourceShopDomain: targetShop,
        targetShopDomain: sourceShop,
        id: { not: data.id ?? "" },
      },
    });
    if (
      opposing.some(
        (policy) =>
          policy.fields.some((field) =>
            fields.includes(field as (typeof fields)[number]),
          ) ||
          (data.syncInventory && policy.syncInventory),
      )
    )
      throw new DomainError(
        "FIELD_OWNERSHIP_CONFLICT",
        "The reverse policy already owns a selected field or inventory. Assign each field to one source.",
        409,
      );
    const record = {
      workspaceId: context.workspaceId,
      sourceShopDomain: sourceShop,
      targetShopDomain: targetShop,
      fields,
      syncProduct: fields.some((field) =>
        (PRODUCT_FIELDS as readonly string[]).includes(field),
      ),
      syncPrices: fields.some((field) =>
        (PRICE_FIELDS as readonly string[]).includes(field),
      ),
      syncVariants: fields.some((field) =>
        (VARIANT_FIELDS as readonly string[]).includes(field),
      ),
      syncInventory: data.syncInventory,
      inventoryMode: data.syncInventory ? "SOURCE" : "DISABLED",
      inventoryAuthority: data.syncInventory ? sourceShop : null,
      buffer: data.buffer,
      reconciliationMinutes: data.reconciliationMinutes,
      enabled: false,
      status: "DRAFT",
      approvedBy: null,
      approvedAt: null,
    };
    const policy = data.id
      ? await tx.syncPolicy.update({ where: { id: data.id }, data: record })
      : await tx.syncPolicy.create({ data: record });
    await invalidatePlans(tx, actor, context.workspaceId, policy.id);
    await audit(
      tx,
      actor,
      "POLICY_SAVED",
      "SyncPolicy",
      policy.id,
      context.workspaceId,
      { fields, syncInventory: data.syncInventory, sourceShop, targetShop },
    );
    return policy;
  });
}
export async function getPolicies(actor: Actor) {
  const context = await workspaceOrEmpty(actor);
  const workspaceId = context?.workspaceId ?? "__unpaired__";
  const [policies, previews] = await Promise.all([
    prisma.syncPolicy.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.syncPreview.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  return {
    policies,
    previews,
    connections: context?.connections ?? [await currentConnection(actor)],
    canManage: actor.role === "OWNER",
    canOperate: actor.role === "OWNER" || context?.role === "OPERATOR",
    ...flags(),
  };
}

export async function previewPolicy(actor: Actor, policyId: string) {
  const context = await requireOperator(actor);
  const policy = await prisma.syncPolicy.findFirst({
    where: { id: policyId, workspaceId: context.workspaceId },
  });
  if (!policy)
    throw new DomainError("POLICY_NOT_FOUND", "Policy not found.", 404);
  await requirePairAccess(actor, policy.sourceShopDomain);
  await requirePairAccess(actor, policy.targetShopDomain);
  const { buildPreview } = await import("./sync-engine.server");
  const preview = await buildPreview(policy.id);
  return serial(async (tx) => {
    await requireOperator(actor, tx);
    const latest = await tx.syncPolicy.findFirst({
      where: { id: policy.id, workspaceId: context.workspaceId },
    });
    if (!latest || latest.updatedAt.getTime() !== policy.updatedAt.getTime())
      throw new DomainError(
        "POLICY_CHANGED",
        "The policy changed while preparing the preview. Run it again.",
        409,
      );
    const result = await tx.syncPreview.create({
      data: {
        workspaceId: context.workspaceId,
        policyId: policy.id,
        createdBy: actorKey(actor),
        sourceHash: preview.sourceHash,
        targetHash: preview.targetHash,
        changes: json(preview.changes),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });
    await audit(
      tx,
      actor,
      "SYNC_PREVIEWED",
      "SyncPreview",
      result.id,
      context.workspaceId,
      {
        policyId,
        count: Array.isArray(preview.changes) ? preview.changes.length : 0,
      },
    );
    return result;
  });
}
export async function updatePolicy(
  actor: Actor,
  policyId: string,
  action: "PAUSE" | "ACTIVATE",
) {
  requireOwner(actor);
  if (!["PAUSE", "ACTIVATE"].includes(action))
    throw new DomainError("INVALID_ACTION", "Choose pause or activate.");
  return serial(async (tx) => {
    const context = await requireWorkspace(actor, tx);
    const policy = await tx.syncPolicy.findFirst({
      where: { id: policyId, workspaceId: context.workspaceId },
    });
    if (!policy)
      throw new DomainError("POLICY_NOT_FOUND", "Policy not found.", 404);
    if (action === "ACTIVATE") {
      assertWriteGates(policy.syncInventory);
      const preview = await tx.syncPreview.findFirst({
        where: {
          policyId,
          workspaceId: context.workspaceId,
          status: { in: ["PENDING", "APPROVED", "APPLIED"] },
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });
      if (!preview)
        throw new DomainError(
          "PREVIEW_REQUIRED",
          "Run and review a fresh dry-run preview before activating.",
          409,
        );
      assertSafePreview(preview.changes);
      const opposing = await tx.syncPolicy.findMany({
        where: {
          workspaceId: context.workspaceId,
          sourceShopDomain: policy.targetShopDomain,
          targetShopDomain: policy.sourceShopDomain,
          enabled: true,
          id: { not: policy.id },
        },
      });
      if (
        opposing.some(
          (other) =>
            other.fields.some((field) => policy.fields.includes(field)) ||
            (other.syncInventory && policy.syncInventory),
        )
      )
        throw new DomainError(
          "FIELD_OWNERSHIP_CONFLICT",
          "An active reverse policy owns a selected field or inventory.",
          409,
        );
    }
    const result = await tx.syncPolicy.update({
      where: { id: policy.id },
      data: {
        enabled: action === "ACTIVATE",
        status: action === "ACTIVATE" ? "ACTIVE" : "PAUSED",
        ...(action === "ACTIVATE"
          ? { approvedBy: actorKey(actor), approvedAt: new Date() }
          : {}),
      },
    });
    // Activation moves updatedAt, which every consent fingerprint covers, so no
    // earlier consent can pass again; revoke it rather than leave it ACTIVE.
    const revoked = await revokeStandingConsents(
      tx,
      { workspaceId: context.workspaceId, policyId },
      {
        actor: actorKey(actor),
        shopDomain: actor.shop,
        reason: action === "ACTIVATE" ? "POLICY_ACTIVATED" : "POLICY_PAUSED",
      },
    );
    if (action === "ACTIVATE" && revoked.length)
      await tx.syncJob.updateMany({
        where: {
          workspaceId: context.workspaceId,
          policyId,
          status: { in: ["PENDING", "RETRY", "RUNNING"] },
          OR: revoked.map((id) => ({
            payload: { path: ["consentId"], equals: id },
          })),
        },
        data: {
          status: "CANCELLED",
          leaseUntil: null,
          leaseOwner: null,
          lastError: "AUTOMATIC_CONSENT_REVOKED",
        },
      });
    if (action === "PAUSE") {
      await tx.syncJob.updateMany({
        where: {
          workspaceId: context.workspaceId,
          policyId,
          status: { in: ["PENDING", "RETRY", "RUNNING", "PROCESSING"] },
        },
        data: { status: "CANCELLED", leaseUntil: null, leaseOwner: null },
      });
      await tx.syncPreview.updateMany({
        where: {
          workspaceId: context.workspaceId,
          policyId,
          status: "APPROVED",
        },
        data: { status: "REVOKED" },
      });
    }
    await audit(
      tx,
      actor,
      action === "ACTIVATE" ? "POLICY_ACTIVATED" : "POLICY_PAUSED",
      "SyncPolicy",
      policy.id,
      context.workspaceId,
    );
    return result;
  });
}
export async function approvePreview(actor: Actor, previewId: string) {
  requireOwner(actor);
  const context = await requireWorkspace(actor);
  const preview = await prisma.syncPreview.findFirst({
    where: { id: previewId, workspaceId: context.workspaceId },
  });
  if (!preview)
    throw new DomainError("PREVIEW_NOT_FOUND", "Preview not found.", 404);
  if (preview.status !== "PENDING" || preview.expiresAt <= new Date())
    throw new DomainError(
      "PREVIEW_EXPIRED",
      "This preview has expired or was already used. Run a fresh preview.",
      409,
    );
  assertSafePreview(preview.changes);
  const { buildPreview } = await import("./sync-engine.server");
  const current = await buildPreview(preview.policyId);
  if (
    current.sourceHash !== preview.sourceHash ||
    current.targetHash !== preview.targetHash ||
    stableHash(current.changes) !== stableHash(preview.changes)
  )
    throw new DomainError(
      "PREVIEW_STALE",
      "Store data changed. Review a fresh preview before applying.",
      409,
    );
  return serial(async (tx) => {
    const freshContext = await requireWorkspace(actor, tx);
    if (freshContext.workspaceId !== preview.workspaceId)
      throw new DomainError(
        "WORKSPACE_CHANGED",
        "The store pair changed.",
        409,
      );
    const currentPreview = await tx.syncPreview.findFirst({
      where: {
        id: preview.id,
        workspaceId: freshContext.workspaceId,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
    });
    const policy = await tx.syncPolicy.findFirst({
      where: {
        id: preview.policyId,
        workspaceId: freshContext.workspaceId,
        enabled: true,
        status: "ACTIVE",
      },
    });
    if (!currentPreview || !policy)
      throw new DomainError(
        "ACTIVE_POLICY_REQUIRED",
        "Activate the policy and use a fresh preview before approving.",
        409,
      );
    assertWriteGates(policy.syncInventory);
    await tx.syncPreview.update({
      where: { id: preview.id },
      data: {
        status: "APPROVED",
        approvedBy: actorKey(actor),
        approvedAt: new Date(),
      },
    });
    const job = await tx.syncJob.create({
      data: {
        workspaceId: freshContext.workspaceId,
        policyId: policy.id,
        sourceShop: policy.sourceShopDomain,
        targetShop: policy.targetShopDomain,
        previewId: preview.id,
        operation: "APPLY_PREVIEW",
        idempotencyKey: `preview:${preview.id}`,
        payload: { previewId: preview.id },
      },
    });
    await audit(
      tx,
      actor,
      "SYNC_APPROVED",
      "SyncJob",
      job.id,
      freshContext.workspaceId,
      { previewId: preview.id, policyId: policy.id },
    );
    return job;
  });
}
export async function getOperations(
  actor: Actor,
  params = new URLSearchParams(),
) {
  const context = await workspaceOrEmpty(actor);
  const workspaceId = context?.workspaceId ?? "__unpaired__";
  const jobStatus = (params.get("status") || "").slice(0, 40);
  const jobId = (params.get("job") || "").slice(0, 100);
  const conflictStatus = (params.get("conflictStatus") || "").slice(0, 40);
  const jobsWhere = {
    ...(context
      ? { workspaceId }
      : {
          sourceShop: actor.shop,
          targetShop: actor.shop,
          operation: "CATALOG_IMPORT",
        }),
    ...(jobStatus ? { status: jobStatus } : {}),
    ...(jobId ? { id: jobId } : {}),
  };
  const conflictsWhere = {
    workspaceId,
    ...(conflictStatus ? { status: conflictStatus } : {}),
  };
  const previewWhere = {
    workspaceId,
    ...(params.get("previewStatus")
      ? { status: params.get("previewStatus")!.slice(0, 40) }
      : {}),
  };
  const auditWhere = context
    ? { workspaceId }
    : { shopDomain: actor.shop, workspaceId: null };
  const eventWhere = {
    shopDomain: {
      in: context?.connections.map((connection) => connection.shopDomain) ?? [
        actor.shop,
      ],
    },
  };
  const [
    jobs,
    conflicts,
    previews,
    reconciliations,
    auditEvents,
    events,
    heartbeats,
  ] = await Promise.all([
    listPage(
      params.get("jobsPage"),
      () => prisma.syncJob.count({ where: jobsWhere }),
      (window) =>
        prisma.syncJob.findMany({
          where: jobsWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...window,
        }),
    ),
    listPage(
      params.get("conflictsPage"),
      () => prisma.syncConflict.count({ where: conflictsWhere }),
      (window) =>
        prisma.syncConflict.findMany({
          where: conflictsWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...window,
        }),
    ),
    listPage(
      params.get("previewsPage"),
      () => prisma.syncPreview.count({ where: previewWhere }),
      (window) =>
        prisma.syncPreview.findMany({
          where: previewWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...window,
        }),
    ),
    listPage(
      params.get("runsPage"),
      () => prisma.reconciliationRun.count({ where: { workspaceId } }),
      (window) =>
        prisma.reconciliationRun.findMany({
          where: { workspaceId },
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          ...window,
        }),
    ),
    listPage(
      params.get("auditPage"),
      () => prisma.auditEvent.count({ where: auditWhere }),
      (window) =>
        prisma.auditEvent.findMany({
          where: auditWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...window,
        }),
    ),
    listPage(
      params.get("eventsPage"),
      () => prisma.webhookEvent.count({ where: eventWhere }),
      (window) =>
        prisma.webhookEvent.findMany({
          where: eventWhere,
          orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
          ...window,
        }),
    ),
    prisma.workerHeartbeat.findMany({ orderBy: { seenAt: "desc" }, take: 5 }),
  ]);
  const attempts = await prisma.syncAttempt.findMany({
    where: { jobId: { in: jobs.rows.map((job) => job.id) } },
    orderBy: { attempt: "desc" },
  });
  return {
    jobs: jobs.rows.map((job) => ({
      ...job,
      attempts: attempts.filter((attempt) => attempt.jobId === job.id),
    })),
    conflicts: conflicts.rows,
    previews: previews.rows,
    reconciliations: reconciliations.rows,
    audit: auditEvents.rows,
    events: events.rows,
    pages: {
      jobs: jobs.pageInfo,
      conflicts: conflicts.pageInfo,
      previews: previews.pageInfo,
      runs: reconciliations.pageInfo,
      audit: auditEvents.pageInfo,
      events: events.pageInfo,
    },
    heartbeats,
    canManage: actor.role === "OWNER",
    canOperate: actor.role === "OWNER" || context?.role === "OPERATOR",
  };
}
async function ownedJob(actor: Actor, jobId: string, tx: Tx) {
  const connection = await currentConnection(actor, tx);
  const workspaceId = connection.workspaceId;
  if (workspaceId) await requireWorkspace(actor, tx);
  const job = await tx.syncJob.findFirst({
    where: {
      id: jobId,
      OR: [
        ...(workspaceId ? [{ workspaceId }] : []),
        {
          sourceShop: actor.shop,
          targetShop: actor.shop,
          operation: "CATALOG_IMPORT",
        },
      ],
    },
  });
  if (!job) throw new DomainError("JOB_NOT_FOUND", "Job not found.", 404);
  return job;
}
export async function retryJob(actor: Actor, jobId: string) {
  requireOwner(actor);
  return serial(async (tx) => {
    const job = await ownedJob(actor, jobId, tx);
    if (!["FAILED", "DEAD_LETTER", "RETRY"].includes(job.status))
      throw new DomainError(
        "JOB_NOT_RETRYABLE",
        "Only failed jobs with a known safe outcome can be retried.",
        409,
      );
    if (job.operation === "APPLY_PREVIEW")
      throw new DomainError(
        "FRESH_PREVIEW_REQUIRED",
        "Create a fresh preview to retry a write safely. An old write approval cannot be replayed.",
        409,
      );
    const result = await tx.syncJob.update({
      where: { id: job.id },
      data: {
        status: "PENDING",
        availableAt: new Date(),
        leaseUntil: null,
        leaseOwner: null,
        lastError: null,
        maxAttempts: job.attempts + 5,
      },
    });
    await audit(
      tx,
      actor,
      "JOB_RETRIED",
      "SyncJob",
      job.id,
      job.workspaceId || undefined,
    );
    return result;
  });
}
export async function cancelJob(actor: Actor, jobId: string) {
  requireOwner(actor);
  return serial(async (tx) => {
    const job = await ownedJob(actor, jobId, tx);
    if (["COMPLETED", "SUCCEEDED", "CANCELLED"].includes(job.status))
      throw new DomainError(
        "JOB_FINISHED",
        "This job is already finished.",
        409,
      );
    const result = await tx.syncJob.update({
      where: { id: job.id },
      data: { status: "CANCELLED", leaseUntil: null, leaseOwner: null },
    });
    if (job.previewId)
      await tx.syncPreview.updateMany({
        where: {
          id: job.previewId,
          workspaceId: job.workspaceId,
          status: "APPROVED",
        },
        data: { status: "REVOKED" },
      });
    await audit(
      tx,
      actor,
      "JOB_CANCELLED",
      "SyncJob",
      job.id,
      job.workspaceId || undefined,
    );
    return result;
  });
}
export async function resolveConflict(actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = z
    .object({
      id: z.string().min(1).max(100),
      resolution: z.enum(["KEEP_TARGET", "RETRY"]),
    })
    .strict()
    .parse(input);
  return serial(async (tx) => {
    const context = await requireWorkspace(actor, tx);
    const conflict = await tx.syncConflict.findFirst({
      where: { id: data.id, workspaceId: context.workspaceId, status: "OPEN" },
    });
    if (!conflict)
      throw new DomainError(
        "CONFLICT_NOT_FOUND",
        "Open conflict not found.",
        404,
      );
    // RETRY is a request for a new preview; it never silently reapplies an old stock adjustment.
    const result = await tx.syncConflict.update({
      where: { id: conflict.id },
      data: {
        status: "RESOLVED",
        resolution: data.resolution,
        resolvedAt: new Date(),
        resolvedBy: actorKey(actor),
      },
    });
    await audit(
      tx,
      actor,
      "CONFLICT_RESOLVED",
      "SyncConflict",
      conflict.id,
      context.workspaceId,
      {
        resolution: data.resolution,
        nextAction:
          data.resolution === "RETRY" ? "FRESH_PREVIEW_REQUIRED" : "NONE",
      },
    );
    return result;
  });
}
export async function requestReconciliation(actor: Actor, policyId: string) {
  const context = await requireOperator(actor);
  const policy = await prisma.syncPolicy.findFirst({
    where: { id: policyId, workspaceId: context.workspaceId },
  });
  if (!policy)
    throw new DomainError("POLICY_NOT_FOUND", "Policy not found.", 404);
  return serial(async (tx) => {
    await requireOperator(actor, tx);
    const run = await tx.reconciliationRun.create({
      data: {
        workspaceId: context.workspaceId,
        policyId,
        createdBy: actorKey(actor),
      },
    });
    await tx.syncJob.create({
      data: {
        workspaceId: context.workspaceId,
        policyId,
        sourceShop: policy.sourceShopDomain,
        targetShop: policy.targetShopDomain,
        operation: "RECONCILE",
        payload: { runId: run.id },
        idempotencyKey: `reconcile:${run.id}`,
      },
    });
    await audit(
      tx,
      actor,
      "RECONCILIATION_REQUESTED",
      "ReconciliationRun",
      run.id,
      context.workspaceId,
    );
    return run;
  });
}
export async function getSettings(actor: Actor) {
  const context = await workspaceOrEmpty(actor);
  const notification = context
    ? await prisma.notificationSetting.findUnique({
        where: { workspaceId: context.workspaceId },
      })
    : null;
  return {
    workspace: context?.workspace ?? null,
    notification,
    externalAlertsConfigured: !!alertDestination(),
    notificationDeliveries: context
      ? await prisma.notificationDelivery.findMany({
          where: { workspaceId: context.workspaceId },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            status: true,
            attempts: true,
            errorCode: true,
            createdAt: true,
            deliveredAt: true,
          },
        })
      : [],
    privacyRequests: await prisma.privacyRequest.findMany({
      where: { shopDomain: actor.shop },
      orderBy: { receivedAt: "desc" },
      take: 25,
      select: {
        id: true,
        topic: true,
        status: true,
        outcome: true,
        receivedAt: true,
        completedAt: true,
      },
    }),
    canManage: actor.role === "OWNER",
    ...flags(),
  };
}
export async function updateSettings(actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      reconciliationMinutes: z.number().int().min(5).max(10080).optional(),
      retentionDays: z.number().int().min(7).max(3650).optional(),
      retentionEnabled: z.boolean().optional(),
      notificationsEnabled: z.boolean().optional(),
      externalNotificationsEnabled: z.boolean().optional(),
      failureThreshold: z.number().int().min(1).max(100).optional(),
      lagMinutes: z.number().int().min(1).max(1440).optional(),
    })
    .strict()
    .parse(input);
  if (data.externalNotificationsEnabled && !alertDestination())
    throw new DomainError(
      "ALERT_DESTINATION_REQUIRED",
      "The deployment operator must configure an HTTPS alert destination before you can enable delivery.",
      409,
    );
  return serial(async (tx) => {
    const context = await requireWorkspace(actor, tx);
    const {
      notificationsEnabled,
      externalNotificationsEnabled,
      failureThreshold,
      lagMinutes,
      ...workspaceData
    } = data;
    const workspace = await tx.workspace.update({
      where: { id: context.workspaceId },
      data: workspaceData,
    });
    await tx.notificationSetting.upsert({
      where: { workspaceId: context.workspaceId },
      create: {
        workspaceId: context.workspaceId,
        ...(notificationsEnabled === undefined
          ? {}
          : { enabled: notificationsEnabled }),
        ...(failureThreshold === undefined ? {} : { failureThreshold }),
        ...(lagMinutes === undefined ? {} : { lagMinutes }),
        ...(externalNotificationsEnabled === undefined
          ? {}
          : { externalEnabled: externalNotificationsEnabled }),
      },
      update: {
        ...(notificationsEnabled === undefined
          ? {}
          : { enabled: notificationsEnabled }),
        ...(failureThreshold === undefined ? {} : { failureThreshold }),
        ...(lagMinutes === undefined ? {} : { lagMinutes }),
        ...(externalNotificationsEnabled === undefined
          ? {}
          : { externalEnabled: externalNotificationsEnabled }),
      },
    });
    await audit(
      tx,
      actor,
      "SETTINGS_UPDATED",
      "Workspace",
      workspace.id,
      context.workspaceId,
      data,
    );
    return workspace;
  });
}
export async function getOverview(actor: Actor) {
  const context = await workspaceOrEmpty(actor);
  const workspaceId = context?.workspaceId ?? "__unpaired__";
  const shops = context?.connections.map(
    (connection) => connection.shopDomain,
  ) ?? [actor.shop];
  const [
    products,
    variants,
    inventory,
    mappings,
    jobs,
    failedJobs,
    conflicts,
    webhooks,
    recentJobs,
    recentAudit,
    heartbeats,
  ] = await Promise.all([
    prisma.productSnapshot.count({ where: { shopDomain: { in: shops } } }),
    prisma.variantSnapshot.count({ where: { shopDomain: { in: shops } } }),
    prisma.inventorySnapshot.count({ where: { shopDomain: { in: shops } } }),
    prisma.productMapping.count({
      where: { workspaceId, verifiedAt: { not: null } },
    }),
    prisma.syncJob.count({ where: { workspaceId } }),
    prisma.syncJob.count({
      where: { workspaceId, status: { in: ["FAILED", "DEAD_LETTER", "HELD"] } },
    }),
    prisma.syncConflict.count({ where: { workspaceId, status: "OPEN" } }),
    prisma.webhookEvent.count({ where: { shopDomain: { in: shops } } }),
    prisma.syncJob.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.auditEvent.findMany({
      where: context
        ? { workspaceId }
        : { shopDomain: actor.shop, workspaceId: null },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.workerHeartbeat.findMany({ orderBy: { seenAt: "desc" }, take: 5 }),
  ]);
  return {
    shop: actor.shop,
    workspace: context?.workspace ?? null,
    canManage: actor.role === "OWNER",
    stores: context?.connections ?? [await currentConnection(actor)],
    counts: {
      products,
      variants,
      inventory,
      mappings,
      jobs,
      failedJobs,
      conflicts,
      webhooks,
    },
    recentJobs,
    recentAudit,
    heartbeats,
    ...flags(),
  };
}

export async function getMembers(actor: Actor) {
  requireOwner(actor);
  const context = await workspaceOrEmpty(actor);
  return {
    members: context
      ? await prisma.workspaceMember.findMany({
          where: { workspaceId: context.workspaceId, shopDomain: actor.shop },
          orderBy: { createdAt: "asc" },
          take: 100,
        })
      : [],
    connections: [await currentConnection(actor)],
    canManage: actor.role === "OWNER",
  };
}
export async function setMember(actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = z
    .object({
      shopDomain: z.string(),
      userId: z.string().regex(/^[1-9][0-9]{0,24}$/),
      role: z.enum(["VIEWER", "OPERATOR"]),
      status: z.enum(["ACTIVE", "REVOKED"]),
    })
    .strict()
    .parse(input);
  const shopDomain = normalizeShop(data.shopDomain);
  return serial(async (tx) => {
    const context = await requirePairAccess(actor, shopDomain, tx);
    const existing = await tx.workspaceMember.findUnique({
      where: {
        workspaceId_shopDomain_userId: {
          workspaceId: context.workspaceId,
          shopDomain,
          userId: data.userId,
        },
      },
    });
    if (existing?.role === "OWNER")
      throw new DomainError(
        "OWNER_AUTHORITY",
        "Store-owner authority is managed by Shopify and cannot be changed here.",
        403,
      );
    if (shopDomain !== actor.shop)
      throw new DomainError(
        "STAFF_STORE_AUTHORITY",
        "Only the owner of this store can manage its staff access.",
        403,
      );
    const member = await tx.workspaceMember.upsert({
      where: {
        workspaceId_shopDomain_userId: {
          workspaceId: context.workspaceId,
          shopDomain,
          userId: data.userId,
        },
      },
      create: {
        workspaceId: context.workspaceId,
        shopDomain,
        userId: data.userId,
        role: data.role,
        status: data.status,
      },
      update: { role: data.role, status: data.status },
    });
    await audit(
      tx,
      actor,
      "MEMBERSHIP_UPDATED",
      "WorkspaceMember",
      member.id,
      context.workspaceId,
      { shopDomain, userId: data.userId, role: data.role, status: data.status },
    );
    return member;
  });
}
