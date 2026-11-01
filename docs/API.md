# SyncPilot application contracts

These are the implemented React Router loaders and form actions. The `/api/...` paths in the master specification are design proposals; this release does not expose a generic token-bearing GraphQL proxy or a second public REST API.

All `/app` loaders and actions first call the official Shopify `authenticate.admin(request)`. Authenticated data is scoped to the current shop, or to an active workspace and verified two-store pair. Management actions additionally require a verified Shopify store owner. Actions use server-side services; hiding a button is not the authorization check.

## Browser contract

Catalog and inventory selectors use the `store` query/form field. Shopify’s reserved `shop` parameter remains authentication context and is never a business-data selector.

Actions accept URL-encoded form data. The `intent` field selects an operation. The action form parser bounds request bodies to 64 KiB and rejects other form encodings and an explicitly foreign `Origin`. Shopify authentication remains mandatory. Do not send credentials, Shopify tokens, or arbitrary GraphQL in form fields.

Successful actions return a small success message and revalidate loader data. Expected validation and authorization failures return a 4xx response containing a human-readable `error`; unexpected server failures return a generic message. Auth redirects and Shopify boundary responses retain their framework behavior. Zod validates service inputs independently of UI form parsing.

| Route                 | Read behavior                                                                                    | POST intents and data                                                                                                                                                            | Authority                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `/app`                | Current authorized workspace counts, recent jobs/audit and worker signals                        | None                                                                                                                                                                             | Authenticated shop; workspace membership for cross-store data       |
| `/app/stores`         | Current installation, authorized connections, relevant pairing requests without challenge hashes | `initiate`: `destinationShop`, `organizationConfirmed`; `accept`: `requestId`, `challenge`, `organizationConfirmed`; `confirm`/`reject`: `id`; `disconnect`: shop domain in `id` | Store owner                                                         |
| `/app/products`       | Paginated imported catalog (`store`, `q`, `status`, `page`)                                      | `import`: `store`                                                                                                                                                                | Store owner; paired-store guard when importing another store        |
| `/app/inventory`      | Paginated imported per-location observations (`store`, `q`, `location`, `page`)                  | None; import through Products                                                                                                                                                    | Authenticated shop; workspace membership for another store          |
| `/app/mappings`       | Authorized product, variant and location mappings plus imported identities                       | `save`: mapping `kind`, `sourceShop`, `targetShop`, `sourceGid`, `targetGid`, `identityConfirmed`; `delete`: `kind`, `id`                                                        | Store owner; policies paused and no active leased job               |
| `/app/rules`          | Policies and exact dry-run plans                                                                 | `save`: policy fields below; `preview`, `activate`, `pause`: policy `id`; `approve`: plan `id` plus UI approval acknowledgement                                                  | Store owner                                                         |
| `/app/activity`       | Latest scoped jobs with attempt details and webhook receipt metadata                             | `retry`/`cancel`: job `id`                                                                                                                                                       | Store owner; unpaired catalog import is limited to the current shop |
| `/app/conflicts`      | Latest scoped conflict evidence and decisions                                                    | `KEEP_TARGET`/`RETRY`: conflict `id`                                                                                                                                             | Store owner                                                         |
| `/app/reconciliation` | Latest scoped reconciliation runs and findings                                                   | `reconcile`: `policyId`                                                                                                                                                          | Store owner                                                         |
| `/app/settings`       | Workspace preferences, in-app alerts, worker signals and audit; members for owners               | `settings`: preferences below; `member`: `shopDomain`, numeric Shopify `userId`, `status`                                                                                        | Store owner                                                         |
| `/app/help`           | Operational guidance and supported-scope limits                                                  | None                                                                                                                                                                             | Authenticated shop                                                  |

The form's exact field conversion lives in the route module. Service function signatures below are the stable internal boundary; they accept validated values rather than raw requests.

## Pairing and membership

