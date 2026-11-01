export default function Privacy() {
  return (
    <main
      style={{
        maxWidth: 760,
        margin: "40px auto",
        padding: 24,
        fontFamily: "system-ui",
        lineHeight: 1.6,
      }}
    >
      <h1>SyncPilot data handling</h1>
      <p>
        SyncPilot uses the store identity, authorized staff identity, encrypted
        Shopify sessions, product catalogs, variants, locations, inventory
        quantities and operational records to provide product and inventory
        synchronization. It does not request or store customer or order records.
      </p>
      <p>
        Cross-store access requires pairing approved by both store owners. Store
        owners control workspace access, policies and approvals. Shopify
        credentials stay on the server and are encrypted at rest in application
        sessions.
      </p>
      <h2>History and deletion</h2>
      <p>
        History cleanup is off by default. A workspace owner can enable daily
        cleanup and choose 7–3650 days in Settings. Cleanup deletes eligible
        closed operational and audit records in bounded batches. Open conflicts,
        failed or held jobs, current catalog snapshots and credentials remain
        until resolved or the installation is erased.
      </p>
      <p>
        Shopify privacy deliveries are authenticated. Customer requests record
        only a receipt because SyncPilot stores no customer data. After an
        uninstall, an authenticated shop erasure request removes that store’s
        sessions, catalog and shared workspace records. Other stores’ private
        catalogs and sessions are preserved. A changed or reinstalled connection
        holds erasure for operator review.
      </p>
      <h2>Backups and contact</h2>
      <p>
        Database backups are managed separately by the deployment operator.
        Erased information can remain in restricted backups until their
        configured expiry. Operators must preserve erasure receipts and replay
        erasure requests before reconnecting any restored backup.
      </p>
      <p>
        For access, correction, deletion or backup retention questions, contact
        the store owner or the operator who provided your private SyncPilot
        installation.
      </p>
    </main>
  );
}
