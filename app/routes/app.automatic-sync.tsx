import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { requireActor } from "../services/authorization.server";
import {
  getAutomaticConsents,
  grantAutomaticConsent,
  revokeAutomaticConsent,
} from "../services/automatic-sync.server";
import { databaseNow } from "../services/database-clock.server";
import {
  readActionForm,
  actionFailure,
  checked,
  numberField,
  textField,
} from "../components/actions.server";
import { Changes, readChanges } from "../components/previews";
import { DomainError } from "../domain/errors";
import { CONSENT_LIMITS, type ConsentLimit } from "../domain/automatic-limits";
import {
  EmptyState,
  Field,
  InlineAction,
  Notice,
  Page,
  ReadOnly,
  Section,
  Status,
  Submit,
  Table,
  Time,
} from "../components/ui";

const fieldLabels: Record<string, string> = {
  title: "Title",
  descriptionHtml: "Description",
  vendor: "Vendor",
  productType: "Product type",
  tags: "Tags",
  seoTitle: "SEO title",
  seoDescription: "SEO description",
};
const fieldList = (fields: string[]) =>
  fields.map((field) => fieldLabels[field] || field).join(", ");

const limits: {
  name: ConsentLimit;
  label: string;
  value: number;
  hint: string;
}[] = [
  {
    name: "durationMinutes",
    label: "Consent lasts (minutes)",
    value: 60,
    hint: "Consent ends after this time, at most 24 hours.",
  },
  {
    name: "intervalMinutes",
    label: "Run interval (minutes)",
    value: 15,
    hint: "At most one automatic run starts per interval.",
  },
  {
    name: "maxJobs",
    label: "Maximum runs",
    value: 4,
    hint: "Runs that write changes. Consent stops when they are used.",
  },
  {
    name: "maxChanges",
    label: "Maximum field changes in total",
    value: 50,
    hint: "Across every run. The reviewed plan must fit within it.",
  },
  {
    name: "perRunChanges",
    label: "Maximum field changes per run",
    value: 25,
    hint: "A larger run is held instead of written. The reviewed plan must fit within it.",
  },
];

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    ...(await getAutomaticConsents(
      requireActor(await authenticate.admin(request)),
    )),
    observedNow: (await databaseNow()).getTime(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const form = await readActionForm(request);
  try {
    const intent = textField(form, "intent");
    if (intent === "grant") {
      if (!checked(form, "confirmed"))
        return {
          error:
            "Confirm that you reviewed the plan and accept the limits before granting consent.",
        };
      await grantAutomaticConsent(actor, {
        policyId: textField(form, "policyId"),
        previewId: textField(form, "previewId"),
        durationMinutes: numberField(form, "durationMinutes"),
        intervalMinutes: numberField(form, "intervalMinutes"),
        maxJobs: numberField(form, "maxJobs"),
        maxChanges: numberField(form, "maxChanges"),
        perRunChanges: numberField(form, "perRunChanges"),
        confirmed: true,
      });
      return {
        success:
          "Automatic consent granted. The first run starts at the next worker cycle.",
      };
    }
    if (intent === "revoke") {
      await revokeAutomaticConsent(actor, textField(form, "id"));
      return {
        success:
          "Consent revoked. Queued automatic runs were cancelled and nothing further is written under it.",
      };
    }
    return { error: "Choose a valid automatic sync action." };
  } catch (error) {
    // Consent checks raise SyncError, which has no HTTP status. Its messages are
    // fixed app text, so show them instead of the generic failure.
    const known = error as { name?: string; code?: string; message?: string };
    return actionFailure(
      known.name === "SyncError"
        ? new DomainError(String(known.code), String(known.message), 409)
        : error,
    );
  }
}

function Limit({
  form,
  name,
  label,
  value,
  hint,
}: (typeof limits)[number] & { form: string }) {
  const id = `${form}-${name}`;
  return (
    <Field name={id} label={label} hint={hint}>
      <input
        id={id}
        name={name}
        type="number"
        min={CONSENT_LIMITS[name].min}
        max={CONSENT_LIMITS[name].max}
        step={1}
        defaultValue={value}
        required
      />
    </Field>
  );
}

