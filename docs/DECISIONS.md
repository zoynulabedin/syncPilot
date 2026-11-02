# Decisions and open requirements

Date: 2026-11-02 (Asia/Dhaka). Branch: codex/complete-syncpilot.

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

The owner supplied rankup-ai.myshopify.com and explicitly answered **Keep stores separate** when asked about read-only pairing. Both existing installations are independently connected. Quickstart's completed read-only import contains 17 products/26 variants/2 locations; Rankup's contains 2 products/13 variants/1 location. Local metadata confirms no workspace association, no pair, no active policy and disabled product/inventory write switches. Do not create or accept a pairing request under the current instruction.

The added field adapters cover selected SEO title/description, SKU, taxability and inventory policy. They do not authorize those fields for any real store. Retention and external alert delivery require owner opt-in; no destination is configured or contacted. The encrypted backup CLI is operator-host tooling, with separate backup/session keys. All five additive/initial migrations have been applied locally after a backup.

## Activation decisions still required

- If the owner later requests pairing, confirm distribution eligibility and obtain both actual owners' approvals then. The current separate-store decision remains in force.
- Define physical stock authority and how destination sales feed that authority; identify exact inventory locations and whether stock pools are shared or independent.
- Approve field ownership, currency handling, buffers and the selected pilot resources.
- Supply staging domain/app configuration, hosting access, secrets, alert destination and backup owner.
- Decide when to implement currently unsupported product creation, option/media/metafield/collection adapters, shared stock ledger and unattended synchronization.

These are explicit release boundaries. Do not label the full master specification or production deployment complete until their empirical gates pass.
