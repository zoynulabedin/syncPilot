# SyncPilot

Private Shopify product and inventory synchronization with verified two-store pairing, persistent catalog imports, explicit mappings, owner-reviewed plans, and a recoverable background worker.

**Current release: local approval-based implementation. Production acceptance is incomplete.** Shopify writes are disabled by default. Webhooks and scheduled reconciliation prepare proposals; an owner must approve each exact plan. An optional, owner-granted and time-boxed automatic consent can cover descriptive product fields only, behind a separate deployment switch that is off by default. This is not unattended inventory synchronization or a shared-stock allocation system.

## Implemented

- Shopify React Router embedded UI with verified online owner identity and separate offline worker sessions.
- Expiring, hashed pairing challenges; acceptance in the second installation and confirmation by the initiating owner; tenant checks.
- Staff roles inside a paired workspace, granted by the store owner: `VIEWER` (read-only) and `OPERATOR` (can also queue catalog imports and prepare dry runs and reconciliation comparisons). Only Shopify store owners approve writes, change policies, mappings and settings, manage staff and stock pools, and grant or revoke automatic consent.
- Checkpointed product, variant, location, and per-location inventory imports; searchable catalog and inventory pages.
- Explicit GID mappings and parent-variant validation. SKU/barcode suggestions never authorize a mapping alone.
- Source ownership for title, description HTML, vendor, product type, handle, tags, status, SEO title/description, variant price, compare-at price, SKU, taxability and inventory policy. Reverse policies must own different fields.
- Exact, expiring dry runs and single-use approvals. Targeted product/price updates; authoritative available-inventory writes with a safety buffer, expected-quantity CAS and Shopify idempotency.
- Optional bounded automatic sync (`/app/automatic-sync`): a store owner grants a time-boxed consent with run and change budgets for one-way copying of title, description, vendor, product type, tags and SEO title/description. Never inventory, prices, status, handles, variants or structural changes. Off unless `AUTOMATIC_SYNC_ENABLED` and `SYNC_WRITE_ENABLED` are both exactly `true`. Pause, activation, policy and mapping edits, disconnect, uninstall and scope changes revoke it. No test yet covers a successful automatic run.
- Stock pools (`/app/stock-pools`): a manual planning ledger for splitting one physical pool into store allowances and reservations. It never writes Shopify quantities, never imports orders or sales, and does not prevent overselling.
- Durable PostgreSQL inbox/jobs, leased processing, resource locks, bounded retries, dead letters, conflict review, cancellation and conservative recovery after uncertain writes.
- Read-only scheduled/on-demand reconciliation; searchable, paginated mappings and history; in-app alerts and optional durable external webhook alerts; owner-opted history retention and authenticated privacy handling.
- Request budgets applied after Shopify authentication: per verified shop and per verified user for admin routes, and per shop for catalog webhooks after HMAC verification. Per-IP and flood limits belong at the reverse proxy.
- AES-256-GCM access/refresh token storage with context authentication; generic liveness/readiness probes; encrypted streaming backups and disposable restore drills that verify session-key recovery.

## Local development

Requires Node 22.12+, npm, Shopify CLI, and Docker (or another local PostgreSQL whose session `TimeZone` is UTC). The dev launcher (`scripts/dev-services.mjs`) and the integration/HTTP test runner (`scripts/test-integration.mjs`) work on Windows as well as macOS and Linux; run encrypted backups on a Linux operator host. Run commands from the repository root. The nested `syncPilot/` folder from an earlier layout is ignored and no longer tracked; fresh clones do not contain it.

```bash
cp -n .env.example .env          # PowerShell: Copy-Item .env.example .env
# Set DATABASE_URL to match the local Compose password and POSTGRES_PORT.
# Set SESSION_ENCRYPTION_KEY once to a base 64-encoded random 32-byte key.
docker compose up -d --wait postgres redis
npm ci
npm run setup
npm run dev
```

Shopify CLI supplies development app credentials and the temporary HTTPS tunnel to both the web process and a separate worker process. Keep it running. `npm run worker` is the standalone worker entry point for deployments with their own environment. Never paste tokens into the UI or commit environment files.

Compose binds PostgreSQL to `127.0.0.1:${POSTGRES_PORT:-5432}` and Redis to `127.0.0.1:${REDIS_PORT:-6380}`. If a port is already in use, change it in the ignored `.env` and keep `DATABASE_URL` and `REDIS_URL` aligned.

PostgreSQL must run with session `TimeZone` set to UTC. The official `postgres` images default to UTC; managed or self-installed servers may not. Otherwise `/ready` returns 503 and the worker exits with `DATABASE_TIME_ZONE_NOT_UTC`; see the [runbook](docs/RUNBOOK.md) for the fix.

If `npm run setup` or `npm run dev` stops with Prisma error P3009 for `20240530213853_create_session_table`, the database ran the template's SQLite migration that was in the migration set from `d619e59` to `f8a83f2`. Run `npx prisma migrate resolve --rolled-back 20240530213853_create_session_table`, then `npm run setup`; see the runbook.

