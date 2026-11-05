# SyncPilot implementation status

Date: 2026-11-03. Branch: `main` at `f8a83f2` (same as `origin/main`). The changes listed under "Changes on 2026-11-03" are in the working tree and **not committed**. Earlier milestones: merge `d619e59` (implementation branch `codex/complete-syncpilot` into main), feature `dc7ca9a`, foundation `bdcc5ee`.

## Changes on 2026-11-03

- **Request limits.** The global pre-authentication buckets are removed. Admin routes are limited only after Shopify verifies the session token: per verified shop 600 reads (GET/HEAD) and 120 writes per minute, per verified user 180 reads and 30 writes per minute; parent and child loaders of one request count once. Catalog webhooks (`products/create`, `products/update`, `products/delete`, `inventory_levels/update`) are limited after HMAC verification to 1,200 per minute per shop, keyed on the trimmed, lowercased shop domain. Lifecycle (`app/uninstalled`, `app/scopes_update`) and compliance webhooks and `/auth/login` are never limited. Over budget: 429 with `Retry-After: 60`; limiter database failure: 503 with `Retry-After: 10` (lifecycle and compliance webhooks are never blocked). Per-IP and flood limits are the reverse proxy's job. The worker stage `RATE_LIMIT_CLEANUP` deletes up to 1,000 `RequestRateLimit` rows idle for over a day about every 60 seconds.
- **Database time zone guard.** `/ready` returns the generic 503 and the worker exits with code 1 before any maintenance, job claim or heartbeat when the PostgreSQL session `TimeZone` is not UTC (code `DATABASE_TIME_ZONE_NOT_UTC`). The web process keeps serving requests; traffic stops only if the proxy or orchestrator acts on the readiness failure. Prisma `DateTime` columns are `TIMESTAMP(3)` without time zone holding UTC wall-clock time, and raw SQL compares them with `NOW()`/`CURRENT_TIMESTAMP`, so leases, schedules and expiries are wrong in any other zone. Reproduced: with the test server in Asia/Dhaka, 7 integration tests failed (automatic consents looked expired, a 10,000-product import lost a product, an alert was delivered twice); in UTC all pass.
- **Migrations.** Removed the template's SQLite migration `20240530213853_create_session_table`, merged in from main in `d619e59`. It sorted first and cannot run on PostgreSQL, so `prisma migrate deploy` failed on every PostgreSQL database, fresh or already migrated, and recorded the migration as failed in `_prisma_migrations`. Removing the folder does not clear that record: such a database refuses the nine remaining migrations with P3009 until the failed row is marked rolled back (RUNBOOK, "P3009"). Reproduced and recovered on 2026-11-03 on the disposable server, for both a fresh database and one already holding five earlier migrations.
- **Automatic sync page.** `/app/automatic-sync` lets a store owner grant and revoke bounded standing consent; staff see it read-only and the server rejects their grant/revoke with 403. See API.md and SECURITY.md for eligibility, bounds and revocation.
- **Consent revocation.** Pausing, activating or saving a policy revokes that policy's ACTIVE and HELD consents; mapping changes, disconnect, uninstall and scope change revoke every ACTIVE and HELD consent in the workspace. Each writes `AUTOMATIC_CONSENT_REVOKED` with `details.reason` `POLICY_PAUSED`, `POLICY_ACTIVATED`, `STORES_DISCONNECTED`, `APP_UNINSTALLED`, `SCOPES_CHANGED` or `CONFIGURATION_CHANGED`; an owner's revoke from the page writes the event with no `details`. Scope change now also cancels `AUTO_PREVIEW` jobs; disconnect also revokes APPROVED plans.
- **Scheduler.** Every due consent the scheduler inspects has `nextRunAt` advanced, so blocked or exhausted consents cannot starve others. Because every path that changes a consent's fingerprint now revokes it, `CONSENT_CHANGED` is only a fallback for a consent an earlier release left ACTIVE: its next run dead-letters once and holds it (`AUTOMATIC_CONSENT_HELD`) instead of failing every interval.
- **Staff access.** Shopify staff on an unpaired store can open Products and Reconciliation read-only again (regression from `a9a4ead`). `OPERATOR` capability exists only inside an active verified pair.
- **Stock pools.** Kept as a manual planning ledger (owner decision). It never writes Shopify quantities, never imports orders or sales and does not prevent overselling; the page subtitle says so.
- **Catalog adapters.** Unused structural adapter code and the `CATALOG_ADAPTERS_WRITE_ENABLED`/`CATALOG_METAFIELD_ALLOWLIST` settings were removed. Structural catalog operations stay unsupported; the `CatalogOperation` table remains in the schema, unused, and privacy erasure still deletes its rows.
- **Repository and tooling.** Removed the dead `/app/catalog-plans` link and the template demo page `app.additional.tsx`. `scripts/test-integration.mjs` and `scripts/dev-services.mjs` run on Windows. The nested `syncPilot` gitlink (no `.gitmodules` entry; clones got an empty folder) is untracked and `/syncPilot/` is ignored; the folder on disk was kept.

