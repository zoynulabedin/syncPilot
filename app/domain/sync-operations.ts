/** Contract checked against Shopify Admin GraphQL 2026-10. See docs/SHOPIFY_CONTRACTS.md. */
export const SHOP_QUERY = `#graphql
  query SyncPilotShop { shop { id currencyCode } }
`;
export const INSTALLATION_CHECK_QUERY = `#graphql
  query SyncPilotInstallationCheck {
    shop { id myshopifyDomain currencyCode }
    currentAppInstallation { accessScopes { handle } }
  }
`;
export const PRODUCTS_QUERY = `#graphql
  query SyncPilotProducts($after: String) {
    products(first: 100, after: $after, sortKey: ID) {
      nodes { id title status handle descriptionHtml vendor productType tags updatedAt seo { title description } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
export const VARIANTS_QUERY = `#graphql
  query SyncPilotVariants($after: String) {
    productVariants(first: 100, after: $after, sortKey: ID) {
      nodes { id sku barcode price compareAtPrice taxable inventoryPolicy selectedOptions { name value } product { id } inventoryItem { id tracked } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
export const LOCATIONS_QUERY = `#graphql
  query SyncPilotLocations($after: String) {
    locations(first: 100, after: $after, includeInactive: true) {
      nodes { id name isActive }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
export const INVENTORY_QUERY = `#graphql
  query SyncPilotInventoryLevels($id: ID!, $after: String) {
    inventoryItem(id: $id) { id tracked inventoryLevels(first: 100, after: $after) {
      nodes { location { id } quantities(names: ["available"]) { name quantity } }
      pageInfo { hasNextPage endCursor }
    } }
  }
`;
export const RESOURCES_QUERY = `#graphql
  query SyncPilotResources($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title status handle descriptionHtml vendor productType tags updatedAt seo { title description } }
      ... on ProductVariant { id sku barcode price compareAtPrice taxable inventoryPolicy selectedOptions { name value } product { id } inventoryItem { id tracked } }
      ... on Location { id name isActive }
    }
  }
`;
export const INVENTORY_LEVEL_QUERY = `#graphql
  query SyncPilotInventoryLevel($id: ID!, $locationId: ID!) {
    inventoryItem(id: $id) { id tracked inventoryLevel(locationId: $locationId) {
      location { id isActive } quantities(names: ["available"]) { name quantity }
    } }
  }
`;
export const PRODUCT_UPDATE = `#graphql
  mutation SyncPilotProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id } userErrors { field message } }
  }
`;
export const VARIANT_UPDATE = `#graphql
  mutation SyncPilotVariantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
      productVariants { id price compareAtPrice } userErrors { field message }
    }
  }
`;
export const INVENTORY_SET = `#graphql
  mutation SyncPilotInventorySet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { referenceDocumentUri changes { name delta quantityAfterChange } }
      userErrors { code field message }
    }
  }
`;
