import { randomUUID } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import { SyncError } from "../../app/domain/sync";
import type { Actor } from "../../app/services/authorization.server";
import {
  acceptPairing,
  confirmPairing,
  ensureInstallation,
  initiatePairing,
  setMember,
  verifyStore,
} from "../../app/services/control-plane.server";
import { updateInstallationScopes } from "../../app/services/installation.server";
import { action, loader } from "../../app/routes/app.stores";
import {
  HOUR,
  SECOND,
  SKEWS,
  fromDatabase,
  remaining,
  restoreProcessClock,
  skewProcessClock,
} from "./clock-skew";

const mocks = vi.hoisted(() => ({ request: vi.fn(), auth: vi.fn() }));
vi.mock("../../app/services/shopify-client.server", () => ({
  shopifyRequest: mocks.request,
}));
vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: mocks.auth },
}));

const SCOPES = ["read_products", "write_products"];
const answerFor = (shop: string, scopes = SCOPES) => ({
  shop: {
    id: "gid://shopify/Shop/4242",
    myshopifyDomain: shop,
    currencyCode: "USD",
  },
  currentAppInstallation: {
    accessScopes: scopes.map((handle) => ({ handle })),
  },
});
async function paired() {
  const key = randomUUID().slice(0, 8);
  const a: Actor = {
    shop: `verify-a-${key}.myshopify.com`,
    userId: "1",
    role: "OWNER",
  };
  const b: Actor = {
    shop: `verify-b-${key}.myshopify.com`,
    userId: "2",
    role: "OWNER",
  };
  await ensureInstallation(a);
  await ensureInstallation(b);
  const pairing = await initiatePairing(a, {
    destinationShop: b.shop,
    organizationConfirmed: true,
  });
  await acceptPairing(b, {
    requestId: pairing.request.id,
    challenge: pairing.challenge,
    organizationConfirmed: true,
  });
  const { workspace } = await confirmPairing(a, {
    requestId: pairing.request.id,
  });
  return { a, b, workspaceId: workspace.id };
}
const connection = (shop: string) =>
  prisma.shopConnection.findUniqueOrThrow({ where: { shopDomain: shop } });
