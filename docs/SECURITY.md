# SyncPilot security boundaries and release conditions

This implementation is an approval-based synchronization system. It is not evidence of production acceptance, unattended automatic stock synchronization, or a guarantee against overselling across independent Shopify checkouts. Deployment write switches remain off until the operator completes the development-store acceptance gates.

## Trust boundaries

- Shopify authenticates every app loader/action through its official React Router integration and verifies webhook HMAC before data enters the inbox.
- Online session `associated_user.account_owner` establishes management authority. A domain, frontend subject, arbitrary user ID or checkbox cannot create a Shopify owner.
- A shop installation does not authorize another shop's data. Cross-store access requires the current installation, active workspace, exactly two active connections, verified pair and authorized workspace membership. Workers independently check the same store pair and persisted owner approval proofs.
- Staff grants are read-only and scoped to Shopify shop plus user ID. Owners cannot use this application to promote staff to Shopify owner. Unknown staff receive no cross-store access.
- Pairing challenge hashes and Shopify credentials never appear in loader data. The pairing challenge is a separate high-entropy secret shown once to the initiating owner, not a Shopify token.

Application services expect an `Actor` derived only after `authenticate.admin(request)`. They are server modules, not public APIs accepting a browser-supplied actor. Do not add routes that deserialize an actor or proxy arbitrary GraphQL using an offline token.

## Pairing protections

The initiating store owner names an already-installed destination and attests distribution eligibility. The destination owner independently authenticates, presents the one-time challenge and attests eligibility. The original initiating owner confirms. A serializable transaction creates the pair, workspace and owner membership proofs atomically. Self-pairs, occupied stores, concurrent pending requests, incorrect challenges, expired requests and replay are rejected. Five incorrect challenges lock the request; codes expire after 15 minutes.

Both-owner attestation is recorded as attestation. This application does not claim to discover or verify the Shopify Plus organization ID through Admin GraphQL. Before installing or activating on real stores, obtain the actual eligibility confirmation. Never use manual token sharing to bypass Shopify distribution rules.

A store ownership transfer requires disconnect/re-pair to establish new owner approval records. Disconnect revokes pair/memberships, pauses policies, invalidates plans and cancels outstanding work while retaining audit history. Reopening a store installation must not restore the revoked workspace pair.

## Write authorization

All of the following are required:

1. An active verified pair and two active installations.
2. Explicitly verified product/variant/location identities relevant to the operation.
3. A policy with one source per selected field; inventory has exactly one authoritative source.
4. A reviewed exact dry-run plan with no held items and at most 1,000 changes.
5. A current store-owner approval, unexpired plan, stable idempotency key and active policy.
6. Matching live source and destination observations immediately before applying each resource.
7. Deployment `SYNC_WRITE_ENABLED=true`; inventory additionally requires `INVENTORY_WRITE_ENABLED=true`.

The string must be exactly lowercase `true`. Default, unset and other values mean disabled. The UI cannot change these deployment variables. The backend and worker both enforce them.

Webhooks and scheduled reconciliation detect changes and prepare proposals. They do not grant new mutation approval. Bulk destructive operations, product deletion/creation, media, options and metafield writing are unavailable. Bidirectional product ownership is expressed through disjoint one-way field policies. Shared inventory allocation/ledger and two-way stock mirroring are not available.

## Concurrency, recovery and known limits

Durable jobs use leases, fencing and bounded attempts. Target resource locks serialize SyncPilot writers. Exact approvals are single-use; concurrent approval requests create one job. Changed mappings/configuration invalidate plans and queued writes. Workers recheck policy, pair, owner proofs, mapping and lease before resource mutations. Unknown mutation outcomes are held for review rather than replayed blindly. A new comparison is required to repair a failed/uncertain write.

Inventory mutations include the expected destination quantity and Shopify idempotency contract. If stock changes between preview/read and mutation, compare-and-set should reject the write. Production acceptance must empirically cover concurrent sales, restock, duplicate delivery and a crash after remote success.

Shopify scalar product and price mutations do not provide the same inventory compare-and-set guarantee. Re-reading fields immediately before mutation narrows the check-then-write gap but cannot prevent every simultaneous merchant/app edit. Post-write verification detects some divergence. Do not promise strict cross-client atomicity or “no silent overwrites” for arbitrary concurrent editors.

