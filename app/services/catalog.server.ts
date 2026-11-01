import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { normalizeShop } from "../domain/guards";
import {
  stableHash,
  SyncError,
  type ProductRecord,
  type VariantRecord,
} from "../domain/sync";
import {
  SHOP_QUERY,
  PRODUCTS_QUERY,
  VARIANTS_QUERY,
  LOCATIONS_QUERY,
  INVENTORY_QUERY,
} from "../domain/sync-operations";
import {
  currentConnection,
  requireOwner,
  requirePairAccess,
  type Actor,
} from "./authorization.server";
import { shopifyRequest } from "./shopify-client.server";

export const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  handle: z.string(),
  descriptionHtml: z.string(),
  vendor: z.string(),
  productType: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.string(),
  seo: z
    .object({
      title: z.string().nullable(),
      description: z.string().nullable(),
    })
    .optional(),
});
export const variantSchema = z.object({
  id: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  price: z.string(),
  compareAtPrice: z.string().nullable(),
  taxable: z.boolean().optional(),
  inventoryPolicy: z.enum(["DENY", "CONTINUE"]).optional(),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
  product: z.object({ id: z.string() }),
  inventoryItem: z.object({ id: z.string(), tracked: z.boolean() }).nullable(),
});
const locationSchema = z.object({
  id: z.string(),
  name: z.string(),
  isActive: z.boolean(),
});
const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
type Checkpoint = {
  phase: "products" | "variants" | "locations" | "inventory";
  after: string | null;
  item?: number;
};
const checkpointSchema = z.object({
  phase: z.enum(["products", "variants", "locations", "inventory"]),
  after: z.string().nullable(),
  item: z.number().int().nonnegative().optional(),
});
type Progress = () => Promise<void>;
const json = (value: unknown) => value as Prisma.InputJsonValue;

