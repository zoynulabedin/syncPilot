import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { requireActor } from "../services/authorization.server";
import { getOverview } from "../services/control-plane.server";
import {
  EmptyState,
  Metric,
  Page,
  Section,
  Status,
  Table,
  Time,
} from "../components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const overview = await getOverview(
    requireActor(await authenticate.admin(request)),
  );
  return {
    ...overview,
    workerHealthy: overview.heartbeats.some(
      (heartbeat) =>
        heartbeat.status === "RUNNING" &&
        Date.now() - new Date(heartbeat.seenAt).getTime() < 120_000,
    ),
  };
}

export default function Overview() {
  const {
    shop,
    workspace,
    stores,
    counts,
    recentJobs,
    recentAudit,
    workerHealthy,
    writesEnabled,
  } = useLoaderData<typeof loader>();
  return (
    <Page
      title="SyncPilot overview"
      subtitle={`Product and inventory operations for ${shop}`}
      action={
        <>
          <Link
            className="sp-button"
            to={workspace ? "/app/rules" : "/app/stores"}
          >
            {workspace ? "Preview synchronization" : "Connect your stores"}
          </Link>
          <Link className="sp-button sp-button-secondary" to="/app/activity">
            View activity
          </Link>
        </>
      }
    >
      {!writesEnabled && (
        <s-banner tone="info">
          Write protection is on. You can import catalogs, verify mappings, and
          review dry runs. Shopify changes require approved plans and the server
          write gate.
        </s-banner>
      )}
      <div className="sp-metrics">
        <Metric
          label="Connected stores"
          value={stores.length}
          detail={workspace ? "Verified workspace" : "Pairing required"}
          href="/app/stores"
        />
        <Metric
          label="Imported products"
          value={counts.products}
          detail={`${counts.variants} variants`}
          href="/app/products"
        />
        <Metric
          label="Verified product maps"
          value={counts.mappings}
          href="/app/mappings"
        />
        <Metric
          label="Total jobs"
          value={counts.jobs}
          detail={`${counts.failedJobs} need attention`}
          href="/app/activity"
        />
        <Metric
          label="Open conflicts"
          value={counts.conflicts}
          href="/app/conflicts"
        />
        <Metric
          label="Worker"
          value={workerHealthy ? "Online" : "No signal"}
          detail={
            workerHealthy
              ? "Heartbeat received recently"
              : "Start the worker process"
          }
          href="/app/settings"
        />
      </div>
      <div className="sp-grid">
        <Section
          title="Connection health"
          description={workspace?.name || "Prepare your first workspace"}
        >
          {workspace && stores.length > 1 ? (
            <>
              <div className="sp-connection">
                <div className="sp-connection-node">
                  <strong>{stores[0].shopDomain}</strong>
                  <Status value={stores[0].status} />
                </div>
                <span
                  className="sp-connection-arrow"
                  aria-label="Verified connection"
                >
                  ↔
                </span>
                <div className="sp-connection-node">
                  <strong>{stores[1].shopDomain}</strong>
                  <Status value={stores[1].status} />
                </div>
              </div>
              <p className="sp-muted">
                Direction and field ownership are defined per policy. Pairing
                never enables writes by itself.
              </p>
              <Link to="/app/rules">Review policies →</Link>
            </>
          ) : (
            <EmptyState
              title="Connect a second authorized store"
              href="/app/stores"
              label="Set up store pairing"
            >
              Each store owner approves the connection in their own Shopify
              installation.
            </EmptyState>
          )}
        </Section>
        <Section
          title="Get ready to synchronize"
          description="Every change starts with a verified identity and a reviewable plan."
        >
          <ol className="sp-steps">
            <li>
              <div>
                <strong>Verify both installations</strong>
                <p className="sp-muted">
                  {workspace
                    ? "Your workspace is paired."
                    : "Install the app in both eligible stores and complete pairing."}
                </p>
              </div>
            </li>
            <li>
              <div>
                <strong>Import and map your catalog</strong>
                <p className="sp-muted">
                  {counts.products
                    ? `${counts.products} products imported. Review product, variant, and location mappings.`
                    : "Import current Shopify data. Ambiguous matches require review."}
                </p>
              </div>
            </li>
            <li>
              <div>
                <strong>Choose ownership and preview</strong>
                <p className="sp-muted">
                  Select the source for each field and inventory location.
                  Approve the exact changes before execution.
                </p>
              </div>
            </li>
          </ol>
        </Section>
      </div>
      <Section
        title="Recent sync jobs"
        aside={<Link to="/app/activity">View all jobs →</Link>}
      >
        {recentJobs.length ? (
          <Table
            headings={[
              "Operation",
              "Direction",
              "Status",
              "Attempts",
              "Created",
            ]}
          >
            {recentJobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <Link to={`/app/activity?job=${job.id}`}>
                    {job.operation.replaceAll("_", " ")}
                  </Link>
                </td>
                <td>
                  <div className="sp-stack">
                    <span>{job.sourceShop}</span>
                    <span className="sp-muted">→ {job.targetShop}</span>
                  </div>
                </td>
                <td>
                  <Status value={job.status} />
                </td>
                <td>{job.attempts}</td>
                <td>
                  <Time value={job.createdAt} />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState
            title="No synchronization jobs yet"
            href="/app/rules"
            label="Configure a policy"
          >
            Approved dry-run plans create durable jobs. Incoming webhook
            receipts are tracked separately.
          </EmptyState>
        )}
      </Section>
      <Section
        title="Workspace audit"
        description="A record of connection, configuration, and approval decisions."
        aside={<Link to="/app/settings">View audit trail →</Link>}
      >
        {recentAudit.length ? (
          <Table headings={["Action", "Actor", "When"]}>
            {recentAudit.map((event) => (
              <tr key={event.id}>
                <td>{event.action.replaceAll("_", " ")}</td>
                <td>
                  <span className="sp-gid">{event.actor}</span>
                </td>
                <td>
                  <Time value={event.createdAt} />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="sp-muted">
            Your audit trail will appear as owners configure the workspace.
          </p>
        )}
      </Section>
    </Page>
  );
}
