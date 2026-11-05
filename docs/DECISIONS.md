# Decisions and open requirements

Date: 2026-11-03. Branch: `main` at `f8a83f2`, with today's changes uncommitted.

## Implemented choices

- Preserve the foundation's private/custom distribution and PostgreSQL schema rather than adopt main's public-app sample configuration or SQLite migration. The template's SQLite `Session` migration that arrived with the main merge was removed on 2026-11-03 because it broke `prisma migrate deploy` on every PostgreSQL database; a database that already recorded it as failed needs the RUNBOOK P3009 recovery.
- Use online Shopify owner identity for management, offline per-shop sessions for workers, and explicit staff membership with two roles: `VIEWER` (read-only) and `OPERATOR` (can also prepare imports, dry runs and reconciliation comparisons). Owner authority is never delegated.
- Require both owners to attest distribution eligibility, a destination challenge acceptance and source confirmation. No organization API verification is claimed.
- PostgreSQL is the durable queue/outbox authority. Redis is provisioned, not a second source of job truth.
- Owner approval applies to exact plans. No standing/unattended write consent is inferred from pairing or policy activation. The only standing consent is an explicit owner grant on `/app/automatic-sync`, bounded in time, runs and changes, limited to descriptive product fields and gated by `AUTOMATIC_SYNC_ENABLED`.
- Support safe targeted existing-product fields and prices first. Destructive/list-structure operations remain unsupported.
- Inventory supports one explicit authoritative source and available quantities. No shared-pool formula or bidirectional stock behavior is invented.
- Request budgets are enforced only after Shopify authentication (per shop and user for admin, per shop for catalog webhooks). The app never trusts forwarding headers; per-IP and flood limits belong to the reverse proxy.
- PostgreSQL must run with session `TimeZone` UTC. The app refuses to become ready and the worker refuses to start otherwise; it never changes database settings itself.
- Local Compose binds PostgreSQL (default 5432) and Redis (default 6380) to loopback; ports are overridable in `.env`. Deployment flags stay false.

## Owner decisions recorded 2026-11-03

- Build the owner-facing automatic-sync page (done).
- Remove the unused structural catalog-operation code and its settings, but keep the `CatalogOperation` table in the schema (unused; privacy erasure still clears it). Structural catalog adapters stay unsupported.
- Keep stock pools as a manual planning ledger: no Shopify quantity writes, no order or sales import. It does not prevent overselling.
- Do not split `control-plane.server.ts` or `sync-engine.server.ts`; today's changes to them are formatting plus the listed fixes.
- The owner is updating the `shopify.app.toml` application/redirect URL placeholders and access scopes; they are not done yet.

## User-supplied second store

The owner supplied rankup-ai.myshopify.com and explicitly answered **Keep stores separate** when asked about read-only pairing. Both existing installations are independently connected. As recorded on 2026-11-02, Quickstart's completed read-only import contains 17 products/26 variants/2 locations; Rankup's contains 2 products/13 variants/1 location, and local metadata confirmed no workspace association, no pair, no active policy and disabled product/inventory write switches. Do not create or accept a pairing request under the current instruction.

The added field adapters cover selected SEO title/description, SKU, taxability and inventory policy. They do not authorize those fields for any real store. Retention and external alert delivery require owner opt-in; no destination is configured or contacted. The encrypted backup CLI is operator-host tooling, with separate backup/session keys. The migration set is now nine; the earlier development database had five applied after a backup on 2026-11-02 and was not re-checked on 2026-11-03. If `npm run dev` or `npm run setup` ran against it after the main merge (`d619e59`), it holds a failed SQLite migration row and refuses the remaining migrations with P3009 until that row is marked rolled back (RUNBOOK).

## Activation decisions still required

- If the owner later requests pairing, confirm distribution eligibility and obtain both actual owners' approvals then. The current separate-store decision remains in force.
- Define physical stock authority and how destination sales feed that authority; identify exact inventory locations and whether stock pools are shared or independent. The manual ledger does not answer this.
- Approve field ownership, currency handling, buffers and the selected pilot resources.
- Supply staging domain/app configuration, hosting access, secrets, reverse-proxy rate limits, alert destination and backup owner.
- Decide whether and when to enable automatic sync after a live pilot, and whether a HELD apply (unknown outcome) should stop a consent.
- Decide whether to implement structural catalog adapters (product creation, options, media, metafields, collections) or a Shopify-connected shared stock authority; otherwise drop the unused `CatalogOperation` table in a reviewed migration.

These are explicit release boundaries. Do not label the full master specification or production deployment complete until their empirical gates pass.
