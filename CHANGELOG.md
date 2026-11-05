# SyncPilot

## 2026.11.03
- Request limits redesigned. The global pre-authentication buckets (admin 1,200/min, webhook 2,400/min, login 120/min, shared by every caller) are removed; unverified requests never consume a budget. Admin routes are limited after Shopify verifies the session token: 600 reads and 120 writes per minute per verified shop, 180 reads and 30 writes per minute per verified user. Webhooks are limited after HMAC verification, only for `products/create`, `products/update`, `products/delete` and `inventory_levels/update`: 1,200 per minute per shop (`RATE_LIMITS.shopCatalogWebhook`), answered with 429 and `Retry-After: 60`. Lifecycle and compliance webhooks and `/auth/login` are not limited. A limiter database failure returns 503 with `Retry-After: 10`. Per-IP and flood limits must be configured at the reverse proxy; the app never trusts forwarding headers. Cleanup of expired `RequestRateLimit` rows moved to the worker stage `RATE_LIMIT_CLEANUP`. No schema change.
- PostgreSQL session `TimeZone` must be UTC. `/ready` returns the generic 503 and the worker exits with code 1 and `DATABASE_TIME_ZONE_NOT_UTC` before doing any work when it is not. Nothing changes the database setting automatically.
- Removed the Shopify template's SQLite migration `20240530213853_create_session_table`. It sorted first and cannot run on PostgreSQL (`DATETIME`), so since the main merge (`d619e59`) `prisma migrate deploy` failed on every PostgreSQL database, fresh or already migrated, and left a failed row in `_prisma_migrations`. `20261031180000_init` already creates `Session`. Nine PostgreSQL migrations remain. A database that ran deploy with the old set (`npm run dev`, `npm run setup` or the Compose `migrate` service) refuses them with P3009 until `npx prisma migrate resolve --rolled-back 20240530213853_create_session_table` is run; see the runbook.
- Added the owner page `/app/automatic-sync` to grant and revoke bounded standing consent for one-way descriptive product fields (title, description, vendor, product type, tags, SEO title and description). Bounds: duration and interval 5–1,440 minutes, 1–100 runs, 1–1,000 total changes, 1–100 changes per run. Requires `AUTOMATIC_SYNC_ENABLED` and `SYNC_WRITE_ENABLED` both exactly `true` to grant or run; revoke always works. Staff see it read-only.
- Pausing or activating a policy, disconnecting stores, uninstalling and scope changes now revoke ACTIVE and HELD automatic consents in the same transaction; policy saves and mapping changes, which already revoked ACTIVE consents, now also revoke HELD ones. Each of these revocations writes an `AUTOMATIC_CONSENT_REVOKED` audit event with a `details.reason`; an owner's revoke from the page writes the event without one. A scope change also cancels queued `AUTO_PREVIEW` jobs; disconnect also revokes APPROVED plans.
- The automatic-sync scheduler advances every due consent it inspects, so blocked or exhausted consents no longer starve others. As a fallback for a consent an earlier release left ACTIVE after a configuration change, the run that finds the changed fingerprint holds it (`AUTOMATIC_CONSENT_HELD`, code `CONSENT_CHANGED`) instead of failing every interval.
- Shopify staff on an unpaired store can open Products and Reconciliation read-only again instead of an error page (regression from `a9a4ead`).
- Stock pools are kept as a manual planning ledger by owner decision; the page subtitle now says Shopify quantities never change there.
- Removed unused structural catalog adapter code (`app/domain/catalog-operations.ts`, `app/domain/catalog-adapters.ts`), the `CATALOG_ADAPTERS_WRITE_ENABLED` and `CATALOG_METAFIELD_ALLOWLIST` settings, the dead `/app/catalog-plans` link and the template demo page `app/routes/app.additional.tsx`. The `CatalogOperation` table stays in the schema, unused.
- `scripts/test-integration.mjs` and `scripts/dev-services.mjs` now run on Windows. `tests/backup-crypto.test.ts` skips only the POSIX file-mode assertion on Windows.
- Untracked the nested `syncPilot` gitlink, which had no `.gitmodules` entry; `/syncPilot/` is ignored. The folder on disk was not deleted.
- Verified locally on Windows 11 with Node 24.15 and PostgreSQL 18.6 in UTC: typecheck, lint and build pass; 122 unit, 62 integration and 4 HTTP smoke tests pass; fresh migration and schema parity pass. Not run: encrypted backup drill, Docker image build, live Shopify tests, deployment. No test covers a successful automatic run.

# @shopify/shopify-app-template-react-router

