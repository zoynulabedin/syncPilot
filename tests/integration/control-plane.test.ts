import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import type { Actor } from "../../app/services/authorization.server";
import {
  requirePairAccess,
  requireWorkspace,
} from "../../app/services/authorization.server";
import {
  acceptPairing,
  approvePreview,
  cancelJob,
  confirmPairing,
  deleteMapping,
  disconnectStore,
  ensureInstallation,
  getMappings,
  getOperations,
  getStores,
  initiatePairing,
  retryJob,
  saveMapping,
  savePolicy,
  setMember,
  updatePolicy,
} from "../../app/services/control-plane.server";
import { buildPreview } from "../../app/services/sync-engine.server";

const changes = [
  {
    kind: "PRODUCT" as const,
    sourceId: "gid://shopify/Product/100",
    targetId: "gid://shopify/Product/200",
    field: "title",
    before: "Old",
    after: "New",
  },
];
vi.mock("../../app/services/sync-engine.server", () => ({
  buildPreview: vi.fn(async () => ({
    sourceHash: "source-hash",
    targetHash: "target-hash",
    changes,
  })),
}));
let sequence = 0;
async function fixture(paired = true) {
  sequence++;
  const a: Actor = {
    shop: `control-a-${sequence}.myshopify.com`,
    userId: "101",
    role: "OWNER",
  };
  const b: Actor = {
    shop: `control-b-${sequence}.myshopify.com`,
    userId: "202",
    role: "OWNER",
  };
  const c: Actor = {
    shop: `control-c-${sequence}.myshopify.com`,
    userId: "303",
    role: "OWNER",
  };
  await Promise.all([a, b, c].map(ensureInstallation));
  const pending = await initiatePairing(a, {
    destinationShop: b.shop,
    organizationConfirmed: true,
  });
  let workspaceId = "";
  if (paired) {
    await acceptPairing(b, {
      requestId: pending.request.id,
      challenge: pending.challenge,
      organizationConfirmed: true,
    });
    const result = await confirmPairing(a, { requestId: pending.request.id });
    workspaceId = result.workspace.id;
  }
  return { a, b, c, pending, workspaceId };
}
async function product(shopDomain: string, id: number) {
  return prisma.productSnapshot.create({
    data: {
      shopDomain,
      productGid: `gid://shopify/Product/${id}`,
      title: `Product ${id}`,
      status: "ACTIVE",
      handle: `product-${id}`,
      data: {},
      hash: `hash-${id}`,
    },
  });
}
const policyData = (
  sourceShop: string,
  targetShop: string,
  fields = ["title"],
) => ({
  sourceShop,
  targetShop,
  fields,
  syncInventory: false,
  inventoryMode: "DISABLED" as const,
  buffer: 0,
  reconciliationMinutes: 360,
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "control plane PostgreSQL isolation and approvals",
  () => {
    beforeEach(() => {
      process.env.SYNC_WRITE_ENABLED = "false";
      process.env.INVENTORY_WRITE_ENABLED = "false";
      vi.mocked(buildPreview).mockResolvedValue({
        sourceHash: "source-hash",
        targetHash: "target-hash",
        changes,
      });
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });

    it("pairs only after both owners approve; never exposes or stores the plaintext challenge", async () => {
      const { a, b, c, pending } = await fixture(false);
      const stored = await prisma.storePairingRequest.findUniqueOrThrow({
        where: { id: pending.request.id },
      });
      expect(stored.challengeHash).not.toBe(pending.challenge);
      expect(stored.challengeHash).toHaveLength(64);
      expect(pending.request).not.toHaveProperty("challengeHash");
      expect((await getStores(b)).pairings[0]).not.toHaveProperty(
        "challengeHash",
      );
      await expect(
        confirmPairing(a, { requestId: stored.id }),
      ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
      await expect(
        acceptPairing(c, {
          requestId: stored.id,
          challenge: pending.challenge,
          organizationConfirmed: true,
        }),
      ).rejects.toMatchObject({ code: "PAIRING_NOT_FOUND" });
      await acceptPairing(b, {
        requestId: stored.id,
        challenge: pending.challenge,
        organizationConfirmed: true,
      });
      const result = await confirmPairing(a, { requestId: stored.id });
      expect((await requireWorkspace(a)).workspaceId).toBe(result.workspace.id);
      expect((await requireWorkspace(b)).workspaceId).toBe(result.workspace.id);
      await expect(requirePairAccess(c, a.shop)).rejects.toMatchObject({
        code: "PAIRING_REQUIRED",
      });
      expect((await getOperations(c)).jobs).toEqual([]);
      await expect(
        confirmPairing(a, { requestId: stored.id }),
      ).rejects.toMatchObject({ code: "PAIRING_USED" });
      expect(
        (
          await prisma.storePairingRequest.findUniqueOrThrow({
            where: { id: stored.id },
          })
        ).challengeHash,
      ).toBeNull();
    });
    it("persists failed challenge attempts, locks the fifth attempt, and rejects expiry", async () => {
      const { b, pending } = await fixture(false);
      for (let n = 0; n < 5; n++)
        await expect(
          acceptPairing(b, {
            requestId: pending.request.id,
            challenge: "wrong",
            organizationConfirmed: true,
          }),
        ).rejects.toMatchObject({ code: "INVALID_CHALLENGE" });
      expect(
        (
          await prisma.storePairingRequest.findUniqueOrThrow({
            where: { id: pending.request.id },
          })
        ).attempts,
      ).toBe(5);
      await expect(
        acceptPairing(b, {
          requestId: pending.request.id,
          challenge: pending.challenge,
          organizationConfirmed: true,
        }),
      ).rejects.toMatchObject({ code: "PAIRING_LOCKED" });
      const other = await fixture(false);
      await prisma.storePairingRequest.update({
        where: { id: other.pending.request.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(
        acceptPairing(other.b, {
          requestId: other.pending.request.id,
          challenge: other.pending.challenge,
          organizationConfirmed: true,
        }),
      ).rejects.toMatchObject({ code: "PAIRING_EXPIRED" });
    });
    it("denies unknown staff until a verified owner grants read-only membership", async () => {
      const { a, b } = await fixture();
      const staff: Actor = { shop: a.shop, userId: "404", role: "VIEWER" };
      await expect(requireWorkspace(staff)).rejects.toMatchObject({
        code: "MEMBERSHIP_REQUIRED",
      });
      await expect(
        initiatePairing(staff, {
          destinationShop: b.shop,
          organizationConfirmed: true,
        }),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      await setMember(a, {
        shopDomain: a.shop,
        userId: staff.userId,
        role: "VIEWER",
        status: "ACTIVE",
      });
      expect((await requireWorkspace(staff)).workspaceId).toBeTruthy();
      await expect(
        savePolicy(staff, policyData(a.shop, b.shop)),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      await setMember(a, {
        shopDomain: a.shop,
        userId: staff.userId,
        role: "VIEWER",
        status: "REVOKED",
      });
      await expect(requireWorkspace(staff)).rejects.toMatchObject({
        code: "MEMBERSHIP_REQUIRED",
      });
    });
    it("requires imported identities and rejects target collisions or third-store mappings", async () => {
      const { a, b, c } = await fixture();
      await Promise.all([
        product(a.shop, 100),
        product(a.shop, 101),
        product(b.shop, 200),
      ]);
      const mapping = {
        kind: "PRODUCT",
        sourceShop: a.shop,
        targetShop: b.shop,
        sourceGid: "gid://shopify/Product/100",
        targetGid: "gid://shopify/Product/200",
      };
      await saveMapping(a, mapping);
      await expect(
        saveMapping(a, { ...mapping, sourceGid: "gid://shopify/Product/101" }),
      ).rejects.toMatchObject({ code: "MAPPING_COLLISION" });
      await expect(
        saveMapping(a, { ...mapping, targetShop: c.shop }),
      ).rejects.toMatchObject({ code: "STORE_NOT_AUTHORIZED" });
      expect((await getMappings(c)).products).toEqual([]);
    });
    it("enforces one owner per field across reverse policies and keeps writes off by default", async () => {
      const { a, b } = await fixture();
      const policy = await savePolicy(a, policyData(a.shop, b.shop));
      expect(policy.enabled).toBe(false);
      await expect(
        savePolicy(b, policyData(b.shop, a.shop)),
      ).rejects.toMatchObject({ code: "FIELD_OWNERSHIP_CONFLICT" });
      expect(
        (await savePolicy(b, policyData(b.shop, a.shop, ["vendor"]))).enabled,
      ).toBe(false);
      await expect(
        updatePolicy(a, policy.id, "ACTIVATE"),
      ).rejects.toMatchObject({ code: "WRITES_DISABLED" });
      process.env.SYNC_WRITE_ENABLED = "true";
      await expect(
        updatePolicy(a, policy.id, "ACTIVATE"),
      ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
    });
    it("paginates every mapping with stable ties and searches resources beyond the first page without tenant leaks", async () => {
      const { a, b, c, workspaceId } = await fixture();
      const createdAt = new Date("2026-01-01T00:00:00Z");
      await prisma.productMapping.createMany({
        data: Array.from({ length: 61 }, (_, n) => ({
          id: `${workspaceId}-mapping-${String(n).padStart(3, "0")}`,
          workspaceId,
          sourceShopDomain: a.shop,
          targetShopDomain: b.shop,
          sourceProductGid: `gid://shopify/Product/${1000 + n}`,
          targetProductGid: `gid://shopify/Product/${2000 + n}`,
          createdAt,
        })),
      });
      await prisma.productSnapshot.createMany({
        data: Array.from({ length: 61 }, (_, n) => ({
          shopDomain: a.shop,
          productGid: `gid://shopify/Product/${1000 + n}`,
          title: `Resource ${String(n).padStart(3, "0")}`,
          handle: `resource-${n}`,
          status: "ACTIVE",
          data: {},
          hash: "test",
        })),
      });
      const found = [];
      for (let page = 1; page <= 3; page++) {
        const result = await getMappings(
          a,
          new URLSearchParams({ mappingPage: String(page) }),
        );
        expect(result.mappingPage.total).toBe(61);
        expect(result.products.length).toBeLessThanOrEqual(25);
        found.push(...result.products.map((row) => row.id));
      }
      expect(new Set(found).size).toBe(61);
      expect(found).toHaveLength(61);
      const result = await getMappings(
        a,
        new URLSearchParams({
          q: "2060",
          resourceQ: "Resource 060",
          mappingPage: "999999",
        }),
      );
      expect(result.products).toHaveLength(1);
      expect(result.mappingPage.page).toBe(1);
      expect(result.snapshots.products[0].productGid).toBe(
        "gid://shopify/Product/1060",
      );
      expect(
        (await getMappings(c, new URLSearchParams({ resourceQ: "Resource" })))
          .snapshots.products,
      ).toEqual([]);
    });
    it("filters all job history before pagination and scopes old job links, audits and webhook pages", async () => {
      const { a, b, c, workspaceId } = await fixture();
      const createdAt = new Date("2026-01-01T00:00:00Z");
      await prisma.syncJob.createMany({
        data: Array.from({ length: 61 }, (_, n) => ({
          id: `${workspaceId}-job-${String(n).padStart(3, "0")}`,
          workspaceId,
          policyId: "",
          sourceShop: a.shop,
          targetShop: b.shop,
          operation: "RECONCILE",
          status: n === 0 ? "FAILED" : "COMPLETED",
          createdAt,
        })),
      });
      await prisma.webhookEvent.createMany({
        data: Array.from({ length: 61 }, (_, n) => ({
          shopDomain: b.shop,
          deliveryId: `listing-${n}`,
          topic: "PRODUCTS_UPDATE",
          receivedAt: createdAt,
        })),
      });
      const first = await getOperations(a);
      const second = await getOperations(
        a,
        new URLSearchParams({ jobsPage: "2", eventsPage: "2" }),
      );
      expect(first.pages.jobs.total).toBe(61);
      expect(second.jobs).toHaveLength(25);
      expect(
        second.jobs.some((job) =>
          first.jobs.some((item) => item.id === job.id),
        ),
      ).toBe(false);
      expect(
        second.events.some((event) =>
          first.events.some((item) => item.id === event.id),
        ),
      ).toBe(false);
      const filtered = await getOperations(
        a,
        new URLSearchParams({ status: "FAILED" }),
      );
      expect(filtered.pages.jobs.total).toBe(1);
      const oldId = `${workspaceId}-job-000`;
      expect(
        (await getOperations(a, new URLSearchParams({ job: oldId }))).jobs[0]
          .id,
      ).toBe(oldId);
      const other = await getOperations(
        c,
        new URLSearchParams({ job: oldId, eventsPage: "2", auditPage: "2" }),
      );
      expect(other.jobs).toEqual([]);
      expect(other.events).toEqual([]);
      expect(other.audit).toEqual([]);
    });
    it("consumes exact approvals once and rejects stale or unapproved data", async () => {
      const { a, b, workspaceId } = await fixture();
      const policy = await savePolicy(a, policyData(a.shop, b.shop));
      const preview = await prisma.syncPreview.create({
        data: {
          workspaceId,
          policyId: policy.id,
          createdBy: `${a.shop}:${a.userId}`,
          sourceHash: "source-hash",
          targetHash: "target-hash",
          changes,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await expect(approvePreview(a, preview.id)).rejects.toMatchObject({
        code: "ACTIVE_POLICY_REQUIRED",
      });
      process.env.SYNC_WRITE_ENABLED = "true";
      await updatePolicy(a, policy.id, "ACTIVATE");
      vi.mocked(buildPreview).mockResolvedValueOnce({
        sourceHash: "changed",
        targetHash: "target-hash",
        changes,
      });
      await expect(approvePreview(a, preview.id)).rejects.toMatchObject({
        code: "PREVIEW_STALE",
      });
      const job = await approvePreview(a, preview.id);
      expect(job.idempotencyKey).toBe(`preview:${preview.id}`);
      expect(job.operation).toBe("APPLY_PREVIEW");
      await expect(approvePreview(a, preview.id)).rejects.toMatchObject({
        code: "PREVIEW_EXPIRED",
      });
      await expect(retryJob(a, job.id)).rejects.toMatchObject({
        code: "JOB_NOT_RETRYABLE",
      });
    });
    it("serializes concurrent approvals into exactly one durable write job", async () => {
      const { a, b, workspaceId } = await fixture();
      const policy = await savePolicy(a, policyData(a.shop, b.shop));
      const preview = await prisma.syncPreview.create({
        data: {
          workspaceId,
          policyId: policy.id,
          createdBy: `${a.shop}:${a.userId}`,
          sourceHash: "source-hash",
          targetHash: "target-hash",
          changes,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      process.env.SYNC_WRITE_ENABLED = "true";
      await updatePolicy(a, policy.id, "ACTIVATE");
      const results = await Promise.allSettled([
        approvePreview(a, preview.id),
        approvePreview(a, preview.id),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        await prisma.syncJob.count({ where: { previewId: preview.id } }),
      ).toBe(1);
      expect(
        (
          await prisma.syncPreview.findUniqueOrThrow({
            where: { id: preview.id },
          })
        ).status,
      ).toBe("APPROVED");
    });
    it("invalidates approved plans and queued writes when mappings change", async () => {
      const { a, b, workspaceId } = await fixture();
      await Promise.all([product(a.shop, 100), product(b.shop, 200)]);
      const mapping = await saveMapping(a, {
        kind: "PRODUCT",
        sourceShop: a.shop,
        targetShop: b.shop,
        sourceGid: "gid://shopify/Product/100",
        targetGid: "gid://shopify/Product/200",
      });
      const policy = await savePolicy(a, policyData(a.shop, b.shop));
      const preview = await prisma.syncPreview.create({
        data: {
          workspaceId,
          policyId: policy.id,
          createdBy: `${a.shop}:${a.userId}`,
          sourceHash: "source-hash",
          targetHash: "target-hash",
          changes,
          status: "APPROVED",
          approvedBy: `${a.shop}:${a.userId}`,
          approvedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const job = await prisma.syncJob.create({
        data: {
          workspaceId,
          policyId: policy.id,
          sourceShop: a.shop,
          targetShop: b.shop,
          operation: "APPLY_PREVIEW",
          previewId: preview.id,
        },
      });
      await deleteMapping(a, { kind: "PRODUCT", id: mapping.id });
      expect(
        (
          await prisma.syncPreview.findUniqueOrThrow({
            where: { id: preview.id },
          })
        ).status,
      ).toBe("STALE");
      expect(
        (await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } }))
          .status,
      ).toBe("CANCELLED");
      await expect(approvePreview(a, preview.id)).rejects.toMatchObject({
        code: "PREVIEW_EXPIRED",
      });
    });
    it("cannot promote staff to owner or alter an owner's Shopify-derived authority", async () => {
      const { a, b } = await fixture();
      await expect(
        setMember(a, {
          shopDomain: b.shop,
          userId: b.userId,
          role: "VIEWER",
          status: "REVOKED",
        }),
      ).rejects.toMatchObject({ code: "OWNER_AUTHORITY" });
      await expect(
        setMember(a, {
          shopDomain: a.shop,
          userId: "999",
          role: "OWNER",
          status: "ACTIVE",
        }),
      ).rejects.toThrow();
      expect(
        (
          await prisma.workspaceMember.findFirstOrThrow({
            where: { shopDomain: b.shop, userId: b.userId },
          })
        ).role,
      ).toBe("OWNER");
    });
    it("revokes pairing and pending work atomically without deleting audit history", async () => {
      const { a, b, workspaceId } = await fixture();
      const policy = await savePolicy(a, policyData(a.shop, b.shop));
      const job = await prisma.syncJob.create({
        data: {
          workspaceId,
          policyId: policy.id,
          sourceShop: a.shop,
          targetShop: b.shop,
          operation: "APPLY_PREVIEW",
          status: "PENDING",
        },
      });
      await disconnectStore(a, b.shop);
      expect(
        (await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } }))
          .status,
      ).toBe("CANCELLED");
      expect(
        (await prisma.storePair.findFirstOrThrow({ where: { workspaceId } }))
          .status,
      ).toBe("REVOKED");
      expect(
        (
          await prisma.shopConnection.findUniqueOrThrow({
            where: { shopDomain: a.shop },
          })
        ).workspaceId,
      ).toBeNull();
      expect(
        await prisma.auditEvent.count({
          where: { workspaceId, action: "STORES_DISCONNECTED" },
        }),
      ).toBe(1);
      await expect(requireWorkspace(a)).rejects.toMatchObject({
        code: "PAIRING_REQUIRED",
      });
      await ensureInstallation(a);
      await expect(requireWorkspace(a)).rejects.toMatchObject({
        code: "PAIRING_REQUIRED",
      });
    });
    it("allows safe cancellation and read-import retry before pairing without touching another shop", async () => {
      const { a, c } = await fixture(false);
      const job = await prisma.syncJob.create({
        data: {
          workspaceId: "",
          policyId: "",
          sourceShop: a.shop,
          targetShop: a.shop,
          operation: "CATALOG_IMPORT",
          status: "FAILED",
          attempts: 5,
        },
      });
      await expect(retryJob(c, job.id)).rejects.toMatchObject({
        code: "JOB_NOT_FOUND",
      });
      expect((await retryJob(a, job.id)).status).toBe("PENDING");
      expect((await cancelJob(a, job.id)).status).toBe("CANCELLED");
    });
  },
);
