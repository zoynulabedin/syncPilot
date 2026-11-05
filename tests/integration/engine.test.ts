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
  scheduleReconciliations,
} from "../../app/services/sync-engine.server";
import { recordVerifiedWebhook } from "../../app/services/webhook-inbox.server";
import {
  HOUR,
  MINUTE,
  SECOND,
  SKEWS,
  fromDatabase,
  remaining,
  restoreProcessClock,
  skewProcessClock,
} from "./clock-skew";

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
  describe("which rows a finished import keeps", () => {
    const counts = async (shop: string) => ({
      products: await prisma.productSnapshot.count({
        where: { shopDomain: shop },
      }),
      variants: await prisma.variantSnapshot.count({
        where: { shopDomain: shop },
      }),
      locations: await prisma.locationSnapshot.count({
        where: { shopDomain: shop },
      }),
      inventory: await prisma.inventorySnapshot.count({
        where: { shopDomain: shop },
      }),
    });
    const fixtureCatalog = () => ({
      products: [product(1), product(2)],
      variants: [variant(11, 1, true), variant(12, 2, true)],
    });
    const everything = { products: 2, variants: 2, locations: 1, inventory: 2 };
    afterEach(restoreProcessClock);

    it.each(SKEWS)(
      "keeps every row it wrote with the worker's clock an hour %s the database's",
      async (_, direction) => {
        const shop = await ownShop();
        const { products, variants } = fixtureCatalog();
        api.request.mockImplementation(catalogApi(products, variants));
        const snapshot = await prisma.catalogSnapshot.create({
          data: { shopDomain: shop, status: "QUEUED" },
        });
        skewProcessClock(direction * HOUR);
        await executeCatalogImport(snapshot.id, shop);
        expect(await counts(shop)).toEqual(everything);
        expect(
          await prisma.catalogSnapshot.findUniqueOrThrow({
            where: { id: snapshot.id },
          }),
        ).toMatchObject({
          status: "COMPLETED",
          products: 2,
          variants: 2,
          locations: 1,
        });
      },
    );
    it.each(SKEWS)(
      "keeps every row it wrote when the clock that queued it ran an hour %s the worker's",
      async (_, direction) => {
        const shop = await ownShop();
        const { products, variants } = fixtureCatalog();
        api.request.mockImplementation(catalogApi(products, variants));
        const snapshot = await prisma.catalogSnapshot.create({
          data: {
            shopDomain: shop,
            status: "QUEUED",
            startedAt: await fromDatabase(direction * HOUR),
          },
        });
        await executeCatalogImport(snapshot.id, shop);
        expect(await counts(shop)).toEqual(everything);
      },
    );
    it.each(SKEWS)(
      "removes what the store no longer has when its last import's clock ran an hour %s",
      async (_, direction) => {
        const shop = await ownShop();
        const { products, variants } = fixtureCatalog();
        api.request.mockImplementation(catalogApi(products, variants));
        const first = await prisma.catalogSnapshot.create({
          data: { shopDomain: shop, status: "QUEUED" },
        });
        await executeCatalogImport(first.id, shop);
        // The earlier import's worker stamped these from a clock that differed.
        const stamped = { observedAt: await fromDatabase(direction * HOUR) };
        const where = { where: { shopDomain: shop }, data: stamped };
        await prisma.productSnapshot.updateMany(where);
        await prisma.variantSnapshot.updateMany(where);
        await prisma.locationSnapshot.updateMany(where);
        await prisma.inventorySnapshot.updateMany(where);
        api.request.mockImplementation(
          catalogApi(products.slice(0, 1), variants.slice(0, 1)),
        );
        const second = await prisma.catalogSnapshot.create({
          data: { shopDomain: shop, status: "QUEUED" },
        });
        await executeCatalogImport(second.id, shop);
        expect(await counts(shop)).toEqual({
          products: 1,
          variants: 1,
          locations: 1,
          inventory: 1,
        });
      },
    );
    it("deletes nothing for an import that began before rows carried a generation, and the next import finishes the job", async () => {
      const shop = await ownShop();
      const { products, variants } = fixtureCatalog();
      api.request.mockImplementation(catalogApi(products, variants));
      await prisma.productSnapshot.create({
        data: {
          shopDomain: shop,
          productGid: gid("Product", 999),
          title: "Removed from the store",
          status: "ACTIVE",
          handle: "removed",
          data: {},
          hash: "synthetic",
        },
      });
      const running = await prisma.catalogSnapshot.create({
        data: { shopDomain: shop, status: "RUNNING", generation: 0 },
      });
      await executeCatalogImport(running.id, shop);
      expect((await counts(shop)).products).toBe(3);
      const next = await prisma.catalogSnapshot.create({
        data: { shopDomain: shop, status: "QUEUED" },
      });
      await executeCatalogImport(next.id, shop);
      expect((await counts(shop)).products).toBe(2);
    });
    it("keeps what an older import wrote after a newer one began, when both resume", async () => {
      // A retry waits while a webhook's import runs for the same store, so two
      // imports can take turns. Neither may delete what the other just saw.
      const shop = await ownShop();
      const products = Array.from({ length: 150 }, (_, i) => product(100 + i));
      const handler = catalogApi(products);
      const failAfter = (pages: number) => {
        let served = 0;
        api.request.mockImplementation(
          async (s: string, doc: string, vars: Record<string, unknown>) => {
            if (doc.includes("SyncPilotProducts") && served++ >= pages)
              throw new SyncError("NETWORK_TIMEOUT", "Synthetic timeout", true);
            return handler(s, doc, vars);
          },
        );
      };
      const older = await prisma.catalogSnapshot.create({
        data: { shopDomain: shop, status: "QUEUED" },
      });
      const newer = await prisma.catalogSnapshot.create({
        data: { shopDomain: shop, status: "QUEUED" },
      });
      failAfter(0);
      await expect(executeCatalogImport(older.id, shop)).rejects.toBeDefined();
      failAfter(1);
      await expect(executeCatalogImport(newer.id, shop)).rejects.toBeDefined();
      api.request.mockImplementation(handler);
      // The older one rewrites the page the newer one already passed.
      await executeCatalogImport(older.id, shop);
      await executeCatalogImport(newer.id, shop);
      expect(
        await prisma.productSnapshot.count({ where: { shopDomain: shop } }),
      ).toBe(150);
    });
  });
  describe.each(SKEWS)(
    "with the worker's clock an hour %s the database's",
    (_, direction) => {
      beforeEach(() => skewProcessClock(direction * HOUR));
      afterEach(async () => {
        restoreProcessClock();
        // A later file's worker claims globally.
        await prisma.syncJob.updateMany({
          where: { status: { in: ["PENDING", "RETRY", "RUNNING"] } },
          data: { status: "CANCELLED", leaseOwner: null, leaseUntil: null },
        });
      });
      const job = (id: string) =>
        prisma.syncJob.findUniqueOrThrow({ where: { id } });

      it("holds a claimed lease for its full term and reports a current heartbeat", async () => {
        const shop = await ownShop();
        const { job: claimed } = await catalogJob(shop);
        const handler = catalogApi();
        const seen: number[] = [];
        api.request.mockImplementation(
          async (s: string, doc: string, vars: Record<string, unknown>) => {
            seen.push(await remaining((await job(claimed.id)).leaseUntil));
            return handler(s, doc, vars);
          },
        );
        const worker = `skew-lease-${sequence}-${direction}`;
        await runWorkerOnce(worker);
        expect((await job(claimed.id)).status).toBe("SUCCEEDED");
        expect(seen.length).toBeGreaterThan(1);
        for (const left of seen) {
          expect(left).toBeGreaterThan(MINUTE);
          expect(left).toBeLessThanOrEqual(2 * MINUTE);
        }
        const heartbeat = await prisma.workerHeartbeat.findUniqueOrThrow({
          where: { id: worker },
        });
        expect(Math.abs(await remaining(heartbeat.seenAt))).toBeLessThan(
          10 * SECOND,
        );
      });
      it("leaves another worker's lease alone, and its store's queue with it", async () => {
        const shop = await ownShop();
        const { job: running } = await catalogJob(shop, {
          status: "RUNNING",
          attempts: 1,
          leaseOwner: "live-worker",
          leaseUntil: await fromDatabase(MINUTE),
        });
        const { job: waiting } = await catalogJob(shop);
        await prisma.syncAttempt.create({
          data: { jobId: running.id, attempt: 1, status: "RUNNING" },
        });
        expect(await runWorkerOnce(`skew-live-${sequence}`)).toEqual({
          processed: false,
        });
        expect(await job(running.id)).toMatchObject({
          status: "RUNNING",
          leaseOwner: "live-worker",
        });
        expect((await job(waiting.id)).status).toBe("PENDING");
      });
      it("does not hold a write that another worker is still making", async () => {
        const f = await pairFixture();
        await prisma.syncJob.update({
          where: { id: f.job.id },
          data: {
            status: "RUNNING",
            attempts: 1,
            leaseOwner: "live-writer",
            leaseUntil: await fromDatabase(MINUTE),
          },
        });
        await runWorkerOnce(`skew-writer-${sequence}`);
        expect((await job(f.job.id)).status).toBe("RUNNING");
        expect(
          (
            await prisma.syncPreview.findUniqueOrThrow({
              where: { id: f.preview.id },
            })
          ).status,
        ).toBe("APPROVED");
        expect(
          await prisma.syncConflict.count({ where: { jobId: f.job.id } }),
        ).toBe(0);
      });
      it("recovers a lease once it has run out", async () => {
        const shop = await ownShop();
        const { job: abandoned } = await catalogJob(shop, {
          status: "RUNNING",
          attempts: 1,
          leaseOwner: "dead-worker",
          leaseUntil: await fromDatabase(-SECOND),
        });
        await prisma.syncAttempt.create({
          data: { jobId: abandoned.id, attempt: 1, status: "RUNNING" },
        });
        await runWorkerOnce(`skew-dead-${sequence}`);
        expect((await job(abandoned.id)).leaseOwner).not.toBe("dead-worker");
        expect(
          (
            await prisma.syncAttempt.findUniqueOrThrow({
              where: { jobId_attempt: { jobId: abandoned.id, attempt: 1 } },
            })
          ).status,
        ).toBe("INTERRUPTED");
      });
      it("waits out a retry delay, and no longer", async () => {
        const shop = await ownShop();
        const { job: failing } = await catalogJob(shop);
        api.request.mockRejectedValue(
          new SyncError("NETWORK_TIMEOUT", "Synthetic timeout", true),
        );
        await runWorkerOnce(`skew-retry-${sequence}`);
        const retried = await job(failing.id);
        expect(retried.status).toBe("RETRY");
        const delay = await remaining(retried.availableAt);
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(2 * SECOND);
      });
      it("applies an approved plan that is still valid", async () => {
        const f = await pairFixture();
        await prisma.syncPreview.update({
          where: { id: f.preview.id },
          data: { expiresAt: await fromDatabase(10 * MINUTE) },
        });
        process.env.SYNC_WRITE_ENABLED = "true";
        api.request.mockImplementation(liveApi(f));
        await runWorkerOnce(`skew-apply-${sequence}`);
        expect((await job(f.job.id)).status).toBe("SUCCEEDED");
        expect(f.target.products[0].title).toBe("Master title");
      });
      it("refuses an approved plan that has expired, before any write", async () => {
        const f = await pairFixture();
        await prisma.syncPreview.update({
          where: { id: f.preview.id },
          data: { expiresAt: await fromDatabase(-MINUTE) },
        });
        process.env.SYNC_WRITE_ENABLED = "true";
        api.request.mockImplementation(liveApi(f));
        await runWorkerOnce(`skew-expired-${sequence}`);
        expect((await job(f.job.id)).lastError).toContain("APPROVAL_REQUIRED");
        expect(f.target.products[0].title).toBe("Replica title");
      });
      it("expires a waiting plan when its window ends, and not before", async () => {
        const f = await pairFixture();
        const plan = (expiresAt: Date) =>
          prisma.syncPreview.create({
            data: {
              workspaceId: f.workspace.id,
              policyId: f.policy.id,
              createdBy: "system",
              sourceHash: "source",
              targetHash: "target",
              changes: [],
              expiresAt,
            },
          });
        const live = await plan(await fromDatabase(10 * MINUTE));
        const lapsed = await plan(await fromDatabase(-MINUTE));
        await scheduleReconciliations();
        const status = async (id: string) =>
          (await prisma.syncPreview.findUniqueOrThrow({ where: { id } }))
            .status;
        expect(await status(live.id)).toBe("PENDING");
        expect(await status(lapsed.id)).toBe("EXPIRED");
      });
      it("gives a comparison's plan its full 15 minutes", async () => {
        const f = await pairFixture();
        await prisma.syncJob.update({
          where: { id: f.job.id },
          data: { status: "CANCELLED" },
        });
        await prisma.syncJob.create({
          data: {
            workspaceId: f.workspace.id,
            policyId: f.policy.id,
            sourceShop: f.sourceShop,
            targetShop: f.targetShop,
            operation: "RECONCILE",
            availableAt: new Date("2000-01-01"),
          },
        });
        api.request.mockImplementation(liveApi(f));
        await runWorkerOnce(`skew-compare-${sequence}`);
        const plan = await prisma.syncPreview.findFirstOrThrow({
          where: { policyId: f.policy.id, status: "PENDING" },
        });
        const left = await remaining(plan.expiresAt);
        expect(left).toBeGreaterThan(14 * MINUTE);
        expect(left).toBeLessThanOrEqual(15 * MINUTE);
      });
    },
  );
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
  describe("webhook events and the comparisons they queue", () => {
    const eventFixture = async () => {
      const f = await pairFixture();
      // Only the deliveries under test should be claimable.
      await prisma.syncJob.update({
        where: { id: f.job.id },
        data: { status: "CANCELLED" },
      });
      const live = liveApi(f);
      const handler = async (
        shop: string,
        doc: string,
        variables: Record<string, unknown> = {},
      ) => {
        const catalog = shop === f.sourceShop ? f.source : f.target;
        return /SyncPilot(Products|Variants|Locations|InventoryLevels)\b/.test(
          doc,
        )
          ? catalogApi(catalog.products, catalog.variants)(shop, doc, variables)
          : live(shop, doc, variables);
      };
      api.request.mockImplementation(handler);
      return { ...f, handler };
    };
    const deliver = (
      shop: string,
      topic: string,
      resourceId: string,
      id = `${topic}-${++sequence}`,
    ) =>
      recordVerifiedWebhook(
        new Request("https://fixture.invalid", {
          headers: { "x-shopify-webhook-id": id },
        }),
        shop,
        topic,
        resourceId,
      );
    const event = (id: string) =>
      prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    const comparisons = (policyId: string) =>
      prisma.syncJob.findMany({
        where: { policyId, operation: "RECONCILE" },
        orderBy: { createdAt: "asc" },
      });
    /** Claims and runs every job that is currently due. */
    async function drain() {
      for (let i = 0; i < 25; i++) {
        await dispatchInbox();
        const result = await runWorkerOnce(`event-worker-${sequence}`);
        if (!result.processed) return;
      }
      throw new Error("The queue did not drain");
    }

    it("leaves a processed event alone when the comparison it queued fails, and through the retry", async () => {
      const f = await eventFixture();
      const delivered = await deliver(f.sourceShop, "PRODUCTS_UPDATE", "100");
      const throttled = async (
        shop: string,
        doc: string,
        variables?: Record<string, unknown>,
      ) => {
        if (doc.includes("SyncPilotResources"))
          throw new SyncError("THROTTLED", "Slow down.", true);
        return f.handler(shop, doc, variables);
      };
      api.request.mockImplementation(throttled);
      await dispatchInbox();
      await runWorkerOnce("event-worker");
      expect(await event(delivered.id)).toMatchObject({
        status: "PROCESSED",
        lastError: null,
      });
      await runWorkerOnce("event-worker");
      const [comparison] = await comparisons(f.policy.id);
      expect(comparison).toMatchObject({
        status: "RETRY",
        eventId: delivered.id,
      });
      expect(await event(delivered.id)).toMatchObject({
        status: "PROCESSED",
        lastError: null,
      });
      // The retry succeeds and nothing has to restore the event.
      api.request.mockImplementation(f.handler);
      await prisma.syncJob.update({
        where: { id: comparison.id },
        data: { availableAt: new Date("2000-01-01") },
      });
      await runWorkerOnce("event-worker");
      expect(
        (
          await prisma.syncJob.findUniqueOrThrow({
            where: { id: comparison.id },
          })
        ).status,
      ).toBe("SUCCEEDED");
      expect((await event(delivered.id)).status).toBe("PROCESSED");
      // A comparison that dead-letters does not mark the import failed either.
      api.request.mockImplementation(async (shop, doc, variables) => {
        if (doc.includes("SyncPilotResources"))
          throw new SyncError("AUTH_FAILURE", "Reconnect the store.");
        return f.handler(shop, doc, variables);
      });
      const second = await deliver(f.sourceShop, "PRODUCTS_UPDATE", "100");
      await drain();
      const latest = (await comparisons(f.policy.id)).at(-1)!;
      expect(latest).toMatchObject({
        status: "DEAD_LETTER",
        eventId: second.id,
      });
      expect(await event(second.id)).toMatchObject({
        status: "PROCESSED",
        lastError: null,
      });
    });

    it("still reports a failed refresh on its event, and clears it when a retry succeeds", async () => {
      const f = await eventFixture();
      const delivered = await deliver(f.sourceShop, "PRODUCTS_UPDATE", "100");
      api.request.mockImplementation(async (shop, doc, variables) => {
        if (doc.includes("SyncPilotProducts"))
          throw new SyncError("THROTTLED", "Slow down.", true);
        return f.handler(shop, doc, variables);
      });
      await dispatchInbox();
      await runWorkerOnce("event-worker");
      expect(await event(delivered.id)).toMatchObject({
        status: "DISPATCHED",
        lastError: "THROTTLED: Slow down.",
      });
      api.request.mockImplementation(f.handler);
      await prisma.syncJob.updateMany({
        where: { eventId: delivered.id, operation: "WEBHOOK_REFRESH" },
        data: { availableAt: new Date("2000-01-01") },
      });
      await runWorkerOnce("event-worker");
      expect(await event(delivered.id)).toMatchObject({
        status: "PROCESSED",
        lastError: null,
      });
    });

    it("compares a destination edit on a mapped product against the source, and only reports it", async () => {
      const f = await eventFixture();
      await deliver(f.targetShop, "PRODUCTS_UPDATE", "200");
      await drain();
      const [comparison] = await comparisons(f.policy.id);
      expect(comparison).toMatchObject({
        status: "SUCCEEDED",
        sourceShop: f.sourceShop,
        targetShop: f.targetShop,
      });
      const run = await prisma.reconciliationRun.findFirstOrThrow({
        where: { policyId: f.policy.id },
        orderBy: { startedAt: "desc" },
      });
      expect(run).toMatchObject({ status: "COMPLETED", drifted: 1 });
      expect(
        await prisma.syncPreview.count({
          where: {
            policyId: f.policy.id,
            status: "PENDING",
            createdBy: "system",
          },
        }),
      ).toBe(1);
      for (const [, doc] of api.request.mock.calls)
        expect(String(doc)).not.toMatch(/mutation/);
    });

    it("finds nothing to report when the destination event is the app's own write", async () => {
      const f = await eventFixture();
      f.target.products[0].title = f.source.products[0].title;
      await deliver(f.targetShop, "PRODUCTS_UPDATE", "200");
      await drain();
      const run = await prisma.reconciliationRun.findFirstOrThrow({
        where: { policyId: f.policy.id },
        orderBy: { startedAt: "desc" },
      });
      expect(run).toMatchObject({ status: "COMPLETED", total: 0, drifted: 0 });
      expect(
        await prisma.syncPreview.count({
          where: { policyId: f.policy.id, createdBy: "system" },
        }),
      ).toBe(0);
    });

    it("skips destination events that cannot change what the policy owns", async () => {
      const f = await eventFixture();
      await deliver(f.targetShop, "PRODUCTS_UPDATE", "999");
      // This policy does not sync stock.
      await deliver(f.targetShop, "INVENTORY_LEVELS_UPDATE", "210");
      await drain();
      expect(await comparisons(f.policy.id)).toHaveLength(0);
      await prisma.syncPolicy.update({
        where: { id: f.policy.id },
        data: { syncInventory: true },
      });
      await deliver(f.targetShop, "INVENTORY_LEVELS_UPDATE", "999");
      await drain();
      expect(await comparisons(f.policy.id)).toHaveLength(0);
      await deliver(f.targetShop, "INVENTORY_LEVELS_UPDATE", "210");
      await drain();
      expect(await comparisons(f.policy.id)).toHaveLength(1);
    });

    it("keeps one comparison waiting per policy, because it reads live state when it runs", async () => {
      const f = await eventFixture();
      for (let i = 0; i < 3; i++)
        await deliver(f.sourceShop, "PRODUCTS_UPDATE", "100");
      await dispatchInbox();
      // Only the refresh jobs run; the comparison they queue stays waiting.
      await prisma.syncJob.updateMany({
        where: { operation: "RECONCILE" },
        data: { availableAt: new Date(Date.now() + 60_000) },
      });
      for (let i = 0; i < 3; i++) {
        await runWorkerOnce("event-worker");
        await prisma.syncJob.updateMany({
          where: { operation: "RECONCILE", status: "PENDING" },
          data: { availableAt: new Date(Date.now() + 60_000) },
        });
      }
      const waiting = await comparisons(f.policy.id);
      expect(waiting).toHaveLength(1);
      expect(waiting[0].status).toBe("PENDING");
      // Once it has started, the next change needs its own comparison.
      await prisma.syncJob.update({
        where: { id: waiting[0].id },
        data: { availableAt: new Date("2000-01-01") },
      });
      await runWorkerOnce("event-worker");
      await deliver(f.sourceShop, "PRODUCTS_UPDATE", "100");
      await drain();
      expect(await comparisons(f.policy.id)).toHaveLength(2);
    });

    it("stores the merchant-action correlation with the receipt", async () => {
      const shop = await ownShop();
      const triggeredAt = new Date("2026-03-30T14:30:00.000Z");
      const stored = await recordVerifiedWebhook(
        new Request("https://fixture.invalid", {
          headers: { "x-shopify-webhook-id": `correlated-${sequence}` },
        }),
        shop,
        "PRODUCTS_UPDATE",
        "100",
        { eventId: "merchant-action-1", triggeredAt },
      );
      expect(stored).toMatchObject({
        eventId: "merchant-action-1",
        triggeredAt,
      });
    });
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
