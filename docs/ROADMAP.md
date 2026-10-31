# SyncPilot Engineering Roadmap

## Product goal

Privately synchronize selected Shopify product fields and inventory across two authorized stores with predictable field ownership and robust failure recovery. No budget assumptions.

## Stage 0 — Foundation (implemented on branch; validation pending)
- Shopify React Router app with embedded navigation and authentication
- PostgreSQL/Prisma schema and migration
- Current-store Products and Inventory read-only screens
- Webhook delivery inbox with HMAC verification via Shopify package and idempotent receipt storage
- Uninstall session cleanup
- All sync policies disabled by default

**Gate:** npm install, typecheck, prisma migrate deploy, and authenticated Shopify dev-store test must pass before merge.

## Stage 1 — Store onboarding and secure pairing
- Install same custom app on two stores in one Plus org
- Per-store installation health and OAuth session handling
- Two-admin verification, expiring pairing challenge, deny cross-tenant data leakage
- Validate authorization for every cross-store operation; no raw token in UI
- Revoke connection and pause jobs on uninstall

**Gate:** No store can initiate data reads from another store without verified pairing.

## Stage 2 — Catalog discovery and mapping
- Initial bulk catalog read and incremental pagination
- Product/variant ID pairing, SKU and barcode-assisted matching (never SKU-only)
- Location ID discovery and verified mapping
- Field ownership policies: product content, prices, statuses, options
- Dry-run diff screen with explicit approval

**Gate:** Ambiguous records remain quarantined; no destructive updates.

## Stage 3 — Product sync engine
- Queue-backed idempotent jobs, leased processing and retry/dead-letter flow
- One-way selected-field updates and safe create/update policies
- Echo-loop prevention and webhook dedupe
- Per-field conflict resolution and detailed audit trail

**Gate:** Idempotency, repeated webhook and partial-failure tests pass.

## Stage 4 — Inventory sync engine
- Explicit authoritative quantity source or centrally reserved allocation ledger
- InventoryItem and Location mapping; available/on-hand distinctions
- InventorySetQuantities with CAS and @idempotent per 2026-10 API
- Correct handling of order, cancellation, refund and restock signals
- Single-writer per stock key; recoverable transactional outbox
- Oversell protection buffers; reconciliation after delivery failures

**Gate:** Concurrency, double-delivery and stock drift tests pass under load.

## Stage 5 — Operations dashboard and two-way policies
- Sync rules editor and status controls
- Product/inventory mapping management UI
- Jobs, attempts, retries, conflicts, approvals
- Bidirectional product field ownership; two-way inventory only behind controlled stock authority
- Scheduled drift comparison and controlled repair

**Gate:** dry run and audit evidence accompany every high-risk change.

## Stage 6 — Production hardening
- Store scopes, token lifecycle, encryption, minimum permissions
- Rate-limit adaptive throttling and backpressure
- Sentry/OpenTelemetry metrics, alerts, backup/restore and SLOs
- Real two-store staging; pilot with selected SKUs; rollback plan
- Gradual production enablement, sign-off and documentation

## Explicit non-goals in foundation branch
No production automation, inventory writes, Shopify-to-Shopify product transfer, customer data, supplier integrations, billing or deployment completion.
