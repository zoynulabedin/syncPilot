import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { requireActor } from "../services/authorization.server";
import {
  getMembers,
  getOperations,
  getSettings,
  setMember,
  updateSettings,
} from "../services/control-plane.server";
import {
  readActionForm,
  actionFailure,
  checked,
  numberField,
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
  const [settings, operations, membership] = await Promise.all([
    getSettings(actor),
    getOperations(actor),
    actor.role === "OWNER"
      ? getMembers(actor)
      : Promise.resolve({ members: [], connections: [] }),
  ]);
  const failed = operations.jobs.filter((job) =>
    ["FAILED", "DEAD_LETTER", "HELD"].includes(job.status),
  ).length;
  const lagMinutes = settings.notification?.lagMinutes ?? 15;
  const lagging = operations.jobs.filter(
    (job) =>
      ["PENDING", "RETRY"].includes(job.status) &&
      Date.now() - new Date(job.availableAt).getTime() > lagMinutes * 60000,
  ).length;
  return {
    ...settings,
    ...membership,
    audit: operations.audit,
    heartbeats: operations.heartbeats,
    alerts: { failed, lagging },
    observedNow: Date.now(),
  };
}
export async function action({ request }: ActionFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const form = await readActionForm(request);
  try {
    const intent = textField(form, "intent");
    if (intent === "settings") {
      await updateSettings(actor, {
        name: textField(form, "name"),
        retentionDays: numberField(form, "retentionDays", 90),
        reconciliationMinutes: numberField(form, "reconciliationMinutes", 360),
        notificationsEnabled: checked(form, "notificationsEnabled"),
        failureThreshold: numberField(form, "failureThreshold", 3),
        lagMinutes: numberField(form, "lagMinutes", 15),
      });
    } else if (intent === "member") {
      const status = textField(form, "status");
      if (status !== "ACTIVE" && status !== "REVOKED")
        return { error: "Choose an access state." };
      await setMember(actor, {
        shopDomain: textField(form, "shopDomain"),
        userId: textField(form, "userId"),
        role: "VIEWER",
        status,
      });
    } else return { error: "Choose a valid settings action." };
    return { success: "Settings saved and recorded in the audit trail." };
  } catch (error) {
    return actionFailure(error);
  }
}
export default function Settings() {
  const {
    workspace,
    notification,
    canManage,
    writesEnabled,
    inventoryWritesEnabled,
    members,
    connections,
    audit,
    heartbeats,
    alerts,
    observedNow,
  } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <Page
      title="Settings & audit"
      subtitle="Workspace access, operational signals, and a traceable history of every decision."
    >
      <Notice data={result} />
      <ReadOnly canManage={canManage} />
      <Section
        title="Release controls"
        description="Deployment controls are read-only here. Enabling them alone never authorizes a Shopify write."
      >
        <div className="sp-grid">
          <p>
            Product writes{" "}
            <Status value={writesEnabled ? "ENABLED" : "DISABLED"} />
          </p>
          <p>
            Inventory writes{" "}
            <Status value={inventoryWritesEnabled ? "ENABLED" : "DISABLED"} />
          </p>
        </div>
        <p className="sp-muted">
          A write also needs a verified pair, active owner-approved policy,
          verified mappings, an unexpired exact plan, and fresh Shopify
          preconditions.
        </p>
      </Section>
      {!workspace ? (
        <Section title="Workspace settings">
          <EmptyState
            title="Pair your stores first"
            href="/app/stores"
            label="Connect stores"
          >
            Settings and staff access become available after both store owners
            approve the workspace.
          </EmptyState>
        </Section>
      ) : (
        <>
          <Section title="Workspace preferences">
            <Form method="post">
              <div className="sp-form-grid">
                <Field name="name" label="Workspace name">
                  <input
                    id="name"
                    name="name"
                    defaultValue={workspace.name}
                    maxLength={100}
                    required
                    disabled={!canManage}
                  />
                </Field>
                <Field
                  name="retentionDays"
                  label="History retention target (days)"
                  hint="A retention policy target. Automated purge is not enabled; audit history is preserved."
                >
                  <input
                    id="retentionDays"
                    name="retentionDays"
                    type="number"
                    min={7}
                    max={3650}
                    defaultValue={workspace.retentionDays}
                    required
                    disabled={!canManage}
                  />
                </Field>
                <Field
                  name="reconciliationMinutes"
                  label="Default comparison interval (minutes)"
                  hint="Existing policies retain their own interval."
                >
                  <input
                    id="reconciliationMinutes"
                    name="reconciliationMinutes"
                    type="number"
                    min={5}
                    max={10080}
                    defaultValue={workspace.reconciliationMinutes}
                    required
                    disabled={!canManage}
                  />
                </Field>
                <Field name="failureThreshold" label="Failures before alert">
                  <input
                    id="failureThreshold"
                    name="failureThreshold"
                    type="number"
                    min={1}
                    max={100}
                    defaultValue={notification?.failureThreshold ?? 3}
                    required
                    disabled={!canManage}
                  />
                </Field>
                <Field name="lagMinutes" label="Queue lag alert (minutes)">
                  <input
                    id="lagMinutes"
                    name="lagMinutes"
                    type="number"
                    min={1}
                    max={1440}
                    defaultValue={notification?.lagMinutes ?? 15}
                    required
                    disabled={!canManage}
                  />
                </Field>
              </div>
              <label className="sp-checkbox">
                <input
                  name="notificationsEnabled"
                  type="checkbox"
                  defaultChecked={notification?.enabled ?? true}
                  disabled={!canManage}
                />
                Show operational alerts in SyncPilot
              </label>
              <div className="sp-actions">
                <Submit intent="settings" disabled={!canManage}>
                  Save preferences
                </Submit>
              </div>
            </Form>
          </Section>
          {notification?.enabled !== false && (
            <Section title="Operational alerts">
              {alerts.failed >= (notification?.failureThreshold ?? 3) && (
                <div role="alert" className="sp-notice sp-notice-error">
                  {alerts.failed} recent jobs need attention.{" "}
                  <Link to="/app/activity">Inspect failures</Link>
                </div>
              )}
              {alerts.lagging > 0 && (
                <div role="alert" className="sp-notice sp-notice-error">
                  {alerts.lagging} recent jobs exceed the configured queue lag
                  threshold.
                </div>
              )}
              {alerts.failed < (notification?.failureThreshold ?? 3) &&
                alerts.lagging === 0 && (
                  <p className="sp-muted">
                    No threshold alerts among the latest 50 jobs.
                  </p>
                )}
              <p className="sp-muted">
                Alerts stay inside this app. External email and messaging
                delivery is not configured.
              </p>
            </Section>
          )}
          {canManage && (
            <Section
              title="Staff access"
              description="Shopify verifies store owners. Owners can grant a Shopify staff identity read-only workspace access."
            >
              <Table headings={["Store", "Shopify user ID", "Role", "State"]}>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>{member.shopDomain}</td>
                    <td>{member.userId}</td>
                    <td>{member.role}</td>
                    <td>
                      <Status value={member.status} />
                    </td>
                  </tr>
                ))}
              </Table>
              <Form method="post">
                <div className="sp-form-grid">
                  <Field name="shopDomain" label="Store">
                    <select id="shopDomain" name="shopDomain">
                      {connections.map((connection) => (
                        <option key={connection.shopDomain}>
                          {connection.shopDomain}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field name="userId" label="Shopify staff user ID">
                    <input
                      id="userId"
                      name="userId"
                      inputMode="numeric"
                      pattern="[1-9][0-9]*"
                      required
                    />
                  </Field>
                  <Field name="status" label="Read-only access">
                    <select id="status" name="status">
                      <option value="ACTIVE">Grant access</option>
                      <option value="REVOKED">Revoke access</option>
                    </select>
                  </Field>
                </div>
                <Submit intent="member" secondary>
                  Update staff access
                </Submit>
              </Form>
            </Section>
          )}
        </>
      )}
      <Section title="Worker signals">
        <Table headings={["Worker", "State", "Last signal"]}>
          {heartbeats.map((heartbeat) => (
            <tr key={heartbeat.id}>
              <td className="sp-gid">{heartbeat.id}</td>
              <td>
                <Status
                  value={
                    heartbeat.status === "RUNNING" &&
                    observedNow - new Date(heartbeat.seenAt).getTime() > 120000
                      ? "STALE"
                      : heartbeat.status
                  }
                />
              </td>
              <td>
                <Time value={heartbeat.seenAt} />
              </td>
            </tr>
          ))}
        </Table>
        {heartbeats.length === 0 && (
          <p className="sp-muted">No worker heartbeat yet.</p>
        )}
      </Section>
      <Section
        title="Audit trail"
        description="Latest 50 authorized workspace decisions. Credentials and webhook payloads are excluded."
      >
        {audit.length ? (
          <Table headings={["Action", "Actor", "Resource", "When"]}>
            {audit.map((event) => (
              <tr key={event.id}>
                <td>{event.action.replaceAll("_", " ")}</td>
                <td className="sp-gid">{event.actor}</td>
                <td>
                  {event.resourceType}
                  <div className="sp-gid">{event.resourceId}</div>
                </td>
                <td>
                  <Time value={event.createdAt} />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="sp-muted">No audit entries yet.</p>
        )}
      </Section>
    </Page>
  );
}
