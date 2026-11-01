# SyncPilot

Private Shopify product and inventory synchronization with verified two-store pairing, persistent catalog imports, explicit mappings, owner-reviewed plans, and a recoverable background worker.

**Current release: local approval-based implementation. Production acceptance is incomplete.** Shopify writes are disabled by default. Webhooks and scheduled reconciliation prepare proposals; an owner must approve each exact plan. This is not unattended synchronization or a shared-stock allocation system.

## Implemented

- Shopify React Router embedded UI with verified online owner identity and separate offline worker sessions.
- Expiring, hashed pairing challenges; acceptance in the second installation and confirmation by the initiating owner; tenant checks and read-only staff membership.
- Checkpointed product, variant, location, and per-location inventory imports; searchable catalog and inventory pages.
- Explicit GID mappings and parent-variant validation. SKU/barcode suggestions never authorize a mapping alone.
- Source ownership for title, description HTML, vendor, product type, handle, tags, status, variant price, and compare-at price. Reverse policies must own different fields.
- Exact, expiring dry runs and single-use approvals. Targeted product/price updates; authoritative available-inventory writes with a safety buffer, expected-quantity CAS and Shopify idempotency.
- Durable PostgreSQL inbox/jobs, leased processing, resource locks, bounded retries, dead letters, conflict review, cancellation and conservative recovery after uncertain writes.
- Read-only scheduled/on-demand reconciliation, real job/audit views, in-app operational alerts, settings, and help.
- AES-256-GCM access/refresh token storage with context authentication; generic liveness/readiness probes; local backup and disposable restore rehearsal tools.

## Local development

Requires Node 22.12+, npm, Shopify CLI, and Docker. Run commands from this checkout, not the preserved nested `syncPilot/` folder.

```bash
cp -n .env.example .env
# Set DATABASE_URL to match the local Compose password and POSTGRES_PORT.
# Set SESSION_ENCRYPTION_KEY once to a base 64-encoded random 32-byte key.
docker compose up -d --wait postgres redis
npm ci
npm run setup
npm run dev
```

Shopify CLI supplies development app credentials and the temporary HTTPS tunnel to both the web process and a separate worker process. Keep it running. `npm run worker` is the standalone worker entry point for deployments with their own environment. Never paste tokens into the UI or commit environment files.

This Mac currently uses PostgreSQL on **5433** and Redis on **6380** to avoid existing host services; its ignored `.env` keeps both database URL and port aligned. A clean checkout defaults PostgreSQL to 5432. Compose binds development dependencies to loopback.

Keep `SYNC_WRITE_ENABLED=false` and `INVENTORY_WRITE_ENABLED=false` through discovery and verification. Production requires `SESSION_ENCRYPTION_KEY` at startup. Preserve that key separately from encrypted session backups. To encrypt existing legacy rows after configuring it:

```bash
npm run sessions:encrypt
```

## Operator flow

1. Install the same app in two eligible development/sandbox stores or eligible stores in the same Shopify Plus organization.
2. Both store owners approve pairing in their own installations. Eligibility is attested, not discovered through an organization API.
3. Import each catalog. Verify product mappings, then variants and locations.
4. Save a field/authority policy as a draft and run a dry run.
5. After release approval enables deployment write switches, activate the policy and approve the exact unexpired plan. The worker checks live state again.
6. Inspect jobs, attempts, conflicts and reconciliation findings. Resolve uncertain outcomes with a fresh comparison rather than replaying old stock approvals.

An authoritative inventory policy needs a business stock model that handles destination sales correctly. Independent pools should not mirror quantities; shared physical pools require a reservation/allocation ledger. Asynchronous copies cannot guarantee zero overselling across independent checkouts.

## Verification

```bash
npm run check
npm run test:integration
npm run test:e 2 e
bash scripts/backup-local.sh
bash scripts/restore-drill.sh backups/your-backup.dump
```

`check` runs typecheck, lint, unit tests and build. Integration tests create, migrate and drop a generated local `syncpilot_test_*` database and exercise synthetic Shopify responses, including 10,000 products, concurrency, CAS, duplicate deliveries, interruption and revocation. HTTP smoke tests start the built server with synthetic Shopify credentials and check probes, authentication rejection and forged-webhook rejection; they do not substitute for an authenticated browser/two-store test.

## Deployment and remaining work

`Dockerfile` and `docker-compose.production.yml` provide web, worker, PostgreSQL, Redis and a separate migration task. Do not deploy them with development credentials. Configure a separate staging app/domain/secrets, run migrations once, keep write flags off, and complete real two-store acceptance before a production pilot.

Unsupported: new product creation, variant structure changes, media/metafields/collections, shared-pool ledger allocation, unrestricted two-way inventory, unattended mutation consent, external notification delivery and automatic retention purge. Mapping/history displays are bounded; large mapping administration needs pagination. Shopify product/price mutations have a read-to-write concurrency gap; inventory has API CAS. See the status and security documents before enabling writes.

- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Application contracts](docs/API.md)
- [Security and limits](docs/SECURITY.md)
- [Operations runbook](docs/RUNBOOK.md)
- [Project audit](docs/PROJECT_AUDIT.md)
- [Decisions and open requirements](docs/DECISIONS.md)
- [Shopify API contracts](docs/SHOPIFY_CONTRACTS.md)

Scaffolding is adapted from Shopify's official React Router template; see LICENSE.md.