## Implemented (cumulative)

Searchable, paginated product/variant/location mappings and imported-resource suggestions; paginated job, receipt, plan, conflict, reconciliation and audit history; selected SEO title/description and variant SKU/taxability/inventory-policy adapters; owner-opted history retention; authenticated privacy receipts and uninstall erasure; optional durable operational webhook alerts; encrypted streaming backups and isolated restore drills; Coolify staging configuration and CI backup coverage.

Maintenance stages fail independently with bounded retry cadence. A privacy/retention/alert/rate-limit-cleanup failure cannot suppress job processing. Alert DNS lookup and HTTPS share one deadline, preventing an indefinitely stalled resolver or a late request after timeout.

The core includes online owner identity, offline encrypted sessions, both-owner challenge pairing, tenant and `VIEWER`/`OPERATOR` staff access controls, checkpointed discovery, explicit GID mappings, field ownership, exact expiring dry runs, single-use approvals, targeted writes, inventory CAS/idempotency, durable jobs/leases/locks, conservative uncertain-outcome recovery, reconciliation, authenticated request budgets, bounded automatic consent for descriptive product fields and a manual stock-pool ledger.

## Store decision and live evidence

Recorded 2026-11-02 on the earlier development machine; not re-checked on 2026-11-03. The owner explicitly chose **Keep stores separate**. Both installations remain independent: no workspace pairing, no active policy, and both Shopify write switches are false. No live Shopify product/stock mutation, external alert delivery, production deployment or remote push of today's changes occurred.

- Quickstart: authenticated owner UI and worker verified; a fresh read-only import completed with 17 products, 26 variants and 2 locations.
- Rankup: its earlier read-only import is persisted as completed with 2 products, 13 variants and 1 location. Local metadata confirmed its connection has no workspace.
- Local metadata check: 0 pairs and 0 active policies. A store's catalog selector exposes its own installation while unpaired.
- Temporary development tunnels must stay running and are not deployment hosting.

## Executed verification (2026-11-03)

Environment: Windows 11 Pro, Node 24.15, disposable local PostgreSQL 18.6 with `TimeZone=UTC`. Compose and CI still use PostgreSQL 17; 18.6 was only the local test server.

- `npm run typecheck`, `npm run lint`, `npm run build`: PASS (build prints only React Router v8 future-flag warnings).
- `npm test`: 17 files, **122 tests PASS**. The 9 database test files (62 tests) skip without a database.
- `node scripts/test-integration.mjs` against the disposable server: fresh migration of all **9 migrations** PASS, Prisma schema/migration parity PASS, 9 files, **62 tests PASS**, 0 failed.
- `node scripts/test-integration.mjs --http`: **4 PASS**. These use synthetic credentials and are not live Shopify webhook acceptance.

The counts previously recorded here (79 unit, 41 integration, 5 migrations) are superseded.

## Not verified

