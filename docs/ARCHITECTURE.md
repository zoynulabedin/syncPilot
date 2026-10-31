# SyncPilot Architecture — Security-first Multi-store Sync

## Deployment
- React Router embedded UI -> authenticated server routes -> PostgreSQL/Prisma
- Shopify per-store tokens managed through @shopify/shopify-app-session-storage-prisma
- Planned: Redis/BullMQ jobs (separate web and worker process)
- Planned: verified pairing, snapshot importer, mapping engine, reconciliation worker

## Ingest and processing
1. Shopify webhook arrives on a route.
2. Shopify library verifies HMAC with `authenticate.webhook(request)`.
3. Store metadata with unique (shopDomain, deliveryId); reply quickly.
4. Planned worker claims inbox event, finds enabled policy, checks tenant+pairing.
5. Enqueue one job per authorized destination and mapped resource.
6. Worker loads latest source and target states, validates mapping and field ownership.
7. Apply mutation with Shopify API throttling, idempotency and CAS where appropriate.
8. Record attempts and audit events; on stale state, hold a conflict.
9. Periodic reconciliation compares snapshots to repair missed events.

**Foundation currently stops at step 3.**

## Security boundaries
- Two installations do not imply two stores are authorized to share data.
- Only verified workspace pairing can authorize cross-store operations.
- Each Admin GraphQL request is sent with the token of its own installed store.
- Tokens stay server side. Separate environment secrets and encryption at rest.
- Scope cross-store lookups by workspaceId and check current shop membership.
- No SKU-only variant association.
- Destructive operations are disabled by default.
- Uninstall revokes write operations, marks ShopConnection as UNINSTALLED.

## Product vs inventory source of truth
Product: field-by-field ownership (title/description/variants/price/status).
Inventory: explicit quantity authority, not naive A <-> B mirroring.
Multi-store shared stock cannot be safely managed with independent unconditional stock overwrites.

## Operational controls
- event delivery ID dedupe + job idempotency key
- Retryable errors / dead-letter queue / bounded exponential backoff
- Per-store GraphQL cost throttling
- CAS on absolute inventory quantities; never opt out by default
- Manual approvals for mapping conflicts, deletion and bulk changes
- 6-hour or daily reconciliation (configurable), with dry-run mode

## Remaining implementation
Pairing endpoints, UI, multi-store scope verification, queue, workers, GraphQL writers, reconciliation, tests, deployment secrets and operational runbook.
