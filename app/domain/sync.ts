import { createHash } from "node:crypto";

export const PRODUCT_FIELDS = [
  "title",
  "descriptionHtml",
  "vendor",
  "productType",
  "handle",
  "tags",
  "status",
  "seoTitle",
  "seoDescription",
] as const;
export const VARIANT_FIELDS = ["sku", "taxable", "inventoryPolicy"] as const;
export type ProductField = (typeof PRODUCT_FIELDS)[number];
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type ProductRecord = {
  id: string;
  title: string;
  status: string;
  handle: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  updatedAt?: string;
  seo?: { title: string | null; description: string | null };
};
export type VariantRecord = {
  id: string;
  product: { id: string };
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  selectedOptions: { name: string; value: string }[];
  inventoryItem: { id: string; tracked: boolean } | null;
  taxable?: boolean;
  inventoryPolicy?: "DENY" | "CONTINUE";
};
export type LocationRecord = { id: string; name: string; isActive: boolean };
export type LevelRecord = {
  inventoryItemGid: string;
  locationGid: string;
  quantity: number;
};
export type CatalogRecords = {
  currency: string | null;
  products: ProductRecord[];
  variants: VariantRecord[];
  locations: LocationRecord[];
  inventory: LevelRecord[];
};
export type PolicyRecord = {
  fields: string[];
  syncProduct: boolean;
  syncPrices: boolean;
  syncVariants?: boolean;
  syncInventory: boolean;
  sourceShopDomain: string;
  targetShopDomain: string;
  direction: string;
  inventoryMode: string;
  inventoryAuthority: string | null;
  buffer: number;
  allowNegative: boolean;
};
export type Mappings = {
  products: {
    sourceProductGid: string;
    targetProductGid: string;
    verifiedAt: Date | null;
  }[];
  variants: {
    sourceVariantGid: string;
    targetVariantGid: string;
    sourceInventoryGid: string | null;
    targetInventoryGid: string | null;
    verifiedAt: Date | null;
  }[];
  locations: {
    sourceLocationGid: string;
    targetLocationGid: string;
    verifiedAt: Date | null;
  }[];
};
export type SyncChange = {
  kind: "PRODUCT" | "PRICE" | "VARIANT" | "INVENTORY" | "HOLD";
  sourceId: string;
  targetId?: string;
  field?: string;
  before?: Json;
  after?: Json;
  sourceProductId?: string;
  targetProductId?: string;
  sourceLocationId?: string;
  targetLocationId?: string;
  code?: string;
  message?: string;
};

export class SyncError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public uncertain = false,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}
export function stableHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function sameValue(left: unknown, right: unknown) {
  return stableHash(left ?? null) === stableHash(right ?? null);
}
export function selectedValue(
  record: ProductRecord | VariantRecord,
  field: string,
): Json | undefined {
  if (field === "seoTitle" || field === "seoDescription") {
    const seo = (record as ProductRecord).seo;
    return seo
      ? (seo[field === "seoTitle" ? "title" : "description"] ?? "")
      : undefined;
  }
  if (field === "sku") return (record as VariantRecord).sku ?? "";
  const value = (record as unknown as Record<string, Json | undefined>)[field];
  if (field === "price" || field === "compareAtPrice")
    return money(value as string | null);
  return field === "tags" && Array.isArray(value) ? [...value].sort() : value;
}