const audits = (shop: string, action: string) =>
  prisma.auditEvent.count({ where: { shopDomain: shop, action } });

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "verifying a store against Shopify",
  () => {
    beforeEach(() => {
      mocks.request.mockReset();
      mocks.auth.mockReset();
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });

    it("no longer treats a page load as verification", async () => {
      const { a } = await paired();
      await ensureInstallation(a);
      expect((await connection(a.shop)).verifiedAt).toBeNull();
      expect(mocks.request).not.toHaveBeenCalled();
    });

    it("records what Shopify says for the store's own owner", async () => {
      const { a } = await paired();
      mocks.request.mockResolvedValue(answerFor(a.shop));
      await expect(verifyStore(a, a.shop)).resolves.toEqual({
        verified: true,
        scopes: SCOPES,
      });
      expect(mocks.request).toHaveBeenCalledOnce();
      const [shop, document, , options] = mocks.request.mock.calls[0];
      expect(shop).toBe(a.shop);
      expect(document).toContain("SyncPilotInstallationCheck");
      expect(document).not.toMatch(/mutation/);
      expect(options).toBeUndefined();
      const after = await connection(a.shop);
      expect(after).toMatchObject({
        shopGid: "gid://shopify/Shop/4242",
        currency: "USD",
        scopes: "read_products,write_products",
        lastError: null,
      });
      expect(after.verifiedAt).toBeInstanceOf(Date);
      expect(await audits(a.shop, "STORE_VERIFIED")).toBe(1);
      // A first recording is not a change, so nothing is paused for it.
      expect(await audits(a.shop, "SCOPES_CHANGED")).toBe(0);
      expect(after.scopesUpdatedAt).toBeNull();
    });

    it("records a failed check without moving the last good verification", async () => {
      const { a } = await paired();
      mocks.request.mockResolvedValueOnce(answerFor(a.shop));
      await verifyStore(a, a.shop);
      const verifiedAt = (await connection(a.shop)).verifiedAt;
      mocks.request.mockRejectedValueOnce(
        new SyncError("AUTH_FAILURE", "Shopify access was revoked."),
      );
      await expect(verifyStore(a, a.shop)).resolves.toEqual({
        verified: false,
        code: "AUTH_FAILURE",
        message: "Shopify access was revoked.",
      });
      expect(await connection(a.shop)).toMatchObject({
        verifiedAt,
        lastError: "AUTH_FAILURE: Shopify access was revoked.",
      });
      expect(await audits(a.shop, "STORE_VERIFICATION_FAILED")).toBe(1);
      // An unexpected error reveals nothing, and a later success clears the note.
      mocks.request.mockRejectedValueOnce(new Error("secret internals"));
      const unexpected = await verifyStore(a, a.shop);
      expect(unexpected).toMatchObject({ verified: false, code: "UNKNOWN" });
      expect(JSON.stringify(unexpected)).not.toContain("secret");
      mocks.request.mockResolvedValueOnce(answerFor(a.shop));
      await verifyStore(a, a.shop);
      expect((await connection(a.shop)).lastError).toBeNull();
    });

    it("fails the check when Shopify answers for another store", async () => {
      const { a } = await paired();
      mocks.request.mockResolvedValue(answerFor("elsewhere.myshopify.com"));
      await expect(verifyStore(a, a.shop)).resolves.toMatchObject({
        verified: false,
        code: "TENANT_DENIED",
      });
      expect(await connection(a.shop)).toMatchObject({
        verifiedAt: null,
        shopGid: null,
      });
    });

    it("treats a changed scope set as a scope change, which pauses writes", async () => {
      const { a, b, workspaceId } = await paired();
      const policy = await prisma.syncPolicy.create({
        data: {
          workspaceId,
          sourceShopDomain: a.shop,
          targetShopDomain: b.shop,
          fields: ["title"],
          enabled: true,
          status: "ACTIVE",
        },
      });
      mocks.request.mockResolvedValueOnce(answerFor(a.shop));
      await verifyStore(a, a.shop);
      expect(
        (
          await prisma.syncPolicy.findUniqueOrThrow({
            where: { id: policy.id },
          })
        ).status,
      ).toBe("ACTIVE");
      mocks.request.mockResolvedValueOnce(answerFor(a.shop, ["read_products"]));
      await verifyStore(a, a.shop);
      expect(await audits(a.shop, "SCOPES_CHANGED")).toBe(1);
      expect((await connection(a.shop)).scopes).toBe("read_products");
      expect(
        (
          await prisma.syncPolicy.findUniqueOrThrow({
            where: { id: policy.id },
          })
        ).status,
      ).toBe("PAUSED");
    });

    it.each(SKEWS)(
      "dates a scope change it finds by the database's clock, with this process an hour %s it",
      async (_, direction) => {
        const { a } = await paired();
        mocks.request.mockResolvedValueOnce(answerFor(a.shop));
        await verifyStore(a, a.shop);
        skewProcessClock(direction * HOUR);
        try {
          mocks.request.mockResolvedValueOnce(
            answerFor(a.shop, ["read_products"]),
          );
          await verifyStore(a, a.shop);
        } finally {
          restoreProcessClock();
        }
        // Not lost as older than the installation, and no newer than now.
        expect(await audits(a.shop, "SCOPES_CHANGED")).toBe(1);
        const found = await connection(a.shop);
        expect(found.scopes).toBe("read_products");
        expect(Math.abs(await remaining(found.scopesUpdatedAt))).toBeLessThan(
          10 * SECOND,
        );
        // So a later change from Shopify still applies.
        await expect(
          updateInstallationScopes(a.shop, SCOPES, {
            updatedAt: await fromDatabase(SECOND),
          }),
        ).resolves.toEqual({ applied: true });
      },
    );

    describe("scope changes still on their way", () => {
      const HOUR = 3_600_000;
      /** A paired store with live write authority, installed well before any change. */
      async function live() {
        const f = await paired();
        await prisma.shopConnection.update({
          where: { shopDomain: f.a.shop },
          data: { installedAt: new Date(Date.now() - 24 * HOUR) },
        });
        const policy = await prisma.syncPolicy.create({
          data: {
            workspaceId: f.workspaceId,
            sourceShopDomain: f.a.shop,
            targetShopDomain: f.b.shop,
            fields: ["title"],
            enabled: true,
            status: "ACTIVE",
          },
        });
        const policyStatus = async () =>
          (
            await prisma.syncPolicy.findUniqueOrThrow({
              where: { id: policy.id },
            })
          ).status;
        const reactivate = () =>
          prisma.syncPolicy.update({
            where: { id: policy.id },
            data: { enabled: true, status: "ACTIVE" },
          });
        return { ...f, policy, policyStatus, reactivate };
      }
      const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
      const check = async (actor: Actor, scopes = SCOPES) => {
        mocks.request.mockResolvedValueOnce(answerFor(actor.shop, scopes));
        return verifyStore(actor, actor.shop);
      };

      it("still applies a delivery that was already on its way when the first check ran", async () => {
        const f = await live();
        await check(f.a);
        expect(await connection(f.a.shop)).toMatchObject({
          scopes: "read_products,write_products",
          scopesUpdatedAt: null,
        });
        expect(await f.policyStatus()).toBe("ACTIVE");
        await expect(
          updateInstallationScopes(f.a.shop, SCOPES, {
            updatedAt: ago(1),
            webhookId: "delayed",
          }),
        ).resolves.toEqual({ applied: true });
        expect(await f.policyStatus()).toBe("PAUSED");
        expect(await audits(f.a.shop, "SCOPES_CHANGED")).toBe(1);
        expect(await audits(f.a.shop, "SCOPES_UPDATE_IGNORED")).toBe(0);
      });

      it("leaves the last applied change where it was when a check finds nothing new", async () => {
        const f = await live();
        await updateInstallationScopes(f.a.shop, SCOPES, { updatedAt: ago(3) });
        const applied = (await connection(f.a.shop)).scopesUpdatedAt;
        await f.reactivate();
        await check(f.a);
        expect((await connection(f.a.shop)).scopesUpdatedAt).toEqual(applied);
        expect(await f.policyStatus()).toBe("ACTIVE");
        // Older than the last applied change: still ignored.
        await expect(
          updateInstallationScopes(f.a.shop, ["read_products"], {
            updatedAt: ago(4),
          }),
        ).resolves.toMatchObject({
          applied: false,
          reason: "OLDER_THAN_LAST_APPLIED",
        });
        expect(await f.policyStatus()).toBe("ACTIVE");
        // Newer than it and older than the check: a change the check cannot rule out.
        await expect(
          updateInstallationScopes(f.a.shop, SCOPES, { updatedAt: ago(1) }),
        ).resolves.toEqual({ applied: true });
        expect(await f.policyStatus()).toBe("PAUSED");
      });

      it("keeps the scopes of a delivery applied while the first check waited on Shopify", async () => {
        const f = await live();
        mocks.request.mockImplementationOnce(async () => {
          await updateInstallationScopes(f.a.shop, ["read_inventory"], {
            updatedAt: ago(1),
          });
          return answerFor(f.a.shop);
        });
        await expect(verifyStore(f.a, f.a.shop)).resolves.toMatchObject({
          verified: true,
        });
        expect((await connection(f.a.shop)).scopes).toBe("read_inventory");
        // The next check compares against it and reports the difference.
        await check(f.a);
        expect((await connection(f.a.shop)).scopes).toBe(
          "read_products,write_products",
        );
        expect(await audits(f.a.shop, "SCOPES_CHANGED")).toBe(2);
      });

      it("does not let an older delivery undo what a check found changed", async () => {
        const f = await live();
        await check(f.a);
        await check(f.a, ["read_products"]);
        expect(await f.policyStatus()).toBe("PAUSED");
        await f.reactivate();
        await expect(
          updateInstallationScopes(f.a.shop, SCOPES, { updatedAt: ago(1) }),
        ).resolves.toMatchObject({
          applied: false,
          reason: "OLDER_THAN_LAST_APPLIED",
        });
        expect((await connection(f.a.shop)).scopes).toBe("read_products");
        expect(await f.policyStatus()).toBe("ACTIVE");
      });

      it("names who ran the check when it finds changed scopes, and Shopify when a delivery does", async () => {
        const f = await live();
        const staff: Actor = { shop: f.a.shop, userId: "303", role: "VIEWER" };
        await setMember(f.a, {
          shopDomain: f.a.shop,
          userId: staff.userId,
          role: "OPERATOR",
          status: "ACTIVE",
        });
        const standing = () =>
          prisma.automaticConsent.create({
            data: {
              workspaceId: f.workspaceId,
              policyId: f.policy.id,
              fingerprint: randomUUID(),
              approvedBy: `${f.a.shop}:1`,
              fields: ["title"],
              expiresAt: new Date(Date.now() + HOUR),
              intervalMinutes: 60,
              maxJobs: 1,
              maxChanges: 1,
              perRunChanges: 1,
            },
          });
        const actors = async (action: string, resourceId?: string) =>
          (
            await prisma.auditEvent.findMany({
              where: { shopDomain: f.a.shop, action, resourceId },
              orderBy: { createdAt: "asc" },
              select: { actor: true },
            })
          ).map((row) => row.actor);
        await check(f.a);
        const found = await standing();
        await check(staff, ["read_products"]);
        const byStaff = `${f.a.shop}:303`;
        expect(await actors("SCOPES_CHANGED")).toEqual([byStaff]);
        expect(await actors("AUTOMATIC_CONSENT_REVOKED", found.id)).toEqual([
          byStaff,
        ]);
        expect(await f.policyStatus()).toBe("PAUSED");
        await f.reactivate();
        const delivered = await standing();
        await updateInstallationScopes(f.a.shop, SCOPES, {
          updatedAt: new Date(Date.now() + 60_000),
        });
        expect(await actors("SCOPES_CHANGED")).toEqual([
          byStaff,
          "shopify:webhook",
        ]);
        expect(await actors("AUTOMATIC_CONSENT_REVOKED", delivered.id)).toEqual(
          ["shopify:webhook"],
        );
      });
    });

    it("lets an operator check the verified pair, and nobody reach anything else", async () => {
      const { a, b } = await paired();
      const staff: Actor = { shop: a.shop, userId: "303", role: "VIEWER" };
      await setMember(a, {
        shopDomain: a.shop,
        userId: staff.userId,
        role: "VIEWER",
        status: "ACTIVE",
      });
      await expect(verifyStore(staff, a.shop)).rejects.toMatchObject({
        code: "OPERATOR_REQUIRED",
      });
      await setMember(a, {
        shopDomain: a.shop,
        userId: staff.userId,
        role: "OPERATOR",
        status: "ACTIVE",
      });
      mocks.request.mockImplementation(async (shop: string) => answerFor(shop));
      await expect(verifyStore(staff, a.shop)).resolves.toMatchObject({
        verified: true,
      });
      await expect(verifyStore(staff, b.shop)).resolves.toMatchObject({
        verified: true,
      });
      mocks.request.mockClear();
      const unrelated = await paired();
      await expect(verifyStore(staff, unrelated.b.shop)).rejects.toMatchObject({
        code: "STORE_NOT_AUTHORIZED",
      });
      await expect(verifyStore(a, unrelated.b.shop)).rejects.toMatchObject({
        code: "STORE_NOT_AUTHORIZED",
      });
      await expect(verifyStore(a, "not a shop")).rejects.toMatchObject({
        code: "INVALID_SHOP",
      });
      expect(mocks.request).not.toHaveBeenCalled();
    });

    describe("through the Stores page", () => {
      const url = "https://sync.example.invalid/app/stores";
      const route = {
        url: new URL(url),
        pattern: "/app/stores",
        params: {},
        context: {},
      };
      const signIn = (actor: Actor) =>
        mocks.auth.mockResolvedValue({
          session: {
            shop: actor.shop,
            onlineAccessInfo: {
              associated_user: {
                id: Number(actor.userId),
                account_owner: actor.role === "OWNER",
              },
            },
          },
        });
      const post = (id: string): ActionFunctionArgs => ({
        ...route,
        request: new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ intent: "verify", id }).toString(),
        }),
      });
      const get = (): LoaderFunctionArgs => ({
        ...route,
        request: new Request(url),
      });

      it("reports success and failure to the operator and offers the action to who may use it", async () => {
        const { a } = await paired();
        signIn(a);
        mocks.request.mockResolvedValueOnce(answerFor(a.shop));
        await expect(action(post(a.shop))).resolves.toMatchObject({
          success: expect.stringContaining("Shopify confirmed"),
        });
        const page = await loader(get());
        expect(page.canVerify).toBe(true);
        expect(
          page.connections.find((row) => row.shopDomain === a.shop)?.verifiedAt,
        ).toBeInstanceOf(Date);
        mocks.request.mockRejectedValueOnce(
          new SyncError("AUTH_FAILURE", "Reopen the app to reconnect."),
        );
        await expect(action(post(a.shop))).resolves.toEqual({
          error: "Shopify check failed. Reopen the app to reconnect.",
        });
        // A viewer sees the page without the action, and is refused if they post.
        const viewer: Actor = { shop: a.shop, userId: "404", role: "VIEWER" };
        await setMember(a, {
          shopDomain: a.shop,
          userId: viewer.userId,
          role: "VIEWER",
          status: "ACTIVE",
        });
        signIn(viewer);
        expect((await loader(get())).canVerify).toBe(false);
        const refused = await action(post(a.shop));
        expect(refused).toMatchObject({ init: { status: 403 } });
      });
    });
  },
);
