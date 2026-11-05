# Shopify API contracts

All 10 documents in app/domain/sync-operations.ts were checked by the Shopify AI Toolkit against Admin GraphQL 2026-10 during implementation. They are now the app's only GraphQL documents: the unused structural catalog documents (productCreate, productVariantsBulkCreate, productOptionsCreate, media, metafield and collection operations in app/domain/catalog-operations.ts) were removed on 2026-11-03 and those operations are unsupported. The configured app version remains 2026-10; no new production scope was added. Automatic sync writes through the same productUpdate path and adds no documents or scopes. The access scopes and the example.com application/redirect URLs in shopify.app.toml are being set by the app owner and have not been revalidated.

- Shop identity/currency; paginated products, variants, locations and inventory-item location levels.
- Fresh mapped resource reads and an inventory-item/location available-quantity read.
- productUpdate with ProductUpdateInput, targeted core fields, tags and selected SEO subfields only; no structural list replacement.
- productVariantsBulkUpdate with allowPartialUpdates:false for selected price/compare-at price, SKU through inventoryItem.sku, taxable and inventoryPolicy fields. Variant structure is not replaced.
- inventorySetQuantities with per-item changeFromQuantity, available quantity, explicit location and @idempotent(key:...).

Both top-level GraphQL errors and mutation userErrors are checked. A successful HTTP 200 alone does not mark a mutation successful. The worker rereads affected values after writing and holds ambiguous outcomes.

Primary references:

- https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/inventorySetQuantities
- https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/ProductUpdateInput
- https://shopify.dev/docs/api/admin-graphql/2026-10/payloads/ProductVariantsBulkUpdatePayload
- https://shopify.dev/docs/api/shopify-app-react-router/latest/entrypoints/shopifyapp

Webhooks: `authenticate.webhook` verifies the HMAC over the raw body only. The `X-Shopify-Topic` and `X-Shopify-Shop-Domain` headers are not signed; the library and this app trust them after the body verifies. Catalog topics over the per-shop budget receive 429 with `Retry-After: 60`; Shopify retries a failed delivery up to 8 times over 4 hours and then stops ([Troubleshoot webhooks](https://shopify.dev/docs/apps/build/webhooks/troubleshoot)); scheduled reconciliation detects drift a dropped delivery leaves and prepares a plan for review. Sustained 429s also raise the failed-delivery rate shown in the Dev Dashboard logs, so watch it after bulk edits. Real signed delivery and retry behavior have not been observed against this app.

The installed React Router integration documents that useOnlineTokens:true retains both online and offline sessions. Owner authority comes from the online associated user's account_owner; workers use the official offline refresh path through the encrypted session adapter.

The expanded query selections and literal selected-field mutation inputs were revalidated against 2026-10. Local unit/integration tests use synthetic GraphQL fixtures. Successful schema validation and synthetic mutations do not establish that both real installations have accepted permissions or that their live workflows have passed.