export default function AutomaticSync() {
  const {
    paired,
    consents,
    policies,
    previews,
    automaticFields,
    canManage,
    enabled,
    observedNow,
  } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const eligible = policies.filter((policy) => policy.eligible);
  return (
    <Page
      title="Automatic sync"
      subtitle="Let SyncPilot keep descriptive product fields in step on a schedule, within limits a store owner sets."
      action={
        <Link className="sp-button sp-button-secondary" to="/app/rules">
          Sync rules
        </Link>
      }
    >
      <Notice data={result} />
      <ReadOnly canManage={canManage} />
      {!enabled && (
        <s-banner tone="info">
          Automatic sync is turned off for this deployment. New consents cannot
          be granted and existing consents do not run; you can still revoke
          them. Only the deployment operator can turn it on.
        </s-banner>
      )}
      <Section
        title="What automatic sync does"
        description="A store owner grants a short-lived consent for one sync policy after reviewing its exact plan. SyncPilot then compares the stores on a schedule and writes only what that consent allows."
      >
        <ol className="sp-steps">
          <li>
            <div>
              <strong>One-way descriptive fields only</strong>
              <p>
                It copies {fieldList(automaticFields)} from a policy&apos;s
                source store to its destination store, for products you have
                already mapped and verified.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>Never stock, prices or structure</strong>
              <p>
                It never changes inventory, prices, product status, URL handles
                or variants, and never creates, deletes or restructures products
                or collections. Those still need an exact plan approved on Sync
                rules.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>Bounded by time and budget</strong>
              <p>
                Each consent ends at its expiry time, runs at most once per
                interval, and stops when its run or change budget is used. A run
                with more changes than its per-run limit, or with any change
                outside the consent, is held instead of written.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>Stops when its setup changes</strong>
              <p>
                Pausing or editing the policy, changing its mappings,
                disconnecting a store, ending the pairing or the approving owner
                losing access stops automatic writes. After a policy or mapping
                change the consent is held, and a store owner must grant a new
                one.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>Owners decide</strong>
              <p>
                Only store owners can grant or revoke consent. Staff can view
                consents but cannot change them. Every automatic run is recorded
                in Activity and the audit trail.
              </p>
            </div>
          </li>
        </ol>
        <p>
          Deployment switch <Status value={enabled ? "ENABLED" : "DISABLED"} />
        </p>
        <p className="sp-muted">
          Read-only here. Automatic sync runs only while the deployment operator
          has enabled both automatic sync and Shopify writes.
        </p>
      </Section>
      {!paired ? (
        <Section title="Workspace required">
          <EmptyState
            title="Pair your stores first"
            href="/app/stores"
            label="Connect stores"
          >
            Automatic consent can be granted after both owners have approved a
            shared workspace. Separate store installations continue to operate
            independently.
          </EmptyState>
        </Section>
      ) : (
        <>
          <Section
            title="Consents"
            description="Up to 100 most recent consents. A held consent stopped because a run exceeded its limits or its policy or mappings changed; grant a new one to continue."
          >
            {consents.length ? (
              <Table
                headings={[
                  "State",
                  "Policy",
                  "Budget used",
                  "Schedule",
                  "Approved by",
                  "Actions",
                ]}
              >
                {consents.map((consent) => {
                  const policy = policies.find(
                    (item) => item.id === consent.policyId,
                  );
                  const lapsed =
                    new Date(consent.expiresAt).getTime() <= observedNow;
                  const state =
                    consent.status === "ACTIVE" && lapsed
                      ? "EXPIRED"
                      : consent.status;
                  return (
                    <tr key={consent.id}>
                      <td>
                        <Status value={state} />
                        {state === "ACTIVE" && consent.exhausted && (
                          <div className="sp-muted">Budget used</div>
                        )}
                      </td>
                      <td>
                        <div className="sp-stack">
                          {policy ? (
                            <>
                              <strong>{policy.sourceShopDomain}</strong>
                              <span className="sp-muted">
                                → {policy.targetShopDomain}
                              </span>
                            </>
                          ) : (
                            <span className="sp-muted">Policy unavailable</span>
                          )}
                          <span>{fieldList(consent.fields)}</span>
                        </div>
                      </td>
                      <td>
                        Runs {consent.usedJobs} / {consent.maxJobs}
                        <div className="sp-muted">
                          Changes {consent.usedChanges} / {consent.maxChanges}
                        </div>
                        <div className="sp-muted">
                          Up to {consent.perRunChanges} per run
                        </div>
                      </td>
                      <td>
                        Every {consent.intervalMinutes} min
                        <div className="sp-muted">
                          {state !== "ACTIVE" || consent.exhausted ? (
                            "Next run —"
                          ) : enabled ? (
                            <>
                              Next run <Time value={consent.nextRunAt} />
                            </>
                          ) : (
                            "Paused by the deployment switch"
                          )}
                        </div>
                        <div className="sp-muted">
                          {consent.revokedAt ? (
                            <>
                              Revoked <Time value={consent.revokedAt} />
                            </>
                          ) : (
                            <>
                              Expires <Time value={consent.expiresAt} />
                            </>
                          )}
                        </div>
                      </td>
                      <td className="sp-gid">{consent.approvedBy}</td>
                      <td>
                        {canManage &&
                        (consent.status === "ACTIVE" ||
                          consent.status === "HELD") ? (
                          <InlineAction
                            intent="revoke"
                            id={consent.id}
                            label="Revoke"
                            danger
                            confirm="Revoke this consent? Queued automatic runs are cancelled and nothing further is written under it."
                          />
                        ) : (
                          <span className="sp-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            ) : (
              <EmptyState title="No automatic consents yet">
                Every synchronization waits for an exact owner approval until a
                store owner grants a bounded consent.
              </EmptyState>
            )}
          </Section>
          {canManage && enabled && (
            <Section
              title="Grant consent"
              description="Choose a policy and one of its fresh exact plans. Review its changes, set the limits, then confirm. Only one active consent is allowed per policy."
            >
              {eligible.length ? (
                eligible.map((policy) => {
                  const plans = previews.filter(
                    (preview) => preview.policyId === policy.id,
                  );
                  // The server rejects empty, held or out-of-scope plans, and plans
                  // larger than the highest per-run limit; only offer the rest.
                  const usable = plans.filter((preview) => {
                    const changes = readChanges(preview.changes);
                    return (
                      changes.length > 0 &&
                      changes.length <= CONSENT_LIMITS.perRunChanges.max &&
                      changes.every(
                        (change) =>
                          change.kind === "PRODUCT" &&
                          Boolean(change.field) &&
                          policy.fields.includes(String(change.field)),
                      )
                    );
                  });
                  const active = consents.some(
                    (consent) =>
                      consent.policyId === policy.id &&
                      consent.status === "ACTIVE",
                  );
                  // Both change limits must cover the reviewed plan, so start them
                  // at least at the preselected (newest) plan's size.
                  const planSize = usable.length
                    ? readChanges(usable[0].changes).length
                    : 0;
                  return (
                    <details
                      className="sp-details"
                      key={policy.id}
                      open={eligible.length === 1}
                    >
                      <summary>
                        {policy.sourceShopDomain} → {policy.targetShopDomain} ·{" "}
                        {fieldList(policy.fields)}
                      </summary>
                      {active ? (
                        <div className="sp-inline-note">
                          This policy already has an active consent. Revoke it
                          above before granting a new one.
                        </div>
                      ) : !usable.length ? (
                        <div className="sp-inline-note">
                          No fresh plan can back a consent for this policy. Run
                          a dry run on <Link to="/app/rules">Sync rules</Link>{" "}
                          and return while it is unexpired. A plan qualifies
                          when it has between 1 and{" "}
                          {CONSENT_LIMITS.perRunChanges.max} changes, none are
                          held, and every change is a product field this policy
                          owns.
                        </div>
                      ) : (
                        <Form method="post">
                          <input
                            type="hidden"
                            name="policyId"
                            value={policy.id}
                          />
                          <fieldset className="sp-fieldset">
                            <legend>Reviewed plan</legend>
                            {usable.map((preview, index) => (
                              <div key={preview.id}>
                                <label className="sp-checkbox">
                                  <input
                                    type="radio"
                                    name="previewId"
                                    value={preview.id}
                                    defaultChecked={index === 0}
                                    required
                                  />
                                  <span>
                                    {readChanges(preview.changes).length}{" "}
                                    proposed changes · created{" "}
                                    <Time value={preview.createdAt} /> · expires{" "}
                                    <Time value={preview.expiresAt} />
                                  </span>
                                </label>
                                <details className="sp-details">
                                  <summary>Review these changes</summary>
                                  <Changes value={preview.changes} />
                                </details>
                              </div>
                            ))}
                            {plans.length > usable.length && (
                              <p className="sp-muted">
                                {plans.length - usable.length} other fresh plans
                                include held or out-of-scope changes, or more
                                than {CONSENT_LIMITS.perRunChanges.max} changes,
                                and cannot back a consent.
                              </p>
                            )}
                          </fieldset>
                          <div className="sp-form-grid">
                            {limits.map((limit) => (
                              <Limit
                                key={limit.name}
                                form={policy.id}
                                {...limit}
                                value={
                                  limit.name === "maxChanges" ||
                                  limit.name === "perRunChanges"
                                    ? Math.max(limit.value, planSize)
                                    : limit.value
                                }
                              />
                            ))}
                          </div>
                          <label className="sp-checkbox">
                            <input type="checkbox" name="confirmed" required />
                            <span>
                              I reviewed this plan and allow SyncPilot to copy{" "}
                              {fieldList(policy.fields)} from{" "}
                              {policy.sourceShopDomain} to{" "}
                              {policy.targetShopDomain} without further
                              approval, within these limits.
                            </span>
                          </label>
                          <div className="sp-actions">
                            <Submit intent="grant">
                              Grant automatic consent
                            </Submit>
                          </div>
                        </Form>
                      )}
                    </details>
                  );
                })
              ) : (
                <EmptyState
                  title="No eligible policy"
                  href="/app/rules"
                  label="Review sync rules"
                >
                  Automatic consent needs an active, owner-approved one-way
                  policy that owns only descriptive product fields (
                  {fieldList(automaticFields)}) with inventory, price and
                  variant sync turned off.
                </EmptyState>
              )}
            </Section>
          )}
        </>
      )}
    </Page>
  );
}
