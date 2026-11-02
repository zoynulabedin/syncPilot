import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.server";
import { DomainError, normalizeShop } from "../domain/guards";
import { MAX_STOCK, assertStockConserved } from "../domain/stock-ledger";
import { stableHash } from "../domain/sync";
import { type Actor, currentConnection, requireOwner, requireWorkspace } from "./authorization.server";

type Tx = Prisma.TransactionClient;
const quantity = z.number().int().min(0).max(MAX_STOCK);
const identifier = z.string().min(1).max(100);
const operation = { poolId: identifier, operationKey: z.string().min(8).max(100), expectedVersion: quantity };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));

async function serial<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: "Serializable", timeout: 15_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2034" && attempt < 4) continue;
        if (error.code === "P2002")
          throw new DomainError("STOCK_IDENTITY_USED", "This stock identity or reference is already registered. Refresh the ledger before retrying.", 409);
      }
      throw error;
    }
  }
}

async function audit(tx: Tx, actor: Actor, workspaceId: string, poolId: string, action: string, details: unknown) {
  await tx.auditEvent.create({ data: {
    workspaceId, shopDomain: actor.shop, actor: `${actor.shop}:${actor.userId}`,
    action, resourceType: "StockPool", resourceId: poolId, details: json(details),
  } });
}

export async function createStockPool(actor: Actor, input: unknown) {
  requireOwner(actor);
  const data = z.object({
    name: z.string().trim().min(1).max(100), reference: z.string().trim().min(1).max(100),
    physical: quantity, safetyBuffer: quantity, centralLedgerConfirmed: z.literal(true),
  }).strict().parse(input);
  assertStockConserved({ ...data, reserved: 0 }, []);
  return serial(async (tx) => {
    const { workspaceId } = await requireWorkspace(actor, tx);
    const pool = await tx.stockPool.create({ data: {
      workspaceId, name: data.name, reference: data.reference, physical: data.physical, safetyBuffer: data.safetyBuffer,
    } });
    await audit(tx, actor, workspaceId, pool.id, "STOCK_POOL_CREATED", { physical: data.physical, safetyBuffer: data.safetyBuffer });
    return pool;
  });
}

