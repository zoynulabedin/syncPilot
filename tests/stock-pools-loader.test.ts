import { beforeEach, describe, expect, it, vi } from "vitest";

// The default client stays empty, so a real service call fails on any lookup
// the test did not stub.
const mocks = vi.hoisted(() => ({ prisma: {} as Record<string, unknown> }));
vi.mock("../app/db.server", () => ({ default: mocks.prisma }));
vi.mock("../app/services/database-clock.server", () => ({
  databaseNow: async () => new Date(),
}));
import type { Actor } from "../app/services/authorization.server";
import { getStockPools } from "../app/services/stock-ledger.server";

const shop = "ledger-source.myshopify.com";
const partner = "ledger-target.myshopify.com";
const owner: Actor = { shop, userId: "101", role: "OWNER" };
const staff: Actor = { shop, userId: "202", role: "VIEWER" };

// One installation row that upsert really updates, so a later lookup sees the
// reactivated state just as PostgreSQL would.
const installation = (row: Record<string, unknown>) => {
  const shopConnection = {
    upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) =>
      Object.assign(row, update),
    ),
    findUnique: vi.fn(async () => ({ ...row })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      Object.assign(row, data),
    ),
    findMany: vi
      .fn()
      .mockResolvedValue([{ shopDomain: shop }, { shopDomain: partner }]),
  };
  // Reinstalling stored new sessions before this page's loader ran.
  Object.assign(mocks.prisma, {
    shopConnection,
    session: { count: vi.fn().mockResolvedValue(1) },
    auditEvent: { create: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) =>
      work(mocks.prisma),
    ),
  });
  return shopConnection;
};

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of Object.keys(mocks.prisma)) delete mocks.prisma[key];
});

describe("stock pools loader", () => {
  it("reactivates a reinstalled store instead of reporting it inactive", async () => {
    for (const actor of [owner, staff]) {
      // Uninstalling cleared the pairing and marked the installation removed.
      const row = {
        shopDomain: shop,
        workspaceId: null,
        status: "UNINSTALLED",
        uninstalledAt: new Date("2026-11-01T00:00:00Z"),
      };
      const shopConnection = installation(row);
      await expect(getStockPools(actor)).resolves.toEqual({
        pools: [],
        total: 0,
        page: 1,
        selected: null,
        connections: [],
        canManage: actor.role === "OWNER",
      });
      expect(shopConnection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { shopDomain: shop },
          data: expect.objectContaining({
            status: "CONNECTED",
            uninstalledAt: null,
          }),
        }),
      );
      expect(row).toMatchObject({ status: "CONNECTED", uninstalledAt: null });
    }
    // An unpaired store has no ledger, so no stock or workspace was read.
    expect(mocks.prisma).not.toHaveProperty("stockPool");
  });

  it("lists the paired workspace's pools after reactivation", async () => {
    const shopConnection = installation({
      shopDomain: shop,
      workspaceId: "workspace-1",
      status: "CONNECTED",
      uninstalledAt: null,
    });
    const pool = { id: "pool-1", workspaceId: "workspace-1", allocations: [] };
    const stockPool = {
      count: vi.fn().mockResolvedValue(30),
      findMany: vi.fn().mockResolvedValue([pool]),
      findFirst: vi.fn().mockResolvedValue(pool),
    };
    Object.assign(mocks.prisma, {
      workspace: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: "workspace-1", state: "ACTIVE" }),
      },
      workspaceMember: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ status: "ACTIVE", role: "VIEWER" }),
      },
      storePair: {
        findFirst: vi.fn().mockResolvedValue({
          id: "pair-1",
          sourceShop: shop,
          targetShop: partner,
          status: "VERIFIED",
        }),
      },
      stockPool,
    });
    for (const actor of [owner, staff])
      await expect(getStockPools(actor, "pool-1", 5)).resolves.toEqual({
        pools: [pool],
        total: 30,
        // Requested page 5 is clamped to the last of two pages.
        page: 2,
        selected: pool,
        connections: [{ shopDomain: shop }, { shopDomain: partner }],
        canManage: actor.role === "OWNER",
      });
    expect(shopConnection.upsert).toHaveBeenCalledTimes(2);
    for (const [query] of stockPool.findMany.mock.calls)
      expect(query).toMatchObject({
        where: { workspaceId: "workspace-1" },
        skip: 25,
        take: 25,
      });
    for (const [query] of stockPool.findFirst.mock.calls)
      expect(query.where).toEqual({ id: "pool-1", workspaceId: "workspace-1" });
  });

  it("still refuses staff without an active membership", async () => {
    installation({
      shopDomain: shop,
      workspaceId: "workspace-1",
      status: "CONNECTED",
      uninstalledAt: null,
    });
    Object.assign(mocks.prisma, {
      workspace: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: "workspace-1", state: "ACTIVE" }),
      },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(getStockPools(staff)).rejects.toMatchObject({
      code: "MEMBERSHIP_REQUIRED",
      status: 403,
    });
    expect(mocks.prisma).not.toHaveProperty("stockPool");
  });
});
