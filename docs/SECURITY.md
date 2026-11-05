# SyncPilot security boundaries and release conditions

This implementation is an approval-based synchronization system. It is not evidence of production acceptance, unattended automatic stock synchronization, or a guarantee against overselling across independent Shopify checkouts. The only standing consent is an explicit, bounded owner grant for descriptive product fields, behind its own deployment switch. Deployment write switches remain off until the operator completes the development-store acceptance gates.

## Trust boundaries

- Shopify authenticates every app loader/action through its official React Router integration and verifies webhook HMAC before data enters the inbox.
- Online session `associated_user.account_owner` establishes management authority. A domain, frontend subject, arbitrary user ID or checkbox cannot create a Shopify owner.
- A shop installation does not authorize another shop's data. Cross-store access requires the current installation, active workspace, exactly two active connections, verified pair and authorized workspace membership. Workers independently check the same store pair and persisted owner approval proofs.
- Staff grants are scoped to Shopify shop plus user ID and exist only inside an active verified pair. `VIEWER` is read-only. `OPERATOR` can additionally queue catalog imports and prepare dry runs and reconciliation comparisons, which read Shopify but never write. Only a verified Shopify store owner can approve plans, activate or pause policies, change policies, mappings or settings, manage staff and stock pools, cancel or retry jobs, or grant or revoke automatic consent. Owners cannot use this application to promote staff to Shopify owner. Unknown staff receive no cross-store access; staff on an unpaired store see read-only pages and never get operator capability, even if an old `OPERATOR` row exists.
- Pairing challenge hashes and Shopify credentials never appear in loader data. The pairing challenge is a separate high-entropy secret shown once to the initiating owner, not a Shopify token.

Application services expect an `Actor` derived only after `authenticate.admin(request)`. They are server modules, not public APIs accepting a browser-supplied actor. Do not add routes that deserialize an actor or proxy arbitrary GraphQL using an offline token.

## Pairing protections

The initiating store owner names an already-installed destination and attests distribution eligibility. The destination owner independently authenticates, presents the one-time challenge and attests eligibility. The original initiating owner confirms. A serializable transaction creates the pair, workspace and owner membership proofs atomically. Self-pairs, occupied stores, concurrent pending requests, incorrect challenges, expired requests and replay are rejected. Five incorrect challenges lock the request; codes expire after 15 minutes.

Both-owner attestation is recorded as attestation. This application does not claim to discover or verify the Shopify Plus organization ID through Admin GraphQL. Before installing or activating on real stores, obtain the actual eligibility confirmation. Never use manual token sharing to bypass Shopify distribution rules.

A store ownership transfer requires disconnect/re-pair to establish new owner approval records. SyncPilot does not detect a transfer: until disconnect, the former owner's `OWNER` membership stays active and automatic consent they granted still passes the worker's owner check. Disconnect revokes pair/memberships, pauses policies, revokes automatic consents, revokes pending and approved plans and cancels outstanding work while retaining audit history. Reopening a store installation must not restore the revoked workspace pair.

## Write authorization

All of the following are required:

1. An active verified pair and two active installations.
2. Explicitly verified product/variant/location identities relevant to the operation.
3. A policy with one source per selected field; inventory has exactly one authoritative source.
4. A reviewed exact dry-run plan with no held items and at most 1,000 changes.
5. A current store-owner approval, unexpired plan, stable idempotency key and active policy.
6. Matching live source and destination observations immediately before applying each resource.
7. Deployment `SYNC_WRITE_ENABLED=true`; inventory additionally requires `INVENTORY_WRITE_ENABLED=true`.

For an automatic run, the owner review and approval in items 4 and 5 are replaced: the run's plan (at most 100 changes, no held items, consented fields only) is created and approved by `system:automatic-sync`, and no owner reviews it. What authorizes it instead is an active, unexpired, unchanged bounded consent whose granting owner still has an active owner membership, granted against an owner-reviewed plan, plus `AUTOMATIC_SYNC_ENABLED=true`. The plan still expires (within 15 minutes, never after the consent), the write still uses a stable key (`automatic-apply:<jobId>`), and the policy must still be active. See "Bounded automatic consent" below.

The string must be exactly lowercase `true`. Default, unset and other values mean disabled. The UI cannot change these deployment variables. The backend and worker both enforce them.

Webhooks and scheduled reconciliation detect changes and prepare proposals. They do not grant new mutation approval. Bulk destructive operations, product deletion/creation, media, options, metafields and collections (structural catalog adapters) are unavailable; the unused `CatalogOperation` table grants nothing. Bidirectional product ownership is expressed through disjoint one-way field policies. Shopify-connected shared inventory allocation and two-way stock mirroring are not available. The Stock pools page is a manual, owner-only planning ledger; changes to an existing pool carry a version check and an idempotent operation key. It never writes Shopify quantities, never imports orders or sales, and does not prevent overselling.

## Bounded automatic consent

