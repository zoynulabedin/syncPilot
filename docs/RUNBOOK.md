# SyncPilot operations runbook

## Start and verify locally

From the root checkout, run docker compose up -d --wait postgres redis, npm ci, npm run setup, then npm run dev. Shopify CLI starts both web and worker with the linked development app environment. PostgreSQL and Redis remain on loopback. On this Mac the ignored environment uses 5433/6380.

Check /health for liveness and /ready for database/configured-Redis readiness. Settings shows worker heartbeat; Activity shows actual attempts and errors. A healthy web process does not prove that a worker, store pair or Shopify permissions are healthy.

Run npm run check, npm run test:integration and npm run test:e 2 e. Integration runner creates a fresh generated local database and refuses arbitrary remote targets. It drops only that generated database. Tests never authorize real Shopify mutations.

## Pair and operate

Open the app in each eligible store as its owner. Create a pairing request in the source installation; share its request ID/challenge securely with the destination owner. Accept there and confirm from the initiating owner. Do not send Shopify tokens manually. Owner transfer requires disconnect and re-pair.

Import both catalogs and verify stable product, variant and location GIDs. Save a draft policy, run a dry run, inspect every proposed field/quantity, then activate and approve only when deployment release switches have been explicitly authorized. Plans expire after 15 minutes and are single-use. Pausing a policy cancels future work and revokes approvals.

## Failure recovery

- AUTH_FAILURE/INSUFFICIENT_SCOPE: reopen the affected store's app with an authorized owner; verify scopes, then reimport. Scope changes pause policies and revoke plans.
- MAPPING/LOCATION/VARIANT errors: inspect identities, pause policies, correct mappings, reimport and create a fresh preview. Never map by SKU alone.
- THROTTLED/NETWORK_TIMEOUT on reads: bounded retry resumes persisted checkpoints. Inspect attempts and queue lag rather than manually duplicating jobs.
- STALE_QUANTITY/STALE_PREVIEW: preserve the new target state. Reconcile and review a fresh exact plan; never disable CAS.
- UNKNOWN_OUTCOME/HELD: a remote write may have succeeded. Inspect live Shopify state and audit evidence. Do not replay the old adjustment or manufacture a new idempotency key to retry blindly.
- Worker restart: expired read leases retry; expired write leases hold for review. Start one or more independent workers; PostgreSQL fencing/source/resource locks protect application writers.
- Uninstall: sessions are removed and pair/policies/approvals/jobs revoked even if no session remains. Reinstallation does not restore pairing automatically.

Cancellation cannot recall a mutation already accepted by Shopify. Product/price APIs lack strict inventory-style CAS; avoid concurrent third-party editors during the pilot. Inventory copy mode requires a documented business stock authority and does not create reservations.

## Backup and restore

Run bash scripts/backup-local.sh. Files are permission-restricted and gitignored, but database dumps themselves are not encrypted by that script. Encrypt before offsite transfer and store SESSION_ENCRYPTION_KEY separately in secure storage. Legacy pre-migration dumps may contain plaintext credentials; never upload them to chat or Git.

After configuring the persistent key, npm run sessions:encrypt encrypts legacy access/refresh rows with optimistic conditions and never prints credentials. Back up the key before migration. Never replace it without a key migration/reauthentication plan.

Run bash scripts/restore-drill.sh backups/file.dump to restore only into a generated disposable database, inspect applied migrations, then drop that test database. The normal application database is not replaced. A local restore rehearsal passed during this session; staging encrypted-offsite/PITR restore and restored token decryption still need operational acceptance.

## Staging and release

Use a distinct Shopify staging app/configuration and HTTPS domain. Set production secrets in the hosting secret manager, persistent database/Redis storage and a stable session key. docker-compose.production.yml contains web, worker, postgres, redis and a tools-profile migration service. Run the migration task once before bringing up app replicas; do not make every replica race migrations.

Keep both write flags false. Complete two-real-development-store installation/owner/pairing/import/webhook tests, an explicitly approved small field pilot, inventory concurrent-sale/CAS tests and crash recovery. Configure ingress limits, encrypted backups, monitoring, alert delivery, support ownership and rollback. No staging/production deployment has been performed by this work.

For emergency rollback first close write gates, pause policies and stop workers, preserve attempts/audit and inspect in-flight outcomes. Roll back application image only to a schema-compatible version; migrations are forward-only. Do not drop data or blindly restore over an application database.