Keep `SYNC_WRITE_ENABLED=false`, `INVENTORY_WRITE_ENABLED=false` and `AUTOMATIC_SYNC_ENABLED=false` through discovery and verification. Production requires `SESSION_ENCRYPTION_KEY` at startup. Preserve that key separately from encrypted session backups. To encrypt existing legacy rows after configuring it:

```bash
npm run sessions:encrypt
```

## Operator flow

1. Install the same app in two eligible development/sandbox stores or eligible stores in the same Shopify Plus organization.
2. Both store owners approve pairing in their own installations. Eligibility is attested, not discovered through an organization API.
3. Import each catalog (owner or `OPERATOR`). Verify product mappings, then variants and locations.
4. Save a field/authority policy as a draft and run a dry run.
5. After release approval enables deployment write switches, activate the policy and approve the exact unexpired plan. The worker checks live state again.
6. Inspect jobs, attempts, conflicts and reconciliation findings. Resolve uncertain outcomes with a fresh comparison rather than replaying old stock approvals.
7. Optional, only after live acceptance and with `AUTOMATIC_SYNC_ENABLED=true`: on Automatic sync, grant a bounded consent backed by a fresh reviewed plan. Revoke it from the same page.

An authoritative inventory policy needs a business stock model that handles destination sales correctly. Independent pools should not mirror quantities; shared physical pools require a reservation/allocation authority that sees destination sales. The Stock pools page records allowances and reservations by hand and is not connected to Shopify orders or quantities, so it is not that authority. Asynchronous copies cannot guarantee zero overselling across independent checkouts.

## Verification

```bash
npm run check
npm run test:integration
npm run test:e2e
npm run test:backup
# Trusted operator host, with BACKUP_ENCRYPTION_KEY and SESSION_ENCRYPTION_KEY in secret storage:
npm run backup:encrypted
npm run restore:encrypted -- backups/your-backup.spbk
```

`check` runs typecheck, lint, unit tests and build. Integration tests need a local PostgreSQL (`localhost`, `127.0.0.1` or `postgres` host) running in UTC. They create, migrate and drop a generated `syncpilot_test_*` database and exercise synthetic Shopify responses, including 10,000 products, concurrency, CAS, duplicate deliveries, interruption, revocation, request limits, automatic-sync scheduling and the database time-zone guard. HTTP smoke tests start the built server with synthetic Shopify credentials and check probes, authentication rejection and forged-webhook rejection; they do not substitute for an authenticated browser/two-store test.

Latest local run (2026-11-03, Windows 11, Node 24.15, PostgreSQL 18.6 in UTC): typecheck, lint and build pass; 122 unit tests pass; all 9 migrations apply to a fresh database with schema parity; 62 integration tests and 4 HTTP smoke tests pass. The encrypted backup drill and Docker image build were not re-run, and nothing was tested against live Shopify stores. Details: [implementation status](docs/IMPLEMENTATION_STATUS.md).

## Deployment and remaining work

`Dockerfile` and `docker-compose.production.yml` provide web, worker, PostgreSQL, Redis and a separate migration task. Do not deploy them with development credentials. Configure a separate staging app/domain/secrets, replace the `example.com` application and redirect URLs in `shopify.app.toml` and confirm its access scopes, run migrations once, keep write flags off, configure per-IP limits at the reverse proxy, and complete real two-store acceptance before a production pilot.

Unsupported: new product creation, variant structure changes, options/media/metafields/collections (structural catalog adapters; the `CatalogOperation` table remains in the schema unused), automatic sync of inventory, prices, status, handles or variants, a Shopify-connected shared-stock allocation authority, unrestricted two-way inventory and role delegation beyond `VIEWER`/`OPERATOR`. Policy selectors still show at most 50 policies and 20 recent previews; the dedicated history pages paginate. Shopify product/price mutations have a read-to-write concurrency gap; inventory has API CAS. See the status and security documents before enabling writes.

- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Remaining work](docs/REMAINING_WORK.md) and [roadmap](docs/ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Application contracts](docs/API.md)
- [Security and limits](docs/SECURITY.md)
- [Operations runbook](docs/RUNBOOK.md)
- [Project audit](docs/PROJECT_AUDIT.md)
- [Decisions and open requirements](docs/DECISIONS.md)
- [Shopify API contracts](docs/SHOPIFY_CONTRACTS.md)

Scaffolding is adapted from Shopify's official React Router template; see LICENSE.md.

Encrypted backup commands require compatible PostgreSQL client tools on a trusted operator host; the application runtime image does not include them. External alert delivery and retention are off until the owner opts in. See [operations](docs/RUNBOOK.md), [alerts](docs/NOTIFICATIONS.md), and [staging setup](docs/COOLIFY_STAGING.md). The owner chose to keep the two development stores separate; this work does not authorize pairing or writes.
