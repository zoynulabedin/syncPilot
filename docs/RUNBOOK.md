# SyncPilot operations runbook

## Start and verify locally

From the repository root, run docker compose up -d --wait postgres redis, npm ci, npm run setup, then npm run dev. Shopify CLI starts both web and worker with the linked development app environment. PostgreSQL and Redis remain on loopback, by default on 5432 and 6380; change `POSTGRES_PORT`/`REDIS_PORT` in the ignored `.env` if those are taken, keeping `DATABASE_URL`/`REDIS_URL` aligned. The dev launcher and the integration/HTTP test runner also work on Windows; encrypted backups are meant for a Linux operator host. The nested `syncPilot/` folder is ignored and not part of the app.

PostgreSQL must run with session `TimeZone` UTC (see the failure entry below). Check /health for liveness and /ready for database, UTC session time zone and configured-Redis readiness. Settings shows worker heartbeat; Activity shows actual attempts and errors. A healthy web process does not prove that a worker, store pair or Shopify permissions are healthy.

Run npm run check, npm run test:integration and npm run test:e2e. Integration runner creates a fresh generated database on a local server (`localhost`, `127.0.0.1` or `postgres` host) and refuses other targets. It drops only that generated database. The server must be in UTC. Tests never authorize real Shopify mutations.

## Pair and operate

The current owner instruction is to keep both stores separate. The following pairing procedure is for a later explicitly authorized connection; do not initiate it under the current decision.

Open the app in each eligible store as its owner. Create a pairing request in the source installation; share its request ID/challenge securely with the destination owner. Accept there and confirm from the initiating owner. Do not send Shopify tokens manually. Owner transfer requires disconnect and re-pair.

Import both catalogs and verify stable product, variant and location GIDs. Save a draft policy, run a dry run, inspect every proposed field/quantity, then activate and approve only when deployment release switches have been explicitly authorized. Plans expire after 15 minutes and are single-use. Pausing a policy cancels future work and revokes approvals and automatic consents.

Staff access is managed in Settings by each store's owner, inside a paired workspace only: `VIEWER` reads, `OPERATOR` can also start imports (Products) and reconciliation comparisons (Reconciliation). The server also accepts dry runs from operators, but the Sync Rules page currently enables the Dry run button for owners only. Approvals, policies, mappings, stock pools and automatic consent remain owner-only.

Automatic sync (`/app/automatic-sync`) is off unless `AUTOMATIC_SYNC_ENABLED` and `SYNC_WRITE_ENABLED` are both exactly `true`; keep it off until a live pilot passes. To grant, an owner picks a fresh dry-run plan for an eligible descriptive-fields policy, sets the limits and confirms. The worker runs its automatic-sync pass about once a minute per worker process (later while that worker is busy with a long job), so the first run is queued within about a minute of the grant, then at most one per interval; a run that exceeds its budgets or includes a field outside the consent is held instead of written. After a pause, activation, policy or mapping edit, disconnect or scope change, grant a fresh consent; the old one is revoked. Revoke works even with the switch off and cancels queued automatic runs. When an earlier automatic or manual preview/apply job for the policy is still pending or running, that run slot is skipped until the next interval.

Stock pools (`/app/stock-pools`) are a manual planning ledger. Recording a pool, allowance or reservation there never changes Shopify quantities and does not see orders; keep it consistent with the real stock authority by hand.

## Failure recovery