Automatic sync is the one exception to per-plan approval, and it is narrow. It runs only while `AUTOMATIC_SYNC_ENABLED` and `SYNC_WRITE_ENABLED` both equal exactly `true`; otherwise nothing is scheduled and granting is refused. A verified store owner with an active owner membership grants it on `/app/automatic-sync` for one policy that is enabled, active, owner-approved, one-way, product-only (no inventory, price or variant sync) and owns only title, description HTML, vendor, product type, tags, SEO title and SEO description. Every product mapping must be verified. The grant must be backed by a fresh exact plan with 1 to 100 changes, no held items and only owned fields, which is rebuilt and compared before the consent is stored. The owner sets whole-number bounds: duration and interval 5–1,440 minutes, 1–100 runs, 1–1,000 total changes and 1–100 changes per run. One ACTIVE consent per policy.

Each run compares live state and creates an approved exact plan only if it fits the remaining run and change budgets and contains only consented fields; otherwise the consent is HELD and nothing is written. The resulting write goes through the normal `APPLY_PREVIEW` path, which rechecks pair, policy, mappings, write switches and live hashes, and locks the consent row while it checks that the consent is ACTIVE, unexpired, unchanged (its fingerprint covers policy, mappings and pair) and that the approving owner still has access. A policy or mapping change revokes the consent in the same transaction (next paragraph). Only a consent an earlier release left ACTIVE can reach a run with a changed fingerprint; that run fails with `CONSENT_CHANGED` and marks it HELD.

Pausing, activating or saving a policy revokes that policy's ACTIVE and HELD consents; mapping changes, disconnect, uninstall and scope change revoke every ACTIVE and HELD consent in the workspace. Each of these lifecycle and configuration revocations writes an `AUTOMATIC_CONSENT_REVOKED` audit event with `details.reason` set to `POLICY_PAUSED`, `POLICY_ACTIVATED`, `STORES_DISCONNECTED`, `APP_UNINSTALLED`, `SCOPES_CHANGED` or `CONFIGURATION_CHANGED`; the actor is the store owner, or `shopify:webhook` for uninstall and scope change. An owner's direct revoke from `/app/automatic-sync` writes the same action with no `details`, so an audit filter on `details.reason` misses it. The same transaction cancels queued automatic jobs, and running ones on pause, activation, disconnect, uninstall, scope change and direct revocation; saving a policy or mapping already requires the policy to be paused. An owner can revoke an ACTIVE or HELD consent at any time, including while the deployment switch is off. Revocation, like pause, cannot recall a mutation Shopify already accepted. Automatic sync has not been exercised against live stores.

## Concurrency, recovery and known limits

Durable jobs use leases, fencing and bounded attempts. Target resource locks serialize SyncPilot writers. Exact approvals are single-use; concurrent approval requests create one job. Changed mappings/configuration invalidate plans and queued writes. Workers recheck policy, pair, owner proofs, mapping and lease before resource mutations. Unknown mutation outcomes are held for review rather than replayed blindly. A new comparison is required to repair a failed/uncertain write.

Inventory mutations include the expected destination quantity and Shopify idempotency contract. If stock changes between preview/read and mutation, compare-and-set should reject the write. Production acceptance must empirically cover concurrent sales, restock, duplicate delivery and a crash after remote success.

Shopify scalar product and price mutations do not provide the same inventory compare-and-set guarantee. Re-reading fields immediately before mutation narrows the check-then-write gap but cannot prevent every simultaneous merchant/app edit. Post-write verification detects some divergence. Do not promise strict cross-client atomicity or “no silent overwrites” for arbitrary concurrent editors.

Pause, cancellation, consent revocation, disconnect and uninstall stop future authorized resource operations; they cannot unsend a mutation Shopify already accepted. Inspect live state and audit evidence after an in-flight cancellation. An asynchronous two-store app cannot guarantee zero overselling in independent checkouts; buffers and reconciliation mitigate risk without replacing a shared stock reservation authority.

## Session credentials and encryption

The session storage adapter wraps Shopify's Prisma adapter. With `SESSION_ENCRYPTION_KEY` configured, access and refresh tokens are encrypted with AES-256-GCM, a fresh nonce, and authenticated context including shop, session ID and token purpose. Ciphertext copied to a different session or purpose fails authentication. Production requires a key encoding 32 bytes. Keep it in the deployment secret manager and back it up separately from the database.

Development without a key can still store plaintext tokens. Existing legacy plaintext rows are readable and become encrypted on a subsequent save. The explicit npm run sessions:encrypt maintenance command migrates legacy access/refresh rows with optimistic update conditions and never prints credentials. Before production, configure the persistent key, run that migration or controlled reauthentication, and verify no plaintext rows remain. Do not claim all backups are encrypted solely because new session saves use encryption.

Key loss makes encrypted sessions unreadable and requires controlled reauthentication. Replacing a key without a migration makes old ciphertext unreadable. No multi-key online rotation or managed KMS integration is implemented. Plan rotation, restore and incident response before production.

## Request, data and logging controls

