import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { requireActor } from "../services/authorization.server";
import {
  getOperations,
  getPolicies,
  resolveConflict,
} from "../services/control-plane.server";
import {
  readActionForm,
  actionFailure,
  textField,
} from "../components/actions.server";
import { Changes, readChanges } from "../components/previews";
import { Pagination, QueryFields } from "../components/list-navigation";
import {
  EmptyState,
  Field,
  Gid,
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
  const params = new URL(request.url).searchParams;
  const filter = params.get("conflictStatus") ?? params.get("status") ?? "OPEN";
  params.delete("status");
  params.set("conflictStatus", filter);
  params.set("previewStatus", "PENDING");
  const [operations, { policies }] = await Promise.all([
    getOperations(actor, params),
    getPolicies(actor),
  ]);
  return {
    ...operations,
    policies,
    filter,
  };
}
export async function action({ request }: ActionFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const form = await readActionForm(request);
  try {
    const resolution = textField(form, "intent");
    if (resolution !== "KEEP_TARGET" && resolution !== "RETRY")
      return { error: "Choose a valid conflict decision." };
    await resolveConflict(actor, { id: textField(form, "id"), resolution });
    return {
      success:
        resolution === "RETRY"
          ? "Decision recorded. Correct the cause and create a fresh dry-run plan in Sync Rules; no old write approval is replayed."
          : "Decision recorded. The current destination value is preserved; no Shopify change was made.",
    };
  } catch (error) {
    return actionFailure(error);
  }
}

export default function Conflicts() {
  const { conflicts, previews, pages, policies, canManage, filter } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const visible = conflicts.filter(
    (conflict) => !filter || conflict.status === filter,
  );
  const pending = previews.filter((preview) => preview.status === "PENDING");
  return (
    <Page
      title="Conflicts & approvals"
      subtitle="Inspect the evidence, make an explicit decision, and keep every repair reviewable."
      action={
        <Link className="sp-button sp-button-secondary" to="/app/rules">
          Create a fresh dry run
        </Link>
      }
    >
      <Notice data={actionData} />
      <ReadOnly canManage={canManage} />
      <Section
        title="Conflict center"
        description="No force-overwrite action is available. A retry requires fresh observations and a new approved plan."
      >
        <Form method="get" className="sp-search">
          <QueryFields
            exclude={["status", "conflictStatus", "conflictsPage"]}
          />
          <Field name="conflictStatus" label="Conflict state">
            <select
              id="conflictStatus"
              name="conflictStatus"
              defaultValue={filter}
            >
              <option value="OPEN">Open</option>
              <option value="RESOLVED">Resolved</option>
              <option value="">All states</option>
            </select>
          </Field>
          <button type="submit" className="sp-button sp-button-secondary">
            Apply filter
          </button>
        </Form>
        {visible.length ? (
          <Table
            headings={[
              "Issue",
              "Resource / field",
              "Evidence",
              "State",
              "Decision",
            ]}
          >
            {visible.map((conflict) => (
              <tr key={conflict.id}>
                <td>
                  <strong>{conflict.code.replaceAll("_", " ")}</strong>
                  <div className="sp-muted">
                    <Time value={conflict.createdAt} />
                  </div>
                  {conflict.jobId && (
                    <Link to={`/app/activity?job=${conflict.jobId}`}>
                      Inspect job →
                    </Link>
                  )}
                </td>
                <td>
                  <Gid value={conflict.resourceId} />
                  <div className="sp-muted">
                    {conflict.field || "Multiple fields"}
                  </div>
                </td>
                <td>
                  <details>
                    <summary>Observed values & context</summary>
                    <pre className="sp-code">
                      {JSON.stringify(
                        {
                          source: conflict.sourceValue,
                          destination: conflict.targetValue,
                          details: conflict.details,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </td>
                <td>
                  <Status value={conflict.status} />
                  {conflict.resolution && (
                    <div className="sp-muted">
                      {conflict.resolution.replaceAll("_", " ")}
                    </div>
                  )}
                </td>
                <td>
                  {conflict.status === "OPEN" ? (
                    <Form method="post">
                      <input type="hidden" name="id" value={conflict.id} />
                      <div className="sp-actions">
                        <Submit
                          intent="KEEP_TARGET"
                          secondary
                          disabled={!canManage}
                        >
                          Keep destination
                        </Submit>
                        <Submit intent="RETRY" secondary disabled={!canManage}>
                          Request fresh preview
                        </Submit>
                      </div>
                      <p className="sp-muted">
                        After fixing identity or location issues, reimport and
                        preview again.
                      </p>
                    </Form>
                  ) : (
                    <Time value={conflict.resolvedAt} />
                  )}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState
            title={
              filter === "OPEN"
                ? "No open conflicts"
                : "No conflicts in this view"
            }
          >
            Missing mappings, stale quantities, and rejected Shopify writes are
            held here with context for review.
          </EmptyState>
        )}
        <Pagination
          info={pages.conflicts}
          param="conflictsPage"
          label="conflicts"
        />
      </Section>
      <Section
        title="Plans awaiting review"
        description="Approval happens in Sync Rules alongside policy ownership, activation state, and write gates."
      >
        {pending.length ? (
          pending.map((preview) => {
            const policy = policies.find(
              (item) => item.id === preview.policyId,
            );
            const changes = readChanges(preview.changes);
            return (
              <details className="sp-details" key={preview.id}>
                <summary>
                  {changes.length} proposed changes ·{" "}
                  {policy?.sourceShopDomain || "Source"} →{" "}
                  {policy?.targetShopDomain || "Destination"}
                </summary>
                <p className="sp-muted">
                  Created <Time value={preview.createdAt} /> · Expires{" "}
                  <Time value={preview.expiresAt} />
                </p>
                <Changes value={preview.changes} />
                <div className="sp-actions">
                  <Link className="sp-button" to="/app/rules">
                    Review policy and approval
                  </Link>
                </div>
              </details>
            );
          })
        ) : (
          <EmptyState title="No plans awaiting review">
            Run a dry-run comparison to inspect proposed changes before enabling
            synchronization.
          </EmptyState>
        )}
        <Pagination info={pages.previews} param="previewsPage" label="plans" />
      </Section>
    </Page>
  );
}