type Receipt = { version: number; allocationId?: string; reservationId?: string };
async function mutate(
  actor: Actor,
  data: { poolId: string; operationKey: string; expectedVersion: number },
  kind: string,
  request: unknown,
  apply: (tx: Tx, pool: { id: string; physical: number; reserved: number; safetyBuffer: number }, workspaceId: string) => Promise<Omit<Receipt, "version">>,
): Promise<Receipt> {
  requireOwner(actor);
  return serial(async (tx) => {
    const { workspaceId } = await requireWorkspace(actor, tx);
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "StockPool" WHERE "id" = ${data.poolId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    if (!locked.length) throw new DomainError("STOCK_POOL_NOT_FOUND", "Stock pool was not found in this workspace.", 404);
    const pool = await tx.stockPool.findUniqueOrThrow({ where: { id: data.poolId } });
    const hash = stableHash({ kind, request, actor: `${actor.shop}:${actor.userId}` });
    const prior = await tx.stockLedgerOperation.findUnique({ where: { poolId_operationKey: { poolId: pool.id, operationKey: data.operationKey } } });
    if (prior) {
      if (prior.requestHash !== hash) throw new DomainError("IDEMPOTENCY_MISMATCH", "This operation key was already used for a different stock change.", 409);
      return prior.result as Receipt;
    }
    if (pool.version !== data.expectedVersion) throw new DomainError("STALE_STOCK_POOL", "This ledger changed since you opened it. Refresh before approving another change.", 409);
    const extra = await apply(tx, pool, workspaceId);
    const allocations = await tx.stockAllocation.findMany({ where: { poolId: pool.id } });
    const reserved = await tx.stockReservation.aggregate({ where: { poolId: pool.id, status: "ACTIVE" }, _sum: { quantity: true } });
    if ((reserved._sum.quantity ?? 0) !== pool.reserved)
      throw new DomainError("STOCK_LEDGER_INCONSISTENT", "Reservation totals do not match the stock ledger. Hold changes and reconcile it.", 409);
    assertStockConserved(pool, allocations.map((row) => row.quantity));
    const updated = await tx.stockPool.update({ where: { id: pool.id }, data: {
      physical: pool.physical, reserved: pool.reserved, safetyBuffer: pool.safetyBuffer, version: { increment: 1 },
    } });
    const result: Receipt = { version: updated.version, ...extra };
    await tx.stockLedgerOperation.create({ data: { poolId: pool.id, operationKey: data.operationKey, requestHash: hash, kind, result: json(result) } });
    await audit(tx, actor, workspaceId, pool.id, `STOCK_${kind}`, { ...result, physical: pool.physical, reserved: pool.reserved, safetyBuffer: pool.safetyBuffer, operationKey: data.operationKey });
    return result;
  });
}

export async function adjustStockPool(actor: Actor, input: unknown) {
  const data = z.object({ ...operation, physical: quantity, safetyBuffer: quantity }).strict().parse(input);
  return mutate(actor, data, "ADJUSTED", data, async (_tx, pool) => {
    pool.physical = data.physical; pool.safetyBuffer = data.safetyBuffer;
    return {};
  });
}

export async function allocateStock(actor: Actor, input: unknown) {
  const data = z.object({
    ...operation, shopDomain: z.string().max(100),
    inventoryItemGid: z.string().regex(/^gid:\/\/shopify\/InventoryItem\/\d+$/),
    locationGid: z.string().regex(/^gid:\/\/shopify\/Location\/\d+$/), quantity,
  }).strict().parse(input);
  data.shopDomain = normalizeShop(data.shopDomain);
  return mutate(actor, data, "ALLOCATED", data, async (tx, pool, workspaceId) => {
    const connection = await tx.shopConnection.findFirst({ where: { shopDomain: data.shopDomain, workspaceId, status: "CONNECTED", uninstalledAt: null } });
    if (!connection) throw new DomainError("STORE_NOT_AUTHORIZED", "Select an active store from this workspace.", 403);
    const [variant, location, observed] = await Promise.all([
      tx.variantSnapshot.findFirst({ where: { shopDomain: data.shopDomain, inventoryItemGid: data.inventoryItemGid, tracked: true } }),
      tx.locationSnapshot.findUnique({ where: { shopDomain_locationGid: { shopDomain: data.shopDomain, locationGid: data.locationGid } } }),
      tx.inventorySnapshot.findUnique({ where: { shopDomain_inventoryItemGid_locationGid: { shopDomain: data.shopDomain, inventoryItemGid: data.inventoryItemGid, locationGid: data.locationGid } } }),
    ]);
    if (!variant || !location?.isActive || !observed) throw new DomainError("STOCK_IDENTITY_UNVERIFIED", "Import a tracked inventory item at an active location before allocating stock.", 409);
    const key = { shopDomain: data.shopDomain, inventoryItemGid: data.inventoryItemGid, locationGid: data.locationGid };
    const existing = await tx.stockAllocation.findUnique({ where: { shopDomain_inventoryItemGid_locationGid: key } });
    if (existing && existing.poolId !== pool.id) throw new DomainError("STOCK_IDENTITY_USED", "This inventory item and location already belong to another physical stock pool.", 409);
    const allocation = await tx.stockAllocation.upsert({
      where: { shopDomain_inventoryItemGid_locationGid: key },
      create: { ...key, poolId: pool.id, quantity: data.quantity }, update: { quantity: data.quantity },
    });
    return { allocationId: allocation.id };
  });
}

export async function reserveStock(actor: Actor, input: unknown) {
  const data = z.object({ ...operation, allocationId: identifier, reference: z.string().trim().min(1).max(100), quantity: quantity.min(1) }).strict().parse(input);
  return mutate(actor, data, "RESERVED", data, async (tx, pool) => {
    const allocation = await tx.stockAllocation.findFirst({ where: { id: data.allocationId, poolId: pool.id } });
    if (!allocation || allocation.quantity < data.quantity) throw new DomainError("STOCK_UNAVAILABLE", "This allocation does not contain enough unreserved stock.", 409);
    const reservation = await tx.stockReservation.create({ data: { poolId: pool.id, allocationId: allocation.id, reference: data.reference, quantity: data.quantity } });
    await tx.stockAllocation.update({ where: { id: allocation.id }, data: { quantity: { decrement: data.quantity } } });
    pool.reserved += data.quantity;
    return { reservationId: reservation.id };
  });
}

export async function completeStockReservation(actor: Actor, input: unknown) {
  const data = z.object({ ...operation, reservationId: identifier, outcome: z.enum(["RELEASED", "FULFILLED"]) }).strict().parse(input);
  return mutate(actor, data, data.outcome, data, async (tx, pool) => {
    const reservation = await tx.stockReservation.findFirst({ where: { id: data.reservationId, poolId: pool.id } });
    if (!reservation || reservation.status !== "ACTIVE") throw new DomainError("RESERVATION_INACTIVE", "This reservation is missing or already completed.", 409);
    await tx.stockReservation.update({ where: { id: reservation.id }, data: { status: data.outcome, completedAt: new Date() } });
    pool.reserved -= reservation.quantity;
    if (data.outcome === "FULFILLED") pool.physical -= reservation.quantity;
    else await tx.stockAllocation.update({ where: { id: reservation.allocationId }, data: { quantity: { increment: reservation.quantity } } });
    return { reservationId: reservation.id };
  });
}

export async function getStockPools(actor: Actor, selectedPoolId?: string, page = 1) {
  const connection = await currentConnection(actor);
  if (!connection.workspaceId) return { pools: [], total: 0, page: 1, selected: null, connections: [], canManage: actor.role === "OWNER" };
  const { workspaceId, connections } = await requireWorkspace(actor);
  const total = await prisma.stockPool.count({ where: { workspaceId } });
  page = Math.max(1, Math.min(Math.ceil(total / 25) || 1, Number.isSafeInteger(page) ? page : 1));
  const pools = await prisma.stockPool.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 25, take: 25, include: { allocations: true } });
  const selected = selectedPoolId ? await prisma.stockPool.findFirst({ where: { id: selectedPoolId, workspaceId }, include: { allocations: true, reservations: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 100 }, operations: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 25 } } }) : null;
  return { pools, total, page, selected, connections, canManage: actor.role === "OWNER" };
}
