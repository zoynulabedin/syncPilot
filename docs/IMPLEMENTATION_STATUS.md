# SyncPilot implementation status

Date: 2026-11-01 (Asia/Dhaka). Branch: codex/complete-syncpilot. Base: bdcc5ee.

## Implemented

Verified owner pairing, tenant boundaries and staff access; checkpointed catalog, variant, location and inventory discovery; explicit GID mappings; field ownership policies; exact expiring dry runs and approvals; targeted product/price and authoritative inventory CAS writers; durable inbox/jobs, worker leases, single-writer locks, retry/dead-letter/conflict recovery; read-only reconciliation; operational UI, settings, in-app alerts, audit, encrypted sessions, readiness, CI, container and backup tooling.

Shopify writes remain disabled. Events and schedules generate reviewable proposals rather than unattended write approval. No live Shopify product/stock mutation, production deployment, main merge or remote push was performed.

## Executed verification

- TypeScript, ESLint and production build: PASS.
- Unit tests: 49 PASS (integration cases are skipped in the separate unit run).
- Fresh disposable PostgreSQL integration: 30 PASS, including a 10,000-product fixture, real database concurrency/approval/tenant checks, simulated inventory CAS, uncertain outcomes, cancellation and lifecycle revocation.
- Built-server HTTP smoke: 3 PASS. Liveness/readiness, invalid-token rejection and forged webhook rejection are checked using synthetic credentials; these are not authenticated browser tests.
- Prisma validation/generation and both forward migrations: PASS locally; migrations from an empty database also pass in integration tests.
- Session encryption migration: 1 legacy local session encrypted without printing credentials. Adapter/authenticated-encryption persistence tests pass.
- Local homepage, health, readiness and HTTPS tunnel health returned HTTP 200 in the recorded session. PostgreSQL 17/Redis were healthy and the separate worker reported writes disabled.
- Local database backup and isolated restore rehearsal: PASS, with 2 applied migrations. The application database was not replaced. Offsite encrypted restore/token decryption acceptance is still required.
- Dependency audit after targeted overrides: 0 high/critical findings; moderate findings remain.
- Polaris/NavMenu validation: PASS for the generated components. Final authenticated browser navigation remains unverified because browser session inspection failed and desktop-app access was blocked.
- Local Docker build: PASS.

Evidence is in ignored local-check-results/final-*.log files. Test Shopify responses are synthetic and do not establish live-store acceptance.

A final navigation regression fix separates the business `store` filter from Shopify’s reserved `shop` authentication parameter. Six loader-level tests cover paired-store selection, preserved actor context and third-store rejection.

## Outstanding scope and release gates

The full master specification is incomplete. Both-owner live acceptance on Quickstart and rankup-ai.myshopify.com, real webhook delivery and explicitly approved small product/price/inventory pilots, merchant stock authority, staging hosting/domain/secrets, ingress limits, alerting, offsite restore and production sign-off remain.

Advanced creation/options/media/metafield/collection adapters, shared-pool allocation ledger, unattended mutation consent, external alert delivery, automatic retention/privacy operations, and full mapping-history pagination are not implemented. Product/price APIs also retain a documented read-to-write concurrency gap; inventory has API CAS.

See RUNBOOK.md, PROJECT_AUDIT.md, API.md, SECURITY.md, SHOPIFY_CONTRACTS.md and DECISIONS.md. Do not label this production-ready or the whole specification complete.
