import { randomUUID } from "node:crypto";
import type { AutomaticConsent, Prisma, SyncJob } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import prisma from "../../app/db.server";
import type { Actor } from "../../app/services/authorization.server";
import {
  assertJobConsent,
  getAutomaticConsents,
  grantAutomaticConsent,
  processAutomaticPreview,
  revokeAutomaticConsent,
  scheduleAutomaticSync,
} from "../../app/services/automatic-sync.server";
import {
  disconnectStore,
  savePolicy,
  updatePolicy,
} from "../../app/services/control-plane.server";
import {
  revokeInstallation,
  updateInstallationScopes,
} from "../../app/services/installation.server";
import { runWorkerOnce } from "../../app/services/sync-engine.server";
import {
  HOUR,
  SKEWS,
  fromDatabase,
  remaining,
  restoreProcessClock,
  skewProcessClock,
  withMachineClockSkewed,
} from "./clock-skew";

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
// Granting consent compares the stores again; report the reviewed plan unchanged.
// The worker itself stays real, so a write can run against synthetic Shopify.
vi.mock("../../app/services/sync-engine.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../app/services/sync-engine.server")
  >()),
  buildPreview: vi.fn(async () => ({
    sourceHash: "source-hash",
    targetHash: "target-hash",
    changes,
  })),
}));
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../app/services/shopify-client.server", () => ({
  shopifyRequest: api.request,
}));

const MINUTE = 60_000;
function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
function gates(automatic: string | undefined, writes: string | undefined) {
  setEnv("AUTOMATIC_SYNC_ENABLED", automatic);
  setEnv("SYNC_WRITE_ENABLED", writes);
}

const workspaces: string[] = [];
async function pairFixture() {
  // Unique across runs, so the file can rerun against an existing database.
  const suffix = randomUUID().replaceAll("-", "");
  const owner: Actor = {
    shop: `automatic-a-${suffix}.myshopify.com`,
    userId: "101",
    role: "OWNER",
  };
  const sourceShop = owner.shop,
    targetShop = `automatic-b-${suffix}.myshopify.com`;
  const workspace = await prisma.workspace.create({
    data: { name: "Automatic sync fixture" },
  });
  workspaces.push(workspace.id);
  await prisma.shopConnection.createMany({
    data: [
      { shopDomain: sourceShop, workspaceId: workspace.id },
      { shopDomain: targetShop, workspaceId: workspace.id },
    ],
  });
  await prisma.workspaceMember.create({
    data: {
      workspaceId: workspace.id,
      shopDomain: sourceShop,
      userId: owner.userId,
      role: "OWNER",
    },
  });
  const pair = await prisma.storePair.create({
    data: {
      workspaceId: workspace.id,
      sourceShop,
      targetShop,
      requestId: `automatic-pair-${suffix}`,
    },
  });
  return { suffix, owner, sourceShop, targetShop, workspace, pair };
}
type Pair = Awaited<ReturnType<typeof pairFixture>>;

// An approved one-way descriptive policy: the only scope automatic consent accepts.
function policy(
  f: Pair,
  data: Partial<
    Pick<Prisma.SyncPolicyUncheckedCreateInput, "enabled" | "status">
  > = {},
) {
  return prisma.syncPolicy.create({
    data: {
      workspaceId: f.workspace.id,
      sourceShopDomain: f.sourceShop,
      targetShopDomain: f.targetShop,
      fields: ["title"],
      syncProduct: true,
      enabled: true,
      status: "ACTIVE",
      approvedBy: `${f.owner.shop}:${f.owner.userId}`,
      approvedAt: new Date(),
      ...data,
    },
  });
}

// Inserted directly: the scheduler reads budgets and timing, never the fingerprint.
function consent(
  f: Pair,
  policyId: string,
  data: Pick<
    Prisma.AutomaticConsentUncheckedCreateInput,
    "nextRunAt" | "expiresAt"
  > &
    Partial<
      Pick<
        Prisma.AutomaticConsentUncheckedCreateInput,
        "usedJobs" | "usedChanges" | "status"
      >
    >,
) {
  return prisma.automaticConsent.create({
    data: {
      workspaceId: f.workspace.id,
      policyId,
      fingerprint: "synthetic-fingerprint",
      approvedBy: `${f.owner.shop}:${f.owner.userId}`,
      fields: ["title"],
      intervalMinutes: 15,
      maxJobs: 3,
      maxChanges: 10,
      perRunChanges: 5,
      ...data,
    },
  });
}

function inFlight(
  f: Pair,
  policyId: string,
  operation: "AUTO_PREVIEW" | "APPLY_PREVIEW",
  status: "PENDING" | "RETRY" | "RUNNING",
  consentId?: string,
) {
  return prisma.syncJob.create({
    data: {
      workspaceId: f.workspace.id,
      policyId,
      sourceShop: f.sourceShop,
      targetShop: f.targetShop,
      operation,
      status,
      ...(consentId ? { payload: { consentId } } : {}),
    },
  });
}

const reload = (id: string) =>
  prisma.automaticConsent.findUniqueOrThrow({ where: { id } });