- AUTH_FAILURE/INSUFFICIENT_SCOPE: reopen the affected store's app with an authorized owner; verify scopes, then reimport. Scope changes pause policies and revoke plans and automatic consents.
- MAPPING/LOCATION/VARIANT errors: inspect identities, pause policies, correct mappings, reimport and create a fresh preview. Never map by SKU alone.
- THROTTLED/NETWORK_TIMEOUT on reads: bounded retry resumes persisted checkpoints. Inspect attempts and queue lag rather than manually duplicating jobs.
- STALE_QUANTITY/STALE_PREVIEW: preserve the new target state. Reconcile and review a fresh exact plan; never disable CAS.
- UNKNOWN_OUTCOME/HELD: a remote write may have succeeded. Inspect live Shopify state and audit evidence. Do not replay the old adjustment or manufacture a new idempotency key to retry blindly.
- Worker restart: expired read leases retry; expired write leases hold for review. Start one or more independent workers; PostgreSQL fencing/source/resource locks protect application writers.
- Uninstall: sessions are removed and pair/policies/approvals/automatic consents/jobs revoked even if no session remains. Reinstallation does not restore pairing automatically. If Stock pools or Automatic sync is the first page opened after a reinstall and shows "This installation is inactive", open the dashboard first; it reactivates the installation record.
- DATABASE_TIME_ZONE_NOT_UTC: /ready returns 503 and the worker exits with code 1 (fatal log line) before any maintenance, job claim or heartbeat; the web log repeats the code about once a minute. The web process still serves admin requests (request budgets, approvals, grants) against that database unless the proxy or orchestrator removes it on the readiness failure, so fix the zone promptly. Run `SHOW timezone;` on the application database. Fix with `ALTER DATABASE "<db>" SET timezone TO 'UTC';` or `timezone = 'UTC'` in postgresql.conf and a reload, remove any `ALTER ROLE ... SET timezone` override, then restart web and worker (pooled connections keep the old zone). Accepted names are UTC and its aliases (Etc/UTC, UCT, Universal, Zulu, GMT, GMT0, GMT+0, GMT-0, Greenwich and their Etc/ forms); offset-only settings such as UTC0 are rejected. Nothing changes the setting automatically. Under `npm run dev`, node --watch keeps running after the worker exits, so look for the fatal line. If the database is unreachable at startup the worker keeps retrying with WORKER_DEPENDENCY_FAILURE instead of exiting.
- HTTP 429 with Retry-After: 60: a verified shop or user exceeded its per-minute admin budget, or a shop exceeded 1,200 catalog webhooks per minute. Shopify retries webhooks (up to 8 times over 4 hours) and scheduled reconciliation detects any remaining drift and prepares a plan for review; budgets are in `RATE_LIMITS` in `app/services/rate-limit.server.ts`. HTTP 503 with Retry-After: 10 on admin or catalog webhook requests means the limiter's database call failed; check PostgreSQL.
- WORKER_MAINTENANCE_FAILURE with stage RATE_LIMIT_CLEANUP: expired limiter rows were not removed this cycle. Jobs are unaffected; the table grows slowly while the cleanup fails or the worker is stopped.
- Automatic consent HELD (AUTOMATIC_CONSENT_HELD in audit): a run's comparison exceeded the per-run, remaining-change or run budget, or included a change outside the consented fields (`details.code` `CONSENT_BUDGET` or `CONSENT_SCOPE`); nothing was written. Or, for a consent left ACTIVE by an earlier release, the policy or mappings had changed after the grant (`CONSENT_CHANGED`, after one dead-lettered run). A current pause, activation, policy save or mapping change revokes the consent instead of holding it. Review the policy and a fresh dry run, then grant a new consent; a HELD consent does not block that.
- `prisma migrate deploy` fails with P3009 naming `20240530213853_create_session_table` (from `npm run dev`, `npm run setup` or the Compose `migrate` service): the database ran deploy with the template's SQLite migration, which the main merge `d619e59` added to the PostgreSQL migration set and which stayed there through `f8a83f2`. That migration failed on its first statement and changed nothing, but its failed row blocks every later migration even though the folder is gone. With the application's `DATABASE_URL`, run `npx prisma migrate resolve --rolled-back 20240530213853_create_session_table`, then `npx prisma migrate deploy`. On 2026-11-03 this sequence applied all nine migrations, both on a fresh database and on one already holding earlier migrations. Check the earlier development database and any staging database migrated in that window. Under Compose the `migrate` service never succeeds until this is done, so web and worker do not start; run the resolve command once in a one-off container from the application image (it contains the Prisma CLI), for example `docker compose -f docker-compose.production.yml run --rm migrate npx prisma migrate resolve --rolled-back 20240530213853_create_session_table`, then redeploy. The container form was not tested; Docker was not available on the verification machine.

