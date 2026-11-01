import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { Pagination } from "../components/list-navigation";
import { operationalCounts } from "../services/notifications.server";
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
    getOperations(actor, new URL(request.url).searchParams),
    actor.role === "OWNER"
      ? getMembers(actor)
      : Promise.resolve({ members: [], connections: [] }),
  ]);
  const lagMinutes = settings.notification?.lagMinutes ?? 15;
  const alerts = settings.workspace
    ? await operationalCounts(settings.workspace.id, lagMinutes)
    : { failed: 0, held: 0, lagging: 0 };
  return {
    ...settings,
    ...membership,
    audit: operations.audit,
    auditPage: operations.pages.audit,
    heartbeats: operations.heartbeats,
    alerts,
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
        retentionEnabled: checked(form, "retentionEnabled"),
        reconciliationMinutes: numberField(form, "reconciliationMinutes", 360),
        notificationsEnabled: checked(form, "notificationsEnabled"),
        externalNotificationsEnabled: checked(
          form,
          "externalNotificationsEnabled",
        ),
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
    auditPage,
    privacyRequests,
    externalAlertsConfigured,
    notificationDeliveries,
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
                  label="History retention (days)"
                  hint="With cleanup enabled, eligible closed history and audit entries older than this are deleted. Open conflicts, failed or held jobs, and current catalog data are preserved."
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
                  name="retentionEnabled"
                  type="checkbox"
                  defaultChecked={workspace.retentionEnabled}
                  disabled={!canManage}
                />
                Enable daily deletion of eligible history, including old audit
                entries
              </label>
              <p className="sp-muted">
                Deletion is permanent. Up to 500 entries per history type are
                removed per daily cleanup; larger backlogs continue on later
                days.
              </p>
              <label className="sp-checkbox">
                <input
                  name="notificationsEnabled"
                  type="checkbox"
                  defaultChecked={notification?.enabled ?? true}
                  disabled={!canManage}
                />
                Show operational alerts in SyncPilot
              </label>
              <label className="sp-checkbox">
                <input
                  name="externalNotificationsEnabled"
                  type="checkbox"
                  defaultChecked={notification?.externalEnabled ?? false}
                  disabled={!canManage || !externalAlertsConfigured}
                />
                Send alert counts and resolution notices to the
                operator-configured webhook
              </label>
              <p className="sp-muted">
                {externalAlertsConfigured
                  ? "A destination is configured. Deliveries contain a workspace reference and job counts; product data and credentials are excluded."
                  : "The deployment operator has not configured an external alert destination."}
              </p>
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
                  {alerts.failed} jobs need attention.{" "}
                  <Link to="/app/activity">Inspect failures</Link>
                </div>
              )}
              {alerts.held > 0 && (
                <div role="alert" className="sp-notice sp-notice-error">
                  {alerts.held} held jobs require review before retrying or
                  making further changes.
                </div>
              )}
              {alerts.lagging > 0 && (
                <div role="alert" className="sp-notice sp-notice-error">
                  {alerts.lagging} jobs exceed the configured queue lag
                  threshold.
                </div>
              )}
              {alerts.failed < (notification?.failureThreshold ?? 3) &&
                alerts.lagging === 0 &&
                alerts.held === 0 && (
                  <p className="sp-muted">
                    No job thresholds are exceeded in this workspace.
                  </p>
                )}
              <p className="sp-muted">
                External delivery requires the opt-in above. Each issue
                generates an opening notice and a resolution notice; an
                unchanged issue stays quiet.
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
      <Section
        title="External alert delivery"
        description="Latest 10 delivery attempts. Retry and response details exclude endpoint credentials and response bodies."
      >
        {notificationDeliveries.length ? (
          <Table
            headings={["Delivery", "State", "Attempts", "Result", "Created"]}
          >
            {notificationDeliveries.map((delivery) => (
              <tr key={delivery.id}>
                <td className="sp-gid">{delivery.id}</td>
                <td>
                  <Status value={delivery.status} />
                </td>
                <td>{delivery.attempts}</td>
                <td>
                  {delivery.errorCode ||
                    (delivery.deliveredAt ? "Delivered" : "Queued")}
                </td>
                <td>
                  <Time value={delivery.createdAt} />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="sp-muted">No external deliveries have been queued.</p>
        )}
      </Section>
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
        title="Privacy requests"
        description="Latest 25 receipts for this installation. SyncPilot does not store customer or order records. Store erasure requests are processed by the worker after uninstall."
      >
        {privacyRequests.length ? (
          <Table headings={["Request", "State", "Outcome", "Received"]}>
            {privacyRequests.map((request) => (
              <tr key={request.id}>
                <td>{request.topic.replaceAll("_", " ")}</td>
                <td>
                  <Status value={request.status} />
                </td>
                <td>
                  {request.outcome?.replaceAll("_", " ") || "Awaiting worker"}
                </td>
                <td>
                  <Time value={request.receivedAt} />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="sp-muted">No privacy requests for this installation.</p>
        )}
        <p>
          <Link to="/privacy" target="_blank" rel="noreferrer">
            Data handling and retention
          </Link>
        </p>
      </Section>
      <Section
        title="Audit trail"
        description="Authorized workspace decisions. Credentials and webhook payloads are excluded."
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
        <Pagination info={auditPage} param="auditPage" label="audit events" />
      </Section>
    </Page>
  );
}
