# SyncPilot remaining roadmap

The local approval-based implementation now includes verified identity/pairing controls, imports, explicit mappings, selected core/SEO/variant fields, exact plans, durable workers, inventory CAS, operations/history pagination, privacy/retention, optional external webhook alerts and encrypted recovery tooling. See IMPLEMENTATION_STATUS.md for executed evidence and limits.

1. Configure the intended Coolify staging project/server, separate staging Shopify app, HTTPS domain and secret storage. Deploy web/worker/PostgreSQL/Redis with one-shot migrations, keeping both write flags false. Verify authenticated own-store navigation and real signed Shopify events. The owner currently keeps both stores separate.
2. Complete external monitoring/alert receiver acceptance, scheduled encrypted offsite backups, an isolated offsite restore, erasure replay, service restart and rollback rehearsal. Add ingress/per-user limits and operational SLOs.
3. Add needed structural catalog adapters (creation/options/media/metafields/collections), each with verified contracts, exact scoped approval and partial-failure tests. Keep unsupported operations unavailable.
4. Design bounded standing consent and conflict baselines before unattended product updates. Shared physical stock needs an approved reservation/allocation ledger and destination-sales accounting.
5. Expand role delegation and remove remaining policy/staff selector caps when needed. Dedicated catalog/mapping/history pages already paginate.
6. Only if the owner later authorizes cross-store use: establish distribution eligibility and both-owner pairing, define field/currency/stock/location authority, then run an allowlisted product pilot followed by inventory concurrency/CAS/recovery acceptance.
7. Publish the reviewed branch, reconcile main's ancestry in review, and complete staging/client production sign-off before enabling real writes.

These are release dependencies and explicit remaining product work. Green local checks do not establish production acceptance or authorize store pairing.