/** Enqueue durable discovery. Ownership/pairing is checked before any other shop can be read. */
export async function importCatalog(actor: Actor, shopDomain = actor.shop) {
  requireOwner(actor);
  const shop = normalizeShop(shopDomain);
  const own = await currentConnection(actor);
  if (shop !== actor.shop) await requirePairAccess(actor, shop);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`catalog:${shop}`}))::text`;
    const queued = await tx.syncJob.findFirst({
      where: {
        sourceShop: shop,
        operation: "CATALOG_IMPORT",
        status: { in: ["PENDING", "RETRY", "RUNNING"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (
      queued?.payload &&
      typeof queued.payload === "object" &&
      !Array.isArray(queued.payload) &&
      typeof queued.payload.snapshotId === "string"
    ) {
      const active = await tx.catalogSnapshot.findUnique({
        where: { id: queued.payload.snapshotId },
      });
      if (active) return active;
    }
    const snapshot = await tx.catalogSnapshot.create({
      data: { shopDomain: shop, status: "QUEUED" },
    });
    await tx.syncJob.create({
      data: {
        workspaceId: own.workspaceId ?? "",
        policyId: "",
        sourceShop: shop,
        targetShop: shop,
        operation: "CATALOG_IMPORT",
        payload: {
          snapshotId: snapshot.id,
          requestedBy: actor.userId,
          requestedShop: actor.shop,
        },
        idempotencyKey: `import:${shop}:${snapshot.id}`,
      },
    });
    await tx.auditEvent.create({
      data: {
        workspaceId: own.workspaceId,
        shopDomain: actor.shop,
        actor: actor.userId,
        action: "CATALOG_IMPORT_REQUESTED",
        resourceType: "CatalogSnapshot",
        resourceId: snapshot.id,
      },
    });
    return snapshot;
  });
}

export async function saveProduct(
  shop: string,
  product: ProductRecord,
  currency: string,
  observedAt = new Date(),
) {
  const data = {
    title: product.title,
    status: product.status,
    handle: product.handle,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    currency,
    data: json(product),
    hash: stableHash(product),
    shopifyUpdatedAt: product.updatedAt ? new Date(product.updatedAt) : null,
    observedAt,
  };
  await prisma.productSnapshot.upsert({
    where: {
      shopDomain_productGid: { shopDomain: shop, productGid: product.id },
    },
    create: { shopDomain: shop, productGid: product.id, ...data },
    update: data,
  });
}
export async function saveVariant(
  shop: string,
  variant: VariantRecord,
  observedAt = new Date(),
) {
  const data = {
    productGid: variant.product.id,
    inventoryItemGid: variant.inventoryItem?.id,
    sku: variant.sku,
    barcode: variant.barcode,
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    options: json(variant.selectedOptions),
    tracked: variant.inventoryItem?.tracked ?? false,
    data: json(variant),
    hash: stableHash(variant),
    observedAt,
  };
  await prisma.variantSnapshot.upsert({
    where: {
      shopDomain_variantGid: { shopDomain: shop, variantGid: variant.id },
    },
    create: { shopDomain: shop, variantGid: variant.id, ...data },
    update: data,
  });
}

/** Called only by the leased worker; checkpoints advance after persistence of every complete page. */
export async function executeCatalogImport(
  snapshotId: string,
  shop: string,
  progress: Progress = async () => {},
) {
  const snapshot = await prisma.catalogSnapshot.findUnique({
    where: { id: snapshotId },
  });
  if (!snapshot || snapshot.shopDomain !== shop)
    throw new SyncError(
      "TENANT_DENIED",
      "Catalog job does not match its installation.",
    );
  const info = await shopifyRequest<{
    shop: { id: string; currencyCode: string };
  }>(shop, SHOP_QUERY);
  if (!info.shop?.currencyCode || !info.shop.id)
    throw new SyncError(
      "INVALID_INPUT",
      "Shopify did not return shop currency and identity.",
    );
  const currency = info.shop.currencyCode;
  await prisma.shopConnection.update({
    where: { shopDomain: shop },
    data: { shopGid: info.shop.id, currency },
  });
  await prisma.catalogSnapshot.update({
    where: { id: snapshot.id },
    data: { status: "RUNNING", lastError: null },
  });
  let checkpoint: Checkpoint = snapshot.cursor
    ? checkpointSchema.parse(JSON.parse(snapshot.cursor))
    : { phase: "products", after: null };
  const advance = async (value: Checkpoint) => {
    await progress();
    checkpoint = value;
    await prisma.catalogSnapshot.update({
      where: { id: snapshot.id },
      data: { cursor: JSON.stringify(value) },
    });
  };
  const ensureCursor = (
    page: { hasNextPage: boolean; endCursor: string | null },
    after: string | null,
  ) => {
    if (page.hasNextPage && (!page.endCursor || page.endCursor === after))
      throw new SyncError(
        "PAGINATION_STALLED",
        "Shopify pagination did not advance; the import was paused safely.",
      );
  };
  while (checkpoint.phase === "products") {
    await progress();
    const body = await shopifyRequest<unknown>(shop, PRODUCTS_QUERY, {
      after: checkpoint.after,
    });
    const { products: page } = z
      .object({
        products: z.object({
          nodes: z.array(productSchema),
          pageInfo: pageInfoSchema,
        }),
      })
      .parse(body);
    ensureCursor(page.pageInfo, checkpoint.after);
    for (const product of page.nodes)
      await saveProduct(shop, product, currency);
    await advance(
      page.pageInfo.hasNextPage
        ? { phase: "products", after: page.pageInfo.endCursor }
        : { phase: "variants", after: null },
    );
    await prisma.catalogSnapshot.update({
      where: { id: snapshot.id },
      data: {
        products: await prisma.productSnapshot.count({
          where: { shopDomain: shop, observedAt: { gte: snapshot.startedAt } },
        }),
      },
    });
  }
  while (checkpoint.phase === "variants") {
    await progress();
    const body = await shopifyRequest<unknown>(shop, VARIANTS_QUERY, {
      after: checkpoint.after,
    });
    const { productVariants: page } = z
      .object({
        productVariants: z.object({
          nodes: z.array(variantSchema),
          pageInfo: pageInfoSchema,
        }),
      })
      .parse(body);
    ensureCursor(page.pageInfo, checkpoint.after);
    for (const variant of page.nodes) await saveVariant(shop, variant);
    await advance(
      page.pageInfo.hasNextPage
        ? { phase: "variants", after: page.pageInfo.endCursor }
        : { phase: "locations", after: null },
    );
    await prisma.catalogSnapshot.update({
      where: { id: snapshot.id },
      data: {
        variants: await prisma.variantSnapshot.count({
          where: { shopDomain: shop, observedAt: { gte: snapshot.startedAt } },
        }),
      },
    });
  }
  while (checkpoint.phase === "locations") {
    await progress();
    const body = await shopifyRequest<unknown>(shop, LOCATIONS_QUERY, {
      after: checkpoint.after,
    });
    const { locations: page } = z
      .object({
        locations: z.object({
          nodes: z.array(locationSchema),
          pageInfo: pageInfoSchema,
        }),
      })
      .parse(body);
    ensureCursor(page.pageInfo, checkpoint.after);
    for (const location of page.nodes) {
      await prisma.locationSnapshot.upsert({
        where: {
          shopDomain_locationGid: {
            shopDomain: shop,
            locationGid: location.id,
          },
        },
        create: {
          shopDomain: shop,
          locationGid: location.id,
          name: location.name,
          isActive: location.isActive,
        },
        update: {
          name: location.name,
          isActive: location.isActive,
          observedAt: new Date(),
        },
      });
    }
    await advance(
      page.pageInfo.hasNextPage
        ? { phase: "locations", after: page.pageInfo.endCursor }
        : { phase: "inventory", after: null, item: 0 },
    );
    await prisma.catalogSnapshot.update({
      where: { id: snapshot.id },
      data: {
        locations: await prisma.locationSnapshot.count({
          where: { shopDomain: shop, observedAt: { gte: snapshot.startedAt } },
        }),
      },
    });
  }
  if (checkpoint.phase === "inventory") {
    const items = await prisma.variantSnapshot.findMany({
      where: {
        shopDomain: shop,
        tracked: true,
        inventoryItemGid: { not: null },
        observedAt: { gte: snapshot.startedAt },
      },
      select: { inventoryItemGid: true },
      distinct: ["inventoryItemGid"],
      orderBy: { inventoryItemGid: "asc" },
    });
    for (let index = checkpoint.item ?? 0; index < items.length; index++) {
      const id = items[index].inventoryItemGid!;
      let after = index === checkpoint.item ? checkpoint.after : null;
      for (;;) {
        await progress();
        const body = await shopifyRequest<unknown>(shop, INVENTORY_QUERY, {
          id,
          after,
        });
        const parsed = z
          .object({
            inventoryItem: z
              .object({
                id: z.string(),
                tracked: z.boolean(),
                inventoryLevels: z.object({
                  nodes: z.array(
                    z.object({
                      location: z.object({ id: z.string() }),
                      quantities: z.array(
                        z.object({
                          name: z.string(),
                          quantity: z.number().int(),
                        }),
                      ),
                    }),
                  ),
                  pageInfo: pageInfoSchema,
                }),
              })
              .nullable(),
          })
          .parse(body);
        if (!parsed.inventoryItem) break; // Removed during import: the next preview quarantines its mapping.
        const page = parsed.inventoryItem.inventoryLevels;
        ensureCursor(page.pageInfo, after);
        for (const level of page.nodes) {
          const available = level.quantities.find(
            (quantity) => quantity.name === "available",
          );
          if (!available) continue;
          const identity = {
            shopDomain: shop,
            inventoryItemGid: id,
            locationGid: level.location.id,
          };
          await prisma.inventorySnapshot.upsert({
            where: { shopDomain_inventoryItemGid_locationGid: identity },
            create: { ...identity, quantity: available.quantity },
            update: { quantity: available.quantity, observedAt: new Date() },
          });
        }
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
        await advance({ phase: "inventory", item: index, after });
      }
      await advance({ phase: "inventory", item: index + 1, after: null });
    }
  }
  await progress();
  await prisma.$transaction(async (tx) => {
    const stale = { shopDomain: shop, observedAt: { lt: snapshot.startedAt } };
    await tx.inventorySnapshot.deleteMany({ where: stale });
    await tx.variantSnapshot.deleteMany({ where: stale });
    await tx.productSnapshot.deleteMany({ where: stale });
    await tx.locationSnapshot.deleteMany({ where: stale });
    await tx.catalogSnapshot.update({
      where: { id: snapshot.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        cursor: null,
        lastError: null,
      },
    });
    await tx.shopConnection.update({
      where: { shopDomain: shop },
      data: { lastImportAt: new Date(), lastError: null },
    });
  });
  return prisma.catalogSnapshot.findUniqueOrThrow({
    where: { id: snapshot.id },
  });
}

/** Webhook/scheduler discovery jobs are idempotent and preserve a durable work key. */
export async function enqueueSystemImport(shop: string, correlation: string) {
  const connection = await prisma.shopConnection.findUnique({
    where: { shopDomain: shop },
  });
  if (
    !connection ||
    connection.status !== "CONNECTED" ||
    connection.uninstalledAt
  )
    return null;
  return prisma.$transaction(async (tx) => {
    const key = `import-event:${shop}:${correlation}`;
    const existing = await tx.syncJob.findUnique({
      where: { idempotencyKey: key },
    });
    if (existing) return existing;
    const snapshot = await tx.catalogSnapshot.create({
      data: { shopDomain: shop, status: "QUEUED" },
    });
    return tx.syncJob.create({
      data: {
        workspaceId: connection.workspaceId ?? "",
        policyId: "",
        sourceShop: shop,
        targetShop: shop,
        operation: "CATALOG_IMPORT",
        payload: { snapshotId: snapshot.id, system: true, correlation },
        idempotencyKey: key,
      },
    });
  });
}

export const newCorrelationId = () => randomUUID();