- Encrypted backup/restore drill (`npm run test:backup`): not run; the verification machine has no `pg_dump`/`pg_restore`. It last passed on 2026-11-02 with five migrations and has not been re-run with nine.
- Docker image build: not re-run; Docker is not installed on the verification machine. The last successful image (`syncpilot:verified-20261102`) predates these changes.
- Live Shopify: no store writes, pairing, signed webhook delivery or automatic-sync run against real stores. The automatic-sync page was not opened in a browser; server-render unit tests cover its states.
- Automatic sync, at any level (no synthetic test either): a successful automatic run (the `system:automatic-sync` APPROVED plan, the `automatic-apply:<jobId>` `APPLY_PREVIEW`, the `usedJobs`/`usedChanges` increments and `AUTOMATIC_PLAN_APPROVED`); the `CONSENT_BUDGET`/`CONSENT_SCOPE` hold inside a run; a consent-bound `APPLY_PREVIEW` going through the sync engine's consent check; and `getAutomaticConsents` or `revokeAutomaticConsent` against a database. The integration tests cover grant, scheduling, exhaustion, the gate, the fallback hold and lifecycle revocation; the route tests mock the service or the Prisma client.
- Stock pools: only the conservation domain logic has unit tests. No test calls the ledger service, so its version check, operation-key idempotency, serializable retries and owner/pair checks are untested.
- The earlier development database (five migrations as of 2026-11-02) was not re-checked. If `npm run dev` or `npm run setup` ran against it after `d619e59`, it holds the failed SQLite migration row and needs the RUNBOOK P3009 recovery.
- No deployment, commit or push. CI is configured but has not run on these changes. The dependency audit was not re-run.
- Admin GraphQL documents are unchanged since their validation against 2026-10.

## Migrations, security and deployment impact

Migrations, in order: `20261031180000_init`, `20261101090000_control_plane`, `20261101160000_history_privacy`, `20261101170000_alert_delivery`, `20261101180000_variant_fields`, `20261102010000_stock_ledger`, `20261102020000_catalog_adapters` (creates the unused `CatalogOperation` table, kept deliberately), `20261102030000_bounded_consent`, `20261102060000_request_rate_limits`. Today's changes add no migration. Deploy all forward migrations before new application/worker code. `origin/main` (`f8a83f2`) still contains the SQLite migration, so no database can be migrated from it; deploy only after today's changes are committed, and clear any failed record it left first (RUNBOOK, "P3009").

New deployment requirements: PostgreSQL session `TimeZone` UTC, and per-IP/flood limits at the reverse proxy for `/app`, `/auth` and `/webhooks`. Runtime write switches remain false. `docker-compose.production.yml` does not pass `AUTOMATIC_SYNC_ENABLED` to the containers, so automatic sync stays off in that deployment unless the Compose file is changed in review. External alerting additionally requires an operator-configured HTTPS endpoint/host allowlist and owner opt-in; retention is also off by default. Backups require a separate recoverable backup key and the persistent session key on a trusted operator host with compatible PostgreSQL client tools. The application image does not contain those tools. The `shopify.app.toml` application and redirect URLs are still `example.com` placeholders and must be set, and its access scopes confirmed, by the app owner.

Old data is not cleaned up by a migration: pauses or scope changes made by earlier code may have left consents ACTIVE on paused policies. They are revoked on re-activation (`POLICY_ACTIVATED`), a policy save or a mapping change (`CONFIGURATION_CHANGED`); only a policy that earlier code also re-activated reaches the `CONSENT_CHANGED` hold. No route could grant consent before the 2026-11-03 page, and a consent lasts at most 24 hours, so such rows are unlikely outside test databases.

Product/variant updates retain a read-to-write concurrency gap because those Shopify APIs do not offer inventory-style CAS. Inventory remains authoritative-source mode only; no shared-pool safety claim is made. Privacy erasure preserves the other store's private catalog and sessions in integration tests. Production key management, monitoring and offsite recovery still require operational acceptance.

## Remaining scope and next action

The full master specification is **incomplete**. Structural catalog adapters (product creation, options, media, metafields, collections) are unsupported. There is no Shopify-connected shared-stock reservation/allocation authority; stock pools are a manual ledger. Automatic sync covers descriptive product fields only and has no live acceptance. Role delegation beyond `VIEWER`/`OPERATOR`, proxy-level per-IP limits and complete production acceptance remain. Policy selectors still cap at 50 policies and 20 recent previews; separate history pages paginate.

Next: review and commit today's working-tree changes. Then the deployment input is the intended Coolify project/server and HTTPS staging domain, with credentials supplied through secret storage. Staging authentication, real signed Shopify event delivery, offsite encrypted restore with nine migrations, external receiver/monitoring acceptance and rollback rehearsal remain. Cross-store pairing and write pilots were intentionally not performed under the owner's current decision; reconsider them only if the owner later changes that decision and defines stock/field authority.

See `REMAINING_WORK.md`, `COOLIFY_STAGING.md`, `API.md`, `SECURITY.md`, `SHOPIFY_CONTRACTS.md` and `RUNBOOK.md`. Do not label this production-ready or the whole specification complete.
