# SyncPilot architecture

React Router loaders/actions authenticate through Shopify, derive owner/staff authority from an online session, and call scoped control-plane services. PostgreSQL stores pairing, memberships, snapshots, explicit GID mappings, policies, previews, jobs, attempts, conflicts, reconciliation and audit metadata. Shopify credentials stay in encrypted session storage and never enter loader data.

The independently runnable worker polls PostgreSQL durable jobs. PostgreSQL is the queue and outbox authority; there is no BullMQ dispatcher in this release. Redis is provisioned for future queue acceleration and is checked by readiness when configured. Losing Redis cannot lose PostgreSQL work; readiness may report the configured dependency unavailable.

## Data path

1. The Shopify library verifies a webhook HMAC.
2. A unique shop/delivery receipt is persisted. The worker transactionally turns RECEIVED receipts into idempotent jobs and marks dispatch state.
3. Imports paginate products, variants, locations and each inventory item's location levels. Checkpoints advance only after persistence. Completed imports remove observations not seen in that run.
4. Active field policies and explicit mappings identify authorized comparisons. Events and scheduled reconciliation prepare findings and pending exact plans.
5. An online verified owner activates a reviewed policy and separately approves an unexpired exact plan. A serializable transaction consumes it once and creates an APPLY_PREVIEW job.
6. The worker claims a leased job with row/source locks. It checks the active pair, installations, owner membership proofs, policy, approval, mapping, write flags, source/target hashes and exact changes against live Shopify state.
7. Resource locks serialize SyncPilot writers. Inventory uses expected target quantity and a stable Shopify idempotency key. Product and price writes target selected fields without productSet list replacement.
8. Per-resource remote outcomes, job attempts and audit records are persisted. Unknown outcomes are held, not blindly replayed. Read work retries with bounded backoff and checkpoints.

## Revocation and concurrency

Pause/disconnect/uninstall/scope changes revoke future work and approvals. Workers recheck consent after remote preflight and immediately before mutations. Requests already accepted by Shopify cannot be recalled. Product/price APIs do not provide inventory-style CAS, so concurrent third-party edits still have a narrow check-to-write gap. See SECURITY.md.

Inventory supports one authoritative source, mapped inventory items and locations, available quantity and a nonnegative safety buffer. Shared pools and two-way numerical mirroring are unsupported. Reverse product policies may own disjoint fields.

## Operational boundaries

Local Shopify CLI starts web and worker with the same injected app environment. Deployment uses separate web/worker processes and a one-time migration task. `/health` is liveness; `/ready` checks PostgreSQL and configured Redis and returns generic status. Neither proves Shopify release acceptance.

Imports persist live observations incrementally; snapshots are not transactionally frozen full-catalog point-in-time images. Apply always rereads affected Shopify resources. Catalog import callers are owner-authorized; cross-store imports require an active pair. Large imported identities can be mapped via full GIDs even when suggestion/history displays are bounded.
