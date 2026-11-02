import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import {
  buildSyncPreview,
  SyncError,
  type CatalogRecords,
  type ProductRecord,
  type VariantRecord,
} from "../../app/domain/sync";
import {
  executeCatalogImport,
  importCatalog,
} from "../../app/services/catalog.server";
import {
  buildPreview,
  dispatchInbox,
  runWorkerOnce,
} from "../../app/services/sync-engine.server";
import { recordVerifiedWebhook } from "../../app/services/webhook-inbox.server";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../app/services/shopify-client.server", () => ({
  shopifyRequest: api.request,
}));
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const gid = (kind: string, id: number) => `gid://shopify/${kind}/${id}`;
const product = (id: number, title = `Product ${id}`): ProductRecord => ({
  id: gid("Product", id),
  title,
  status: "ACTIVE",
  handle: `product-${id}`,
  descriptionHtml: "<p>Complete import</p>",
  vendor: "Fixture",
  productType: "Fixture",
  tags: [],
  updatedAt: "2026-11-01T00:00:00Z",
});
const variant = (
  id: number,
  parent: number,
  tracked = false,
): VariantRecord => ({
  id: gid("ProductVariant", id),
  product: { id: gid("Product", parent) },
  sku: `SKU-${id}`,
  barcode: `BAR-${id}`,
  price: "10.00",
  compareAtPrice: null,
  selectedOptions: [{ name: "Size", value: "M" }],
  inventoryItem: { id: gid("InventoryItem", id), tracked },
});
let sequence = 0;
async function ownShop() {
  const shop = `engine-${++sequence}.myshopify.com`;
  await prisma.shopConnection.create({
    data: { shopDomain: shop, currency: "USD", verifiedAt: new Date() },
  });
  return shop;
}
function page<T>(nodes: T[], after: unknown, size = 100) {
  const offset = typeof after === "string" ? Number(after) : 0;
  const batch = nodes.slice(offset, offset + size),
    hasNextPage = offset + size < nodes.length;
  return {
    nodes: batch,
    pageInfo: {
      hasNextPage,
      endCursor: batch.length ? String(offset + batch.length) : null,
    },
  };
}
function catalogApi(
  products: ProductRecord[] = [],
  variants: VariantRecord[] = [],
) {
  return async (
    _shop: string,
    doc: string,
    variables: Record<string, unknown> = {},
  ) => {
    if (doc.includes("SyncPilotShop"))
      return { shop: { id: gid("Shop", 1), currencyCode: "USD" } };
    if (doc.includes("SyncPilotProducts"))
      return { products: page(products, variables.after) };
    if (doc.includes("SyncPilotVariants"))
      return { productVariants: page(variants, variables.after) };
    if (doc.includes("SyncPilotLocations"))
      return {
        locations: page(
          [{ id: gid("Location", 1), name: "Main", isActive: true }],
          variables.after,
        ),
      };
    if (doc.includes("SyncPilotInventoryLevels"))
      return {
        inventoryItem: {
          id: variables.id,
          tracked: true,
          inventoryLevels: page(
            [
              {
                location: { id: gid("Location", 1) },
                quantities: [{ name: "available", quantity: 7 }],
              },
            ],
            variables.after,
          ),
        },
      };
    throw new Error("Unexpected synthetic GraphQL operation");
  };
}
async function catalogJob(
  shop: string,
  overrides: Record<string, unknown> = {},
) {
  const snapshot = await prisma.catalogSnapshot.create({
    data: { shopDomain: shop, status: "QUEUED" },
  });
  const job = await prisma.syncJob.create({
    data: {
      workspaceId: "",
      policyId: "",
      sourceShop: shop,
      targetShop: shop,
      operation: "CATALOG_IMPORT",
      payload: { snapshotId: snapshot.id },
      availableAt: new Date("2000-01-01"),
      ...overrides,
    },
  });
  return { snapshot, job };
}
async function pairFixture(inventory = false) {
  const sourceShop = await ownShop(),
    targetShop = await ownShop();
  const workspace = await prisma.workspace.create({
    data: { name: "Synthetic engine workspace" },
  });
  await prisma.shopConnection.updateMany({
    where: { shopDomain: { in: [sourceShop, targetShop] } },
    data: { workspaceId: workspace.id },
  });
  await prisma.workspaceMember.create({
    data: {
      workspaceId: workspace.id,
      shopDomain: sourceShop,
      userId: "101",
      role: "OWNER",
    },
  });
  await prisma.storePair.create({
    data: {
      workspaceId: workspace.id,
      sourceShop,
      targetShop,
      requestId: `engine-pair-${sequence}`,
    },
  });
  const policy = await prisma.syncPolicy.create({
    data: {
      workspaceId: workspace.id,
      sourceShopDomain: sourceShop,
      targetShopDomain: targetShop,
      fields: inventory ? [] : ["title"],
      syncProduct: !inventory,
      syncPrices: false,
      syncInventory: inventory,
      inventoryMode: inventory ? "SOURCE" : "DISABLED",
      inventoryAuthority: inventory ? sourceShop : null,
      enabled: true,
      status: "ACTIVE",
      approvedBy: `${sourceShop}:101`,
      approvedAt: new Date(),
    },
  });
  const from = product(100, "Master title"),
    to = product(200, "Replica title");
  const sv = variant(110, 100, true),
    tv = variant(210, 200, true);
  for (const [shop, p, v] of [
    [sourceShop, from, sv],
    [targetShop, to, tv],
  ] as const) {
    await prisma.catalogSnapshot.create({
      data: { shopDomain: shop, status: "COMPLETED", completedAt: new Date() },
    });
    await prisma.productSnapshot.create({
      data: {
        shopDomain: shop,
        productGid: p.id,
        title: p.title,
        status: p.status,
        handle: p.handle,
        descriptionHtml: p.descriptionHtml,
        vendor: p.vendor,
        productType: p.productType,
        tags: p.tags,
        currency: "USD",
        data: {},
        hash: "synthetic",
      },
    });
    await prisma.variantSnapshot.create({
      data: {
        shopDomain: shop,
        variantGid: v.id,
        productGid: p.id,
        inventoryItemGid: v.inventoryItem!.id,
        sku: v.sku,
        barcode: v.barcode,
        price: v.price,
        compareAtPrice: null,
        options: v.selectedOptions,
        tracked: true,
        data: {},
        hash: "synthetic",
      },
    });
    await prisma.locationSnapshot.create({
      data: {
        shopDomain: shop,
        locationGid: gid("Location", shop === sourceShop ? 120 : 220),
        name: "Main",
        isActive: true,
      },
    });
    await prisma.inventorySnapshot.create({
      data: {
        shopDomain: shop,
        inventoryItemGid: v.inventoryItem!.id,
        locationGid: gid("Location", shop === sourceShop ? 120 : 220),
        quantity: shop === sourceShop ? 10 : 3,
      },
    });
  }
  const verifiedAt = new Date();
  await prisma.productMapping.create({
    data: {
      workspaceId: workspace.id,
      sourceShopDomain: sourceShop,
      targetShopDomain: targetShop,
      sourceProductGid: from.id,
      targetProductGid: to.id,
      verifiedAt,
    },
  });
  await prisma.variantMapping.create({
    data: {
      workspaceId: workspace.id,
      sourceShopDomain: sourceShop,
      targetShopDomain: targetShop,
      sourceVariantGid: sv.id,
      targetVariantGid: tv.id,
      sourceInventoryGid: sv.inventoryItem!.id,
      targetInventoryGid: tv.inventoryItem!.id,
      verifiedAt,
    },
  });
  await prisma.locationMapping.create({
    data: {
      workspaceId: workspace.id,
      sourceShopDomain: sourceShop,
      targetShopDomain: targetShop,
      sourceLocationGid: gid("Location", 120),
      targetLocationGid: gid("Location", 220),
      verifiedAt,
    },
  });
  const source: CatalogRecords = {
    currency: "USD",
    products: [from],
    variants: [sv],
    locations: [{ id: gid("Location", 120), name: "Main", isActive: true }],
    inventory: [
      {
        inventoryItemGid: sv.inventoryItem!.id,
        locationGid: gid("Location", 120),
        quantity: 10,
      },
    ],
  };
  const target: CatalogRecords = {
    currency: "USD",
    products: [to],
    variants: [tv],
    locations: [{ id: gid("Location", 220), name: "Main", isActive: true }],
    inventory: [
      {
        inventoryItemGid: tv.inventoryItem!.id,
        locationGid: gid("Location", 220),
        quantity: 3,
      },
    ],
  };
  const current = await buildPreview(policy.id);
  const preview = await prisma.syncPreview.create({
    data: {
      workspaceId: workspace.id,
      policyId: policy.id,
      createdBy: `${sourceShop}:101`,
      sourceHash: current.sourceHash,
      targetHash: current.targetHash,
      changes: current.changes,
      status: "APPROVED",
      approvedBy: `${sourceShop}:101`,
      approvedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
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
      payload: { previewId: preview.id },
      idempotencyKey: `preview:${preview.id}`,
      availableAt: new Date("2000-01-01"),
    },
  });
  return {
    sourceShop,
    targetShop,
    workspace,
    policy,
    preview,
    job,
    source,
    target,
  };
}
function liveApi(
  f: Awaited<ReturnType<typeof pairFixture>>,
  staleInventory = false,
) {
  return async (
    shop: string,
    doc: string,
    variables: Record<string, unknown> = {},
  ) => {
    const catalog = shop === f.sourceShop ? f.source : f.target;
    if (doc.includes("SyncPilotShop"))
      return {
        shop: {
          id: gid("Shop", shop === f.sourceShop ? 1 : 2),
          currencyCode: catalog.currency,
        },
      };
    if (doc.includes("SyncPilotResources")) {
      const ids = variables.ids as string[];
      return {
        nodes: ids.map(
          (id) =>
            catalog.products.find((p) => p.id === id) ??
            catalog.variants.find((v) => v.id === id) ??
            catalog.locations.find((l) => l.id === id) ??
            null,
        ),
      };
    }
    if (doc.includes("SyncPilotInventoryLevel")) {
      const level = catalog.inventory.find(
        (l) =>
          l.inventoryItemGid === variables.id &&
          l.locationGid === variables.locationId,
      );
      return {
        inventoryItem: {
          id: variables.id,
          tracked: true,
          inventoryLevel: level
            ? {
                location: { id: level.locationGid, isActive: true },
                quantities: [{ name: "available", quantity: level.quantity }],
              }
            : null,
        },
      };
    }
    if (doc.includes("SyncPilotProductUpdate")) {
      const input = variables.product as {
        id: string;
        title?: string;
        seo?: { title?: string; description?: string };
      };
      const p = catalog.products.find((p) => p.id === input.id)!;
      if (input.title !== undefined) p.title = input.title;
      if (input.seo)
        p.seo = { title: null, description: null, ...p.seo, ...input.seo };
      return { productUpdate: { product: { id: p.id }, userErrors: [] } };
    }
    if (doc.includes("SyncPilotVariantUpdate")) {
      const input = (
        variables.variants as {
          id: string;
          inventoryItem?: { sku: string };
          taxable?: boolean;
          inventoryPolicy?: "DENY" | "CONTINUE";
        }[]
      )[0];
      const v = catalog.variants.find((row) => row.id === input.id)!;
      if (input.inventoryItem) v.sku = input.inventoryItem.sku;
      if (input.taxable !== undefined) v.taxable = input.taxable;
      if (input.inventoryPolicy !== undefined)
        v.inventoryPolicy = input.inventoryPolicy;
      return {
        productVariantsBulkUpdate: {
          productVariants: [{ id: v.id }],
          userErrors: [],
        },
      };
    }
    if (doc.includes("SyncPilotInventorySet")) {
      const input = variables.input as {
        quantities: {
          inventoryItemId: string;
          locationId: string;
          quantity: number;
          changeFromQuantity: number;
        }[];
      };
      const change = input.quantities[0],
        level = catalog.inventory.find(
          (l) =>
            l.inventoryItemGid === change.inventoryItemId &&
            l.locationGid === change.locationId,
        )!;
      if (staleInventory) level.quantity--;
      if (level.quantity !== change.changeFromQuantity)
        return {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [
              {
                code: "CHANGE_FROM_QUANTITY_STALE",
                field: ["quantities"],
                message: "Quantity does not match",
              },
            ],
          },
        };
      level.quantity = change.quantity;
      return {
        inventorySetQuantities: {
          inventoryAdjustmentGroup: {
            referenceDocumentUri: "synthetic",
            changes: [],
          },
          userErrors: [],
        },
      };
    }
    throw new Error("Unexpected synthetic live operation");
  };
}

