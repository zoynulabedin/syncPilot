## Merge verification — 2026-11-02

Resolved 22 add/add conflicts into main, preserving the implementation branch. Fixed unused automatic-sync type import and separated browser-safe domain errors so the stock-ledger page builds without Node crypto. `npm run check` passes: typecheck, lint, 85 unit tests, production client/server build. 44 database tests were skipped by the unit command; explicit integration run failed because PostgreSQL localhost:5433 is unavailable. Docker daemon/application is unavailable. Automatic-sync service exists but management UI remains unfinished; removed its dead navigation link. Production acceptance and previously listed release gates remain open. No live store writes or deployment performed.

# SyncPilot implementation status

Date: 2026-11-02 (Asia/Dhaka). Branch: `codex/complete-syncpilot`. Feature milestone: `dc7ca9a`; foundation base: `bdcc5ee`.

## Implemented this milestone

Searchable, paginated product/variant/location mappings and imported-resource suggestions; paginated job, receipt, plan, conflict, reconciliation and audit history; selected SEO title/description and variant SKU/taxability/inventory-policy adapters; owner-opted history retention; authenticated privacy receipts and uninstall erasure; optional durable operational webhook alerts; encrypted streaming backups and isolated restore drills; Coolify staging configuration and CI backup coverage.

Maintenance stages now fail independently with bounded retry cadence. A privacy/retention/alert failure cannot suppress job processing. Alert DNS lookup and HTTPS share one deadline, preventing an indefinitely stalled resolver or a late request after timeout.

The existing core includes online owner identity, offline encrypted sessions, both-owner challenge pairing, tenant/staff access controls, checkpointed discovery, explicit GID mappings, field ownership, exact expiring dry runs, single-use approvals, targeted writes, inventory CAS/idempotency, durable jobs/leases/locks, conservative uncertain-outcome recovery and reconciliation.

Code and configuration changes are in `app/`, `prisma/`, `scripts/`, `tests/`, `.github/workflows/check.yml`, `deploy/`, `docker-compose.production.yml`, `shopify.app.toml`, `.env.example` and `package.json`. Documentation records contracts, runbooks and release boundaries separately. The original untracked specification and nested checkout are preserved.

## Store decision and live evidence

The owner explicitly chose **Keep stores separate**. Both installations remain independent: no workspace pairing, no active policy, and both Shopify write switches are false. No live Shopify product/stock mutation, external alert delivery, production deployment, remote push or merge occurred.

- Quickstart: authenticated owner UI and worker verified; a fresh read-only import completed with 17 products, 26 variants and 2 locations after the new fields and migrations were installed.
- Rankup: its earlier read-only import is persisted as completed with 2 products, 13 variants and 1 location. Local metadata confirms its connection has no workspace.
- Local metadata check: 0 pairs and 0 active policies. A store's catalog selector exposes its own installation while unpaired.
- The expired development tunnel was replaced, and the embedded Quickstart preview renders again. Temporary tunnels must stay running and are not deployment hosting.

## Executed verification

- TypeScript, ESLint, production build and whitespace checks: PASS.
- Unit tests: **79 PASS**, including maintenance failure isolation and bounded DNS regressions.
- Fresh disposable PostgreSQL 17 integration: **41 PASS**, including 10,000 products, tenant/concurrency/CAS/approval checks, selected-field writes, history pagination, privacy isolation and alert transition/retry behavior.
- Built-server HTTP tests: **4 PASS**, including signed synthetic privacy acceptance and forged-webhook/auth rejection. These use synthetic credentials and are not live Shopify webhook acceptance.
- Fresh migration/schema parity: PASS. All **5 migrations** are applied locally. The three new additive migrations were backed up and applied without replacing the application database.
- Encrypted backup/restore drill: PASS using PostgreSQL 17 client programs in the local container. Five migrations and one synthetic encrypted session restored; session decryption succeeded and a wrong session key was rejected. The application database was not replaced.
- Docker image `syncpilot:verified-20261102`: PASS.
- Expanded query selections and literal SEO/variant mutation inputs: VALID against Admin GraphQL **2026-10**. No new access scope was added.
- Earlier dependency audit: 0 high/critical findings; moderate findings remain. This was not rerun for the later script-only package changes.

Evidence is in ignored `local-check-results/continued-*.log` and `preview-*.log`. CI is configured for these checks but has not run remotely. Local synthetic responses and schema validation do not establish live write acceptance.

## Migrations, security and deployment impact

Deploy all forward migrations before new application/worker code. Runtime write switches remain false. External alerting additionally requires an operator-configured HTTPS endpoint/host allowlist and owner opt-in; retention is also off by default. Backups require a separate recoverable backup key and the persistent session key on a trusted operator host with compatible PostgreSQL client tools. The application image does not contain those tools.

Product/variant updates retain a read-to-write concurrency gap because those Shopify APIs do not offer inventory-style CAS. Inventory remains authoritative-source mode only; no shared-pool safety claim is made. Privacy erasure preserves the other store's private catalog and sessions in integration tests. Production key management, monitoring and offsite recovery still require operational acceptance.

## Remaining scope and next action

The full master specification is **incomplete**. Advanced product creation/options/media/metafield/collection adapters, shared-pool reservation/allocation, bounded unattended consent, broader role delegation, ingress/per-user rate limits and complete production acceptance remain. Policy selectors still cap at 50 policies and 20 recent previews; separate history pages paginate.

Next deployment input is the intended Coolify project/server and HTTPS staging domain, with credentials supplied through secret storage. Staging authentication, real signed Shopify event delivery, offsite encrypted restore, external receiver/monitoring acceptance and rollback rehearsal remain. Cross-store pairing and write pilots were intentionally not performed under the owner's current decision; reconsider them only if the owner later changes that decision and defines stock/field authority.

See `REMAINING_WORK.md`, `COOLIFY_STAGING.md`, `API.md`, `SECURITY.md`, `SHOPIFY_CONTRACTS.md` and `RUNBOOK.md`. Do not label this production-ready or the whole specification complete.
