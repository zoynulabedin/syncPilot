# Decisions and open requirements

Date: 2026-11-01 (Asia/Dhaka). Branch: codex/complete-syncpilot.

## Implemented choices

- Preserve the foundation's private/custom distribution and PostgreSQL schema rather than adopt main's public-app sample configuration or SQLite migration.
- Use online Shopify owner identity for management, offline per-shop sessions for workers, and explicit read-only staff membership.
- Require both owners to attest distribution eligibility, a destination challenge acceptance and source confirmation. No organization API verification is claimed.
- PostgreSQL is the durable queue/outbox authority. Redis is provisioned, not a second source of job truth.
- Owner approval applies to exact plans. No standing/unattended write consent is inferred from pairing or policy activation.
- Support safe targeted existing-product fields and prices first. Destructive/list-structure operations remain unsupported.
- Inventory supports one explicit authoritative source and available quantities. No shared-pool formula or bidirectional stock behavior is invented.
- Local PostgreSQL uses 5433 and Redis 6380 to preserve other host services. Deployment flags stay false.

## User-supplied second store

The owner supplied rankup-ai.myshopify.com. Read-only admin inspection showed the store's dev label and an existing SyncPilot app link. No new installation, pairing approval or stock/product mutation was performed. The local database had only the Quickstart installation at the last check; both live owner flows still need verification.

## Activation decisions still required

- Confirm store distribution eligibility and authorized owners on both actual installations.
- Define physical stock authority and how destination sales feed that authority; identify exact inventory locations and whether stock pools are shared or independent.
- Approve field ownership, currency handling, buffers and the selected pilot resources.
- Supply staging domain/app configuration, hosting access, secrets, alert destination and backup owner.
- Decide when to implement currently unsupported product creation, option/media/metafield/collection adapters, shared stock ledger and unattended synchronization.

These are explicit release boundaries. Do not label the full master specification or production deployment complete until their empirical gates pass.