`requireActor(auth)` derives `{shop, userId, role}` from the authenticated Shopify session. `OWNER` requires `onlineAccessInfo.associated_user.account_owner === true` and its associated user ID. A session-token subject or a stored boolean alone cannot grant owner authority. Other users are `VIEWER` and require an explicit active workspace membership for cross-store reads. Owners can grant or revoke read-only staff membership; the application cannot manufacture or revoke Shopify store-owner authority.

1. `initiatePairing(actor, {destinationShop, organizationConfirmed: true})` requires both active installations, a different destination, neither store already paired, and no current pending request involving either store. Returns `{request, challenge}`. Only a SHA-256 hash is stored; the plaintext challenge is returned once.
2. `acceptPairing(actor, {requestId, challenge, organizationConfirmed: true})` runs only in the named destination installation. A bad code increments durable attempt count. Five failures lock the request. Requests expire after 15 minutes.
3. `confirmPairing(actor, {requestId})` runs only in the initiating installation, by its original verified owner. It requires the destination owner's acceptance and creates the workspace, two owner memberships and verified pair atomically.
4. `rejectPairing(actor, requestId)` cancels/rejects a pending request from either named store. Completed requests cannot be replayed.
5. `disconnectStore(actor, shop)` revokes the workspace pair and memberships, pauses policies, cancels pending/running work and unlinks both connections in one transaction. Audit records remain.

State progression is `PENDING → ACCEPTED → VERIFIED`; cancellation and rejection terminate the request. Expiry is enforced on server-side state transitions even if an older persisted row still has a pending state.

Organization eligibility is attested by both owners. No Admin API organization-ownership verification is claimed. Production activation still requires documented confirmation that the stores are eligible for this custom app.

`setMember(actor, {shopDomain, userId, role: "VIEWER", status: "ACTIVE" | "REVOKED"})` validates a paired shop and numeric Shopify staff ID. Store-owner rows cannot be demoted or modified through this interface. A transferred store should disconnect and re-pair to establish the new owners' approval proofs.

## Mapping and policies

`saveMapping(actor, {kind, sourceShop, targetShop, sourceGid, targetGid})` accepts `PRODUCT`, `VARIANT` or `LOCATION`. Both identities must be imported. Shopify GID resource types are checked. Variant verification requires a verified parent-product mapping; location verification requires both locations active. Mapping never relies on SKU alone. Unique source and destination constraints reject ambiguous destination reuse.

`deleteMapping(actor, {kind, id})` scopes the lookup by workspace. Mapping changes invalidate old pending/approved plans and cancel queued write jobs. The worker also checks mappings before each resource write, and holds variant mappings that no longer have a valid parent-product mapping.

`savePolicy(actor, input)` accepts:

| Field                      | Rules                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | Optional existing policy ID in this workspace; enabled policies must first be paused                                        |
| `sourceShop`, `targetShop` | Different active stores in the verified pair                                                                                |
| `fields`                   | Any selection of `title`, `descriptionHtml`, `vendor`, `productType`, `status`, `handle`, `tags`, `price`, `compareAtPrice` |
| `syncInventory`            | Boolean; false by default                                                                                                   |
| `inventoryMode`            | `DISABLED` or `SOURCE`; inventory requires `SOURCE`                                                                         |
| `inventoryAuthority`       | Must equal `sourceShop` for inventory synchronization                                                                       |
| `buffer`                   | Integer from 0 through 1,000,000                                                                                            |
| `reconciliationMinutes`    | Integer from 5 through 10,080                                                                                               |

At least one field or inventory must be selected. Opposing policies cannot own the same field or both own inventory. Bidirectional product ownership therefore uses two one-way policies with disjoint fields. Saving sets `DRAFT`, disables the policy, and invalidates prior approvals. Inventory shared-pool allocation is not an available mode.

## Preview, activation and approved execution

`previewPolicy(actor, policyId)` authorizes both stores and persists exact changes, source/target hashes, creator and 15-minute expiry. Previewing never writes to Shopify. Plans can contain `PRODUCT`, `PRICE`, `INVENTORY` changes or `HOLD` findings. Unknown, held, empty or more-than-1,000-change plans cannot be approved.

