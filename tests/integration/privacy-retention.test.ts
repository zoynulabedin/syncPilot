import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import { cleanWorkspaceHistory } from "../../app/services/retention.server";
import {
  processPrivacyRequest,
  receivePrivacyRequest,
} from "../../app/services/privacy.server";
import {
  ensureInstallation,
  initiatePairing,
  acceptPairing,
  confirmPairing,
  updateSettings,
} from "../../app/services/control-plane.server";
import { revokeInstallation } from "../../app/services/installation.server";
import type { Actor } from "../../app/services/authorization.server";

async function fixture() {
  const key = randomUUID().slice(0, 8);
  const a: Actor = {
    shop: `privacy-a-${key}.myshopify.com`,
    userId: "1",
    role: "OWNER",
  };
  const b: Actor = {
    shop: `privacy-b-${key}.myshopify.com`,
    userId: "2",
    role: "OWNER",
  };
  await ensureInstallation(a);
  await ensureInstallation(b);
  const request = await initiatePairing(a, {
    destinationShop: b.shop,
    organizationConfirmed: true,
  });
  await acceptPairing(b, {
    requestId: request.request.id,
    challenge: request.challenge,
    organizationConfirmed: true,
  });
  const { workspace } = await confirmPairing(a, {
    requestId: request.request.id,
  });
  return { a, b, workspaceId: workspace.id };
}
async function snapshot(shopDomain: string) {
  return prisma.productSnapshot.create({
    data: {
      shopDomain,
      productGid: "gid://shopify/Product/1",
      title: "Private catalog",
      handle: "private",
      status: "ACTIVE",
      data: {},
      hash: "test",
    },
  });
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "privacy and consented retention",
  () => {
    afterAll(async () => {
      await prisma.$disconnect();
    });
    it("does nothing without owner consent, purges only old closed records, and preserves unresolved evidence and other tenants", async () => {
      const { a, b, workspaceId } = await fixture();
      const other = await fixture();
      const old = new Date(Date.now() - 100 * 86_400_000);
      const data = {
        workspaceId,
        policyId: "",
        sourceShop: a.shop,
        targetShop: b.shop,
        operation: "RECONCILE",
        updatedAt: old,
        createdAt: old,
      };
      const closed = await prisma.syncJob.create({
        data: {
          ...data,
          status: "SUCCEEDED",
          syncAttempts: {
            create: { attempt: 1, status: "SUCCEEDED", startedAt: old },
          },
        },
      });
      const held = await prisma.syncJob.create({
        data: { ...data, status: "HELD" },
      });
      const failed = await prisma.syncJob.create({
        data: { ...data, status: "FAILED" },
      });
      const openJob = await prisma.syncJob.create({
        data: { ...data, status: "SUCCEEDED" },
      });
      await prisma.syncConflict.create({
        data: {
          workspaceId,
          jobId: openJob.id,
          code: "UNKNOWN_OUTCOME",
          details: {},
          createdAt: old,
        },
      });
      const recent = await prisma.syncJob.create({
        data: { ...data, status: "SUCCEEDED", updatedAt: new Date() },
      });
      const otherJob = await prisma.syncJob.create({
        data: {
          ...data,
          workspaceId: other.workspaceId,
          sourceShop: other.a.shop,
          targetShop: other.b.shop,
          status: "SUCCEEDED",
        },
      });
      const audit = await prisma.auditEvent.create({
        data: {
          workspaceId,
          actor: "test",
          action: "OLD_HISTORY",
          createdAt: old,
        },
      });
      await expect(cleanWorkspaceHistory(workspaceId)).resolves.toBeNull();
      expect(
        await prisma.syncJob.findUnique({ where: { id: closed.id } }),
      ).not.toBeNull();
      await expect(
        updateSettings({ ...a, role: "VIEWER" }, { retentionEnabled: true }),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      await updateSettings(a, { retentionEnabled: true, retentionDays: 90 });
      expect((await cleanWorkspaceHistory(workspaceId))?.jobs).toBe(1);
      expect(
        await prisma.syncJob.findUnique({ where: { id: closed.id } }),
      ).toBeNull();
      expect(
        await prisma.syncAttempt.count({ where: { jobId: closed.id } }),
      ).toBe(0);
      expect(
        await prisma.auditEvent.findUnique({ where: { id: audit.id } }),
      ).toBeNull();
      expect(
        await prisma.syncJob.count({
          where: {
            id: {
              in: [held.id, failed.id, openJob.id, recent.id, otherJob.id],
            },
          },
        }),
      ).toBe(5);
      expect((await cleanWorkspaceHistory(workspaceId))?.jobs).toBe(0);
    });
    it("records customer requests idempotently without persisting customer identities or claiming an export was sent", async () => {
      const { a } = await fixture();
      const first = await receivePrivacyRequest(
        a.shop,
        "CUSTOMERS_DATA_REQUEST",
        "delivery-1",
      );
      const duplicate = await receivePrivacyRequest(
        a.shop,
        "CUSTOMERS_DATA_REQUEST",
        "delivery-1",
      );
      expect(duplicate.id).toBe(first.id);
      const concurrent = await Promise.all(
        Array.from({ length: 12 }, () =>
          receivePrivacyRequest(
            a.shop,
            "CUSTOMERS_REDACT",
            "concurrent-delivery",
          ),
        ),
      );
      expect(new Set(concurrent.map((row) => row.id)).size).toBe(1);
      expect(first.outcome).toBe("NO_CUSTOMER_DATA_STORED");
      expect(first.status).toBe("COMPLETED");
      expect(first).not.toHaveProperty("payload");
      await expect(
        receivePrivacyRequest(a.shop, "PRODUCTS_UPDATE", "delivery-2"),
      ).rejects.toMatchObject({ status: 400 });
    });
    it("erases an uninstalled shop and its historical pair after detach, preserving the other store's own data and credentials", async () => {
      const { a, b, workspaceId } = await fixture();
      await snapshot(a.shop);
      const target = await snapshot(b.shop);
      await prisma.session.create({
        data: {
          id: `offline_${b.shop}`,
          shop: b.shop,
          state: "test",
          accessToken: "synthetic-test-token",
        },
      });
      await prisma.syncPolicy.create({
        data: {
          workspaceId,
          sourceShopDomain: a.shop,
          targetShopDomain: b.shop,
        },
      });
      await revokeInstallation(a.shop);
      const request = await receivePrivacyRequest(
        a.shop,
        "SHOP_REDACT",
        "redaction-1",
      );
      expect(await processPrivacyRequest(request.id)).toBe(true);
      expect(
        await prisma.shopConnection.findUnique({
          where: { shopDomain: a.shop },
        }),
      ).toBeNull();
      expect(
        await prisma.productSnapshot.count({ where: { shopDomain: a.shop } }),
      ).toBe(0);
      expect(
        await prisma.workspace.findUnique({ where: { id: workspaceId } }),
      ).toBeNull();
      expect(
        await prisma.productSnapshot.findUnique({ where: { id: target.id } }),
      ).not.toBeNull();
      expect(await prisma.session.count({ where: { shop: b.shop } })).toBe(1);
      const receipt = await prisma.privacyRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(receipt.shopDomain).toBeNull();
      expect(receipt.outcome).toBe("SHOP_DATA_ERASED");
      expect(
        (await receivePrivacyRequest(a.shop, "SHOP_REDACT", "redaction-1")).id,
      ).toBe(request.id);
      expect(await processPrivacyRequest(request.id)).toBe(false);
    });
    it("holds redaction after reinstallation instead of deleting an active store", async () => {
      const { a } = await fixture();
      await snapshot(a.shop);
      await revokeInstallation(a.shop);
      const request = await receivePrivacyRequest(
        a.shop,
        "SHOP_REDACT",
        "redaction-reinstalled",
      );
      await ensureInstallation(a);
      expect(await processPrivacyRequest(request.id)).toBe(false);
      expect(
        (
          await prisma.privacyRequest.findUniqueOrThrow({
            where: { id: request.id },
          })
        ).status,
      ).toBe("HELD");
      expect(
        await prisma.productSnapshot.count({ where: { shopDomain: a.shop } }),
      ).toBe(1);
    });
  },
);