## 2026.10.09
- [#295](https://github.com/Shopify/shopify-app-template-react-router/pull/295) - Update API version to 2026-10. Apps created from this template previously targeted 2025-10, which predates newer Admin API fields such as the `changeFromQuantity` compare-and-swap argument on inventory quantity mutations (available from 2026-01).

## 2026.09.03
- [#280](https://github.com/Shopify/shopify-app-template-react-router/pull/280) - Pin the React Router family to 7.18.2. 7.18.3 tightened action-origin validation to compare the full origin, which made every action return `400 Bad Request` under `shopify app dev` and, in production, behind TLS-terminating proxies that forward to the app over plain HTTP (`react-router-serve` never enables Express `trust proxy`). Fixes [#279](https://github.com/Shopify/shopify-app-template-react-router/issues/279).
- [#280](https://github.com/Shopify/shopify-app-template-react-router/pull/280) - Force `qs` to `^6.16.0` to clear [CVE-2026-82562](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) and [CVE-2026-82417](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g), which reach the app transitively through `@react-router/serve` → `express@4`.

## 2026.01.08
- [#170](https://github.com/Shopify/shopify-app-template-react-router/pull/170) - Update React Router minimum version to v7.12.0

## 2025.12.11

- [#151](https://github.com/Shopify/shopify-app-template-react-router/pull/151) Update `@shopify/shopify-app-react-router` to v1.1.0 and `@shopify/shopify-app-session-storage-prisma` to v8.0.0, add refresh token fields (`refreshToken` and `refreshTokenExpires`) to Session model in Prisma schema, and adopt the `expiringOfflineAccessTokens` flag for enhanced security through token rotation. See [expiring vs non-expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens#expiring-vs-non-expiring-offline-tokens) for more information.

## 2025.10.10

- [#95](https://github.com/Shopify/shopify-app-template-react-router/pull/95) Swap the product link for [admin intents](https://shopify.dev/docs/apps/build/admin/admin-intents).

## 2025.10.02

- [#81](https://github.com/Shopify/shopify-app-template-react-router/pull/81) Add shopify global to eslint for ui extensions

## 2025.10.01

- [#79](https://github.com/Shopify/shopify-app-template-react-router/pull/78) Update API version to 2025-10.
- [#77](https://github.com/Shopify/shopify-app-template-react-router/pull/77) Update `@shopify/shopify-app-react-router` to V1.
- [#73](https://github.com/Shopify/shopify-app-template-react-router/pull/73/files) Rename @shopify/app-bridge-ui-types to @shopify/polaris-types

## 2025.08.30

- [#70](https://github.com/Shopify/shopify-app-template-react-router/pull/70/files) Upgrade `@shopify/app-bridge-ui-types` from 0.2.1 to 0.3.1.

## 2025.08.17

- [#58](https://github.com/Shopify/shopify-app-template-react-router/pull/58) Update Shopify & React Router dependencies.  Use Shopify React Router in graphqlrc, not shopify-api
- [#57](https://github.com/Shopify/shopify-app-template-react-router/pull/57) Update Webhook API version in `shopify.app.toml` to `2025-07`
- [#56](https://github.com/Shopify/shopify-app-template-react-router/pull/56) Remove local CLI from package.json in favor of global CLI installation
- [#53](https://github.com/Shopify/shopify-app-template-react-router/pull/53) Add the Shopify Dev MCP to the template

## 2025.08.16

- [#52](https://github.com/Shopify/shopify-app-template-react-router/pull/52) Use `ApiVersion.July25` rather than `LATEST_API_VERSION` in `.graphqlrc`.

## 2025.07.24

- [14](https://github.com/Shopify/shopify-app-template-react-router/pull/14/files) Add [App Bridge web components](https://shopify.dev/docs/api/app-home/app-bridge-web-components) to the template.

## July 2025

Forked the [shopify-app-template repo](https://github.com/Shopify/shopify-app-template-remix)

# @shopify/shopify-app-template-remix

## 2025.03.18

-[#998](https://github.com/Shopify/shopify-app-template-remix/pull/998) Update to Vite 6

## 2025.03.01

- [#982](https://github.com/Shopify/shopify-app-template-remix/pull/982) Add Shopify Dev Assistant extension to the VSCode extension recommendations

## 2025.01.31

- [#952](https://github.com/Shopify/shopify-app-template-remix/pull/952) Update to Shopify App API v2025-01

## 2025.01.23

- [#923](https://github.com/Shopify/shopify-app-template-remix/pull/923) Update `@shopify/shopify-app-session-storage-prisma` to v6.0.0

## 2025.01.8

- [#923](https://github.com/Shopify/shopify-app-template-remix/pull/923) Enable GraphQL autocomplete for Javascript

## 2024.12.19

- [#904](https://github.com/Shopify/shopify-app-template-remix/pull/904) bump `@shopify/app-bridge-react` to latest
-
## 2024.12.18

- [875](https://github.com/Shopify/shopify-app-template-remix/pull/875) Add Scopes Update Webhook
## 2024.12.05

- [#910](https://github.com/Shopify/shopify-app-template-remix/pull/910) Install `openssl` in Docker image to fix Prisma (see [#25817](https://github.com/prisma/prisma/issues/25817#issuecomment-2538544254))
- [#907](https://github.com/Shopify/shopify-app-template-remix/pull/907) Move `@remix-run/fs-routes` to `dependencies` to fix Docker image build
- [#899](https://github.com/Shopify/shopify-app-template-remix/pull/899) Disable v3_singleFetch flag
- [#898](https://github.com/Shopify/shopify-app-template-remix/pull/898) Enable the `removeRest` future flag so new apps aren't tempted to use the REST Admin API.

## 2024.12.04

- [#891](https://github.com/Shopify/shopify-app-template-remix/pull/891) Enable remix future flags.

## 2024.11.26

- [888](https://github.com/Shopify/shopify-app-template-remix/pull/888) Update restResources version to 2024-10

## 2024.11.06

- [881](https://github.com/Shopify/shopify-app-template-remix/pull/881) Update to the productCreate mutation to use the new ProductCreateInput type

## 2024.10.29

- [876](https://github.com/Shopify/shopify-app-template-remix/pull/876) Update shopify-app-remix to v3.4.0 and shopify-app-session-storage-prisma to v5.1.5

## 2024.10.02

- [863](https://github.com/Shopify/shopify-app-template-remix/pull/863) Update to Shopify App API v2024-10 and shopify-app-remix v3.3.2

## 2024.09.18

- [850](https://github.com/Shopify/shopify-app-template-remix/pull/850) Removed "~" import alias

## 2024.09.17

- [842](https://github.com/Shopify/shopify-app-template-remix/pull/842) Move webhook processing to individual routes

## 2024.08.19

Replaced deprecated `productVariantUpdate` with `productVariantsBulkUpdate`

## v2024.08.06

Allow `SHOP_REDACT` webhook to process without admin context

## v2024.07.16

Started tracking changes and releases using calver
