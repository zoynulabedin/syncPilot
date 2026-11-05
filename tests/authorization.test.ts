import type { PrismaClient } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The default client stays empty so direct calls prove they use the db argument.
const mocks = vi.hoisted(() => ({
  prisma: {} as Record<string, unknown>,
  auth: vi.fn(),
  workspace: vi.fn(),
  operations: vi.fn(),
  policies: vi.fn(),
}));
vi.mock("../app/db.server", () => ({ default: mocks.prisma }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: mocks.auth },
}));
vi.mock("../app/services/control-plane.server", () => ({
  getWorkspace: mocks.workspace,
  getOperations: mocks.operations,
  getPolicies: mocks.policies,
  requestReconciliation: vi.fn(),
}));
import {
  canOperate,
  requireOperator,
  type Actor,
} from "../app/services/authorization.server";
import { loader as productsLoader } from "../app/routes/app.products";
import { loader as reconciliationLoader } from "../app/routes/app.reconciliation";

const source = "auth-source.myshopify.com",
  target = "auth-target.myshopify.com",
  workspaceId = "workspace-auth";
const owner: Actor = { shop: source, userId: "101", role: "OWNER" };
const staff: Actor = { shop: source, userId: "202", role: "VIEWER" };

type Connection = {
  shopDomain: string;
  workspaceId: string | null;
  status: string;
  uninstalledAt: Date | null;
};
type Member = {
  workspaceId: string;
  shopDomain: string;
  userId: string;
  role: string;
  status: string;
};
type MemberKey = Pick<Member, "workspaceId" | "shopDomain" | "userId">;
type PairWhere = {
  workspaceId: string;
  status: string;
  OR: Array<{ sourceShop?: string; targetShop?: string }>;
};

const connection = (
  shopDomain: string,
  overrides: Partial<Connection> = {},
): Connection => ({
  shopDomain,
  workspaceId,
  status: "CONNECTED",
  uninstalledAt: null,
  ...overrides,
});
const membership = (role: string, status = "ACTIVE"): Member => ({
  workspaceId,
  shopDomain: staff.shop,
  userId: staff.userId,
  role,
  status,
});
const uninstalled = { status: "UNINSTALLED", uninstalledAt: new Date() };

/** Answers only the lookups requireWorkspace makes, honouring their filters. */
function database({
  connections = [connection(source), connection(target)],
  members = [],
}: { connections?: Connection[]; members?: Member[] } = {}) {
  const pair = {
    id: "pair-auth",
    workspaceId,
    sourceShop: source,
    targetShop: target,
    status: "VERIFIED",
  };
  const stub = {
    shopConnection: {
      findUnique: vi.fn(
        async ({ where }: { where: { shopDomain: string } }) =>
          connections.find((row) => row.shopDomain === where.shopDomain) ??
          null,
      ),
      findMany: vi.fn(
        async ({ where }: { where: Omit<Connection, "shopDomain"> }) =>
          connections.filter(
            (row) =>
              row.workspaceId === where.workspaceId &&
              row.status === where.status &&
              row.uninstalledAt === where.uninstalledAt,
          ),
      ),
    },
    workspace: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === workspaceId ? { id: workspaceId, state: "ACTIVE" } : null,
      ),
    },
    workspaceMember: {
      findUnique: vi.fn(
        async ({
          where: { workspaceId_shopDomain_userId: key },
        }: {
          where: { workspaceId_shopDomain_userId: MemberKey };
        }) =>
          members.find(
            (row) =>
              row.workspaceId === key.workspaceId &&
              row.shopDomain === key.shopDomain &&
              row.userId === key.userId,
          ) ?? null,
      ),
    },
    storePair: {
      findFirst: vi.fn(async ({ where }: { where: PairWhere }) =>
        where.workspaceId === pair.workspaceId &&
        where.status === pair.status &&
        where.OR.some(
          (shop) =>
            shop.sourceShop === pair.sourceShop ||
            shop.targetShop === pair.targetShop,
        )
          ? pair
          : null,
      ),
    },
  };
  return { stub, db: stub as unknown as PrismaClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.prisma)) delete mocks.prisma[key];
});

