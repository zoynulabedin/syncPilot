# SyncPilot operations runbook

## Start and verify locally

From the root checkout, run docker compose up -d --wait postgres redis, npm ci, npm run setup, then npm run dev. Shopify CLI starts both web and worker with the linked development app environment. PostgreSQL and Redis remain on loopback. On this Mac the ignored environment uses 5433/6380.

Check /health for liveness and /ready for database/configured-Redis readiness. Settings shows worker heartbeat; Activity shows actual attempts and errors. A healthy web process does not prove that a worker, store pair or Shopify permissions are healthy.

Run npm run check, npm run test:integration and npm run test:e2e. Integration runner creates a fresh generated local database and refuses arbitrary remote targets. It drops only that generated database. Tests never authorize real Shopify mutations.

## Pair and operate

The current owner instruction is to keep both stores separate. The following pairing procedure is for a later explicitly authorized connection; do not initiate it under the current decision.

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

Use a trusted operator host with Node 22.12+, project dependencies, and `pg_dump`/`pg_restore` compatible with the PostgreSQL server (17 for this deployment). The runtime image does not contain these client tools. Ubuntu CI installs the client from the [official PostgreSQL Apt repository](https://www.postgresql.org/download/linux/ubuntu/).

Configure `DATABASE_URL`, a persistent base64 32-byte `BACKUP_ENCRYPTION_KEY`, and the separately stored `SESSION_ENCRYPTION_KEY` in secret storage. Keep the two keys independently recoverable from backups. Do not paste key values into command arguments or logs. The backup key encrypts the whole dump; the session key decrypts restored Shopify tokens.

```sh
npm run backup:encrypted
npm run restore:encrypted -- backups/your-backup.spbk
```

The backup streams through authenticated AES-256-GCM into a permission-restricted, gitignored file and refuses to overwrite an existing path. The restore drill authenticates the entire backup, restores only into a generated local disposable database, verifies applied migrations and every encrypted session, then drops the disposable database. It never replaces the application database. A wrong backup/session key fails the drill. Maintain an independent erasure register and replay erasures before using a recovered database.

`npm run test:backup` runs the full drill with synthetic sessions and temporary keys in a disposable database. It passed with five migrations, successful session decryption and rejection of a wrong session key. This proves the local recovery path; offsite transfer, recovery permissions, scheduling, backup-age monitoring and actual offsite restore remain operator acceptance tasks.

The older `backup-local.sh`/`restore-drill.sh` scripts produce plaintext local dumps for development diagnostics. Those dumps are not offsite-ready. Legacy pre-encryption dumps may contain plaintext credentials; never upload them to chat or Git.

## Staging and release

Use a distinct Shopify staging app/configuration and HTTPS domain. Set production secrets in the hosting secret manager, persistent database/Redis storage and a stable session key. docker-compose.production.yml contains web, worker, postgres, redis and a one-shot migration service. Web and worker depend on successful migration completion; do not make every replica race migrations. See COOLIFY_STAGING.md for the ordered setup.

Keep both write flags false. Complete two-real-development-store installation/owner/pairing/import/webhook tests, an explicitly approved small field pilot, inventory concurrent-sale/CAS tests and crash recovery. Configure ingress limits, encrypted backups, monitoring, alert delivery, support ownership and rollback. No staging/production deployment has been performed by this work.

For emergency rollback first close write gates, pause policies and stop workers, preserve attempts/audit and inspect in-flight outcomes. Roll back application image only to a schema-compatible version; migrations are forward-only. Do not drop data or blindly restore over an application database.

Older Shopify CLI versions supply HOST to child processes. The Shopify configuration resolves that validated development URL for both web and worker; production requires an explicit SHOPIFY_APP_URL. CONFIGURATION_ERROR indicates worker initialization settings, distinct from an expired store session.
