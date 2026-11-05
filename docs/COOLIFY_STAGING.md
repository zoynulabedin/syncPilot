# SyncPilot on Coolify staging

Deploy this private app as a Git-based **Docker Compose** application. The Compose file is `docker-compose.production.yml`, with the repository root as the base directory. Deploy `main` only after the 2026-11-03 working-tree changes are reviewed, committed and pushed. The currently pushed `main` (`f8a83f2`) still contains the template's SQLite migration, so its `migrate` service fails on every database, fresh or existing, and leaves a failed migration record. Nothing has been pushed by this work.

## Configure before the first deployment

1. Create a staging resource in the intended Coolify project/environment. Connect the repository using a Git App or deploy key. Select the Docker Compose build pack and the Compose file above.
2. Configure these runtime variables in Coolify's secret manager, not Git:

   | Variable                  | Staging value                                                                       |
   | ------------------------- | ----------------------------------------------------------------------------------- |
   | `APP_ENV`                 | `staging`                                                                           |
   | `SHOPIFY_API_KEY`         | Client ID of a separate Shopify staging app                                         |
   | `SHOPIFY_API_SECRET`      | Secret for that staging app                                                         |
   | `SHOPIFY_APP_URL`         | Stable public HTTPS origin, without the container port                              |
   | `POSTGRES_PASSWORD`       | Strong generated password                                                           |
   | `DATABASE_URL`            | `postgresql://syncpilot:URL_ENCODED_PASSWORD@postgres:5432/syncpilot?schema=public` |
   | `SESSION_ENCRYPTION_KEY`  | Persistent base64-encoded random 32-byte key                                        |
   | `SYNC_WRITE_ENABLED`      | `false`                                                                             |
   | `INVENTORY_WRITE_ENABLED` | `false`                                                                             |
   | `IMAGE_TAG`               | Unique release identifier for this staging installation                             |

   `docker-compose.production.yml` does not pass `AUTOMATIC_SYNC_ENABLED` to the containers, so automatic sync stays off in this deployment; enabling it would need a reviewed Compose change after a live pilot.

   Generate the session key in a trusted terminal with `node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'`, paste it directly into secret storage, and keep a separate recoverable copy. The web, worker and migration containers receive the same runtime environment. Do not use the development `.env`, development tokens or the temporary CLI tunnel domain.

3. In Coolify's domain settings choose the **web** service and container port **3000**, for example `https://syncpilot-staging.example.com:3000`. Set DNS to this server and allow public HTTPS. The example hostname must be replaced with your real domain. Leave PostgreSQL, Redis, worker and migration services without public ports/domains.
4. Configure that same HTTPS origin and `/auth/callback` redirect in the separate Shopify staging app. Copy `deploy/shopify.app.staging.toml.example` to `shopify.app.staging.toml`, fill in its staging client ID and HTTPS URLs, and validate with a current Shopify CLI (`shopify app config validate --config=staging --json`). This validation has not passed yet; the CLI on the earlier development machine did not support the command, and it was not run on 2026-11-03. The repository's own `shopify.app.toml` still has `example.com` application and redirect URLs; the app owner must set them and confirm the access scopes. Review before publishing Shopify app configuration; hosting a container does not publish webhook subscriptions or install the Shopify app.
5. Configure per-IP and flood rate limits in the reverse proxy (Coolify's Traefik, or Cloudflare in front) for `/app`, `/auth` and `/webhooks`. The app limits only Shopify-authenticated shops, users and catalog webhooks and never trusts `X-Forwarded-For`, so unauthenticated floods are bounded only by the proxy.
6. Keep PostgreSQL's session `TimeZone` at UTC. The bundled `postgres:17-alpine` image defaults to UTC; if you use a managed or external database, check `SHOW timezone;` and see the RUNBOOK fix. A non-UTC zone keeps `/ready` at 503 (so the web health check fails) and makes the worker exit with `DATABASE_TIME_ZONE_NOT_UTC`. The web process itself keeps serving requests; it is taken out of traffic only if Coolify's proxy acts on the failed health check.

## Deploy and verify

Deploy the Compose application. Its startup sequence is PostgreSQL/Redis health → one-shot `migrate` → web and worker. A failed migration prevents either application process from starting. Do not move migrations into each replica's startup command. Existing persistent database volumes are retained across deployments, and so is a failed migration record: if this resource was ever deployed from `d619e59`–`f8a83f2`, `migrate` will exit with P3009 for `20240530213853_create_session_table` until it is marked rolled back once (RUNBOOK, "P3009"). A brand-new database volume needs no recovery.

Verify all of the following:

- The migration container exits with code 0 after applying all nine migrations. Web and dependencies are healthy; worker logs report both write switches disabled and no `DATABASE_TIME_ZONE_NOT_UTC` line.
- `https://YOUR_DOMAIN/health` returns `ok`; `/ready` returns only `{"status":"ready"}`. The Compose web health check uses `/ready`, which also requires a UTC database session.
- Requests beyond the proxy's per-IP limit are rejected by the proxy before reaching the app.
- The embedded app opens in one designated development store and Settings shows a fresh worker heartbeat. A local HTTP smoke test does not establish staging authentication.
- Read-only catalog import and a real signed product webhook reach staging. Keep stores separate until both owners explicitly authorize pairing.
- Configure encrypted offsite backups and rehearse a restore with the same session encryption key in isolation. Record the results and backup owner.

Keep staging Shopify product and inventory writes off. Two-store sync acceptance and a production pilot remain separate release gates. No Coolify or Shopify deployment has been performed by this work.

## Rollback

Close all write switches, pause policies (this also revokes automatic consents), stop the worker, and inspect any in-flight outcomes. Redeploy the previous schema-compatible image. Migrations are forward-only; do not replace the live database with a backup during a normal application rollback.

References: [Coolify Docker Compose](https://coolify.io/docs/applications/builds/docker-compose), [Coolify domain configuration](https://coolify.io/docs/applications/configuration/general), [Coolify health checks](https://coolify.io/docs/applications/configuration/health-checks).