describe("operator capability", () => {
  it("lets Shopify-verified owners operate, including on an unpaired store", async () => {
    const { stub, db } = database({
      connections: [connection(source, { workspaceId: null })],
    });
    await expect(canOperate(owner, db)).resolves.toBe(true);
    expect(stub.shopConnection.findUnique).not.toHaveBeenCalled();
  });

  it("keeps staff on an unpaired store read-only without failing the page", async () => {
    const { db } = database({
      connections: [connection(source, { workspaceId: null })],
      members: [membership("OPERATOR")],
    });
    await expect(canOperate(staff, db)).resolves.toBe(false);
    await expect(canOperate({ ...staff, userId: "unknown" }, db)).resolves.toBe(
      false,
    );
    await expect(requireOperator(staff, db)).rejects.toMatchObject({
      code: "PAIRING_REQUIRED",
    });
  });

  it("grants operation only to active operators inside a verified pair", async () => {
    const operator = database({ members: [membership("OPERATOR")] });
    await expect(canOperate(staff, operator.db)).resolves.toBe(true);
    const viewer = database({ members: [membership("VIEWER")] });
    await expect(canOperate(staff, viewer.db)).resolves.toBe(false);
  });

  it("rejects revoked, unidentified or unpaired operator memberships", async () => {
    const revoked = database({ members: [membership("OPERATOR", "REVOKED")] });
    await expect(canOperate(staff, revoked.db)).rejects.toMatchObject({
      code: "MEMBERSHIP_REQUIRED",
    });
    const unidentified = database({
      members: [{ ...membership("OPERATOR"), userId: "unknown" }],
    });
    await expect(
      canOperate({ ...staff, userId: "unknown" }, unidentified.db),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
    const partnerGone = database({
      connections: [connection(source), connection(target, uninstalled)],
      members: [membership("OPERATOR")],
    });
    await expect(canOperate(staff, partnerGone.db)).rejects.toMatchObject({
      code: "PAIRING_INACTIVE",
    });
  });

  it("still rejects staff on an inactive or unknown installation", async () => {
    for (const connections of [
      [connection(source, { workspaceId: null, ...uninstalled })],
      [connection(source, uninstalled), connection(target)],
      [],
    ]) {
      const { db } = database({
        connections,
        members: [membership("OPERATOR")],
      });
      await expect(canOperate(staff, db)).rejects.toMatchObject({
        code: "INSTALLATION_INACTIVE",
        status: 403,
      });
    }
  });
});

const args = (path: string): LoaderFunctionArgs => ({
  request: new Request(`https://sync.example.invalid${path}`),
  url: new URL(`https://sync.example.invalid${path}`),
  pattern: path,
  params: {},
  context: {},
});

describe("read-only pages for staff on an unpaired store", () => {
  beforeEach(() => {
    const unpaired = connection(source, { workspaceId: null });
    Object.assign(mocks.prisma, database({ connections: [unpaired] }).stub, {
      productSnapshot: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      variantSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
      catalogSnapshot: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    mocks.auth.mockResolvedValue({
      session: {
        shop: source,
        onlineAccessInfo: {
          associated_user: { id: 202, account_owner: false },
        },
      },
    });
    mocks.workspace.mockResolvedValue({
      workspaceId: null,
      workspace: null,
      connections: [unpaired],
    });
    mocks.operations.mockResolvedValue({ canManage: false, canOperate: false });
    mocks.policies.mockResolvedValue({ policies: [] });
  });

  it("renders the products page without import controls", async () => {
    await expect(productsLoader(args("/app/products"))).resolves.toMatchObject({
      shop: source,
      canManage: false,
    });
  });

  it("renders the reconciliation page without reconciliation controls", async () => {
    await expect(
      reconciliationLoader(args("/app/reconciliation")),
    ).resolves.toMatchObject({ policies: [], canManage: false });
  });
});

describe("reconciliation controls for a paired operator", () => {
  it("reuses the role getOperations resolved instead of the owner-only flag", async () => {
    // mocks.prisma stays empty, so any extra authorization lookup would fail.
    mocks.auth.mockResolvedValue({
      session: {
        shop: source,
        onlineAccessInfo: {
          associated_user: { id: 202, account_owner: false },
        },
      },
    });
    mocks.operations.mockResolvedValue({ canManage: false, canOperate: true });
    mocks.policies.mockResolvedValue({ policies: [] });
    await expect(
      reconciliationLoader(args("/app/reconciliation")),
    ).resolves.toMatchObject({ canManage: true });
  });
});
