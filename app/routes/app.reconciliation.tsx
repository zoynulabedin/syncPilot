import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import { Pagination } from "../components/list-navigation";
import { canOperate, requireActor } from "../services/authorization.server";
import {
  getOperations,
  getPolicies,
  requestReconciliation,
} from "../services/control-plane.server";
import {
  readActionForm,
  actionFailure,
  textField,
} from "../components/actions.server";
import {
  EmptyState,
  Field,
  Notice,
  Page,
  ReadOnly,
  Section,
  Status,
  Submit,
  Table,
  Time,
} from "../components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const [operations, { policies }] = await Promise.all([
    getOperations(actor, new URL(request.url).searchParams),
    getPolicies(actor),
  ]);
  return { ...operations, policies, canManage: await canOperate(actor) };
}
export async function action({ request }: ActionFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const form = await readActionForm(request);
  try {
    if (textField(form, "intent") !== "reconcile")
      return { error: "Choose a valid reconciliation action." };
    await requestReconciliation(actor, textField(form, "policyId"));
    return {
      success:
        "Read-only reconciliation queued. The worker will compare the stores and save findings for review; it will not automatically repair Shopify data.",
    };
  } catch (error) {
    return actionFailure(error);
  }
}

export default function Reconciliation() {
  const { policies, reconciliations, pages, canManage } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  return (
    <Page
      title="Reconciliation"
      subtitle="Detect missed events and stock drift with scheduled or on-demand comparisons."
      action={
        <button
          className="sp-button sp-button-secondary"
          onClick={() => revalidator.revalidate()}
          disabled={revalidator.state !== "idle"}
        >
          Refresh runs
        </button>
      }
    >
      <Notice data={actionData} />
      <ReadOnly canManage={canManage} />
      <Section
        title="Run a safe comparison"
        description="Reconciliation reads current catalog and inventory state, then prepares findings. Repairs require a separately approved dry-run plan."
      >
        {policies.length ? (
          <Form method="post">
            <div className="sp-form-grid">
              <Field name="policyId" label="Policy to compare">
                <select
                  id="policyId"
                  name="policyId"
                  required
                  disabled={!canManage}
                >
                  {policies.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {policy.sourceShopDomain} → {policy.targetShopDomain}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="sp-inline-note">
                Includes the policy’s mapped products, selected fields, verified
                locations, and inventory buffer. Read-only mode stays on for
                this run.
              </div>
            </div>
            <div className="sp-actions">
              <Submit intent="reconcile" disabled={!canManage}>
                Queue read-only comparison
              </Submit>
            </div>
          </Form>
        ) : (
          <EmptyState
            title="Create a policy first"
            href="/app/rules"
            label="Configure sync rules"
          >
            A policy defines the stores, fields, mappings, and authority that
            reconciliation compares.
          </EmptyState>
        )}
      </Section>
      <Section
        title="Reconciliation history"
        description="All runs, including incomplete work that can be diagnosed from its job."
      >
        {reconciliations.length ? (
          <Table
            headings={[
              "Run / policy",
              "State",
              "Compared",
              "Drifted",
              "Started",
              "Findings",
            ]}
          >
            {reconciliations.map((run) => {
              const policy = policies.find((item) => item.id === run.policyId);
              return (
                <tr key={run.id}>
                  <td>
                    <div className="sp-gid">{run.id}</div>
                    <div className="sp-muted">
                      {policy
                        ? `${policy.sourceShopDomain} → ${policy.targetShopDomain}`
                        : "Policy unavailable"}
                    </div>
                  </td>
                  <td>
                    <Status value={run.status} />
                  </td>
                  <td>{run.total}</td>
                  <td>
                    <strong className={run.drifted ? "sp-risk" : ""}>
                      {run.drifted}
                    </strong>
                  </td>
                  <td>
                    <Time value={run.startedAt} />
                  </td>
                  <td>
                    {run.findings ? (
                      <details>
                        <summary>Inspect findings</summary>
                        <pre className="sp-code">
                          {JSON.stringify(run.findings, null, 2)}
                        </pre>
                        <Link to="/app/rules">
                          Review a fresh repair plan →
                        </Link>
                      </details>
                    ) : (
                      <span className="sp-muted">Waiting for worker</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState title="No comparisons yet">
            Run your first read-only reconciliation after importing both
            catalogs and verifying mappings.
          </EmptyState>
        )}
      </Section>
      <Section title="How recovery works">
        <ol className="sp-steps">
          <li>
            <div>
              <strong>Refresh and compare</strong>
              <p className="sp-muted">
                Read both authorized stores and detect changes missed by webhook
                delivery.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>Review drift and identity</strong>
              <p className="sp-muted">
                Correct mapping issues and inspect stale quantities. Shared
                stock pools need a separate allocation ledger.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>Approve a fresh repair</strong>
              <p className="sp-muted">
                A repair uses current target values, active policy ownership,
                and the same write gates as normal synchronization.
              </p>
            </div>
          </li>
        </ol>
      </Section>
      <Pagination info={pages.runs} param="runsPage" label="runs" />
    </Page>
  );
}
