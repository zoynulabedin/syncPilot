import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import {
  requireOperator,
  requireOwner,
  requireWorkspace,
  type Actor,
} from "../../app/services/authorization.server";
import {
  consumeRateLimit,
  rateLimitKey,
} from "../../app/services/rate-limit.server";
import {
  approvePreview,
  getMembers,
  previewPolicy,
  requestReconciliation,
  savePolicy,
  setMember,
  updateSettings,
} from "../../app/services/control-plane.server";
import { importCatalog } from "../../app/services/catalog.server";

vi.mock("../../app/services/sync-engine.server", () => ({
  buildPreview: vi.fn(async () => ({
    sourceHash: "source",
    targetHash: "target",
    changes: [],
  })),
}));

async function fixture() {
  const id = randomUUID().replaceAll("-", "");
  const owner: Actor = {
    shop: `access-a-${id}.myshopify.com`,
    userId: "101",
    role: "OWNER",
  };
  const other: Actor = {
    shop: `access-b-${id}.myshopify.com`,
    userId: "202",
    role: "OWNER",
  };
  const staff: Actor = { shop: owner.shop, userId: "303", role: "VIEWER" };
  const workspace = await prisma.workspace.create({
    data: { name: "Access fixture" },
  });
  await prisma.shopConnection.createMany({
    data: [owner, other].map((actor) => ({
      shopDomain: actor.shop,
      workspaceId: workspace.id,
    })),
  });
  await prisma.storePair.create({
    data: {
      workspaceId: workspace.id,
      sourceShop: owner.shop,
      targetShop: other.shop,
      requestId: id,
    },
  });
  await prisma.workspaceMember.createMany({
    data: [owner, other].map((actor) => ({
      workspaceId: workspace.id,
      shopDomain: actor.shop,
      userId: actor.userId,
      role: "OWNER",
    })),
  });
  const policy = await savePolicy(owner, {
    sourceShop: owner.shop,
    targetShop: other.shop,
    fields: ["title"],
    syncInventory: false,
    inventoryMode: "DISABLED",
    buffer: 0,
    reconciliationMinutes: 360,
  });
  return { owner, other, staff, workspace, policy };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "request limits and delegated access in PostgreSQL",
  () => {
    afterAll(async () => {
      await prisma.$disconnect();
    });

    it("enforces a concurrent shared budget exactly, isolates identities and resets expired windows", async () => {
      const id = randomUUID();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 40 }, () => consumeRateLimit("test", id, 7)),
      );
      expect(
        outcomes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(7);
      for (const result of outcomes)
        if (result.status === "rejected")
          expect((result.reason as Response).status).toBe(429);
      await expect(
        consumeRateLimit("test", `${id}:other`, 7),
      ).resolves.toBeUndefined();
      await expect(
        consumeRateLimit("other-scope", id, 7),
      ).resolves.toBeUndefined();
      const key = rateLimitKey("test", id);
      await prisma.$executeRaw`UPDATE "RequestRateLimit" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "key" = ${key}`;
      await expect(consumeRateLimit("test", id, 7)).resolves.toBeUndefined();
      const rows = await prisma.$queryRaw<
        Array<{ count: number }>
      >`SELECT "count" FROM "RequestRateLimit" WHERE "key" = ${key}`;
      expect(rows[0].count).toBe(1);
    });

    it("lets an operator prepare discovery and comparisons while owner actions stay protected", async () => {
      const { owner, staff, policy } = await fixture();
      await setMember(owner, {
        shopDomain: owner.shop,
        userId: staff.userId,
        role: "VIEWER",
        status: "ACTIVE",
      });
      await expect(requireOperator(staff)).rejects.toMatchObject({
        code: "OPERATOR_REQUIRED",
      });
      await expect(importCatalog(staff)).rejects.toMatchObject({
        code: "OPERATOR_REQUIRED",
      });
      await setMember(owner, {
        shopDomain: owner.shop,
        userId: staff.userId,
        role: "OPERATOR",
        status: "ACTIVE",
      });
      expect((await requireOperator(staff)).role).toBe("OPERATOR");
      expect(() => requireOwner(staff)).toThrow();
      const snapshot = await importCatalog(staff);
      expect(snapshot.shopDomain).toBe(owner.shop);
      const preview = await previewPolicy(staff, policy.id);
      expect(preview.createdBy).toBe(`${staff.shop}:${staff.userId}`);
      expect((await requestReconciliation(staff, policy.id)).policyId).toBe(
        policy.id,
      );
      await expect(approvePreview(staff, preview.id)).rejects.toMatchObject({
        code: "OWNER_REQUIRED",
      });
      await expect(
        updateSettings(staff, { retentionEnabled: true }),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      await expect(
        setMember(staff, {
          shopDomain: owner.shop,
          userId: "999",
          role: "OPERATOR",
          status: "ACTIVE",
        }),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      await setMember(owner, {
        shopDomain: owner.shop,
        userId: staff.userId,
        role: "OPERATOR",
        status: "REVOKED",
      });
      await expect(previewPolicy(staff, policy.id)).rejects.toMatchObject({
        code: "MEMBERSHIP_REQUIRED",
      });
      await expect(importCatalog(staff)).rejects.toMatchObject({
        code: "MEMBERSHIP_REQUIRED",
      });
    });

    it("prevents cross-store delegation and rejects corrupt stored owner elevation", async () => {
      const { owner, other, staff, workspace } = await fixture();
      await expect(
        setMember(owner, {
          shopDomain: other.shop,
          userId: "999",
          role: "OPERATOR",
          status: "ACTIVE",
        }),
      ).rejects.toMatchObject({ code: "STAFF_STORE_AUTHORITY" });
      await setMember(other, {
        shopDomain: other.shop,
        userId: "999",
        role: "VIEWER",
        status: "ACTIVE",
      });
      expect(
        (await getMembers(owner)).members.every(
          (member) => member.shopDomain === owner.shop,
        ),
      ).toBe(true);
      await prisma.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          shopDomain: staff.shop,
          userId: staff.userId,
          role: "OWNER",
        },
      });
      await expect(requireWorkspace(staff)).rejects.toMatchObject({
        code: "MEMBERSHIP_REQUIRED",
      });
      await expect(
        requireOperator({
          ...staff,
          shop: `alien-${randomUUID()}.myshopify.com`,
        }),
      ).rejects.toMatchObject({ code: "INSTALLATION_INACTIVE" });
    });
  },
);
