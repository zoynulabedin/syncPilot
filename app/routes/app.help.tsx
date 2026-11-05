import type { LoaderFunctionArgs } from "react-router";
import { Link } from "react-router";
import { authenticate } from "../shopify.server";
import { Page, Section } from "../components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return null;
}
export default function Help() {
  return (
    <Page
      title="SyncPilot help"
      subtitle="Connect deliberately, compare current data, and approve only the changes you understand."
    >
      <Section title="First synchronization">
        <ol className="sp-steps">
          <li>
            <div>
              <strong>Install and pair both stores</strong>
              <p>
                Use the same app in eligible development stores or stores in the
                same Shopify Plus organization. Each owner approves in their own
                installation; the initiating owner confirms the accepted
                invitation.
              </p>
              <Link to="/app/stores">Open store pairing →</Link>
            </div>
          </li>
          <li>
            <div>
              <strong>Import both catalogs</strong>
              <p>
                Imports run in the background and persist their progress.
                Refresh Products to see product, variant, and location
                observations.
              </p>
              <Link to="/app/products">Open products →</Link>
            </div>
          </li>
          <li>
            <div>
              <strong>Verify identities</strong>
              <p>
                Map products first, then their variants and locations. SKU and
                barcode suggestions require manual verification.
              </p>
              <Link to="/app/mappings">Review mappings →</Link>
            </div>
          </li>
          <li>
            <div>
              <strong>Set ownership, preview, and review</strong>
              <p>
                Choose supported product fields, inspect the exact proposed
                values, then activate the policy and approve the unexpired plan
                when the deployment write gates have been authorized.
              </p>
              <Link to="/app/rules">Open sync rules →</Link>
            </div>
          </li>
        </ol>
      </Section>
      <Section title="Bounded automatic sync">
        <p>
          After a policy is active and you have reviewed a fresh plan, a store
          owner can grant standing consent for that policy. Consent covers only
          one-way policies whose fields are all descriptive product fields:
          title, description HTML, vendor, product type, tags, and SEO title and
          description. Prices, handles, status, variants and inventory always
          need an exact approval.
        </p>
        <p>
          Each consent has an expiry, a minimum interval between runs, and run
          and change budgets fixed when it is granted. A comparison that would
          exceed them or touch another field holds the consent instead of
          writing. Granting consent and every automatic run require both
          deployment switches, AUTOMATIC_SYNC_ENABLED and SYNC_WRITE_ENABLED, to
          be enabled by whoever runs the deployment; SyncPilot cannot change
          them. Revoking consent never needs them.
        </p>
        <p>
          Consent is revoked when the policy is paused or activated, the policy
          or its mappings change, the stores are disconnected, the app is
          uninstalled, or its access scopes change. The owner can also revoke it
          at any time.
        </p>
        <div className="sp-actions">
          <Link to="/app/automatic-sync">Open automatic sync →</Link>
        </div>
      </Section>
      <Section title="Inventory authority">
        <p>
          One source store owns available stock. Destination availability is
          max(0, source available − safety buffer), with a fresh
          compare-and-swap check for every write. This mode requires a stock
          model in which destination sales do not silently create an untracked
          shared-pool liability.
        </p>
        <p>
          Independent physical pools should keep quantity sync disabled. Stock
          pools are a manual planning ledger: an owner records a physical count,
          per-store allowances and reservations. The ledger refuses allowances
          beyond what remains of that count after active reservations and its
          safety buffer, although a later count or buffer adjustment can leave
          existing reservations inside the buffer. It never writes Shopify
          quantities, never imports orders and does not prevent overselling, so
          record every reservation, release and fulfillment there yourself.
          Asynchronous copies do not guarantee zero overselling at independent
          checkouts.
        </p>
        <div className="sp-actions">
          <Link to="/app/stock-pools">Open stock pools →</Link>
        </div>
      </Section>
      <Section title="Recovery and conflicts">
        <p>
          Repeated webhook deliveries are deduplicated and queued durably. Reads
          can retry from saved checkpoints. An interrupted or uncertain write is
          held for inspection; an old stock approval is never blindly replayed.
        </p>
        <p>
          Pause the policy, inspect the job and conflict, compare current
          Shopify values, correct the mapping or authority, then create a fresh
          preview. Cancelling work cannot recall a request Shopify has already
          accepted.
        </p>
        <div className="sp-actions">
          <Link to="/app/activity">Job history</Link>
          <Link to="/app/conflicts">Conflict center</Link>
          <Link to="/app/reconciliation">Compare drift</Link>
        </div>
      </Section>
      <Section title="Staff access">
        <p>
          After pairing, each store owner can grant their own store’s staff
          access from Settings. Viewers can inspect workspace data. Operators
          can also import catalogs, run dry-run previews and queue read-only
          comparisons.
        </p>
        <p>
          Only a verified Shopify store owner can approve writes, change
          policies or mappings, grant or revoke automatic consent, or manage
          staff. Owner authority comes from Shopify and cannot be delegated.
        </p>
        <div className="sp-actions">
          <Link to="/app/settings">Open settings →</Link>
        </div>
      </Section>
      <Section title="Supported scope">
        <p>
          This release updates selected fields on existing verified products and
          variants: title, description HTML, vendor, product type, handle, tags,
          status, SEO title and description, variant price, compare-at price,
          SKU, tax status, and whether to keep selling when out of stock. It
          supports one authoritative source for mapped location quantities.
        </p>
        <p>
          New product creation, variant structure changes, media, metafields,
          collections, shared-pool quantity sync and deletion are not available.
          Scheduled comparisons and webhook changes create plans for owner
          review; only an active automatic consent applies descriptive product
          changes without a separate approval, within its limits.
        </p>
      </Section>
    </Page>
  );
}
