# Remaining work, in execution order

Updated 2026-11-02 (Asia/Dhaka). Branch: `codex/complete-syncpilot`.

1. **Implemented and database-tested:** searchable, paginated product/variant/location mappings and imported-resource suggestions; paginated jobs, receipts, conflicts, plans, reconciliation and audit history. Filters run before pagination; old job links are tenant scoped. Two additional PostgreSQL regressions pass.
2. **Implemented and database-tested:** owner-opted daily history retention; authenticated privacy receipt processing and uninstall erasure; reinstallation holds deletion; another store's private catalog and sessions survive erasure. Four additional PostgreSQL regressions pass. Cleanup is off by default and has not run against the application database.
3. **Prepared:** Coolify Compose migration dependency and readiness health check, separate staging app template, deployment instructions. Actual deployment requires the Coolify project/server, staging app credentials and HTTPS domain. See `COOLIFY_STAGING.md`.
4. **Implemented and database-tested:** external operational webhook alerts with owner opt-in, durable leased retries, opening/resolution deduplication, and an SSRF-resistant transport. Fifteen transport tests and four PostgreSQL regressions pass. No external destination was contacted. See `NOTIFICATIONS.md`.
5. **Remaining engineering:** advanced product creation/options/media/metafield/collection adapters; shared-pool allocation ledger; explicitly bounded unattended sync consent. Keep each capability off until its acceptance tests and merchant decisions pass.
6. **Remaining acceptance:** authenticated staging navigation, real webhook delivery, encrypted offsite restore, store eligibility and both-owner pairing, small product/price/inventory pilots, stock authority and production sign-off. The owner chose to keep the two stores separate; do not pair them as part of this work.

All five migrations pass fresh disposable PostgreSQL 17 migration/schema-parity checks. The three new additive migrations were also applied locally after a backup; deployment must still run its reviewed one-shot migration service. No production deployment, live Shopify mutation, remote push or merge has occurred.

Latest milestone also adds selected SEO/SKU/taxability/inventory-policy adapters. Worker maintenance failures are isolated and DNS resolution has a total delivery deadline. Verification: 79 unit, 41 PostgreSQL integration and 4 HTTP tests passed; encrypted restore/session-key verification and Docker build passed. Advanced structural adapters remain unsupported.
