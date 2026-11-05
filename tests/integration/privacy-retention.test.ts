import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import {
  cleanHistory,
  cleanWorkspaceHistory,
} from "../../app/services/retention.server";
import {
  processPrivacyRequest,
  processPrivacyRequests,
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
import {
  DAY,
  HOUR,
  SKEWS,
  fromDatabase,
  restoreProcessClock,
  skewProcessClock,
} from "./clock-skew";

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
/** Erasure waits on the uninstall's age, which these tests cannot wait out. */
const uninstalledHoursAgo = (shopDomain: string, hours: number) =>
  prisma.shopConnection.update({
    where: { shopDomain },
    data: { uninstalledAt: new Date(Date.now() - hours * 3_600_000) },
  });
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
      await uninstalledHoursAgo(a.shop, 49);
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
      // Reinstalling issues new sessions before any page runs.
      await prisma.session.create({
        data: {
          id: `offline_${a.shop}`,
          shop: a.shop,
          state: "test",
          accessToken: "synthetic-test-token",
        },
      });
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
    it("waits out Shopify's 48 hours from the uninstall before erasing anything", async () => {
      const { a, workspaceId } = await fixture();
      await snapshot(a.shop);
      await revokeInstallation(a.shop);
      const request = await receivePrivacyRequest(
        a.shop,
        "SHOP_REDACT",
        "redaction-early",
      );
      const untouched = async () => {
        expect(await processPrivacyRequest(request.id)).toBe(false);
        expect(
          await prisma.privacyRequest.findUniqueOrThrow({
            where: { id: request.id },
          }),
        ).toMatchObject({
          status: "PENDING",
          outcome: null,
          shopDomain: a.shop,
        });
        expect(
          await prisma.productSnapshot.count({ where: { shopDomain: a.shop } }),
        ).toBe(1);
        expect(
          await prisma.workspace.findUnique({ where: { id: workspaceId } }),
        ).not.toBeNull();
      };
      await untouched();
      await uninstalledHoursAgo(a.shop, 47);
      await untouched();
      await uninstalledHoursAgo(a.shop, 49);
      expect(await processPrivacyRequest(request.id)).toBe(true);
      expect(
        await prisma.productSnapshot.count({ where: { shopDomain: a.shop } }),
      ).toBe(0);
    });
    describe.each(SKEWS)(
      "with the worker's clock %s the database's",
      (_, direction) => {
        afterEach(restoreProcessClock);
        it("waits out the 48 hours on the database's clock, three days of skew or not", async () => {
          const { a } = await fixture();
          await snapshot(a.shop);
          await revokeInstallation(a.shop);
          await receivePrivacyRequest(a.shop, "SHOP_REDACT", randomUUID());
          const uninstalledFor = async (hours: number) =>
            prisma.shopConnection.update({
              where: { shopDomain: a.shop },
              data: { uninstalledAt: await fromDatabase(-hours * HOUR) },
            });
          const kept = () =>
            prisma.productSnapshot.count({ where: { shopDomain: a.shop } });
          await uninstalledFor(1);
          skewProcessClock(direction * 3 * DAY);
          await processPrivacyRequests();
          expect(await kept()).toBe(1);
          await uninstalledFor(49);
          await processPrivacyRequests();
          expect(await kept()).toBe(0);
        });
        it("keeps a retention cutoff and its daily schedule on the database's clock, eight days of skew or not", async () => {
          const { a, b, workspaceId } = await fixture();
          await prisma.workspace.update({
            where: { id: workspaceId },
            data: { retentionEnabled: true, retentionDays: 7 },
          });
          const closed = async (ageDays: number) =>
            prisma.syncJob.create({
              data: {
                workspaceId,
                policyId: "",
                sourceShop: a.shop,
                targetShop: b.shop,
                operation: "RECONCILE",
                status: "SUCCEEDED",
                updatedAt: await fromDatabase(-ageDays * DAY),
              },
            });
          const recent = await closed(1);
          const old = await closed(8);
          const exists = async (id: string) =>
            !!(await prisma.syncJob.findUnique({ where: { id } }));
          skewProcessClock(direction * 8 * DAY);
          await cleanHistory();
          expect(await exists(recent.id)).toBe(true);
          expect(await exists(old.id)).toBe(false);
          // Ran just now on the database's clock, so it is not due again today.
          const again = await closed(8);
          await cleanHistory();
          expect(await exists(again.id)).toBe(true);
        });
      },
    );
    it("does not let requests waiting out the 48 hours keep a due one from being reached", async () => {
      const waiting = await fixture();
      const due = await fixture();
      await revokeInstallation(waiting.a.shop);
      const waitingRows = [];
      for (let i = 0; i < 12; i++)
        waitingRows.push(
          await receivePrivacyRequest(
            waiting.a.shop,
            "SHOP_REDACT",
            `redaction-waiting-${i}`,
          ),
        );
      await revokeInstallation(due.a.shop);
      const dueRow = await receivePrivacyRequest(
        due.a.shop,
        "SHOP_REDACT",
        "redaction-due",
      );
      await uninstalledHoursAgo(due.a.shop, 49);
      // Rows other tests left behind are settled by the first passes.
      for (let pass = 0; pass < 5; pass++) await processPrivacyRequests();
      expect(
        await prisma.privacyRequest.findUniqueOrThrow({
          where: { id: dueRow.id },
        }),
      ).toMatchObject({ status: "COMPLETED", outcome: "SHOP_DATA_ERASED" });
      expect(
        await prisma.privacyRequest.count({
          where: {
            id: { in: waitingRows.map((row) => row.id) },
            status: "PENDING",
          },
        }),
      ).toBe(12);
    });
    it("holds for review when the store comes back during the 48 hours", async () => {
      const { a } = await fixture();
      await snapshot(a.shop);
      await revokeInstallation(a.shop);
      const request = await receivePrivacyRequest(
        a.shop,
        "SHOP_REDACT",
        "redaction-came-back",
      );
      expect(await processPrivacyRequest(request.id)).toBe(false);
      await prisma.session.create({
        data: {
          id: `offline_${a.shop}`,
          shop: a.shop,
          state: "test",
          accessToken: "synthetic-test-token",
        },
      });
      await ensureInstallation(a);
      // Reached by the worker's own query, which does not skip a live store.
      for (let pass = 0; pass < 5; pass++) await processPrivacyRequests();
      expect(
        await prisma.privacyRequest.findUniqueOrThrow({
          where: { id: request.id },
        }),
      ).toMatchObject({
        status: "HELD",
        outcome: "INSTALLATION_CHANGED_REVIEW_REQUIRED",
      });
      expect(
        await prisma.productSnapshot.count({ where: { shopDomain: a.shop } }),
      ).toBe(1);
    });
  },
);