integration("durable synchronization PostgreSQL worker", () => {
  beforeEach(async () => {
    // This suite is serial and TEST_DATABASE_URL is created/dropped by the local integration runner.
    if (!process.env.TEST_DATABASE_URL)
      throw new Error("A disposable integration database is required");
    await prisma.syncJob.updateMany({
      where: { status: { in: ["PENDING", "RETRY", "RUNNING"] } },
      data: { status: "CANCELLED", leaseOwner: null, leaseUntil: null },
    });
    await prisma.webhookEvent.updateMany({
      where: { status: "RECEIVED" },
      data: { status: "IGNORED" },
    });
    process.env.SYNC_WRITE_ENABLED = "false";
    process.env.INVENTORY_WRITE_ENABLED = "false";
    api.request.mockReset();
    api.request.mockImplementation(catalogApi());
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  it("applies selected SEO and variant fields through exact approvals without changing unrelated SEO or stock", async () => {
    const f = await pairFixture();
    f.source.products[0].seo = {
      title: "Master SEO",
      description: "Source description",
    };
    f.target.products[0].seo = {
      title: "Old SEO",
      description: "Keep destination description",
    };
    Object.assign(f.source.variants[0], {
      sku: "MASTER-SKU",
      taxable: false,
      inventoryPolicy: "DENY",
    });
    Object.assign(f.target.variants[0], {
      sku: "OLD-SKU",
      taxable: true,
      inventoryPolicy: "CONTINUE",
    });
    const policy = await prisma.syncPolicy.update({
      where: { id: f.policy.id },
      data: {
        fields: ["seoTitle", "sku", "taxable", "inventoryPolicy"],
        syncVariants: true,
      },
    });
    for (const [shop, catalog] of [
      [f.sourceShop, f.source],
      [f.targetShop, f.target],
    ] as const) {
      await prisma.productSnapshot.update({
        where: {
          shopDomain_productGid: {
            shopDomain: shop,
            productGid: catalog.products[0].id,
          },
        },
        data: { data: JSON.parse(JSON.stringify(catalog.products[0])) },
      });
      await prisma.variantSnapshot.update({
        where: {
          shopDomain_variantGid: {
            shopDomain: shop,
            variantGid: catalog.variants[0].id,
          },
        },
        data: {
          sku: catalog.variants[0].sku,
          data: JSON.parse(JSON.stringify(catalog.variants[0])),
        },
      });
    }
    const plan = await buildPreview(policy.id);
    await prisma.syncPreview.update({
      where: { id: f.preview.id },
      data: {
        sourceHash: plan.sourceHash,
        targetHash: plan.targetHash,
        changes: plan.changes,
      },
    });
    process.env.SYNC_WRITE_ENABLED = "true";
    api.request.mockImplementation(liveApi(f));
    expect((await runWorkerOnce("advanced-fields-worker")).status).toBe(
      "SUCCEEDED",
    );
    expect(f.target.products[0].seo).toEqual({
      title: "Master SEO",
      description: "Keep destination description",
    });
    expect(f.target.variants[0]).toMatchObject({
      sku: "MASTER-SKU",
      taxable: false,
      inventoryPolicy: "DENY",
      inventoryItem: { tracked: true },
    });
    expect(f.target.inventory[0].quantity).toBe(3);
    const writes = api.request.mock.calls.filter(
      (call) => (call[3] as { write?: boolean })?.write,
    );
    expect(writes).toHaveLength(2);
    expect(writes[1][2]).toMatchObject({
      variants: [
        {
          id: f.target.variants[0].id,
          inventoryItem: { sku: "MASTER-SKU" },
          taxable: false,
          inventoryPolicy: "DENY",
        },
      ],
    });
  });
  it("deduplicates delivery receipts and atomically dispatches one durable job", async () => {
    const shop = await ownShop();
    const request = new Request(
      "https://fixture.invalid/webhooks/products/update",
      { headers: { "X-Shopify-Webhook-Id": `delivery-${sequence}` } },
    );
    const [one, ...duplicates] = await Promise.all(
      Array.from({ length: 12 }, () =>
        recordVerifiedWebhook(request, shop, "PRODUCTS_UPDATE", "100"),
      ),
    );
    const two = duplicates[0];
    expect(new Set(duplicates.map((row) => row.id))).toEqual(new Set([one.id]));
    expect(one.id).toBe(two.id);
    await Promise.all([dispatchInbox(), dispatchInbox()]);
    expect(await prisma.syncJob.count({ where: { eventId: one.id } })).toBe(1);
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: one.id } }))
        .status,
    ).toBe("DISPATCHED");
    expect(api.request).not.toHaveBeenCalled();
    await expect(
      recordVerifiedWebhook(
        new Request("https://fixture.invalid"),
        shop,
        "PRODUCTS_UPDATE",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("never dispatches a cross-store refresh for an uninstalled shop", async () => {
    const shop = await ownShop();
    await prisma.shopConnection.update({
      where: { shopDomain: shop },
      data: { status: "UNINSTALLED", uninstalledAt: new Date() },
    });
    const event = await recordVerifiedWebhook(
      new Request("https://fixture.invalid", {
        headers: { "x-shopify-webhook-id": `uninstall-${sequence}` },
      }),
      shop,
      "PRODUCTS_UPDATE",
      "100",
    );
    await dispatchInbox();
    expect(await prisma.syncJob.count({ where: { eventId: event.id } })).toBe(
      0,
    );
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } }))
        .status,
    ).toBe("IGNORED");
  });
  it("imports every product/variant page, inventory location and resumes a persisted checkpoint", async () => {
    const shop = await ownShop(),
      products = Array.from({ length: 205 }, (_, i) => product(i + 1)),
      variants = Array.from({ length: 145 }, (_, i) =>
        variant(i + 1, i + 1, i === 0),
      );
    const handler = catalogApi(products, variants);
    let failed = false;
    api.request.mockImplementation(
      async (s: string, doc: string, vars: Record<string, unknown> = {}) => {
        if (
          !failed &&
          doc.includes("SyncPilotProducts") &&
          vars.after === "100"
        ) {
          failed = true;
          throw new SyncError(
            "NETWORK_TIMEOUT",
            "Synthetic read timeout",
            true,
          );
        }
        return handler(s, doc, vars);
      },
    );
    const snapshot = await prisma.catalogSnapshot.create({
      data: { shopDomain: shop, status: "QUEUED" },
    });
    await expect(executeCatalogImport(snapshot.id, shop)).rejects.toMatchObject(
      { retryable: true },
    );
    expect(
      await prisma.productSnapshot.count({ where: { shopDomain: shop } }),
    ).toBe(100);
    expect(
      JSON.parse(
        (
          await prisma.catalogSnapshot.findUniqueOrThrow({
            where: { id: snapshot.id },
          })
        ).cursor!,
      ),
    ).toEqual({ phase: "products", after: "100" });
    api.request.mockClear();
    await executeCatalogImport(snapshot.id, shop);
    expect(
      api.request.mock.calls
        .filter((c) => String(c[1]).includes("SyncPilotProducts"))
        .map((c) => (c[2] as { after: string }).after),
    ).toEqual(["100", "200"]);
    expect(
      await prisma.productSnapshot.count({ where: { shopDomain: shop } }),
    ).toBe(205);
    expect(
      await prisma.variantSnapshot.count({ where: { shopDomain: shop } }),
    ).toBe(145);
    expect(
      await prisma.inventorySnapshot.count({ where: { shopDomain: shop } }),
    ).toBe(1);
    expect(
      (
        await prisma.catalogSnapshot.findUniqueOrThrow({
          where: { id: snapshot.id },
        })
      ).status,
    ).toBe("COMPLETED");
  });
  it("handles a 10,000-product fixture without truncation", async () => {
    const shop = await ownShop(),
      products = Array.from({ length: 10_000 }, (_, i) => product(10_000 + i));
    api.request.mockImplementation(catalogApi(products));
    const snapshot = await prisma.catalogSnapshot.create({
      data: { shopDomain: shop, status: "QUEUED" },
    });
    await executeCatalogImport(snapshot.id, shop);
    expect(
      await prisma.productSnapshot.count({ where: { shopDomain: shop } }),
    ).toBe(10_000);
    expect(
      api.request.mock.calls.filter((c) =>
        String(c[1]).includes("SyncPilotProducts"),
      ),
    ).toHaveLength(100);
    expect(
      (
        await prisma.catalogSnapshot.findUniqueOrThrow({
          where: { id: snapshot.id },
        })
      ).products,
    ).toBe(10_000);
  }, 120_000);
  it("leases at most one active import per shop across concurrent workers", async () => {
    const shop = await ownShop();
    await catalogJob(shop);
    await catalogJob(shop);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const handler = catalogApi();
    api.request.mockImplementation(
      async (s: string, doc: string, v: Record<string, unknown> = {}) => {
        if (doc.includes("SyncPilotShop")) {
          entered();
          await gate;
        }
        return handler(s, doc, v);
      },
    );
    const first = runWorkerOnce(`lease-a-${sequence}`),
      second = runWorkerOnce(`lease-b-${sequence}`);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const active = await prisma.syncJob.count({
      where: { sourceShop: shop, status: "RUNNING" },
    });
    release();
    await Promise.all([first, second]);
    expect(active).toBe(1);
  });
  it("recovers read checkpoints after restart and quarantines uncertain write leases", async () => {
    const shop = await ownShop();
    const { snapshot, job } = await catalogJob(shop, {
      status: "RUNNING",
      attempts: 1,
      leaseOwner: "dead-worker",
      leaseUntil: new Date(Date.now() - 1000),
    });
    await prisma.catalogSnapshot.update({
      where: { id: snapshot.id },
      data: { cursor: JSON.stringify({ phase: "variants", after: null }) },
    });
    await prisma.syncAttempt.create({
      data: { jobId: job.id, attempt: 1, status: "RUNNING" },
    });
    await runWorkerOnce(`recovered-${sequence}`);
    for (
      let poll = 0;
      poll < 5 &&
      (await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } }))
        .status !== "SUCCEEDED";
      poll++
    ) {
      // Recovery schedules a read for the next poll; application and database clocks can differ by a few milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await runWorkerOnce(`recovered-${sequence}`);
    }
    expect(
      (await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } }))
        .status,
    ).toBe("SUCCEEDED");
    expect(
      (
        await prisma.syncAttempt.findUniqueOrThrow({
          where: { jobId_attempt: { jobId: job.id, attempt: 1 } },
        })
      ).status,
    ).toBe("INTERRUPTED");
    const f = await pairFixture();
    await prisma.syncJob.update({
      where: { id: f.job.id },
      data: {
        status: "RUNNING",
        attempts: 1,
        leaseOwner: "dead-writer",
        leaseUntil: new Date(Date.now() - 1000),
      },
    });
    await prisma.syncAttempt.create({
      data: { jobId: f.job.id, attempt: 1, status: "RUNNING" },
    });
    api.request.mockClear();
    await runWorkerOnce(`recovery-write-${sequence}`);
    expect(
      (await prisma.syncJob.findUniqueOrThrow({ where: { id: f.job.id } }))
        .status,
    ).toBe("HELD");
    expect(
      (
        await prisma.syncPreview.findUniqueOrThrow({
          where: { id: f.preview.id },
        })
      ).status,
    ).toBe("HELD");
    expect(
      await prisma.syncConflict.count({
        where: { jobId: f.job.id, code: "UNKNOWN_OUTCOME" },
      }),
    ).toBe(1);
    expect(api.request).not.toHaveBeenCalled();
  });
  it("does not contact Shopify for an approved write when global safety switches are off", async () => {
    const f = await pairFixture();
    api.request.mockClear();
    await runWorkerOnce(`gate-${sequence}`);
    const job = await prisma.syncJob.findUniqueOrThrow({
      where: { id: f.job.id },
    });
    expect(job.status).toBe("HELD");
    expect(job.lastError).toContain("WRITES_DISABLED");
    expect(api.request).not.toHaveBeenCalled();
  });
  it("applies one exact selected product field and records its durable outcome with synthetic Shopify", async () => {
    const f = await pairFixture();
    process.env.SYNC_WRITE_ENABLED = "true";
    api.request.mockImplementation(liveApi(f));
    await runWorkerOnce(`apply-${sequence}`);
    expect(
      (await prisma.syncJob.findUniqueOrThrow({ where: { id: f.job.id } }))
        .status,
    ).toBe("SUCCEEDED");
    expect(f.target.products[0].title).toBe("Master title");
    const writes = api.request.mock.calls.filter((c) =>
      String(c[1]).includes("mutation"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0][2]).toEqual({
      product: { id: gid("Product", 200), title: "Master title" },
    });
    expect(
      (
        await prisma.syncPreview.findUniqueOrThrow({
          where: { id: f.preview.id },
        })
      ).status,
    ).toBe("APPLIED");
    expect(
      await prisma.auditEvent.count({
        where: { workspaceId: f.workspace.id, action: "SYNC_RESOURCE_APPLIED" },
      }),
    ).toBe(1);
  });
  it("holds an inventory CAS race with a stable idempotency key and never overwrites the concurrent sale", async () => {
    const f = await pairFixture(true);
    process.env.SYNC_WRITE_ENABLED = "true";
    process.env.INVENTORY_WRITE_ENABLED = "true";
    api.request.mockImplementation(liveApi(f, true));
    await runWorkerOnce(`inventory-${sequence}`);
    const job = await prisma.syncJob.findUniqueOrThrow({
      where: { id: f.job.id },
    });
    expect(job.status).toBe("HELD");
    expect(job.lastError).toContain("STALE_QUANTITY");
    expect(f.target.inventory[0].quantity).toBe(2);
    const write = api.request.mock.calls.find((c) =>
      String(c[1]).includes("SyncPilotInventorySet"),
    )!;
    expect(write[1]).toContain("@idempotent(key: $idempotencyKey)");
    expect(write[2]).toMatchObject({
      idempotencyKey: expect.stringContaining(f.job.id),
      input: { quantities: [{ quantity: 10, changeFromQuantity: 3 }] },
    });
  });
  it("sets and verifies an approved inventory level with compare-and-swap in synthetic Shopify", async () => {
    const f = await pairFixture(true);
    process.env.SYNC_WRITE_ENABLED = "true";
    process.env.INVENTORY_WRITE_ENABLED = "true";
    api.request.mockImplementation(liveApi(f));
    await runWorkerOnce(`inventory-success-${sequence}`);
    expect(
      (await prisma.syncJob.findUniqueOrThrow({ where: { id: f.job.id } }))
        .status,
    ).toBe("SUCCEEDED");
    expect(f.target.inventory[0].quantity).toBe(10);
    expect(
      (
        await prisma.syncPreview.findUniqueOrThrow({
          where: { id: f.preview.id },
        })
      ).status,
    ).toBe("APPLIED");
    expect(
      api.request.mock.calls.filter((c) =>
        String(c[1]).includes("SyncPilotInventorySet"),
      ),
    ).toHaveLength(1);
  });
  it("quarantines an uncertain inventory outcome and never blindly replays its adjustment", async () => {
    const f = await pairFixture(true);
    process.env.SYNC_WRITE_ENABLED = "true";
    process.env.INVENTORY_WRITE_ENABLED = "true";
    const handler = liveApi(f);
    api.request.mockImplementation(
      async (shop: string, doc: string, vars: Record<string, unknown> = {}) => {
        const result = await handler(shop, doc, vars);
        if (doc.includes("SyncPilotInventorySet"))
          throw new SyncError(
            "UNKNOWN_OUTCOME",
            "Synthetic response lost after Shopify applied the mutation",
            false,
            true,
          );
        return result;
      },
    );
    await runWorkerOnce(`inventory-unknown-${sequence}`);
    expect(f.target.inventory[0].quantity).toBe(10);
    const job = await prisma.syncJob.findUniqueOrThrow({
      where: { id: f.job.id },
    });
    expect(job.status).toBe("HELD");
    expect(job.lastError).toContain("UNKNOWN_OUTCOME");
    expect(
      await prisma.syncConflict.count({
        where: { jobId: f.job.id, code: "UNKNOWN_OUTCOME" },
      }),
    ).toBe(1);
    await runWorkerOnce(`inventory-no-replay-${sequence}`);
    expect(
      api.request.mock.calls.filter((c) =>
        String(c[1]).includes("SyncPilotInventorySet"),
      ),
    ).toHaveLength(1);
  });
  it("holds a live destination edit after approval without issuing a mutation", async () => {
    const f = await pairFixture();
    process.env.SYNC_WRITE_ENABLED = "true";
    f.target.products[0].title = "Edited by merchant after approval";
    api.request.mockImplementation(liveApi(f));
    await runWorkerOnce(`stale-live-${sequence}`);
    const job = await prisma.syncJob.findUniqueOrThrow({
      where: { id: f.job.id },
    });
    expect(job.status).toBe("HELD");
    expect(job.lastError).toContain("STALE_PREVIEW");
    expect(
      api.request.mock.calls.filter((c) => String(c[1]).includes("mutation")),
    ).toHaveLength(0);
  });
  it("stops before mutation when cancellation arrives during the final remote preflight", async () => {
    const f = await pairFixture();
    process.env.SYNC_WRITE_ENABLED = "true";
    const handler = liveApi(f);
    let cancelled = false;
    api.request.mockImplementation(
      async (shop: string, doc: string, vars: Record<string, unknown> = {}) => {
        const ids = vars.ids as string[] | undefined;
        if (
          !cancelled &&
          shop === f.targetShop &&
          doc.includes("SyncPilotResources") &&
          ids?.length === 1 &&
          ids[0] === gid("Product", 200)
        ) {
          cancelled = true;
          await prisma.syncJob.update({
            where: { id: f.job.id },
            data: { status: "CANCELLED", leaseOwner: null, leaseUntil: null },
          });
        }
        return handler(shop, doc, vars);
      },
    );
    await runWorkerOnce(`cancel-during-preflight-${sequence}`);
    expect(cancelled).toBe(true);
    expect(
      (await prisma.syncJob.findUniqueOrThrow({ where: { id: f.job.id } }))
        .status,
    ).toBe("CANCELLED");
    expect(f.target.products[0].title).toBe("Replica title");
    expect(
      api.request.mock.calls.filter((c) => String(c[1]).includes("mutation")),
    ).toHaveLength(0);
  });
  it("rejects cross-tenant import requests before enqueueing any work", async () => {
    const shop = await ownShop(),
      other = await ownShop();
    await expect(
      importCatalog({ shop, userId: "101", role: "OWNER" }, other),
    ).rejects.toMatchObject({ code: "PAIRING_REQUIRED" });
    expect(await prisma.syncJob.count({ where: { sourceShop: other } })).toBe(
      0,
    );
    expect(api.request).not.toHaveBeenCalled();
  });
  it("preview hashes change for a stale imported target even if a delayed webhook carries old data", async () => {
    const f = await pairFixture();
    const original = await buildPreview(f.policy.id);
    await prisma.productSnapshot.update({
      where: {
        shopDomain_productGid: {
          shopDomain: f.targetShop,
          productGid: gid("Product", 200),
        },
      },
      data: { title: "Human destination edit" },
    });
    const current = await buildPreview(f.policy.id);
    expect(current.targetHash).not.toBe(original.targetHash);
    const emptyMaps = { products: [], variants: [], locations: [] };
    expect(
      buildSyncPreview(f.policy, emptyMaps, f.source, f.target).changes.every(
        (c) => c.kind === "HOLD",
      ),
    ).toBe(true);
  });
});
