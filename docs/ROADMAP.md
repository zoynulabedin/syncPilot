# SyncPilot remaining roadmap

The local approval-based implementation now includes pairing/RBAC, resumable discovery, explicit mappings, field policies, exact plans, durable workers, targeted product/price updates, authoritative inventory CAS, conflicts, read-only reconciliation and operations UI. See IMPLEMENTATION_STATUS.md for executed evidence and limits.

1. Complete real two-development-store owner authentication, pairing, catalog/locations, HMAC delivery, scope loss, uninstall/reinstall and revocation acceptance. Preserve write protection until those gates pass.
2. Confirm source field ownership, currencies, physical inventory authority, destination-sales accounting, locations and buffers with the owner. Run an explicitly approved allowlisted product pilot, then inventory CAS/concurrency/crash acceptance.
3. Add needed advanced product creation/variant structure/media/metafield/collection adapters with exact GraphQL contracts, scoped approval and partial failure tests. Keep unsupported operations unavailable until their adapters and acceptance exist.
4. Implement explicit standing consent and conflict baselines before unattended product updates. Shared inventory needs a real reservation/allocation ledger, not a two-way numeric toggle.
5. Finish mapping-history pagination, notification delivery, retention/privacy operations, ingress/per-user rate limits, observability and operational SLOs.
6. Deploy separate staging app/domain/web/worker/PostgreSQL/Redis with secret management, encrypted offsite backup/restore and monitoring. Rehearse restart and rollback.
7. Reconcile Git ancestry with main in review, open a draft PR, and complete client production pilot/sign-off before enabling real store writes.

These are release dependencies and explicit remaining product work, not features implied by a green local build.
