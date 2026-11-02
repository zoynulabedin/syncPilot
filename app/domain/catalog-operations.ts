export const CATALOG_HANDLE = `#graphql
query CatalogHandle($query: String!) { products(first: 2, query: $query) { nodes { id handle } } }
`;

export const CATALOG_PRODUCT = `#graphql
query CatalogProduct($id: ID!) { product(id: $id) { id updatedAt options { id name values position } variants(first: 100) { nodes { id selectedOptions { name value } } pageInfo { hasNextPage } } media(first: 100) { nodes { id status } pageInfo { hasNextPage } } } }
`;

export const CATALOG_METAFIELD = `#graphql
query CatalogMetafield($id: ID!, $namespace: String!, $key: String!, $ownerType: MetafieldOwnerType!, $query: String!) { node(id: $id) { id ... on Product { value: metafield(namespace: $namespace, key: $key) { type value compareDigest } } ... on ProductVariant { value: metafield(namespace: $namespace, key: $key) { type value compareDigest } } } metafieldDefinitions(first: 100, ownerType: $ownerType, query: $query) { nodes { namespace key type { name } } pageInfo { hasNextPage } } }
`;

export const CATALOG_COLLECTION = `#graphql
query CatalogCollection($collectionId: ID!, $productId: ID!) { collection(id: $collectionId) { id ruleSet { appliedDisjunctively } hasProduct(id: $productId) } product(id: $productId) { id updatedAt } }
`;

export const CATALOG_CREATE = `#graphql
mutation CatalogCreate($product: ProductCreateInput!) { productCreate(product: $product) { product { id handle } userErrors { field message } } }
`;

export const CATALOG_VARIANTS = `#graphql
mutation CatalogVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy!) { productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) { productVariants { id } userErrors { field message } } }
`;

export const CATALOG_OPTIONS = `#graphql
mutation CatalogOptions($productId: ID!, $options: [OptionCreateInput!]!) { productOptionsCreate(productId: $productId, options: $options, variantStrategy: LEAVE_AS_IS) { product { id } userErrors { field message } } }
`;

export const CATALOG_MEDIA = `#graphql
mutation CatalogMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) { productUpdate(product: $product, media: $media) { product { id media(first: 100) { nodes { id status } pageInfo { hasNextPage } } } userErrors { field message } } }
`;

export const CATALOG_SET_METAFIELD = `#graphql
mutation CatalogSetMetafield($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id compareDigest } userErrors { field message } } }
`;

export const CATALOG_ADD_COLLECTION = `#graphql
mutation CatalogAddCollection($id: ID!, $productIds: [ID!]!) { collectionAddProducts(id: $id, productIds: $productIds) { collection { id } userErrors { field message } } }
`;
