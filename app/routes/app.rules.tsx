import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { requireActor } from "../services/authorization.server";
import { databaseNow } from "../services/database-clock.server";
import {
  approvePreview,
  getPolicies,
  previewPolicy,
  savePolicy,
  updatePolicy,
} from "../services/control-plane.server";
import {
  pageLoader,
  readActionForm,
  actionFailure,
  checked,
  numberField,
  textField,
} from "../components/actions.server";
import { Changes, readChanges } from "../components/previews";
import {
  EmptyState,
  Field,
  Form,
  InlineAction,
  Link,
  Notice,
  Page,
  ReadOnly,
  Section,
  Status,
  Submit,
  Table,
  Time,
} from "../components/ui";

const fieldLabels = {
  title: "Title",
  descriptionHtml: "Description",
  vendor: "Vendor",
  productType: "Product type",
  status: "Product status",
  handle: "URL handle",
  tags: "Tags",
  price: "Variant price",
  compareAtPrice: "Compare-at price",
  seoTitle: "SEO title",
  seoDescription: "SEO description",
  sku: "Variant SKU",
  taxable: "Variant tax status",
  inventoryPolicy: "Allow selling out of stock (DENY / CONTINUE)",
};

export const loader = pageLoader(async ({ request }: LoaderFunctionArgs) => {
  return {
    ...(await getPolicies(requireActor(await authenticate.admin(request)))),
    editingId: new URL(request.url).searchParams.get("edit"),
    observedNow: (await databaseNow()).getTime(),
  };
});

export async function action({ request }: ActionFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const form = await readActionForm(request);
  try {
    const intent = textField(form, "intent");
    if (intent === "save") {
      const mode = textField(form, "inventoryMode");
      if (mode !== "SOURCE" && mode !== "DISABLED")
        return { error: "Choose a supported inventory authority mode." };
      await savePolicy(actor, {
        id: textField(form, "id") || undefined,
        sourceShop: textField(form, "sourceShop"),
        targetShop: textField(form, "targetShop"),
        fields: form.getAll("fields").map(String),
        syncInventory: mode === "SOURCE",
        inventoryAuthority:
          mode === "SOURCE" ? textField(form, "sourceShop") : undefined,
        inventoryMode: mode,
        buffer: numberField(form, "buffer"),
        reconciliationMinutes: numberField(form, "reconciliationMinutes", 360),
      });
      return {
        success:
          "Policy saved as a draft. Run a new dry-run preview before approval or activation.",
      };
    }
    if (intent === "preview") {
      await previewPolicy(actor, textField(form, "id"));
      return {
        success:
          "Dry-run plan created. Review the exact proposed changes below.",
      };
    }
    if (intent === "approve") {
      if (!checked(form, "approvalConfirmed"))
        return {
          error: "Confirm that you reviewed the exact plan before approving.",
        };
      await approvePreview(actor, textField(form, "id"));
      return {
        success:
          "Plan approved. Durable jobs have been created for the reviewed changes.",
      };
    }
    if (intent === "pause" || intent === "activate") {
      await updatePolicy(
        actor,
        textField(form, "id"),
        intent === "pause" ? "PAUSE" : "ACTIVATE",
      );
      return {
        success:
          intent === "pause"
            ? "Policy paused. Workers check policy state before writing."
            : "Policy activated with the approved configuration.",
      };
    }
    return { error: "Choose a valid policy action." };
  } catch (error) {
    return actionFailure(error);
  }
}