Pause, cancellation, disconnect and uninstall stop future authorized resource operations; they cannot unsend a mutation Shopify already accepted. Inspect live state and audit evidence after an in-flight cancellation. An asynchronous two-store app cannot guarantee zero overselling in independent checkouts; buffers and reconciliation mitigate risk without replacing a shared stock reservation authority.

## Session credentials and encryption

The session storage adapter wraps Shopify's Prisma adapter. With `SESSION_ENCRYPTION_KEY` configured, access and refresh tokens are encrypted with AES-256-GCM, a fresh nonce, and authenticated context including shop, session ID and token purpose. Ciphertext copied to a different session or purpose fails authentication. Production requires a key encoding 32 bytes. Keep it in the deployment secret manager and back it up separately from the database.

Development without a key can still store plaintext tokens. Existing legacy plaintext rows are readable and become encrypted on a subsequent save. The explicit npm run sessions:encrypt maintenance command migrates legacy access/refresh rows with optimistic update conditions and never prints credentials. Before production, configure the persistent key, run that migration or controlled reauthentication, and verify no plaintext rows remain. Do not claim all backups are encrypted solely because new session saves use encryption.

Key loss makes encrypted sessions unreadable and requires controlled reauthentication. Replacing a key without a migration makes old ciphertext unreadable. No multi-key online rotation or managed KMS integration is implemented. Plan rotation, restore and incident response before production.

## Request, data and logging controls

Actions validate URL-encoded bodies, bound them to 64 KiB, reject explicit foreign origins and rely on Shopify session authentication. Zod validates domain inputs and bounds numeric settings and fields. Pairing attempts are bounded independently. A complete ingress/per-user rate limiter is not implemented; deploy authenticated request limits and webhook ingress limits for production.

Shop domains are canonical `*.myshopify.com` names and Shopify IDs are checked by resource type. There is no user-supplied remote URL import, arbitrary GraphQL endpoint or token entry form. Product descriptions are displayed as escaped text; never introduce unsanitized HTML rendering. No customer/order data is required for this scope.

Audit records identify actor, operation, shop/workspace, resource and sanitized metadata. Do not log tokens, authentication headers, raw webhook payloads or arbitrary GraphQL responses. Session storage encryption does not encrypt all catalog/audit columns; database access control and encrypted infrastructure/backups remain deployment responsibilities. Public probes return generic status and do not expose topology or credentials.

Retention is off by default and requires persisted owner opt-in. Daily bounded cleanup removes eligible old closed history and audit records, while open conflicts, failed/held jobs and current catalog data are preserved. Authenticated privacy deliveries discard customer payloads; shop erasure removes the uninstalled store's data and shared workspace history without deleting the other store's private catalog or sessions. A changed/reinstalled connection holds erasure for review. Restore operators must maintain an independent erasure register and replay it before enabling restored backups.

External alerts require an operator-configured HTTPS destination/host allowlist and workspace-owner opt-in. The transport rejects private/reserved addresses, pins a validated address for the TLS request, does not follow redirects, and discards response bodies. Durable retries reuse a delivery ID; receivers must deduplicate it. See NOTIFICATIONS.md. No real destination has been contacted during development. The audit table remains an application audit log, not cryptographically immutable storage.

## Required deployment checks

- Separate development, staging and production app configurations, domains, tokens, databases and queues.
- Keep local PostgreSQL and Redis on loopback; expose only the HTTPS app endpoint through the intended ingress.
- Configure secret storage, encryption key backups, TLS, database/Redis authentication and least-privilege runtime access.
- Run dependency auditing, typecheck, lint, unit tests, real fresh-database integration tests and build. Investigate findings instead of labelling the application secure because it compiles.
- Verify two eligible development stores: owner sessions, pairing, import, exact field/price updates, inventory CAS, real HMAC delivery, uninstall, scope loss, reauthentication and unknown-outcome recovery.
- Demonstrate restore from an encrypted backup into an isolated environment. Prove the application can decrypt restored sessions with the separately stored key.
- Define monitoring, release authority, rollback and support ownership. Keep all production write switches off until explicit approval.

For suspected compromise, first disable deployment write switches and stop workers, then revoke affected Shopify credentials, isolate the deployment and preserve sanitized audit/attempt evidence. Rotate secrets with a migration/reauthentication plan; never paste credentials or raw customer data into support chat.