Actions validate URL-encoded bodies, bound them to 64 KiB, reject explicit foreign origins and rely on Shopify session authentication. Zod validates domain inputs and bounds numeric settings and fields. Pairing attempts are bounded independently.

Request budgets apply only after Shopify authentication succeeds, so rejected traffic never consumes a budget or touches the `RequestRateLimit` table. Admin routes: per verified shop 600 reads and 120 writes per minute, per verified user 180 reads and 30 writes per minute. Webhooks: only `products/create`, `products/update`, `products/delete` and `inventory_levels/update`, 1,200 per minute per shop after HMAC verification; over budget returns 429 with `Retry-After: 60`; Shopify retries, and scheduled reconciliation detects remaining drift and prepares a plan for review. `app/uninstalled`, `app/scopes_update`, compliance webhooks and `/auth/login` (which only validates the shop parameter and redirects) are never limited. Budgets live in PostgreSQL, so they are shared across web replicas. If the limiter's database call fails, authenticated admin requests and limited catalog webhooks fail closed with 503 and `Retry-After: 10`; lifecycle and compliance webhooks are never blocked by it. The app never trusts `X-Forwarded-For` or other forwarding headers, so **per-IP and flood limits must be configured at the reverse proxy** (Coolify/Traefik/Cloudflare) for `/app`, `/auth` and `/webhooks` before production. Without them nothing bounds unauthenticated traffic, and each request still costs the Shopify authenticator's verification work (for webhooks, reading the body and, once the HMAC passes, loading the offline session).

Shopify's webhook HMAC covers only the body. The `X-Shopify-Topic` and `X-Shopify-Shop-Domain` headers are unsigned; the library and this app trust them. Someone holding a captured, validly signed delivery could replay it with a lifecycle topic header to avoid the catalog budget, or with varied shop values to create extra limiter rows (case and whitespace variants share one bucket). Both need a captured signed body or the app secret.

Shop domains are canonical `*.myshopify.com` names and Shopify IDs are checked by resource type. There is no user-supplied remote URL import, arbitrary GraphQL endpoint or token entry form. Product descriptions are displayed as escaped text; never introduce unsanitized HTML rendering. No customer/order data is required for this scope.

Audit records identify actor, operation, shop/workspace, resource and sanitized metadata. Do not log tokens, authentication headers, raw webhook payloads or arbitrary GraphQL responses. Session storage encryption does not encrypt all catalog/audit columns; database access control and encrypted infrastructure/backups remain deployment responsibilities. Public probes return generic status and do not expose topology or credentials.

Retention is off by default and requires persisted owner opt-in. Daily bounded cleanup removes eligible old closed history and audit records, while open conflicts, failed/held jobs and current catalog data are preserved. Authenticated privacy deliveries discard customer payloads; shop erasure removes the uninstalled store's data and shared workspace history without deleting the other store's private catalog or sessions. A changed/reinstalled connection holds erasure for review. Restore operators must maintain an independent erasure register and replay it before enabling restored backups.

External alerts require an operator-configured HTTPS destination/host allowlist and workspace-owner opt-in. The transport rejects private/reserved addresses, pins a validated address for the TLS request, does not follow redirects, and discards response bodies. Durable retries reuse a delivery ID; receivers must deduplicate it. See NOTIFICATIONS.md. No real destination has been contacted during development. The audit table remains an application audit log, not cryptographically immutable storage.

## Required deployment checks

- Separate development, staging and production app configurations, domains, tokens, databases and queues.
- Keep local PostgreSQL and Redis on loopback; expose only the HTTPS app endpoint through the intended ingress.
- Configure per-IP and flood limits at the reverse proxy for `/app`, `/auth` and `/webhooks`.
- Run PostgreSQL with session `TimeZone` UTC. Leases, schedules and plan and consent expiries depend on it. Otherwise `/ready` reports not-ready and the worker refuses to start; the web process still serves requests unless the proxy or orchestrator removes it on readiness failure. A running worker is not re-checked.
- Keep `AUTOMATIC_SYNC_ENABLED` off until automatic sync has passed a live-store pilot.
- Configure secret storage, encryption key backups, TLS, database/Redis authentication and least-privilege runtime access.
- Run dependency auditing, typecheck, lint, unit tests, real fresh-database integration tests and build. Investigate findings instead of labelling the application secure because it compiles.
- Verify two eligible development stores: owner sessions, pairing, import, exact field/price updates, inventory CAS, real HMAC delivery, uninstall, scope loss, reauthentication and unknown-outcome recovery.
- Demonstrate restore from an encrypted backup into an isolated environment. Prove the application can decrypt restored sessions with the separately stored key.
- Define monitoring, release authority, rollback and support ownership. Keep all production write switches off until explicit approval.

For suspected compromise, first disable deployment write switches (including `AUTOMATIC_SYNC_ENABLED`) and stop workers, then revoke affected Shopify credentials, isolate the deployment and preserve sanitized audit/attempt evidence. Rotate secrets with a migration/reauthentication plan; never paste credentials or raw customer data into support chat.
