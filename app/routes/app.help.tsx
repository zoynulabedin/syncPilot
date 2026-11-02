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
      <Section title="Inventory authority">
        <p>
          One source store owns available stock. Destination availability is
          max(0, source available − safety buffer), with a fresh
          compare-and-swap check for every write. This mode requires a stock
          model in which destination sales do not silently create an untracked
          shared-pool liability.
        </p>
        <p>
          Independent physical pools should keep quantity sync disabled. Shared
          physical pools require a separate reservation and allocation ledger,
          which is not implemented in this release. Asynchronous copies do not
          guarantee zero overselling at independent checkouts.
        </p>
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
      <Section title="Supported scope">
        <p>
          This release updates selected fields on existing verified products:
          title, description HTML, vendor, product type, handle, tags, status,
          and variant price or compare-at price. It supports one authoritative
          source for mapped location quantities.
        </p>
        <p>
          New product creation, variant structure changes, media, metafields,
          collections, shared-pool allocation, deletion, and unattended write
          consent are not available. Scheduled comparisons and webhook changes
          create plans for owner review.
        </p>
      </Section>
    </Page>
  );
}