// A verified mapping and a fresh reviewed plan, so a real grant succeeds and
// assertJobConsent recomputes the fingerprint it stored.
async function reviewedPlan(f: Pair, policyId: string) {
  await prisma.productMapping.create({
    data: {
      workspaceId: f.workspace.id,
      sourceShopDomain: f.sourceShop,
      sourceProductGid: changes[0].sourceId,
      targetShopDomain: f.targetShop,
      targetProductGid: changes[0].targetId,
      verifiedAt: new Date(),
    },
  });
  return freshPlan(f, policyId);
}
async function freshPlan(f: Pair, policyId: string) {
  return prisma.syncPreview.create({
    data: {
      workspaceId: f.workspace.id,
      policyId,
      createdBy: `${f.owner.shop}:${f.owner.userId}`,
      sourceHash: "source-hash",
      targetHash: "target-hash",
      changes,
      expiresAt: await fromDatabase(15 * MINUTE),
    },
  });
}
const grantInput = (policyId: string, previewId: string, maxJobs: number) => ({
  policyId,
  previewId,
  durationMinutes: 60,
  intervalMinutes: 5,
  maxJobs,
  maxChanges: 10,
  perRunChanges: 5,
  confirmed: true,
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "automatic sync scheduling",
  () => {
    let saved: [string | undefined, string | undefined];
    beforeEach(async () => {
      saved = [
        process.env.AUTOMATIC_SYNC_ENABLED,
        process.env.SYNC_WRITE_ENABLED,
      ];
      gates("true", "true");
      // The scheduler queue is global; take earlier cases' consents out of it.
      await prisma.automaticConsent.updateMany({
        where: { status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
    });
    afterEach(() => {
      gates(...saved);
    });
    afterAll(async () => {
      // Leave no queued automatic work for suites that run the worker later.
      await prisma.syncJob.updateMany({
        where: {
          workspaceId: { in: workspaces },
          status: { in: ["PENDING", "RETRY", "RUNNING"] },
        },
        data: { status: "CANCELLED", leaseOwner: null, leaseUntil: null },
      });
      await prisma.automaticConsent.updateMany({
        where: { workspaceId: { in: workspaces }, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      await prisma.$disconnect();
    });

    it("advances 25+ exhausted or blocked consents so a healthy due consent is still scheduled", async () => {
      const f = await pairFixture();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 120 * MINUTE);
      const exhausted: AutomaticConsent[] = [],
        skipped: AutomaticConsent[] = [];
      const statuses = ["PENDING", "RETRY", "RUNNING"] as const;
      // Thirty blocked consents, all due before the healthy one.
      for (let i = 0; i < 30; i++) {
        const variant = Math.floor(i / 3);
        const nextRunAt = new Date(now.getTime() - 120 * MINUTE + i * 1000);
        if (i % 3 === 0) {
          // Spent jobs or spent changes; usage never shrinks.
          const { id } = await policy(f);
          const budget =
            variant % 2 ? { usedJobs: 3 } : { usedJobs: 1, usedChanges: 10 };
          exhausted.push(
            await consent(f, id, { nextRunAt, expiresAt, ...budget }),
          );
        } else if (i % 3 === 1) {
          // An automatic or manual run is already in flight for the policy.
          const { id } = await policy(f);
          await inFlight(
            f,
            id,
            variant % 2 ? "AUTO_PREVIEW" : "APPLY_PREVIEW",
            statuses[variant % 3],
          );
          skipped.push(await consent(f, id, { nextRunAt, expiresAt }));
        } else {
          // Paused, never activated, or deleted policy.
          const policyId =
            variant % 3 === 2
              ? `automatic-missing-policy-${f.suffix}-${i}`
              : (
                  await policy(
                    f,
                    variant % 3
                      ? { status: "DRAFT" }
                      : { enabled: false, status: "PAUSED" },
                  )
                ).id;
          skipped.push(await consent(f, policyId, { nextRunAt, expiresAt }));
        }
      }
      const healthyPolicy = await policy(f);
      const healthy = await consent(f, healthyPolicy.id, {
        nextRunAt: new Date(now.getTime() - MINUTE),
        expiresAt,
      });

      // The oldest 25 are all blocked. Before the fix they were re-selected every
      // cycle and the healthy consent was never reached.
      expect(await scheduleAutomaticSync(now)).toBe(0);
      expect(await scheduleAutomaticSync(now)).toBe(1);
      expect(await scheduleAutomaticSync(now)).toBe(0);

      const queued = await prisma.syncJob.findMany({
        where: {
          workspaceId: f.workspace.id,
          idempotencyKey: { startsWith: "automatic:" },
        },
      });
      expect(queued).toEqual([
        expect.objectContaining({
          policyId: healthyPolicy.id,
          operation: "AUTO_PREVIEW",
          status: "PENDING",
          idempotencyKey: `automatic:${healthy.id}:${healthy.nextRunAt.getTime()}`,
          payload: { consentId: healthy.id },
        }),
      ]);
      const slot = new Date(now.getTime() + 15 * MINUTE);
      expect(await reload(healthy.id)).toMatchObject({
        status: "ACTIVE",
        nextRunAt: slot,
      });
      for (const row of exhausted)
        expect(await reload(row.id)).toMatchObject({
          status: "ACTIVE",
          nextRunAt: expiresAt,
          usedJobs: row.usedJobs,
          usedChanges: row.usedChanges,
        });
      for (const row of skipped)
        expect(await reload(row.id)).toMatchObject({
          status: "ACTIVE",
          nextRunAt: slot,
        });
    });

    it("re-checks a skipped consent on its next interval with a fresh idempotency key", async () => {
      const f = await pairFixture();
      const { id: policyId } = await policy(f);
      const t0 = new Date(),
        t1 = new Date(t0.getTime() + 15 * MINUTE),
        t2 = new Date(t1.getTime() + 15 * MINUTE);
      const busy = await inFlight(f, policyId, "APPLY_PREVIEW", "RETRY");
      const row = await consent(f, policyId, {
        nextRunAt: new Date(t0.getTime() - 1000),
        expiresAt: new Date(t0.getTime() + 60 * MINUTE),
      });

      expect(await scheduleAutomaticSync(t0)).toBe(0);
      expect((await reload(row.id)).nextRunAt).toEqual(t1);
      await prisma.syncJob.update({
        where: { id: busy.id },
        data: { status: "SUCCEEDED" },
      });
      // The skipped slot is not replayed before the next interval.
      expect(await scheduleAutomaticSync(new Date(t1.getTime() - 1))).toBe(0);
      expect(await scheduleAutomaticSync(t1)).toBe(1);
      expect(await scheduleAutomaticSync(t1)).toBe(0);
      await prisma.syncJob.updateMany({
        where: { policyId, operation: "AUTO_PREVIEW" },
        data: { status: "SUCCEEDED" },
      });
      expect(await scheduleAutomaticSync(t2)).toBe(1);

      const keys = await prisma.syncJob.findMany({
        where: { policyId, operation: "AUTO_PREVIEW" },
        select: { idempotencyKey: true },
      });
      expect(keys.map((job) => job.idempotencyKey).sort()).toEqual([
        `automatic:${row.id}:${t1.getTime()}`,
        `automatic:${row.id}:${t2.getTime()}`,
      ]);
    });

    it("parks an exhausted consent until expiry and keeps it ACTIVE for its queued write", async () => {
      const f = await pairFixture();
      const { id: policyId } = await policy(f);
      const reviewed = await reviewedPlan(f, policyId);
      const granted = await grantAutomaticConsent(
        f.owner,
        grantInput(policyId, reviewed.id, 1),
      );
      // An automatic preview spent the last job on a write that is still queued.
      const now = new Date();
      await prisma.automaticConsent.update({
        where: { id: granted.id },
        data: {
          usedJobs: 1,
          usedChanges: 1,
          nextRunAt: new Date(now.getTime() - MINUTE),
        },
      });
      const write = await prisma.syncJob.create({
        data: {
          workspaceId: f.workspace.id,
          policyId,
          sourceShop: f.sourceShop,
          targetShop: f.targetShop,
          previewId: reviewed.id,
          operation: "APPLY_PREVIEW",
          payload: { previewId: reviewed.id, consentId: granted.id },
        },
      });

      expect(await scheduleAutomaticSync(now)).toBe(0);
      expect(await reload(granted.id)).toMatchObject({
        status: "ACTIVE",
        nextRunAt: granted.expiresAt,
        usedJobs: 1,
        usedChanges: 1,
      });
      await expect(assertJobConsent(write)).resolves.toMatchObject({
        id: granted.id,
        status: "ACTIVE",
      });
      expect(
        await scheduleAutomaticSync(new Date(granted.expiresAt.getTime() - 1)),
      ).toBe(0);
      expect((await reload(granted.id)).status).toBe("ACTIVE");
      expect(
        await prisma.syncJob.count({
          where: { policyId, operation: "AUTO_PREVIEW" },
        }),
      ).toBe(0);

      expect(await scheduleAutomaticSync(granted.expiresAt)).toBe(0);
      expect((await reload(granted.id)).status).toBe("EXPIRED");
      await expect(assertJobConsent(write)).rejects.toMatchObject({
        code: "CONSENT_REVOKED",
      });
    });

    it("holds a consent whose policy changed under it, so failed runs stop and a fresh grant is allowed", async () => {
      const f = await pairFixture();
      const { id: policyId } = await policy(f);
      const reviewed = await reviewedPlan(f, policyId);
      const granted = await grantAutomaticConsent(
        f.owner,
        grantInput(policyId, reviewed.id, 3),
      );
      // A pause that left consent ACTIVE, as releases before lifecycle
      // revocation did; re-activation moves updatedAt, which the fingerprint covers.
      await prisma.syncPolicy.update({
        where: { id: policyId },
        data: { enabled: false, status: "PAUSED" },
      });
      await prisma.syncPolicy.update({
        where: { id: policyId },
        data: { enabled: true, status: "ACTIVE" },
      });
      const now = new Date();
      await prisma.automaticConsent.update({
        where: { id: granted.id },
        data: { nextRunAt: new Date(now.getTime() - MINUTE) },
      });
      expect(await scheduleAutomaticSync(now)).toBe(1);
      const run = await prisma.syncJob.findFirstOrThrow({
        where: { policyId, operation: "AUTO_PREVIEW" },
      });

      await expect(
        processAutomaticPreview(run, async () => {}),
      ).rejects.toMatchObject({ code: "CONSENT_CHANGED" });
      expect(await reload(granted.id)).toMatchObject({
        status: "HELD",
        usedJobs: 0,
        usedChanges: 0,
      });
      expect(
        await prisma.auditEvent.findMany({
          where: { resourceId: granted.id, action: "AUTOMATIC_CONSENT_HELD" },
          select: { details: true },
        }),
      ).toEqual([{ details: { code: "CONSENT_CHANGED", jobId: run.id } }]);
      // The worker dead-letters the run; the next interval queues no replacement.
      await prisma.syncJob.update({
        where: { id: run.id },
        data: { status: "DEAD_LETTER" },
      });
      expect(
        await scheduleAutomaticSync(new Date(now.getTime() + 10 * MINUTE)),
      ).toBe(0);
      // A HELD consent no longer blocks the owner with CONSENT_EXISTS.
      await expect(
        grantAutomaticConsent(f.owner, grantInput(policyId, reviewed.id, 3)),
      ).resolves.toMatchObject({ policyId, status: "ACTIVE" });
    });

    it('does nothing unless both deployment gates are exactly "true"', async () => {
      const f = await pairFixture();
      const now = new Date();
      const due = await consent(f, (await policy(f)).id, {
        nextRunAt: new Date(now.getTime() - MINUTE),
        expiresAt: new Date(now.getTime() + 60 * MINUTE),
      });
      const lapsed = await consent(f, (await policy(f)).id, {
        nextRunAt: new Date(now.getTime() - 120 * MINUTE),
        expiresAt: new Date(now.getTime() - MINUTE),
      });
      for (const [automatic, writes] of [
        [undefined, "true"],
        ["false", "true"],
        ["TRUE", "true"],
        ["1", "true"],
        [" true", "true"],
        ["true", undefined],
        ["true", "false"],
        ["true", "True"],
        [undefined, undefined],
      ] as const) {
        gates(automatic, writes);
        expect(await scheduleAutomaticSync(now)).toBe(0);
      }
      // Nothing was queued, advanced or expired while a gate was closed.
      expect(
        await prisma.syncJob.count({ where: { workspaceId: f.workspace.id } }),
      ).toBe(0);
      expect(await reload(due.id)).toMatchObject({
        status: "ACTIVE",
        nextRunAt: due.nextRunAt,
      });
      expect((await reload(lapsed.id)).status).toBe("ACTIVE");

      gates("true", "true");
      expect(await scheduleAutomaticSync(now)).toBe(1);
      expect((await reload(lapsed.id)).status).toBe("EXPIRED");
    });

    describe("lifecycle revocation", () => {
      const job = (id: string) =>
        prisma.syncJob.findUniqueOrThrow({ where: { id } });
      const timing = () => ({
        nextRunAt: new Date(Date.now() + 15 * MINUTE),
        expiresAt: new Date(Date.now() + 60 * MINUTE),
      });
      // A live consent and an earlier HELD one on the same policy, each with
      // an automatic run still queued.
      async function standing(
        f: Pair,
        policyId: string,
        live?: AutomaticConsent,
      ) {
        const active = live ?? (await consent(f, policyId, timing()));
        const held = await consent(f, policyId, {
          ...timing(),
          status: "HELD",
        });
        const runs = [
          await inFlight(f, policyId, "AUTO_PREVIEW", "PENDING", active.id),
          await inFlight(f, policyId, "AUTO_PREVIEW", "RETRY", held.id),
        ];
        return { consents: [active, held], runs };
      }
      type Standing = Awaited<ReturnType<typeof standing>>;
      type Revocation = { actor: string; shopDomain: string; reason: string };
      async function expectRevoked(
        { consents, runs }: Standing,
        { actor, shopDomain, reason }: Revocation,
      ) {
        for (const row of consents)
          expect(await reload(row.id)).toMatchObject({
            status: "REVOKED",
            revokedAt: expect.any(Date),
          });
        for (const run of runs)
          expect((await job(run.id)).status).toBe("CANCELLED");
        const ids = consents.map((row) => row.id).sort();
        expect(
          await prisma.auditEvent.findMany({
            where: {
              action: "AUTOMATIC_CONSENT_REVOKED",
              resourceId: { in: ids },
            },
            select: {
              resourceId: true,
              actor: true,
              shopDomain: true,
              details: true,
            },
            orderBy: { resourceId: "asc" },
          }),
        ).toEqual(
          ids.map((resourceId) => ({
            resourceId,
            actor,
            shopDomain,
            details: { reason },
          })),
        );
      }
      async function expectUntouched({ consents, runs }: Standing) {
        for (const row of consents)
          expect(await reload(row.id)).toMatchObject({
            status: row.status,
            revokedAt: null,
          });
        for (const run of runs)
          expect((await job(run.id)).status).toBe(run.status);
      }
      const ownerKey = (f: Pair) => `${f.owner.shop}:${f.owner.userId}`;
      const byOwner = (f: Pair, reason: string) => ({
        actor: ownerKey(f),
        shopDomain: f.owner.shop,
        reason,
      });
      const byWebhook = (shopDomain: string, reason: string) => ({
        actor: "shopify:webhook",
        shopDomain,
        reason,
      });

      it("pausing a policy revokes only its consents and queued runs, and a fresh grant is accepted", async () => {
        const f = await pairFixture(),
          other = await pairFixture();
        const { id: policyId } = await policy(f);
        const reviewed = await reviewedPlan(f, policyId);
        const paused = await standing(
          f,
          policyId,
          await grantAutomaticConsent(
            f.owner,
            grantInput(policyId, reviewed.id, 3),
          ),
        );
        const sibling = await standing(f, (await policy(f)).id);
        const elsewhere = await standing(other, (await policy(other)).id);

        await updatePolicy(f.owner, policyId, "PAUSE");
        await expectRevoked(paused, byOwner(f, "POLICY_PAUSED"));
        await expectUntouched(sibling);
        await expectUntouched(elsewhere);

        // The leftover ACTIVE row used to refuse this with CONSENT_EXISTS.
        await updatePolicy(f.owner, policyId, "ACTIVATE");
        await expect(
          grantAutomaticConsent(f.owner, grantInput(policyId, reviewed.id, 3)),
        ).resolves.toMatchObject({ policyId, status: "ACTIVE" });
      });

      it("disconnecting the pair revokes every consent and automatic plan in that workspace only", async () => {
        const f = await pairFixture(),
          other = await pairFixture();
        const first = await policy(f);
        const mine = [
          await standing(f, first.id),
          await standing(f, (await policy(f)).id),
        ];
        const elsewhere = await standing(other, (await policy(other)).id);
        const plan = await prisma.syncPreview.update({
          where: { id: (await freshPlan(f, first.id)).id },
          data: {
            status: "APPROVED",
            createdBy: "system:automatic-sync",
            approvedBy: ownerKey(f),
            approvedAt: new Date(),
          },
        });

        await disconnectStore(f.owner, f.targetShop);
        for (const row of mine)
          await expectRevoked(row, byOwner(f, "STORES_DISCONNECTED"));
        expect(
          (
            await prisma.syncPreview.findUniqueOrThrow({
              where: { id: plan.id },
            })
          ).status,
        ).toBe("REVOKED");
        await expectUntouched(elsewhere);
      });

      // The source store is the consenting owner's; the target store is not.
      it.each(["sourceShop", "targetShop"] as const)(
        "uninstalling the %s revokes every consent in the workspace only",
        async (store) => {
          const f = await pairFixture(),
            other = await pairFixture();
          const shop = f[store];
          const mine = [
            await standing(f, (await policy(f)).id),
            await standing(f, (await policy(f)).id),
          ];
          const elsewhere = await standing(other, (await policy(other)).id);

          await revokeInstallation(shop);
          for (const row of mine)
            await expectRevoked(row, byWebhook(shop, "APP_UNINSTALLED"));
          await expectUntouched(elsewhere);
          // A redelivered uninstall finds no workspace and records nothing more.
          await revokeInstallation(shop);
          for (const row of mine)
            await expectRevoked(row, byWebhook(shop, "APP_UNINSTALLED"));
        },
      );

      it("a scope change revokes the workspace's consents and automatic runs, and a fresh grant is accepted", async () => {
        const f = await pairFixture(),
          other = await pairFixture();
        const { id: policyId } = await policy(f);
        const reviewed = await reviewedPlan(f, policyId);
        const granted = await grantAutomaticConsent(
          f.owner,
          grantInput(policyId, reviewed.id, 3),
        );
        const mine = await standing(f, policyId, granted);
        const running = await prisma.syncJob.update({
          where: {
            id: (
              await inFlight(f, policyId, "AUTO_PREVIEW", "RUNNING", granted.id)
            ).id,
          },
          data: {
            leaseOwner: "synthetic-worker",
            leaseUntil: new Date(Date.now() + MINUTE),
          },
        });
        const elsewhere = await standing(other, (await policy(other)).id);

        await updateInstallationScopes(f.sourceShop, ["read_products"]);
        await expectRevoked(mine, byWebhook(f.sourceShop, "SCOPES_CHANGED"));
        expect(await job(running.id)).toMatchObject({
          status: "CANCELLED",
          leaseOwner: null,
          leaseUntil: null,
          lastError: expect.stringMatching(/^SCOPES_CHANGED:/),
        });
        await expectUntouched(elsewhere);

        // The scope change also revoked the reviewed plan; review afresh.
        const fresh = await freshPlan(f, policyId);
        await updatePolicy(f.owner, policyId, "ACTIVATE");
        await expect(
          grantAutomaticConsent(f.owner, grantInput(policyId, fresh.id, 3)),
        ).resolves.toMatchObject({ policyId, status: "ACTIVE" });
      });

      it("editing a paused policy revokes consents and runs an earlier release left behind", async () => {
        const f = await pairFixture();
        const { id: policyId } = await policy(f, {
          enabled: false,
          status: "PAUSED",
        });
        const stale = await standing(f, policyId);
        const sibling = await standing(f, (await policy(f)).id);

        await savePolicy(f.owner, {
          id: policyId,
          sourceShop: f.sourceShop,
          targetShop: f.targetShop,
          fields: ["title"],
          syncInventory: false,
          inventoryMode: "DISABLED",
          buffer: 0,
          reconciliationMinutes: 360,
        });
        await expectRevoked(stale, byOwner(f, "CONFIGURATION_CHANGED"));
        await expectUntouched(sibling);
      });

      it("activating a policy revokes consents an earlier release left behind, and a fresh grant is accepted", async () => {
        const f = await pairFixture(),
          other = await pairFixture();
        // Paused before lifecycle revocation: its consents stayed ACTIVE and HELD.
        const { id: policyId } = await policy(f, {
          enabled: false,
          status: "PAUSED",
        });
        const reviewed = await reviewedPlan(f, policyId);
        const stale = await standing(f, policyId);
        const sibling = await standing(f, (await policy(f)).id);
        const elsewhere = await standing(other, (await policy(other)).id);

        await updatePolicy(f.owner, policyId, "ACTIVATE");
        await expectRevoked(stale, byOwner(f, "POLICY_ACTIVATED"));
        await expectUntouched(sibling);
        await expectUntouched(elsewhere);
        // The leftover ACTIVE row used to refuse this with CONSENT_EXISTS.
        await expect(
          grantAutomaticConsent(f.owner, grantInput(policyId, reviewed.id, 3)),
        ).resolves.toMatchObject({ policyId, status: "ACTIVE" });
      });

      it("re-activating an active policy revokes its consent and cancels only the runs that carried it", async () => {
        const f = await pairFixture();
        const { id: policyId } = await policy(f);
        const reviewed = await reviewedPlan(f, policyId);
        const granted = await grantAutomaticConsent(
          f.owner,
          grantInput(policyId, reviewed.id, 3),
        );
        const live = await standing(f, policyId, granted);
        // A queued automatic write, and a manual one that needs no consent.
        const write = await inFlight(
          f,
          policyId,
          "APPLY_PREVIEW",
          "PENDING",
          granted.id,
        );
        const manual = await inFlight(f, policyId, "APPLY_PREVIEW", "PENDING");

        await updatePolicy(f.owner, policyId, "ACTIVATE");
        await expectRevoked(live, byOwner(f, "POLICY_ACTIVATED"));
        expect(await job(write.id)).toMatchObject({
          status: "CANCELLED",
          lastError: "AUTOMATIC_CONSENT_REVOKED",
        });
        expect((await job(manual.id)).status).toBe("PENDING");
        // Activation moved the fingerprint, so the old consent could never run again.
        const fresh = await grantAutomaticConsent(
          f.owner,
          grantInput(policyId, reviewed.id, 3),
        );
        expect(fresh).toMatchObject({ policyId, status: "ACTIVE" });
        expect(fresh.fingerprint).not.toBe(granted.fingerprint);
      });
    });

    describe("emergency stops during an automatic write", () => {
      const BLOCKED = Symbol("blocked");
      // BLOCKED when the work is still waiting, e.g. on a row lock, after `ms`.
      async function within<T>(work: Promise<T>, ms: number) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<typeof BLOCKED>((resolve) => {
          timer = setTimeout(() => resolve(BLOCKED), ms);
        });
        try {
          return await Promise.race([work, late]);
        } finally {
          clearTimeout(timer);
        }
      }
      type Stop = (f: Pair, policyId: string, consentId: string) => unknown;
      const stops: [string, Stop][] = [
        ["pausing the policy", (f, id) => updatePolicy(f.owner, id, "PAUSE")],
        [
          "revoking the consent",
          (f, _, consentId) => revokeAutomaticConsent(f.owner, consentId),
        ],
        [
          "disconnecting the pair",
          (f) => disconnectStore(f.owner, f.targetShop),
        ],
        [
          "uninstalling the target store",
          (f) => revokeInstallation(f.targetShop),
        ],
        [
          "losing a scope",
          (f) => updateInstallationScopes(f.sourceShop, ["read_products"]),
        ],
      ];

      // The write transaction runs its consent check, then stays open the way
      // executeGroup does across a Shopify mutation. A stop that waited for it
      // would time out instead of halting the next write.
      it.each(stops)(
        "%s commits promptly, and the next pre-mutation consent check refuses",
        async (_, stop) => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          const reviewed = await reviewedPlan(f, policyId);
          const granted = await grantAutomaticConsent(
            f.owner,
            grantInput(policyId, reviewed.id, 3),
          );
          const write: SyncJob = await inFlight(
            f,
            policyId,
            "APPLY_PREVIEW",
            "RUNNING",
            granted.id,
          );
          let stopped: Promise<unknown> | undefined;
          try {
            await prisma.$transaction(
              async (tx) => {
                await expect(
                  assertJobConsent(write, tx),
                ).resolves.toMatchObject({ id: granted.id, status: "ACTIVE" });
                stopped = Promise.resolve(stop(f, policyId, granted.id));
                expect(await within(stopped, 3_000)).not.toBe(BLOCKED);
                await expect(assertJobConsent(write, tx)).rejects.toMatchObject(
                  {
                    code: "CONSENT_REVOKED",
                  },
                );
              },
              { timeout: 90_000, maxWait: 5000 },
            );
          } finally {
            // Let a stop that was left waiting finish before the next case.
            await stopped?.catch(() => {});
          }
          expect((await reload(granted.id)).status).toBe("REVOKED");
        },
      );

      // Synthetic Shopify for the fixture's one mapped product: the source
      // title differs, so the live comparison proposes one title write.
      function syntheticShop(f: Pair) {
        const titles: Record<string, string> = {
          [changes[0].sourceId]: "New",
          [changes[0].targetId]: "Old",
        };
        const handler = async (
          shop: string,
          doc: string,
          variables: Record<string, unknown> = {},
        ) => {
          if (doc.includes("SyncPilotShop"))
            return {
              shop: {
                id: `gid://shopify/Shop/${shop === f.sourceShop ? 1 : 2}`,
                currencyCode: "USD",
              },
            };
          if (doc.includes("SyncPilotResources"))
            return {
              nodes: (variables.ids as string[]).map((id) =>
                titles[id] === undefined
                  ? null
                  : {
                      id,
                      title: titles[id],
                      status: "ACTIVE",
                      handle: "fixture",
                      descriptionHtml: "<p>Fixture</p>",
                      vendor: "Fixture",
                      productType: "Fixture",
                      tags: [],
                      updatedAt: "2026-11-01T00:00:00Z",
                    },
              ),
            };
          if (doc.includes("SyncPilotProductUpdate")) {
            const input = variables.product as { id: string; title: string };
            titles[input.id] = input.title;
            return {
              productUpdate: { product: { id: input.id }, userErrors: [] },
            };
          }
          throw new Error("Unexpected synthetic GraphQL operation");
        };
        return { titles, handler };
      }

      // The real worker runs the scheduled preview, then the write. The stop
      // lands during executeGroup's last remote read before the mutation, after
      // every in-transaction check ran; a row lock taken anywhere on that path
      // (consent, policy, pair, approval, membership, mapping) would hold it.
      it.each(stops)(
        "%s while the worker is writing commits promptly, and no mutation is sent",
        async (_, stop) => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          const reviewed = await reviewedPlan(f, policyId);
          const granted = await grantAutomaticConsent(
            f.owner,
            grantInput(policyId, reviewed.id, 3),
          );
          // The worker claims globally; leave only this case's runs to claim.
          await prisma.syncJob.updateMany({
            where: { status: { in: ["PENDING", "RETRY", "RUNNING"] } },
            data: { status: "CANCELLED", leaseOwner: null, leaseUntil: null },
          });
          await prisma.webhookEvent.updateMany({
            where: { status: "RECEIVED" },
            data: { status: "IGNORED" },
          });
          await prisma.automaticConsent.update({
            where: { id: granted.id },
            data: { nextRunAt: await fromDatabase(-MINUTE) },
          });
          expect(await scheduleAutomaticSync()).toBe(1);
          const run = await prisma.syncJob.findFirstOrThrow({
            where: { policyId, operation: "AUTO_PREVIEW" },
          });

          const shopify = syntheticShop(f);
          let writing = false,
            targetReads = 0,
            stopped: Promise<unknown> | undefined,
            outcome: unknown;
          api.request.mockReset();
          api.request.mockImplementation(
            async (
              shop: string,
              doc: string,
              variables: Record<string, unknown> = {},
            ) => {
              // The write run reads the target twice before its mutation: the
              // live comparison, then executeGroup's preflight inside the
              // write transaction.
              if (
                writing &&
                shop === f.targetShop &&
                doc.includes("SyncPilotResources") &&
                ++targetReads === 2
              ) {
                stopped = Promise.resolve(stop(f, policyId, granted.id));
                outcome = await within(stopped, 3_000);
              }
              return shopify.handler(shop, doc, variables);
            },
          );
          try {
            expect(
              await runWorkerOnce(`automatic-preview-${f.suffix}`),
            ).toEqual({ processed: true, jobId: run.id, status: "SUCCEEDED" });
            const write = await prisma.syncJob.findFirstOrThrow({
              where: { policyId, operation: "APPLY_PREVIEW" },
            });
            expect(write.payload).toMatchObject({ consentId: granted.id });
            writing = true;
            expect(await runWorkerOnce(`automatic-write-${f.suffix}`)).toEqual({
              processed: true,
              jobId: write.id,
              status: "FAILED",
            });
            expect(
              await prisma.syncJob.findUniqueOrThrow({
                where: { id: write.id },
              }),
            ).toMatchObject({ status: "CANCELLED", leaseOwner: null });
          } finally {
            // Let a stop that was left waiting finish before the next case.
            await stopped?.catch(() => {});
          }
          expect(stopped).toBeDefined();
          expect(outcome).not.toBe(BLOCKED);
          // The next pre-mutation check refused: nothing was written or verified.
          expect(targetReads).toBe(2);
          expect(
            api.request.mock.calls.filter(([, doc]) =>
              String(doc).includes("mutation"),
            ),
          ).toEqual([]);
          expect(shopify.titles[changes[0].targetId]).toBe("Old");
          expect((await reload(granted.id)).status).toBe("REVOKED");
        },
      );
    });

    it("owner revocation ends an ACTIVE or HELD consent once and leaves an ended one as it was", async () => {
      const f = await pairFixture();
      const { id: policyId } = await policy(f);
      const nextRunAt = new Date(Date.now() + 15 * MINUTE),
        expiresAt = new Date(Date.now() + 60 * MINUTE);
      const active = await consent(f, policyId, { nextRunAt, expiresAt });
      const held = await consent(f, policyId, {
        nextRunAt,
        expiresAt,
        status: "HELD",
      });
      const lapsed = await consent(f, policyId, {
        nextRunAt,
        expiresAt: new Date(Date.now() - MINUTE),
        status: "EXPIRED",
      });
      const run = await inFlight(
        f,
        policyId,
        "APPLY_PREVIEW",
        "PENDING",
        active.id,
      );
      const audits = (id: string) =>
        prisma.auditEvent.findMany({
          where: { resourceId: id, action: "AUTOMATIC_CONSENT_REVOKED" },
          select: { actor: true, shopDomain: true, details: true },
        });

      for (const row of [active, held]) {
        await revokeAutomaticConsent(f.owner, row.id);
        expect(await reload(row.id)).toMatchObject({
          status: "REVOKED",
          revokedAt: expect.any(Date),
        });
        // The same reason field the lifecycle revocations write.
        expect(await audits(row.id)).toEqual([
          {
            actor: `${f.owner.shop}:${f.owner.userId}`,
            shopDomain: f.owner.shop,
            details: { reason: "OWNER_REVOKED" },
          },
        ]);
      }
      expect(
        await prisma.syncJob.findUniqueOrThrow({ where: { id: run.id } }),
      ).toMatchObject({
        status: "CANCELLED",
        lastError: "AUTOMATIC_CONSENT_REVOKED",
      });

      // A double submit, or a consent that already lapsed, keeps its record.
      for (const id of [active.id, lapsed.id]) {
        const before = await reload(id);
        const trail = await audits(id);
        await expect(revokeAutomaticConsent(f.owner, id)).resolves.toEqual(
          before,
        );
        expect(await reload(id)).toEqual(before);
        expect(await audits(id)).toEqual(trail);
      }
      expect((await reload(lapsed.id)).status).toBe("EXPIRED");
    });

    it("a lapsed consent the scheduler has not marked yet does not block a fresh grant", async () => {
      const f = await pairFixture();
      const { id: policyId } = await policy(f);
      const reviewed = await reviewedPlan(f, policyId);
      // The scheduler marks lapsed rows EXPIRED only while both switches are on.
      const lapsed = await consent(f, policyId, {
        nextRunAt: await fromDatabase(-120 * MINUTE),
        expiresAt: await fromDatabase(-MINUTE),
      });

      await expect(
        grantAutomaticConsent(f.owner, grantInput(policyId, reviewed.id, 3)),
      ).resolves.toMatchObject({ policyId, status: "ACTIVE" });
      expect(await reload(lapsed.id)).toMatchObject({
        status: "EXPIRED",
        revokedAt: null,
      });
      // A consent that is still running keeps blocking a replacement.
      await expect(
        grantAutomaticConsent(f.owner, grantInput(policyId, reviewed.id, 3)),
      ).rejects.toMatchObject({ code: "CONSENT_EXISTS" });
    });

    // The engine would stamp nextRunAt on this machine and the scheduler reads the
    // database's clock. With this machine ahead, a first run waited out the difference.
    describe.each(SKEWS)(
      "with this machine really an hour %s the database",
      (_, direction) => {
        withMachineClockSkewed(direction * HOUR);

        it("starts a fresh consent's first run at once, then waits its interval", async () => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          const reviewed = await reviewedPlan(f, policyId);
          const granted = await grantAutomaticConsent(
            f.owner,
            grantInput(policyId, reviewed.id, 3),
          );
          expect(await scheduleAutomaticSync()).toBe(1);
          expect(
            await prisma.syncJob.count({
              where: { policyId, operation: "AUTO_PREVIEW" },
            }),
          ).toBe(1);
          const next = await remaining((await reload(granted.id)).nextRunAt);
          expect(next).toBeGreaterThan(4 * MINUTE);
          expect(next).toBeLessThanOrEqual(5 * MINUTE);
        });
      },
    );

    describe.each(SKEWS)(
      "with this process's clock an hour %s the database's",
      (_, direction) => {
        beforeEach(() => skewProcessClock(direction * HOUR));
        afterEach(restoreProcessClock);

        it("keeps a consent running until it expires and runs it when due", async () => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          const running = await consent(f, policyId, {
            nextRunAt: await fromDatabase(-MINUTE),
            expiresAt: await fromDatabase(10 * MINUTE),
          });
          expect(await scheduleAutomaticSync()).toBe(1);
          const after = await reload(running.id);
          expect(after.status).toBe("ACTIVE");
          const next = await remaining(after.nextRunAt);
          expect(next).toBeGreaterThan(14 * MINUTE);
          expect(next).toBeLessThanOrEqual(15 * MINUTE);
        });
        it("ends a consent when it expires", async () => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          const lapsed = await consent(f, policyId, {
            nextRunAt: await fromDatabase(-2 * MINUTE),
            expiresAt: await fromDatabase(-MINUTE),
          });
          expect(await scheduleAutomaticSync()).toBe(0);
          expect((await reload(lapsed.id)).status).toBe("EXPIRED");
        });
        it("does not start a run before it is due", async () => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          await consent(f, policyId, {
            nextRunAt: await fromDatabase(10 * MINUTE),
            expiresAt: await fromDatabase(30 * MINUTE),
          });
          expect(await scheduleAutomaticSync()).toBe(0);
        });
        it("grants consent for its full duration, from a plan that is still valid", async () => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          const reviewed = await reviewedPlan(f, policyId);
          await prisma.syncPreview.update({
            where: { id: reviewed.id },
            data: { expiresAt: await fromDatabase(MINUTE) },
          });
          const granted = await grantAutomaticConsent(
            f.owner,
            grantInput(policyId, reviewed.id, 3),
          );
          const left = await remaining(granted.expiresAt);
          expect(left).toBeGreaterThan(59 * MINUTE);
          expect(left).toBeLessThanOrEqual(60 * MINUTE);
          const page = await getAutomaticConsents(f.owner);
          expect(page.previews.map(({ id }) => id)).toContain(reviewed.id);
        });
        it("refuses a grant from a plan that has expired", async () => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          const reviewed = await reviewedPlan(f, policyId);
          await prisma.syncPreview.update({
            where: { id: reviewed.id },
            data: { expiresAt: await fromDatabase(-MINUTE) },
          });
          await expect(
            grantAutomaticConsent(
              f.owner,
              grantInput(policyId, reviewed.id, 3),
            ),
          ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
          const page = await getAutomaticConsents(f.owner);
          expect(page.previews.map(({ id }) => id)).not.toContain(reviewed.id);
        });
        it("lets a lapsed consent be replaced, and keeps a live one in place", async () => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          const reviewed = await reviewedPlan(f, policyId);
          const existing = await consent(f, policyId, {
            nextRunAt: await fromDatabase(10 * MINUTE),
            expiresAt: await fromDatabase(MINUTE),
          });
          await expect(
            grantAutomaticConsent(
              f.owner,
              grantInput(policyId, reviewed.id, 3),
            ),
          ).rejects.toMatchObject({ code: "CONSENT_EXISTS" });
          await prisma.automaticConsent.update({
            where: { id: existing.id },
            data: { expiresAt: await fromDatabase(-MINUTE) },
          });
          await expect(
            grantAutomaticConsent(
              f.owner,
              grantInput(policyId, reviewed.id, 3),
            ),
          ).resolves.toMatchObject({ status: "ACTIVE" });
        });
        it("stops a run under consent when it expires, and lets it pass before", async () => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          const reviewed = await reviewedPlan(f, policyId);
          const granted = await grantAutomaticConsent(
            f.owner,
            grantInput(policyId, reviewed.id, 3),
          );
          const run: SyncJob = await inFlight(
            f,
            policyId,
            "AUTO_PREVIEW",
            "RUNNING",
            granted.id,
          );
          await prisma.automaticConsent.update({
            where: { id: granted.id },
            data: { expiresAt: await fromDatabase(MINUTE) },
          });
          await expect(assertJobConsent(run)).resolves.toMatchObject({
            id: granted.id,
          });
          await prisma.automaticConsent.update({
            where: { id: granted.id },
            data: { expiresAt: await fromDatabase(-MINUTE) },
          });
          await expect(assertJobConsent(run)).rejects.toMatchObject({
            code: "CONSENT_REVOKED",
          });
        });
        it("runs a live preview under its lease and bounds the plan by the database's clock", async () => {
          const f = await pairFixture();
          const { id: policyId } = await policy(f);
          const reviewed = await reviewedPlan(f, policyId);
          const granted = await grantAutomaticConsent(
            f.owner,
            grantInput(policyId, reviewed.id, 3),
          );
          const run = await prisma.syncJob.create({
            data: {
              workspaceId: f.workspace.id,
              policyId,
              sourceShop: f.sourceShop,
              targetShop: f.targetShop,
              operation: "AUTO_PREVIEW",
              status: "RUNNING",
              leaseOwner: "live-worker",
              leaseUntil: await fromDatabase(MINUTE),
              payload: { consentId: granted.id },
            },
          });
          api.request.mockReset();
          const titles: Record<string, string> = {
            [changes[0].sourceId]: "New",
            [changes[0].targetId]: "Old",
          };
          api.request.mockImplementation(
            async (
              shop: string,
              doc: string,
              variables: Record<string, unknown> = {},
            ) => {
              if (doc.includes("SyncPilotShop"))
                return {
                  shop: {
                    id: `gid://shopify/Shop/${shop === f.sourceShop ? 1 : 2}`,
                    currencyCode: "USD",
                  },
                };
              return {
                nodes: (variables.ids as string[]).map((id) =>
                  titles[id] === undefined
                    ? null
                    : {
                        id,
                        title: titles[id],
                        status: "ACTIVE",
                        handle: "fixture",
                        descriptionHtml: "<p>Fixture</p>",
                        vendor: "Fixture",
                        productType: "Fixture",
                        tags: [],
                        updatedAt: "2026-11-01T00:00:00Z",
                      },
                ),
              };
            },
          );
          await processAutomaticPreview(run, async () => {});
          const plan = await prisma.syncPreview.findFirstOrThrow({
            where: { policyId, status: "APPROVED" },
          });
          const left = await remaining(plan.expiresAt);
          expect(left).toBeGreaterThan(14 * MINUTE);
          expect(left).toBeLessThanOrEqual(15 * MINUTE);
          await prisma.syncJob.updateMany({
            where: { policyId, status: { in: ["PENDING", "RUNNING"] } },
            data: { status: "CANCELLED", leaseOwner: null, leaseUntil: null },
          });
        });
      },
    );

    it("opening the page reactivates a reinstalled store instead of reporting it inactive", async () => {
      const f = await pairFixture();
      await revokeInstallation(f.sourceShop);
      // Reinstalled through Shopify, which issued new sessions; no other page has
      // loaded since.
      await prisma.session.create({
        data: {
          id: `offline_${f.sourceShop}`,
          shop: f.sourceShop,
          state: "synthetic",
          accessToken: "synthetic-token",
        },
      });
      await expect(getAutomaticConsents(f.owner)).resolves.toMatchObject({
        paired: false,
        consents: [],
        policies: [],
        previews: [],
      });
      expect(
        await prisma.shopConnection.findUniqueOrThrow({
          where: { shopDomain: f.sourceShop },
        }),
      ).toMatchObject({
        status: "CONNECTED",
        uninstalledAt: null,
        workspaceId: null,
      });
    });
  },
);