`updatePolicy(actor, policyId, "ACTIVATE")` requires a fresh nonempty dry run, no held items, no opposing ownership conflict and enabled deployment switches. `PAUSE` cancels associated queued/running work and revokes approved plans. Activation alone does not authorize arbitrary future mutations.

`approvePreview(actor, previewId)` rebuilds the comparison and requires matching source/target hashes and canonicalized exact changes. A serializable transaction consumes a pending, unexpired plan once, verifies the active policy and current workspace, records the owner, and creates `APPLY_PREVIEW` with stable key `preview:<plan-id>`. Concurrent approvals yield one durable job.

The deployment variables `SYNC_WRITE_ENABLED` and `INVENTORY_WRITE_ENABLED` must equal the lowercase string `true`; inventory requires both. They are off by default. Services and workers independently enforce these switches. Enabling a switch does not skip pairing, mapping, policy or exact-plan approval.

The worker fetches current Shopify state, compares the exact approved plan again, and rechecks authorization before resource writes. Product fields use targeted updates; variant prices use targeted variant updates; inventory uses available quantity, explicit location mapping, Shopify compare-and-set and a stable idempotency key. Destructive product creation/deletion, media/options/metafields and shared-pool inventory are unsupported and must remain held.

## Jobs, conflicts and reconciliation

`retryJob(actor, jobId)` permits known failed read work. Write jobs cannot be replayed from an old approval; create a fresh preview instead. `cancelJob` revokes an associated approval and marks work cancelled. A Shopify request already submitted can still complete; inspect its live outcome before any repair.

`resolveConflict(actor, {id, resolution: "KEEP_TARGET" | "RETRY"})` records a reviewed decision. `RETRY` means request a new comparison after fixing the cause, not force an old mutation. The UI explains the follow-up import/preview action.

`requestReconciliation(actor, policyId)` creates a durable `RECONCILE` job and run. Reconciliation reads current state and records findings; drift produces a pending exact plan for review. Webhooks and scheduled comparisons produce proposals, not unattended writes.

## Preferences and read bounds

`updateSettings` accepts optional workspace name (1–100 characters), reconciliation interval (5–10,080 minutes), retention target (7–3,650 days), in-app alert enablement, failure threshold (1–100), and queue-lag threshold (1–1,440 minutes). Retention is a stored target; automated purging and external notification delivery are not implemented.

Service reads are bounded: policies 50; plans 20; jobs/conflicts/audit 50; reconciliation runs 20; staff members 100; displayed mapping products 500, variants 1,000 and locations 250; imported identity selectors products 1,000, variants 5,000 and locations 250. These are display bounds, not a claim of a fully paginated mapping API. Large mapping management needs further pagination before large-catalog rollout. Catalog imports use Shopify pagination independently.

## Webhooks and probes

Configured product/inventory webhook routes call `authenticate.webhook(request)` before receipt persistence. Delivery IDs are required and unique per shop. The durable inbox/outbox flow creates idempotent worker jobs. Verified uninstall clears sessions and revokes the pair/workspace even when a session is already absent; scope-change handling updates scope metadata, pauses policies, revokes plans and cancels writes. Test these lifecycle paths with real development-store events before release.

`GET /health` returns `ok` and reports process liveness only. `GET /ready` checks the database and configured Redis and returns `{"status":"ready"}` or a generic 503 response; it exposes no credentials or dependency addresses. Neither probe establishes two-store Shopify connectivity or release readiness.

## Verification

`tests/control-plane-guards.test.ts` checks domain/GID validation, challenge security, owner authority, write switches and preview guards. `tests/integration/control-plane.test.ts` exercises real disposable PostgreSQL transactions for pairing, attempts, expiry, replay, third-store isolation, staff membership, mapping collisions, ownership conflicts, approval consumption/concurrency, invalidation and disconnect. Run through `npm run test:integration`; it creates and drops only a generated local test database.
