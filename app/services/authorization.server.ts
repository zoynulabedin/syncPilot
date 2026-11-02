import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../db.server";
import { DomainError, normalizeShop } from "../domain/guards";

type Database = PrismaClient | Prisma.TransactionClient;
export type Actor = { shop: string; userId: string; role: "OWNER" | "VIEWER" };
export type WorkspaceRole = "OWNER" | "OPERATOR" | "VIEWER";
type AuthResult = {
  session: {
    shop: string;
    userId?: bigint | string | number;
    accountOwner?: boolean;
    onlineAccessInfo?: {
      associated_user?: { id?: number | string; account_owner?: boolean };
    };
  };
};

// Caller must first obtain this object through Shopify authenticate.admin(request).
// A session-token subject alone proves identity, not store-owner authority.
export function requireActor(auth: AuthResult): Actor {
  if (!auth?.session?.shop)
    throw new DomainError(
      "UNAUTHENTICATED",
      "Sign in through Shopify to continue.",
      401,
    );
  const user = auth.session.onlineAccessInfo?.associated_user;
  const userId = user?.id ?? auth.session.userId;
  const owner = user?.account_owner === true && user?.id !== undefined;
  return {
    shop: normalizeShop(auth.session.shop),
    userId: userId === undefined ? "unknown" : String(userId),
    role: owner ? "OWNER" : "VIEWER",
  };
}
export function requireOwner(actor: Actor) {
  if (actor.role !== "OWNER" || actor.userId === "unknown")
    throw new DomainError(
      "OWNER_REQUIRED",
      "A verified store owner must approve this operation.",
      403,
    );
}
export async function currentConnection(actor: Actor, db: Database = prisma) {
  const connection = await db.shopConnection.findUnique({
    where: { shopDomain: actor.shop },
  });
  if (
    !connection ||
    connection.status !== "CONNECTED" ||
    connection.uninstalledAt
  )
    throw new DomainError(
      "INSTALLATION_INACTIVE",
      "This installation is inactive. Reopen SyncPilot through Shopify.",
      403,
    );
  return connection;
}
export async function requireWorkspace(actor: Actor, db: Database = prisma) {
  const connection = await currentConnection(actor, db);
  if (!connection.workspaceId)
    throw new DomainError(
      "PAIRING_REQUIRED",
      "Pair both stores before using workspace features.",
      409,
    );
  const workspaceId = connection.workspaceId;
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace || workspace.state !== "ACTIVE")
    throw new DomainError(
      "WORKSPACE_INACTIVE",
      "This workspace is inactive.",
      403,
    );
  const member = await db.workspaceMember.findUnique({
    where: {
      workspaceId_shopDomain_userId: {
        workspaceId,
        shopDomain: actor.shop,
        userId: actor.userId,
      },
    },
  });
  if (
    actor.role !== "OWNER" &&
    (!member ||
      member.status !== "ACTIVE" ||
      !["VIEWER", "OPERATOR"].includes(member.role) ||
      actor.userId === "unknown")
  )
    throw new DomainError(
      "MEMBERSHIP_REQUIRED",
      "A workspace owner must grant access to this staff account.",
      403,
    );
  const connections = await db.shopConnection.findMany({
    where: { workspaceId, status: "CONNECTED", uninstalledAt: null },
    orderBy: { shopDomain: "asc" },
  });
  const pair = await db.storePair.findFirst({
    where: {
      workspaceId,
      status: "VERIFIED",
      OR: [{ sourceShop: actor.shop }, { targetShop: actor.shop }],
    },
  });
  if (
    !pair ||
    connections.length !== 2 ||
    !connections.some((item) => item.shopDomain === actor.shop)
  )
    throw new DomainError(
      "PAIRING_INACTIVE",
      "The verified store pair is no longer active.",
      403,
    );
  if (
    !connections.some((item) => item.shopDomain === pair.sourceShop) ||
    !connections.some((item) => item.shopDomain === pair.targetShop)
  )
    throw new DomainError(
      "PAIRING_INACTIVE",
      "The verified pair no longer matches this workspace.",
      403,
    );
  const role: WorkspaceRole =
    actor.role === "OWNER"
      ? "OWNER"
      : member?.role === "OPERATOR"
        ? "OPERATOR"
        : "VIEWER";
  return { workspaceId, workspace, connection, connections, pair, role };
}

/** Operators prepare read-only work. Shopify owner authority is never delegated. */
export async function requireOperator(actor: Actor, db: Database = prisma) {
  const context = await requireWorkspace(actor, db);
  if (context.role === "VIEWER")
    throw new DomainError(
      "OPERATOR_REQUIRED",
      "An owner must grant operator access before preparing imports or comparisons.",
      403,
    );
  return context;
}

export async function canOperate(actor: Actor, db: Database = prisma) {
  if (actor.role === "OWNER") return true;
  const context = await requireWorkspace(actor, db);
  return context.role === "OPERATOR";
}
export async function requirePairAccess(
  actor: Actor,
  targetShop: string,
  db: Database = prisma,
) {
  const context = await requireWorkspace(actor, db);
  if (
    !context.connections.some(
      (connection) => connection.shopDomain === targetShop,
    )
  )
    throw new DomainError(
      "STORE_NOT_AUTHORIZED",
      "This store is not a verified member of your workspace.",
      403,
    );
  return context;
}