/** Only selected fields are sent; omitted SEO subfields and inventory-item fields stay untouched. */
export function targetedFields(
  kind: "PRODUCT" | "PRICE" | "VARIANT",
  changes: SyncChange[],
) {
  const fields: Record<string, Json> = {};
  for (const change of changes) {
    const field = change.field || "";
    const allowed: readonly string[] =
      kind === "PRODUCT"
        ? PRODUCT_FIELDS
        : kind === "PRICE"
          ? ["price", "compareAtPrice"]
          : VARIANT_FIELDS;
    if (!allowed.includes(field) || change.after === undefined)
      throw new SyncError("INVALID_INPUT", "Unsupported targeted field.");
    if (field === "seoTitle" || field === "seoDescription") {
      const seo = (fields.seo || {}) as Record<string, Json>;
      seo[field === "seoTitle" ? "title" : "description"] = change.after;
      fields.seo = seo;
    } else if (field === "sku") fields.inventoryItem = { sku: change.after };
    else fields[field] = change.after;
  }
  return fields;
}
export function money(value: string | null): string | null {
  if (value === null) return null;
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new SyncError("INVALID_PRICE", "Shopify returned an invalid price.");
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
export function bufferedQuantity(
  quantity: number,
  buffer: number,
  allowNegative: boolean,
) {
  if (
    !Number.isSafeInteger(quantity) ||
    !Number.isSafeInteger(buffer) ||
    buffer < 0
  )
    throw new SyncError(
      "INVALID_INPUT",
      "Quantity and safety buffer must be whole numbers.",
    );
  const result = quantity - buffer;
  return allowNegative ? result : Math.max(0, result);
}
export function retryDelay(attempt: number, random = Math.random()) {
  return (
    Math.min(300_000, 1000 * 2 ** Math.max(0, attempt - 1)) +
    Math.floor(Math.max(0, Math.min(random, 1)) * 1000)
  );
}
export function globalWritesEnabled(
  inventory = false,
  env: Record<string, string | undefined> = process.env,
) {
  return (
    env.SYNC_WRITE_ENABLED === "true" &&
    (!inventory || env.INVENTORY_WRITE_ENABLED === "true")
  );
}
export function assertWriteGates(inventory = false) {
  if (!globalWritesEnabled(inventory))
    throw new SyncError(
      "WRITES_DISABLED",
      inventory
        ? "Inventory writes are disabled by the environment release gate."
        : "Shopify writes are disabled by the environment release gate.",
    );
}
export function assertCurrentPlan(
  expected: { sourceHash: string; targetHash: string },
  actual: { sourceHash: string; targetHash: string },
) {
  if (
    expected.sourceHash !== actual.sourceHash ||
    expected.targetHash !== actual.targetHash
  ) {
    throw new SyncError(
      "STALE_PREVIEW",
      "Source or destination changed after preview. Import again and approve a new comparison.",
    );
  }
}
export function mutationErrors(payload: unknown) {
  if (!payload || typeof payload !== "object")
    throw new SyncError(
      "PARTIAL_GRAPHQL_ERROR",
      "Shopify did not return a mutation result.",
      false,
      true,
    );
  const errors = "userErrors" in payload ? payload.userErrors : undefined;
  if (!Array.isArray(errors))
    throw new SyncError(
      "PARTIAL_GRAPHQL_ERROR",
      "Shopify mutation result omitted userErrors.",
      false,
      true,
    );
  if (errors.length) {
    const first = errors[0] as { code?: string; message?: string };
    const stale =
      /QUANTITY|COMPARE|STALE|CHANGE_FROM/i.test(first.code ?? "") ||
      /quantity.*(match|changed)|compare|stale/i.test(first.message ?? "");
    throw new SyncError(
      stale ? "STALE_QUANTITY" : "INVALID_INPUT",
      stale
        ? "Destination quantity changed. Review a fresh comparison before retrying."
        : "Shopify rejected this change. Review the selected fields and resource eligibility.",
    );
  }
}

export function buildSyncPreview(
  policy: PolicyRecord,
  maps: Mappings,
  source: CatalogRecords,
  target: CatalogRecords,
) {
  const changes: SyncChange[] = [];
  const sourceState: Json[] = [];
  const targetState: Json[] = [];
  const hold = (
    code: string,
    message: string,
    sourceId = "policy",
    targetId?: string,
  ) =>
    changes.push({
      kind: "HOLD",
      sourceId,
      ...(targetId ? { targetId } : {}),
      code,
      message,
    });
  if (policy.direction !== "ONE_WAY")
    hold(
      "CONFLICTING_OWNERSHIP",
      "Each policy must have one authoritative direction. Use separate policies with disjoint field ownership.",
    );
  if (
    !policy.syncProduct &&
    !policy.syncPrices &&
    !policy.syncVariants &&
    !policy.syncInventory
  )
    hold("EMPTY_POLICY", "Select at least one supported field group.");
  for (const field of policy.fields)
    if (
      !PRODUCT_FIELDS.includes(field as ProductField) &&
      !(VARIANT_FIELDS as readonly string[]).includes(field) &&
      !["price", "compareAtPrice"].includes(field)
    )
      hold(
        "UNSUPPORTED_FIELD",
        `The ${field} field requires a separately verified adapter.`,
      );
  if (policy.syncProduct && !maps.products.length)
    hold(
      "MAPPING_MISSING",
      "Verify a product mapping before comparing product fields.",
    );
  if (
    (policy.syncPrices || policy.syncVariants || policy.syncInventory) &&
    !maps.variants.length
  )
    hold(
      "MAPPING_MISSING",
      "Verify a variant mapping before comparing prices or stock.",
    );
  const product = (catalog: CatalogRecords, id: string) =>
    catalog.products.find((p) => p.id === id);
  for (const map of [...maps.products].sort((a, b) =>
    a.sourceProductGid.localeCompare(b.sourceProductGid),
  )) {
    if (!policy.syncProduct) continue;
    if (!map.verifiedAt) {
      hold(
        "MAPPING_MISSING",
        "Product mapping needs explicit verification.",
        map.sourceProductGid,
        map.targetProductGid,
      );
      continue;
    }
    const from = product(source, map.sourceProductGid),
      to = product(target, map.targetProductGid);
    if (!from || !to) {
      hold(
        "PRODUCT_NOT_FOUND",
        "A mapped product is missing. Review its identity; deletion is never propagated automatically.",
        map.sourceProductGid,
        map.targetProductGid,
      );
      continue;
    }
    if (from.status === "ARCHIVED") {
      hold(
        "DESTRUCTIVE_CHANGE",
        "An archived source product requires manual lifecycle review.",
        from.id,
        to.id,
      );
      continue;
    }
    const selected = policy.fields.filter((f): f is ProductField =>
      PRODUCT_FIELDS.includes(f as ProductField),
    );
    const sf: Record<string, Json> = { id: from.id },
      tf: Record<string, Json> = { id: to.id };
    for (const field of selected) {
      const left = selectedValue(from, field),
        right = selectedValue(to, field);
      if (left === undefined || right === undefined) {
        hold(
          "IMPORT_REQUIRED",
          "Import both catalogs again to observe the selected field.",
          from.id,
          to.id,
        );
        continue;
      }
      sf[field] = left;
      tf[field] = right;
      if (!sameValue(left, right))
        changes.push({
          kind: "PRODUCT",
          sourceId: from.id,
          targetId: to.id,
          field,
          before: right,
          after: left,
        });
    }
    sourceState.push(sf);
    targetState.push(tf);
  }
  if (
    policy.syncPrices &&
    (!source.currency ||
      !target.currency ||
      source.currency !== target.currency)
  )
    hold(
      "CURRENCY_MISMATCH",
      "Price synchronization requires matching, known shop currencies. No implicit conversion is performed.",
    );
  if (
    policy.syncInventory &&
    (policy.inventoryMode !== "SOURCE" ||
      policy.inventoryAuthority !== policy.sourceShopDomain)
  )
    hold(
      "INVENTORY_AUTHORITY",
      "Inventory requires the source shop as explicit authority. Shared pools, independent pools and two-way mirroring cannot use this writer.",
    );
  if (policy.syncInventory && !maps.locations.length)
    hold(
      "LOCATION_MISSING",
      "Verify a location mapping before comparing inventory.",
    );
  for (const map of [...maps.variants].sort((a, b) =>
    a.sourceVariantGid.localeCompare(b.sourceVariantGid),
  )) {
    if (!policy.syncPrices && !policy.syncVariants && !policy.syncInventory)
      continue;
    const from = source.variants.find((v) => v.id === map.sourceVariantGid),
      to = target.variants.find((v) => v.id === map.targetVariantGid);
    if (!map.verifiedAt || !from || !to) {
      hold(
        "VARIANT_MISMATCH",
        "A verified mapped variant is missing or unverified.",
        map.sourceVariantGid,
        map.targetVariantGid,
      );
      continue;
    }
    const parent = maps.products.find(
      (p) =>
        p.sourceProductGid === from.product.id &&
        p.targetProductGid === to.product.id &&
        p.verifiedAt,
    );
    if (!parent) {
      hold(
        "VARIANT_MISMATCH",
        "Variant mapping must belong to the verified product mapping.",
        from.id,
        to.id,
      );
      continue;
    }
    // GIDs remain the mapping identity. These descriptors fence an existing approval
    // against a changed variant meaning; renaming a SKU does not delete its mapping.
    const normalizedOptions = (variant: VariantRecord) =>
      variant.selectedOptions
        .map(({ name, value }) => ({ name, value }))
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name) || a.value.localeCompare(b.value),
        );
    const sf: Record<string, Json> = {
      id: from.id,
      productId: from.product.id,
      sku: from.sku,
      barcode: from.barcode,
      options: normalizedOptions(from),
    };
    const tf: Record<string, Json> = {
      id: to.id,
      productId: to.product.id,
      sku: to.sku,
      barcode: to.barcode,
      options: normalizedOptions(to),
    };
    if (
      policy.syncPrices &&
      source.currency &&
      source.currency === target.currency
    ) {
      sf.currency = source.currency;
      tf.currency = target.currency;
      for (const field of ["price", "compareAtPrice"] as const) {
        if (!policy.fields.includes(field)) continue;
        const left = money(from[field]),
          right = money(to[field]);
        sf[field] = left;
        tf[field] = right;
        if (left !== right)
          changes.push({
            kind: "PRICE",
            sourceId: from.id,
            targetId: to.id,
            sourceProductId: from.product.id,
            targetProductId: to.product.id,
            field,
            before: right,
            after: left,
          });
      }
    }
    if (policy.syncVariants)
      for (const field of VARIANT_FIELDS) {
        if (!policy.fields.includes(field)) continue;
        const left = selectedValue(from, field),
          right = selectedValue(to, field);
        if (
          left === undefined ||
          right === undefined ||
          (field === "sku" && (!from.inventoryItem || !to.inventoryItem))
        ) {
          hold(
            "IMPORT_REQUIRED",
            "Import both catalogs again to observe the selected variant field and inventory identity.",
            from.id,
            to.id,
          );
          continue;
        }
        sf[field] = left;
        tf[field] = right;
        if (!sameValue(left, right))
          changes.push({
            kind: "VARIANT",
            sourceId: from.id,
            targetId: to.id,
            sourceProductId: from.product.id,
            targetProductId: to.product.id,
            field,
            before: right,
            after: left,
          });
      }
    if (policy.syncInventory) {
      sf.inventoryItemId = from.inventoryItem?.id ?? null;
      tf.inventoryItemId = to.inventoryItem?.id ?? null;
      sf.tracked = from.inventoryItem?.tracked ?? false;
      tf.tracked = to.inventoryItem?.tracked ?? false;
      if (
        !from.inventoryItem?.tracked ||
        !to.inventoryItem?.tracked ||
        from.inventoryItem.id !== map.sourceInventoryGid ||
        to.inventoryItem.id !== map.targetInventoryGid
      ) {
        hold(
          "NOT_TRACKED",
          "Both inventory identities must be verified and tracking enabled; tracking is never activated automatically.",
          from.id,
          to.id,
        );
      } else
        for (const loc of [...maps.locations].sort((a, b) =>
          a.sourceLocationGid.localeCompare(b.sourceLocationGid),
        )) {
          const sourceLocation = source.locations.find(
              (l) => l.id === loc.sourceLocationGid,
            ),
            targetLocation = target.locations.find(
              (l) => l.id === loc.targetLocationGid,
            );
          if (
            !loc.verifiedAt ||
            !sourceLocation?.isActive ||
            !targetLocation?.isActive
          ) {
            hold(
              "LOCATION_MISSING",
              "Both mapped locations must be verified and active.",
              from.id,
              to.id,
            );
            continue;
          }
          const left = source.inventory.find(
            (l) =>
              l.inventoryItemGid === from.inventoryItem?.id &&
              l.locationGid === loc.sourceLocationGid,
          );
          const right = target.inventory.find(
            (l) =>
              l.inventoryItemGid === to.inventoryItem?.id &&
              l.locationGid === loc.targetLocationGid,
          );
          if (!left || !right) {
            hold(
              "LOCATION_MISSING",
              "A mapped inventory item is not stocked at this location. No location activation is performed.",
              from.id,
              to.id,
            );
            continue;
          }
          sf[`quantity:${loc.sourceLocationGid}`] = left.quantity;
          tf[`quantity:${loc.targetLocationGid}`] = right.quantity;
          const desired = bufferedQuantity(
            left.quantity,
            policy.buffer,
            policy.allowNegative,
          );
          if (desired !== right.quantity)
            changes.push({
              kind: "INVENTORY",
              sourceId: from.inventoryItem.id,
              targetId: to.inventoryItem.id,
              sourceLocationId: loc.sourceLocationGid,
              targetLocationId: loc.targetLocationGid,
              field: "available",
              before: right.quantity,
              after: desired,
            });
        }
    }
    sourceState.push(sf);
    targetState.push(tf);
  }
  const config = {
    fields: [...policy.fields].sort(),
    buffer: policy.buffer,
    allowNegative: policy.allowNegative,
    inventoryMode: policy.inventoryMode,
    inventoryAuthority: policy.inventoryAuthority,
    syncProduct: policy.syncProduct,
    syncPrices: policy.syncPrices,
    syncInventory: policy.syncInventory,
    source: policy.sourceShopDomain,
    target: policy.targetShopDomain,
  };
  return {
    sourceHash: stableHash({ config, records: sourceState }),
    targetHash: stableHash({ config, records: targetState }),
    changes,
  };
}