export default function Rules() {
  const {
    policies,
    connections,
    previews,
    canManage,
    canOperate,
    writesEnabled,
    inventoryWritesEnabled,
    editingId,
    observedNow,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const editing = policies.find((policy) => policy.id === editingId);
  return (
    <Page
      title="Sync rules"
      subtitle="Choose the owner of each field and preview every change before execution."
      action={
        <Link className="sp-button sp-button-secondary" to="/app/mappings">
          Review mappings
        </Link>
      }
    >
      <Notice data={actionData} />
      {canOperate && !canManage ? (
        <s-banner tone="info">
          You have operator access. You can run dry-run previews; a store owner
          must save, activate, pause or approve policies.
        </s-banner>
      ) : (
        <ReadOnly canManage={canManage} />
      )}
      {!writesEnabled && (
        <s-banner tone="info">
          The server write gate is closed. Drafts and dry runs work; approving
          or activating Shopify writes remains blocked until the release gate is
          explicitly enabled.
        </s-banner>
      )}
      <Section
        title="Configured policies"
        description="Review a dry run, activate its policy, then approve the exact plan. For bidirectional product ownership, use reverse policies with disjoint fields; inventory has one authoritative source."
      >
        {policies.length ? (
          <Table
            headings={[
              "Direction",
              "Owned fields",
              "Inventory authority",
              "State",
              "Actions",
            ]}
          >
            {policies.map((policy) => (
              <tr key={policy.id}>
                <td>
                  <div className="sp-stack">
                    <strong>{policy.sourceShopDomain}</strong>
                    <span className="sp-muted">
                      → {policy.targetShopDomain}
                    </span>
                  </div>
                </td>
                <td>
                  {policy.fields
                    .map(
                      (field) =>
                        fieldLabels[field as keyof typeof fieldLabels] || field,
                    )
                    .join(", ") || "No product fields"}
                </td>
                <td>
                  {policy.syncInventory ? (
                    <>
                      <strong>{policy.inventoryAuthority}</strong>
                      <div className="sp-muted">
                        Available stock · buffer {policy.buffer}
                      </div>
                    </>
                  ) : (
                    <span className="sp-muted">Disabled</span>
                  )}
                </td>
                <td>
                  <Status value={policy.enabled ? "ACTIVE" : policy.status} />
                </td>
                <td>
                  <div className="sp-actions">
                    <Link
                      className="sp-button sp-button-secondary"
                      to={`?edit=${policy.id}`}
                    >
                      Edit
                    </Link>
                    {/* Operators may prepare plans; only owners change or approve them. */}
                    <InlineAction
                      intent="preview"
                      id={policy.id}
                      label="Dry run"
                      disabled={!canOperate}
                    />
                    {policy.enabled ? (
                      <InlineAction
                        intent="pause"
                        id={policy.id}
                        label="Pause"
                        disabled={!canManage}
                      />
                    ) : (
                      <InlineAction
                        intent="activate"
                        id={policy.id}
                        label="Activate"
                        disabled={
                          !canManage ||
                          !writesEnabled ||
                          (policy.syncInventory && !inventoryWritesEnabled)
                        }
                        confirm="Activate this policy after reviewing its dry run? Exact change plans still require separate approval before any write."
                      />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="Define your first sync policy">
            Pair stores and verify mappings, then choose which store owns the
            fields you want to synchronize.
          </EmptyState>
        )}
      </Section>
      {connections.length < 2 ? (
        <Section title="Workspace required">
          <EmptyState
            title="Connect two authorized stores"
            href="/app/stores"
            label="Connect stores"
          >
            Policy sources and destinations must both belong to your verified
            workspace.
          </EmptyState>
        </Section>
      ) : (
        <Section
          title={editing ? "Edit policy" : "Create a policy"}
          description="Pause an active policy before editing. Saving a draft invalidates prior approval. Deletion and destructive collection updates are unavailable."
        >
          {editing?.enabled && (
            <div className="sp-inline-note">
              This policy is active. Pause it in the table above before saving
              changes.
            </div>
          )}
          <Form method="post" key={editing?.id || "new"}>
            <input type="hidden" name="id" value={editing?.id || ""} />
            <div className="sp-form-grid">
              <Field name="sourceShop" label="Authoritative source store">
                <select
                  id="sourceShop"
                  name="sourceShop"
                  defaultValue={
                    editing?.sourceShopDomain || connections[0].shopDomain
                  }
                  required
                  disabled={!canManage}
                >
                  {connections.map((connection) => (
                    <option
                      value={connection.shopDomain}
                      key={connection.shopDomain}
                    >
                      {connection.shopDomain}
                    </option>
                  ))}
                </select>
              </Field>
              <Field name="targetShop" label="Destination store">
                <select
                  id="targetShop"
                  name="targetShop"
                  defaultValue={
                    editing?.targetShopDomain || connections[1].shopDomain
                  }
                  required
                  disabled={!canManage}
                >
                  {connections.map((connection) => (
                    <option
                      value={connection.shopDomain}
                      key={connection.shopDomain}
                    >
                      {connection.shopDomain}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <fieldset className="sp-fieldset" disabled={!canManage}>
              <legend>Fields owned by the source store</legend>
              <div className="sp-form-grid">
                {Object.entries(fieldLabels).map(([field, label]) => (
                  <label key={field} className="sp-checkbox">
                    <input
                      type="checkbox"
                      name="fields"
                      value={field}
                      defaultChecked={editing?.fields.includes(field)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="sp-muted">
                Price fields require matching store currencies. Changing a
                handle or status can affect customer-visible storefront
                behavior; review those changes carefully.
              </p>
            </fieldset>
            <div className="sp-form-grid">
              <Field
                name="inventoryMode"
                label="Inventory policy"
                hint="Only one source store can own available stock. Two-way and shared-pool quantity sync are not available; stock pools are a manual planning ledger that never changes Shopify quantities."
              >
                <select
                  id="inventoryMode"
                  name="inventoryMode"
                  defaultValue={editing?.inventoryMode || "DISABLED"}
                  disabled={!canManage}
                >
                  <option value="DISABLED">
                    Inventory synchronization disabled
                  </option>
                  <option value="SOURCE">
                    Source store owns available inventory
                  </option>
                </select>
              </Field>
              <Field
                name="buffer"
                label="Safety buffer"
                hint="Destination availability is max(0, source available − buffer)."
              >
                <input
                  id="buffer"
                  name="buffer"
                  type="number"
                  min={0}
                  max={1000000}
                  step={1}
                  defaultValue={editing?.buffer || 0}
                  disabled={!canManage}
                  required
                />
              </Field>
              <Field
                name="reconciliationMinutes"
                label="Reconciliation interval (minutes)"
                hint="Scheduled comparisons create reviewable plans. Repairs require approval."
              >
                <input
                  id="reconciliationMinutes"
                  name="reconciliationMinutes"
                  type="number"
                  min={15}
                  max={10080}
                  step={1}
                  defaultValue={editing?.reconciliationMinutes || 360}
                  disabled={!canManage}
                  required
                />
              </Field>
            </div>
            <div className="sp-actions">
              <Submit
                intent="save"
                disabled={!canManage || Boolean(editing?.enabled)}
              >
                Save draft policy
              </Submit>
              {editing && (
                <Link className="sp-button sp-button-secondary" to="/app/rules">
                  Create another policy
                </Link>
              )}
            </div>
          </Form>
        </Section>
      )}
      <Section
        title="Dry-run plans"
        description="Plans expire and are invalidated by changed source, destination, mappings, or policy. A held change must be corrected before approval."
      >
        {previews.length ? (
          previews.map((preview) => {
            const changes = readChanges(preview.changes);
            const held = changes.some((change) => change.kind === "HOLD");
            const expired =
              new Date(preview.expiresAt).getTime() <= observedNow;
            const policy = policies.find(
              (item) => item.id === preview.policyId,
            );
            return (
              <details
                className="sp-details"
                key={preview.id}
                open={preview.status === "PENDING"}
              >
                <summary>
                  <Status
                    value={
                      expired && preview.status === "PENDING"
                        ? "EXPIRED"
                        : preview.status
                    }
                  />{" "}
                  {changes.length} proposed changes{" "}
                  {held ? "· blocked items require review" : ""} ·{" "}
                  <Time value={preview.createdAt} />
                </summary>
                <div className="sp-actions">
                  <span className="sp-gid">{preview.id}</span>
                  <span className="sp-muted">
                    Expires <Time value={preview.expiresAt} />
                  </span>
                </div>
                <Changes value={preview.changes} />
                {preview.status === "PENDING" && (
                  <Form
                    method="post"
                    onSubmit={(event) => {
                      if (
                        !window.confirm(
                          "Approve these exact changes? Jobs will only execute under an active policy and the server write gates.",
                        )
                      )
                        event.preventDefault();
                    }}
                  >
                    <input type="hidden" name="id" value={preview.id} />
                    {!policy?.enabled && (
                      <p className="sp-muted">
                        Activate this policy after reviewing the plan, then
                        approve these exact changes.
                      </p>
                    )}
                    <label className="sp-checkbox">
                      <input
                        type="checkbox"
                        name="approvalConfirmed"
                        required
                        disabled={
                          !canManage ||
                          !writesEnabled ||
                          !policy?.enabled ||
                          expired ||
                          held
                        }
                      />
                      I reviewed these changes and authorize this plan.
                    </label>
                    <Submit
                      intent="approve"
                      disabled={
                        !canManage ||
                        !writesEnabled ||
                        !policy?.enabled ||
                        expired ||
                        held ||
                        Boolean(
                          policy?.syncInventory && !inventoryWritesEnabled,
                        ) ||
                        changes.length === 0
                      }
                    >
                      Approve exact plan
                    </Submit>
                  </Form>
                )}
              </details>
            );
          })
        ) : (
          <EmptyState title="No dry-run plans yet">
            Choose Dry run beside a policy to compare the latest imported source
            and destination data.
          </EmptyState>
        )}
      </Section>
    </Page>
  );
}