Cancellation cannot recall a mutation already accepted by Shopify. Product/price APIs lack strict inventory-style CAS; avoid concurrent third-party editors during the pilot. Inventory copy mode requires a documented business stock authority and does not create reservations.

## Backup and restore

Use a trusted operator host with Node 22.12+, project dependencies, and `pg_dump`/`pg_restore` compatible with the PostgreSQL server (17 for this deployment). The runtime image does not contain these client tools. Ubuntu CI installs the client from the [official PostgreSQL Apt repository](https://www.postgresql.org/download/linux/ubuntu/).

Configure `DATABASE_URL`, a persistent base64 32-byte `BACKUP_ENCRYPTION_KEY`, and the separately stored `SESSION_ENCRYPTION_KEY` in secret storage. Keep the two keys independently recoverable from backups. Do not paste key values into command arguments or logs. The backup key encrypts the whole dump; the session key decrypts restored Shopify tokens.

```sh
npm run backup:encrypted
npm run restore:encrypted -- backups/your-backup.spbk
```

The backup streams through authenticated AES-256-GCM into a permission-restricted, gitignored file and refuses to overwrite an existing path. The restore drill authenticates the entire backup, restores only into a generated local disposable database, verifies applied migrations and every encrypted session, then drops the disposable database. It never replaces the application database. A wrong backup/session key fails the drill. Maintain an independent erasure register and replay erasures before using a recovered database.

`npm run test:backup` runs the full drill with synthetic sessions and temporary keys in a disposable database. It last passed on 2026-11-02 with five migrations, successful session decryption and rejection of a wrong session key. It has not been re-run since the migration set became nine (the 2026-11-03 verification machine has no `pg_dump`/`pg_restore`); re-run it before relying on it. Run backups on a Linux operator host: the 0600 file-mode protection is POSIX-only and its test is skipped on Windows. The drill proves the local recovery path; offsite transfer, recovery permissions, scheduling, backup-age monitoring and actual offsite restore remain operator acceptance tasks.

The older `backup-local.sh`/`restore-drill.sh` scripts produce plaintext local dumps for development diagnostics. Those dumps are not offsite-ready. Legacy pre-encryption dumps may contain plaintext credentials; never upload them to chat or Git.

## Staging and release

Use a distinct Shopify staging app/configuration and HTTPS domain, and replace the `example.com` URLs in `shopify.app.toml`. Set production secrets in the hosting secret manager, persistent database/Redis storage with PostgreSQL in UTC, and a stable session key. docker-compose.production.yml contains web, worker, postgres, redis and a one-shot migration service. Web and worker depend on successful migration completion; do not make every replica race migrations. See COOLIFY_STAGING.md for the ordered setup.

Keep all write flags false. Complete two-real-development-store installation/owner/pairing/import/webhook tests, an explicitly approved small field pilot, inventory concurrent-sale/CAS tests and crash recovery. Configure per-IP and flood limits at the reverse proxy for /app, /auth and /webhooks (the app limits only authenticated shops and users and never trusts forwarding headers), encrypted backups, monitoring, alert delivery, support ownership and rollback. No staging/production deployment has been performed by this work.

For emergency rollback first close write gates (including AUTOMATIC_SYNC_ENABLED), pause policies and stop workers, preserve attempts/audit and inspect in-flight outcomes. Roll back application image only to a schema-compatible version; migrations are forward-only. Do not drop data or blindly restore over an application database.

Older Shopify CLI versions supply HOST to child processes. The Shopify configuration resolves that validated development URL for both web and worker; production requires an explicit SHOPIFY_APP_URL. CONFIGURATION_ERROR indicates worker initialization settings, distinct from an expired store session.
