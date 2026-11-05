# SyncPilot architecture

React Router loaders/actions authenticate through Shopify, derive owner/staff authority from an online session, and call scoped control-plane services. PostgreSQL stores pairing, memberships, snapshots, explicit GID mappings, policies, previews, automatic consents, jobs, attempts, conflicts, reconciliation, request budgets, the manual stock ledger and audit metadata. Shopify credentials stay in encrypted session storage and never enter loader data.

The independently runnable worker polls PostgreSQL durable jobs. PostgreSQL is the queue and outbox authority; there is no BullMQ dispatcher in this release. Redis is provisioned for future queue acceleration and is checked by readiness when configured. Losing Redis cannot lose PostgreSQL work; readiness may report the configured dependency unavailable. The worker polls for jobs about once a second when idle. Each worker process also runs independent maintenance stages (reconciliation scheduling, automatic sync scheduling, privacy, retention, rate-limit cleanup, alert scheduling) about once a minute, checked at the start of a cycle, so a long-running job delays them; a failing stage is logged and does not block jobs.

## Time

Prisma `DateTime` columns are `TIMESTAMP(3)` without time zone holding UTC wall-clock time, and raw SQL compares them with `NOW()`/`CURRENT_TIMESTAMP`. PostgreSQL converts between the two using the session `TimeZone`, so leases, schedules and plan and consent expiries are correct only in UTC. `/ready` reports not-ready and the worker refuses to start (after waiting out an unreachable database) when the zone is not UTC. The check runs at worker startup and on every `/ready` probe, not continuously inside a running worker. The web process keeps serving requests either way; taking it out of rotation is left to the orchestrator acting on readiness.

## Data path

1. The Shopify library verifies a webhook HMAC. Catalog topics then consume a per-shop budget; lifecycle and compliance topics do not.
2. A unique shop/delivery receipt is persisted. The worker transactionally turns RECEIVED receipts into idempotent jobs and marks dispatch state.
3. Imports paginate products, variants, locations and each inventory item's location levels. Checkpoints advance only after persistence. Completed imports remove observations not seen in that run.
4. Active field policies and explicit mappings identify authorized comparisons. Events and scheduled reconciliation prepare findings and pending exact plans.
5. An online verified owner activates a reviewed policy and separately approves an unexpired exact plan. A serializable transaction consumes it once and creates an APPLY_PREVIEW job.
6. Alternatively, for a descriptive-fields policy, an owner grants bounded automatic consent. The worker's automatic-sync stage (only while `AUTOMATIC_SYNC_ENABLED` and `SYNC_WRITE_ENABLED` are both `true`) runs about once a minute per worker process and takes up to 25 due consents per pass, oldest first, advances each one's next run time even when it queues nothing, and queues an AUTO_PREVIEW when the consent still has budget and the policy is active with no preview/apply job in flight. An exhausted consent stays ACTIVE until expiry so an already-queued write can finish. The AUTO_PREVIEW compares live state and, within the consent's budgets and fields, records an approved exact plan and an APPLY_PREVIEW job; otherwise it holds the consent.
7. The worker claims a leased job with row/source locks. It checks the active pair, installations, owner membership proofs, policy, approval or consent, mapping, write flags, source/target hashes and exact changes against live Shopify state.
8. Resource locks serialize SyncPilot writers. Inventory uses expected target quantity and a stable Shopify idempotency key. Product and price writes target selected fields without productSet list replacement.
9. Per-resource remote outcomes, job attempts and audit records are persisted. Unknown outcomes are held, not blindly replayed. Read work retries with bounded backoff and checkpoints.

## Revocation and concurrency

Pause/disconnect/uninstall/scope changes revoke future work and approvals. For standing automatic consent this holds too: pausing, activating or saving a policy revokes that policy's ACTIVE and HELD consents, and mapping changes, disconnect, uninstall and scope change revoke every consent in the workspace, in the same transaction that makes the change, with an `AUTOMATIC_CONSENT_REVOKED` audit event per consent. Workers recheck consent after remote preflight and immediately before mutations. Requests already accepted by Shopify cannot be recalled. Product/price APIs do not provide inventory-style CAS, so concurrent third-party edits still have a narrow check-to-write gap. See SECURITY.md.

Inventory supports one authoritative source, mapped inventory items and locations, available quantity and a nonnegative safety buffer. Shared pools and two-way numerical mirroring are unsupported. Reverse product policies may own disjoint fields.

The stock-pool ledger (`StockPool`, `StockAllocation`, `StockReservation`, `StockLedgerOperation`) is changed only by owner actions on `/app/stock-pools`, in serializable transactions. Adjusting, allocating, reserving and completing carry an expected-version check and an idempotent operation key; creating a pool is guarded by its unique reference. No worker stage, webhook or Shopify call reads or writes it. The `CatalogOperation` table from the structural-adapter migration is unused.

## Operational boundaries

Local Shopify CLI starts web and worker with the same injected app environment. Deployment uses separate web/worker processes and a one-time migration task. `/health` is liveness; `/ready` checks PostgreSQL, the UTC session time zone and configured Redis and returns generic status. Neither proves Shopify release acceptance.

Request budgets are counted in PostgreSQL (`RequestRateLimit`), so they are shared across web replicas, and only after Shopify authentication: per shop and per user for admin routes, per shop for catalog webhooks. Per-IP and flood limits are left to the reverse proxy; the app does not trust forwarding headers.

Imports persist live observations incrementally; snapshots are not transactionally frozen full-catalog point-in-time images. Apply always rereads affected Shopify resources. Catalog imports are started by owners or `OPERATOR` staff; cross-store imports require an active pair. Large imported identities can be mapped via full GIDs even when suggestion/history displays are bounded.
