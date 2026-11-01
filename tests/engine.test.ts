import { describe, expect, it } from "vitest";
import {
  assertCurrentPlan,
  bufferedQuantity,
  buildSyncPreview,
  globalWritesEnabled,
  money,
  mutationErrors,
  retryDelay,
  stableHash,
  type CatalogRecords,
  type Mappings,
  type PolicyRecord,
} from "../app/domain/sync";

function fixture() {
  const source: CatalogRecords = {
    currency: "USD",
    products: [
      {
        id: "p1",
        title: "Source café",
        descriptionHtml: "<p>বাংলা</p>",
        status: "ACTIVE",
        handle: "source",
        vendor: "Vendor",
        productType: "Type",
        tags: ["one", "two"],
      },
    ],
    variants: [
      {
        id: "v1",
        product: { id: "p1" },
        sku: "SKU",
        barcode: "0123",
        price: "12.00",
        compareAtPrice: null,
        selectedOptions: [{ name: "Size", value: "M" }],
        inventoryItem: { id: "i1", tracked: true },
      },
    ],
    locations: [{ id: "l1", name: "Source location", isActive: true }],
    inventory: [{ inventoryItemGid: "i1", locationGid: "l1", quantity: 10 }],
  };
  const target: CatalogRecords = {
    currency: "USD",
    products: [
      { ...source.products[0], id: "p2", title: "Target", handle: "target" },
    ],
    variants: [
      {
        ...source.variants[0],
        id: "v2",
        product: { id: "p2" },
        price: "9.00",
        inventoryItem: { id: "i2", tracked: true },
      },
    ],
    locations: [{ id: "l2", name: "Target location", isActive: true }],
    inventory: [{ inventoryItemGid: "i2", locationGid: "l2", quantity: 3 }],
  };
  const maps: Mappings = {
    products: [
      {
        sourceProductGid: "p1",
        targetProductGid: "p2",
        verifiedAt: new Date(),
      },
    ],
    variants: [
      {
        sourceVariantGid: "v1",
        targetVariantGid: "v2",
        sourceInventoryGid: "i1",
        targetInventoryGid: "i2",
        verifiedAt: new Date(),
      },
    ],
    locations: [
      {
        sourceLocationGid: "l1",
        targetLocationGid: "l2",
        verifiedAt: new Date(),
      },
    ],
  };
  const policy: PolicyRecord = {
    sourceShopDomain: "a.myshopify.com",
    targetShopDomain: "b.myshopify.com",
    direction: "ONE_WAY",
    fields: ["title", "descriptionHtml", "price"],
    syncProduct: true,
    syncPrices: true,
    syncInventory: true,
    inventoryMode: "SOURCE",
    inventoryAuthority: "a.myshopify.com",
    buffer: 2,
    allowNegative: false,
  };
  return { source, target, maps, policy };
}
describe("sync plans and stock invariants", () => {
  it("produces only explicitly selected fields and per-location inventory with expected quantity", () => {
    const f = fixture();
    const plan = buildSyncPreview(f.policy, f.maps, f.source, f.target);
    expect(plan.changes).toEqual([
      {
        kind: "PRODUCT",
        sourceId: "p1",
        targetId: "p2",
        field: "title",
        before: "Target",
        after: "Source café",
      },
      {
        kind: "PRICE",
        sourceId: "v1",
        targetId: "v2",
        sourceProductId: "p1",
        targetProductId: "p2",
        field: "price",
        before: "9",
        after: "12",
      },
      {
        kind: "INVENTORY",
        sourceId: "i1",
        targetId: "i2",
        sourceLocationId: "l1",
        targetLocationId: "l2",
        field: "available",
        before: 3,
        after: 8,
      },
    ]);
    expect(plan.changes.some((c) => c.field === "handle")).toBe(false);
  });
  it("never resolves identity using a duplicate or missing SKU", () => {
    const f = fixture();
    f.maps.products = [];
    f.maps.variants = [];
    f.target.variants.push({ ...f.target.variants[0], id: "duplicate" });
    const plan = buildSyncPreview(f.policy, f.maps, f.source, f.target);
    expect(plan.changes.every((c) => c.kind === "HOLD")).toBe(true);
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MAPPING_MISSING" }),
      ]),
    );
  });
  it("quarantines an unverified mapping and a remapped variant parent", () => {
    const f = fixture();
    f.maps.products[0].verifiedAt = null;
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MAPPING_MISSING" }),
        expect.objectContaining({ code: "VARIANT_MISMATCH" }),
      ]),
    );
    f.maps.products[0].verifiedAt = new Date();
    f.target.variants[0].product.id = "wrong-parent";
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes.some(
        (c) => c.code === "VARIANT_MISMATCH",
      ),
    ).toBe(true);
  });
  it("holds deletions and archival instead of propagating a destructive lifecycle change", () => {
    const f = fixture();
    f.source.products[0].status = "ARCHIVED";
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DESTRUCTIVE_CHANGE" }),
      ]),
    );
    f.source.products = [];
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PRODUCT_NOT_FOUND" }),
      ]),
    );
  });
  it("refuses price transfer across currencies and preserves independent currency fields", () => {
    const f = fixture();
    f.target.currency = "BDT";
    const plan = buildSyncPreview(f.policy, f.maps, f.source, f.target);
    expect(plan.changes.some((c) => c.code === "CURRENCY_MISMATCH")).toBe(true);
    expect(plan.changes.some((c) => c.kind === "PRICE")).toBe(false);
  });
  it("compares only selected price fields and normalizes decimal formatting", () => {
    const f = fixture();
    f.policy.fields = ["compareAtPrice"];
    f.policy.syncProduct = false;
    f.policy.syncInventory = false;
    f.source.variants[0].compareAtPrice = "20.000";
    f.target.variants[0].compareAtPrice = "20.0";
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes,
    ).toEqual([]);
    expect(money("0012.3000")).toBe("0012.3");
    expect(() => money("NaN")).toThrow();
  });
  it("holds untracked items, inactive locations and absent stocking instead of activating them", () => {
    const f = fixture();
    f.target.variants[0].inventoryItem!.tracked = false;
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes.some(
        (c) => c.code === "NOT_TRACKED",
      ),
    ).toBe(true);
    f.target.variants[0].inventoryItem!.tracked = true;
    f.target.locations[0].isActive = false;
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes.some(
        (c) => c.code === "LOCATION_MISSING",
      ),
    ).toBe(true);
    f.target.locations[0].isActive = true;
    f.target.inventory = [];
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes.some(
        (c) => c.code === "LOCATION_MISSING",
      ),
    ).toBe(true);
  });
  it("rejects naive shared-pool or bidirectional inventory authority", () => {
    const f = fixture();
    f.policy.inventoryMode = "SHARED_POOL";
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes.some(
        (c) => c.code === "INVENTORY_AUTHORITY",
      ),
    ).toBe(true);
    f.policy.inventoryMode = "SOURCE";
    f.policy.inventoryAuthority = f.policy.targetShopDomain;
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes.some(
        (c) => c.code === "INVENTORY_AUTHORITY",
      ),
    ).toBe(true);
    f.policy.direction = "TWO_WAY";
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes.some(
        (c) => c.code === "CONFLICTING_OWNERSHIP",
      ),
    ).toBe(true);
  });
  it("floors buffered stock at zero unless backorders are explicitly allowed", () => {
    expect(bufferedQuantity(1, 5, false)).toBe(0);
    expect(bufferedQuantity(1, 5, true)).toBe(-4);
    expect(() => bufferedQuantity(1, -1, false)).toThrow();
    expect(() => bufferedQuantity(1.5, 0, false)).toThrow();
  });
  it("detects changed selected source, target or policy values regardless of webhook arrival order", () => {
    const f = fixture();
    const original = buildSyncPreview(f.policy, f.maps, f.source, f.target);
    f.source.products[0].title = "Latest current value";
    const changed = buildSyncPreview(f.policy, f.maps, f.source, f.target);
    expect(() => assertCurrentPlan(original, changed)).toThrow();
    expect(changed.changes.find((c) => c.field === "title")?.after).toBe(
      "Latest current value",
    );
    expect(() =>
      assertCurrentPlan(
        changed,
        buildSyncPreview(
          { ...f.policy, buffer: 3 },
          f.maps,
          f.source,
          f.target,
        ),
      ),
    ).toThrow();
  });
  it("invalidates approval when mapped variant option identity changes", () => {
    const f = fixture();
    const original = buildSyncPreview(f.policy, f.maps, f.source, f.target);
    f.source.variants[0].selectedOptions = [{ name: "Size", value: "XL" }];
    const changed = buildSyncPreview(f.policy, f.maps, f.source, f.target);
    expect(changed.sourceHash).not.toBe(original.sourceHash);
    expect(() => assertCurrentPlan(original, changed)).toThrow();
  });
  it("keeps verified GID mappings through a SKU rename while requiring a fresh approval", () => {
    const f = fixture();
    const original = buildSyncPreview(f.policy, f.maps, f.source, f.target);
    f.source.variants[0].sku = "RENAMED-SKU";
    const changed = buildSyncPreview(f.policy, f.maps, f.source, f.target);
    expect(changed.sourceHash).not.toBe(original.sourceHash);
    expect(
      changed.changes.some(
        (c) => c.code === "MAPPING_MISSING" || c.code === "VARIANT_MISMATCH",
      ),
    ).toBe(false);
    expect(f.maps.variants[0].sourceVariantGid).toBe("v1");
  });
  it("is deterministic across object order and complete tag ordering", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
    const f = fixture();
    f.policy.fields = ["tags"];
    f.policy.syncPrices = false;
    f.policy.syncInventory = false;
    f.target.products[0].tags.reverse();
    expect(
      buildSyncPreview(f.policy, f.maps, f.source, f.target).changes,
    ).toEqual([]);
  });
  it("classifies CAS user errors and missing mutation results as holds", () => {
    expect(() =>
      mutationErrors({
        userErrors: [
          {
            code: "CHANGE_FROM_QUANTITY_STALE",
            message: "Quantity does not match",
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "STALE_QUANTITY" }));
    expect(() => mutationErrors(null)).toThrow(
      expect.objectContaining({ uncertain: true }),
    );
    expect(() => mutationErrors({})).toThrow(
      expect.objectContaining({ uncertain: true }),
    );
    expect(() => mutationErrors({ userErrors: [] })).not.toThrow();
  });
  it("requires both explicit inventory release flags and bounds exponential retry delays", () => {
    expect(globalWritesEnabled(false, {})).toBe(false);
    expect(globalWritesEnabled(true, { SYNC_WRITE_ENABLED: "true" })).toBe(
      false,
    );
    expect(
      globalWritesEnabled(true, {
        SYNC_WRITE_ENABLED: "true",
        INVENTORY_WRITE_ENABLED: "true",
      }),
    ).toBe(true);
    expect(globalWritesEnabled(false, { SYNC_WRITE_ENABLED: "TRUE" })).toBe(
      false,
    );
    expect(retryDelay(1, 0)).toBe(1000);
    expect(retryDelay(30, 1)).toBe(301000);
  });
});
