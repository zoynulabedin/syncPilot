import { afterAll, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import {
  revokeInstallation,
  updateInstallationScopes,
} from "../../app/services/installation.server";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
let sequence = 0;
async function fixture() {
  const suffix = ++sequence,
    sourceShop = `lifecycle-a-${suffix}.myshopify.com`,
    targetShop = `lifecycle-b-${suffix}.myshopify.com`;
  const workspace = await prisma.workspace.create({
    data: { name: "Lifecycle fixture" },
  });
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
      userId: "101",
      role: "OWNER",
    },
  });
  const pair = await prisma.storePair.create({
    data: {
      workspaceId: workspace.id,
      sourceShop,
      targetShop,
      requestId: `lifecycle-pair-${suffix}`,
    },
  });
  const policy = await prisma.syncPolicy.create({
    data: {
      workspaceId: workspace.id,
      sourceShopDomain: sourceShop,
      targetShopDomain: targetShop,
      fields: ["title"],
      syncProduct: true,
      enabled: true,
      status: "ACTIVE",
    },
  });
  const preview = await prisma.syncPreview.create({
    data: {
      workspaceId: workspace.id,
      policyId: policy.id,
      createdBy: "synthetic-owner",
      sourceHash: "s",
      targetHash: "t",
      changes: [],
      status: "APPROVED",
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const job = await prisma.syncJob.create({
    data: {
      workspaceId: workspace.id,
      policyId: policy.id,
      sourceShop,
      targetShop,
      operation: "APPLY_PREVIEW",
      previewId: preview.id,
      status: "RUNNING",
      leaseOwner: "synthetic-worker",
      leaseUntil: new Date(Date.now() + 60000),
    },
  });
  return { sourceShop, targetShop, workspace, pair, policy, preview, job };
}
integration("installation lifecycle revokes queued authorization", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });
  it("revokes pairing, ownership and queued writes even after offline sessions are absent", async () => {
    const f = await fixture();
    expect(await prisma.session.count({ where: { shop: f.sourceShop } })).toBe(
      0,
    );
    await revokeInstallation(f.sourceShop);
    expect(
      (
        await prisma.shopConnection.findUniqueOrThrow({
          where: { shopDomain: f.sourceShop },
        })
      ).status,
    ).toBe("UNINSTALLED");
    expect(
      (
        await prisma.shopConnection.findUniqueOrThrow({
          where: { shopDomain: f.targetShop },
        })
      ).workspaceId,
    ).toBeNull();
    expect(
      (await prisma.storePair.findUniqueOrThrow({ where: { id: f.pair.id } }))
        .status,
    ).toBe("REVOKED");
    expect(
      await prisma.syncJob.findUniqueOrThrow({ where: { id: f.job.id } }),
    ).toMatchObject({
      status: "CANCELLED",
      leaseOwner: null,
      leaseUntil: null,
    });
    expect(
      await prisma.syncPolicy.findUniqueOrThrow({ where: { id: f.policy.id } }),
    ).toMatchObject({ enabled: false, status: "PAUSED" });
    expect(
      (
        await prisma.syncPreview.findUniqueOrThrow({
          where: { id: f.preview.id },
        })
      ).status,
    ).toBe("REVOKED");
    expect(
      (
        await prisma.workspaceMember.findFirstOrThrow({
          where: { workspaceId: f.workspace.id },
        })
      ).status,
    ).toBe("REVOKED");
    expect(
      (
        await prisma.workspace.findUniqueOrThrow({
          where: { id: f.workspace.id },
        })
      ).state,
    ).toBe("REVOKED");
    await revokeInstallation(f.sourceShop);
    expect(
      await prisma.auditEvent.count({
        where: { workspaceId: f.workspace.id, action: "APP_UNINSTALLED" },
      }),
    ).toBe(1);
  });
  it("removes every online and offline session for the affected shop only", async () => {
    const f = await fixture();
    await prisma.session.createMany({
      data: [
        {
          id: `lifecycle-offline-${sequence}`,
          shop: f.sourceShop,
          state: "synthetic",
          isOnline: false,
          accessToken: "synthetic-token",
        },
        {
          id: `lifecycle-online-${sequence}`,
          shop: f.sourceShop,
          state: "synthetic",
          isOnline: true,
          accessToken: "synthetic-token",
        },
        {
          id: `lifecycle-other-${sequence}`,
          shop: f.targetShop,
          state: "synthetic",
          isOnline: false,
          accessToken: "synthetic-token",
        },
      ],
    });
    await revokeInstallation(f.sourceShop);
    expect(await prisma.session.count({ where: { shop: f.sourceShop } })).toBe(
      0,
    );
    expect(await prisma.session.count({ where: { shop: f.targetShop } })).toBe(
      1,
    );
  });
  it("pauses approval and in-flight writers after scope changes and records the new scope set", async () => {
    const f = await fixture();
    await prisma.session.create({
      data: {
        id: `scope-offline-${sequence}`,
        shop: f.sourceShop,
        state: "synthetic",
        isOnline: false,
        accessToken: "synthetic-token",
        scope: "read_products,write_products",
      },
    });
    await updateInstallationScopes(f.sourceShop, [
      "read_products",
      "read_products",
      "read_inventory",
    ]);
    expect(
      (
        await prisma.session.findUniqueOrThrow({
          where: { id: `scope-offline-${sequence}` },
        })
      ).scope,
    ).toBe("read_inventory,read_products");
    expect(
      (
        await prisma.shopConnection.findUniqueOrThrow({
          where: { shopDomain: f.sourceShop },
        })
      ).scopes,
    ).toBe("read_inventory,read_products");
    expect(
      (
        await prisma.syncPolicy.findUniqueOrThrow({
          where: { id: f.policy.id },
        })
      ).enabled,
    ).toBe(false);
    expect(
      (
        await prisma.syncPreview.findUniqueOrThrow({
          where: { id: f.preview.id },
        })
      ).status,
    ).toBe("REVOKED");
    expect(
      await prisma.syncJob.findUniqueOrThrow({ where: { id: f.job.id } }),
    ).toMatchObject({ status: "CANCELLED", leaseOwner: null });
    expect(
      await prisma.auditEvent.count({
        where: { workspaceId: f.workspace.id, action: "SCOPES_CHANGED" },
      }),
    ).toBe(1);
  });
});
