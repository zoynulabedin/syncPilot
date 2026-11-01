import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { requireActor } from "../services/authorization.server";
import {
  cancelJob,
  getOperations,
  getWorkspace,
  retryJob,
} from "../services/control-plane.server";
import {
  readActionForm,
  actionFailure,
  textField,
} from "../components/actions.server";
import {
  EmptyState,
  Field,
  Gid,
  InlineAction,
  Notice,
  Page,
  ReadOnly,
  Section,
  Status,
  Table,
  Time,
} from "../components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const [operations, workspace] = await Promise.all([
    getOperations(actor),
    getWorkspace(actor),
  ]);
  const shops = [
    ...new Set([
      actor.shop,
      ...workspace.connections.map((connection) => connection.shopDomain),
    ]),
  ];
  const events = await db.webhookEvent.findMany({
    where: { shopDomain: { in: shops } },
    orderBy: { receivedAt: "desc" },
    take: 50,
    select: {
      id: true,
      shopDomain: true,
      topic: true,
      resourceId: true,
      status: true,
      receivedAt: true,
      processedAt: true,
      lastError: true,
    },
  });
  const url = new URL(request.url);
  return {
    ...operations,
    events,
    filter: url.searchParams.get("status") || "",
    selectedJob: url.searchParams.get("job") || "",
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const form = await readActionForm(request);
  try {
    const intent = textField(form, "intent");
    if (intent === "retry") await retryJob(actor, textField(form, "id"));
    else if (intent === "cancel") await cancelJob(actor, textField(form, "id"));
    else return { error: "Choose a valid job action." };
    return {
      success:
        intent === "retry"
          ? "Job queued for a safe retry."
          : "Job cancelled. Any associated write approval has been revoked.",
    };
  } catch (error) {
    return actionFailure(error);
  }
}

export default function Activity() {
  const { jobs, events, canManage, filter, selectedJob } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  const visibleJobs = jobs.filter((job) => !filter || job.status === filter);
  return (
    <Page
      title="Sync jobs & activity"
      subtitle="Durable job execution, attempt history, and verified webhook receipts."
      action={
        <button
          className="sp-button sp-button-secondary"
          onClick={() => revalidator.revalidate()}
          disabled={revalidator.state !== "idle"}
        >
          Refresh activity
        </button>
      }
    >
      <Notice data={actionData} />
      <ReadOnly canManage={canManage} />
      <Section
        title="Recent jobs"
        description="The latest 50 jobs in this workspace. A received webhook and a completed Shopify write are separate events."
      >
        <Form method="get" className="sp-search">
          <Field name="status" label="Filter job state">
            <select id="status" name="status" defaultValue={filter}>
              <option value="">All states</option>
              {[
                "PENDING",
                "RUNNING",
                "RETRY",
                "COMPLETED",
                "SUCCEEDED",
                "FAILED",
                "DEAD_LETTER",
                "HELD",
                "CANCELLED",
              ].map((value) => (
                <option value={value} key={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className="sp-button sp-button-secondary">
            Apply filter
          </button>
        </Form>
        {visibleJobs.length ? (
          <Table
            headings={[
              "Job / operation",
              "Direction",
              "State",
              "Attempts",
              "Created",
              "Actions",
            ]}
          >
            {visibleJobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <strong>{job.operation.replaceAll("_", " ")}</strong>
                  <div className="sp-gid">{job.id}</div>
                  <details className="sp-details" open={selectedJob === job.id}>
                    <summary>Job details</summary>
                    <p className="sp-muted">
                      Next eligible attempt <Time value={job.availableAt} />
                    </p>
                    {job.lastError && (
                      <div className="sp-notice sp-notice-error">
                        {job.lastError}
                      </div>
                    )}
                    <p className="sp-muted">
                      Idempotency key: {job.idempotencyKey || "—"}
                    </p>
                    {job.attempts.length ? (
                      <Table
                        headings={["Attempt", "State", "Result", "Started"]}
                      >
                        {job.attempts.map((attempt) => (
                          <tr key={attempt.id}>
                            <td>{attempt.attempt}</td>
                            <td>
                              <Status value={attempt.status} />
                            </td>
                            <td>
                              {attempt.errorCode || "—"}
                              {attempt.details && (
                                <pre className="sp-code">
                                  {JSON.stringify(attempt.details, null, 2)}
                                </pre>
                              )}
                            </td>
                            <td>
                              <Time value={attempt.startedAt} />
                            </td>
                          </tr>
                        ))}
                      </Table>
                    ) : (
                      <p className="sp-muted">No worker attempts yet.</p>
                    )}
                    {job.payload && (
                      <details>
                        <summary>Submitted plan reference</summary>
                        <pre className="sp-code">
                          {JSON.stringify(job.payload, null, 2)}
                        </pre>
                      </details>
                    )}
                  </details>
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
                <td>
                  {job.attempts.length} / {job.maxAttempts}
                </td>
                <td>
                  <Time value={job.createdAt} />
                </td>
                <td>
                  <div className="sp-actions">
                    {["FAILED", "DEAD_LETTER", "RETRY"].includes(job.status) &&
                      (job.operation === "APPLY_PREVIEW" ? (
                        <Link
                          className="sp-button sp-button-secondary"
                          to="/app/rules"
                        >
                          New dry run
                        </Link>
                      ) : (
                        <InlineAction
                          intent="retry"
                          id={job.id}
                          label="Retry"
                          disabled={!canManage}
                        />
                      ))}
                    {[
                      "PENDING",
                      "RETRY",
                      "RUNNING",
                      "PROCESSING",
                      "HELD",
                    ].includes(job.status) && (
                      <InlineAction
                        intent="cancel"
                        id={job.id}
                        label="Cancel"
                        danger
                        disabled={!canManage}
                        confirm="Cancel this job and revoke any linked write approval? A request already accepted by Shopify may still complete."
                      />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState
            title={filter ? "No jobs in this state" : "No jobs yet"}
            href="/app/products"
            label="Import your catalog"
          >
            Import a catalog or approve a dry-run plan to create durable
            background work.
          </EmptyState>
        )}
      </Section>
      <Section
        title="Verified webhook inbox"
        description="The latest 50 deliveries from authorized stores. RECEIVED means durably stored; it does not mean the catalog or inventory was changed."
      >
        {events.length ? (
          <Table
            headings={[
              "Topic / store",
              "Resource",
              "Processing state",
              "Received",
              "Processed",
            ]}
          >
            {events.map((event) => (
              <tr key={event.id}>
                <td>
                  <strong>{event.topic.replaceAll("_", " ")}</strong>
                  <div className="sp-muted">{event.shopDomain}</div>
                </td>
                <td>
                  <Gid value={event.resourceId} />
                </td>
                <td>
                  <Status value={event.status} />
                  {event.lastError && (
                    <div className="sp-risk">{event.lastError}</div>
                  )}
                </td>
                <td>
                  <Time value={event.receivedAt} />
                </td>
                <td>
                  <Time value={event.processedAt} />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="No webhook deliveries recorded">
            Shopify’s signed product and inventory events will appear here when
            they arrive.
          </EmptyState>
        )}
      </Section>
    </Page>
  );
}
