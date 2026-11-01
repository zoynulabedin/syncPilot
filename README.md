# SyncPilot — Shopify Product & Inventory Sync

SyncPilot is a **custom-distribution embedded Shopify app** for authorized Shopify stores, built with React Router, TypeScript, Shopify Admin GraphQL (2026-10), and PostgreSQL.

> **Current status: FOUNDATION — NOT PRODUCTION READY.**
> This branch contains authenticated Shopify app scaffolding, a PostgreSQL schema and migration, read-only product/inventory dashboards, and a verified webhook inbox. **Cross-store pairing, sync workers, product writes, inventory writes, and reconciliation are not implemented.** No live inventory synchronization should be expected.

## Features implemented on this branch

- Official Shopify React Router application foundation and Shopify embedded layout
- Custom app distribution configuration with separate authenticated installation sessions
- Store onboarding page (current store only; no unsafe automatic cross-store linking)
- Read-only products and variants from the current Shopify store
- Read-only aggregate inventory quantity view
- Verified webhook receiver and deduplicated event inbox for product and inventory changes
- Activity inbox and initial PostgreSQL data model
- Safe default: all SyncPolicy flags disabled

## Prerequisites

- Node.js 22.12+
- npm and Shopify CLI
- Docker Desktop or local PostgreSQL 17
- A Shopify app in Shopify Dev Dashboard
- One or two Shopify development stores (custom distribution supports multiple stores under the same Plus organization)

## Local setup

1. Clone the repository and check out `feat/syncpilot-foundation`.
2. Run `npm ci` (the committed `package-lock.json` ensures reproducible dependencies).
3. Run `docker compose up -d postgres`.
4. Copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`).
5. Use local database URL: `postgresql://syncpilot:syncpilot_dev_only@localhost:5432/syncpilot?schema=public`.
6. Run `npx prisma generate` and `npx prisma migrate deploy`.
7. Run `shopify app config link` and select the existing SyncPilot app in Shopify Dev Dashboard. If the correct app is already linked, check with `shopify app info` instead.
8. Run `shopify app dev --store your-development-store.myshopify.com`. The CLI starts a temporary Cloudflare HTTPS tunnel and automatically configures the selected **development store** because `[build].automatically_update_urls_on_dev = true`. Press `p` in the CLI to open the preview and install it.
9. Verify `/app`, `/app/products`, `/app/inventory`, `/app/stores`, `/app/rules` and `/app/activity`. The example `application_url`/`redirect_urls` in `shopify.app.toml` are not a production configuration; replace them with the real hosted domain before production deployment. The tunnel URL is temporary and might not be written back to TOML.

The sample Docker Compose database password is only for localhost development. For webhooks, use the default Cloudflare tunnel (do **not** use `--use-localhost`). `shopify app dev` requires a development store or Shopify Plus sandbox store, not a production customer store. Keep the terminal running while testing. Use a proper secret for staging/production. Never commit the real `.env`, tokens, or Shopify API secrets.

## Windows local validation and collaboration

After setting up the local `.env` (do not commit it):

```powershell
git checkout feat/syncpilot-foundation
git pull origin feat/syncpilot-foundation
powershell -ExecutionPolicy Bypass -File .\scripts\local-check.ps1
```

This runs `npm ci`, `prisma generate`, `prisma validate`, TypeScript type checking and the React Router production build. It creates `local-check-results/summary.txt` and step-specific stdout/stderr logs. The reports are gitignored.

To include the database migration, start PostgreSQL and then run:

```powershell
docker compose up -d postgres
powershell -ExecutionPolicy Bypass -File .\scripts\local-check.ps1 -SkipInstall -WithMigration
```

Share only `summary.txt` and sanitized failure logs. **Never share `.env`, Shopify tokens/secrets, database passwords, or raw customer data.** The script does not connect Shopify stores and it does not test actual synchronization. To test OAuth and the local tunnel, separately use `shopify app dev --store your-development-store.myshopify.com` in a development store.

## Shopify installation across two stores

Custom-distribution apps can be installed on multiple stores in the **same Shopify Plus organization** (or eligible development stores). Install the same app separately in Store A and Store B using your Shopify custom installation link. Each install produces its own authenticated session. This does not authorize cross-store data access by itself. Store pairing needs explicit approval by authorized staff on both installations and must verify organization/store ownership before enabling sync.

If stores belong to different organizations, do not assume a single custom install link can connect both.

## Safety controls

- All writes are OFF in this branch.
- All mutation actions must enforce workspace authorization and verified variant/location mapping.
- Do not use SKU alone for mapping.
- Shopify webhook HMAC is verified by the official library before recording delivery metadata.
- Webhook delivery IDs are deduplicated in PostgreSQL.
- `inventorySetQuantities` must use expected quantity (CAS) and the required idempotency key under Shopify 2026-10.
- Reconciliation is required because webhooks can be repeated, delayed or lost.

## Development status and next milestones

See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for phases, API architecture, safe pairing, worker queues and release gates.

## Attribution

The React Router app scaffolding is adapted from [Shopify's official app template](https://github.com/Shopify/shopify-app-template-react-router); refer to [LICENSE.md](LICENSE.md).

## Review status

Dependencies, type checking, database migration execution, Shopify OAuth, webhooks and live-store behavior **have not been executed or validated in this chat environment**. Run the listed setup and tests on a development machine before merging or deploying.
