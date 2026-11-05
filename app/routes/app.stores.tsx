import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import { requireActor } from "../services/authorization.server";
import {
  acceptPairing,
  confirmPairing,
  disconnectStore,
  getStores,
  initiatePairing,
  rejectPairing,
  verifyStore,
} from "../services/control-plane.server";
import {
  readActionForm,
  actionFailure,
  checked,
  textField,
} from "../components/actions.server";
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

export async function loader({ request }: LoaderFunctionArgs) {
  return getStores(requireActor(await authenticate.admin(request)));
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const form = await readActionForm(request);
  try {
    switch (textField(form, "intent")) {
      case "initiate": {
        const result = await initiatePairing(actor, {
          destinationShop: textField(form, "destinationShop"),
          organizationConfirmed: checked(form, "organizationConfirmed"),
        });
        return {
          success:
            "Pairing request created. Share the request ID and one-time challenge securely with the owner of the other store.",
          challenge: result.challenge,
          requestId: result.request.id,
        };
      }
      case "accept":
        await acceptPairing(actor, {
          requestId: textField(form, "requestId"),
          challenge: textField(form, "challenge"),
          organizationConfirmed: checked(form, "organizationConfirmed"),
        });
        break;
      case "confirm":
        await confirmPairing(actor, { requestId: textField(form, "id") });
        break;
      case "reject":
        await rejectPairing(actor, textField(form, "id"));
        break;
      case "disconnect":
        await disconnectStore(actor, textField(form, "id"));
        break;
      case "verify": {
        const result = await verifyStore(actor, textField(form, "id"));
        return result.verified
          ? {
              success: "Shopify confirmed this installation and its scopes.",
              challenge: undefined,
              requestId: undefined,
            }
          : { error: `Shopify check failed. ${result.message}` };
      }
      default:
        return { error: "Choose a valid connection action." };
    }
    return {
      success: "Connection updated.",
      challenge: undefined,
      requestId: undefined,
    };
  } catch (error) {
    return actionFailure(error);
  }
}

export default function Stores() {
  const { current, connections, pairings, workspace, canManage, canVerify } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  const challenge =
    actionData && "challenge" in actionData ? actionData.challenge : undefined;
  const requestId =
    actionData && "requestId" in actionData ? actionData.requestId : undefined;
  return (
    <Page
      title="Stores & connections"
      subtitle="Two separate installations. One verified workspace."
      action={
        <button
          className="sp-button sp-button-secondary"
          onClick={() => revalidator.revalidate()}
          disabled={revalidator.state !== "idle"}
        >
          Refresh connection status
        </button>
      }
    >
      <Notice data={actionData} />
      <ReadOnly canManage={canManage} />
      {challenge && (
        <Section
          title="Save this one-time pairing challenge"
          description="This challenge is shown once. It expires with the request; it is never an API token."
        >
          <p>Request ID</p>
          <div className="sp-code">{requestId}</div>
          <p>Challenge</p>
          <div className="sp-code">{challenge}</div>
          <p className="sp-muted">
            The receiving owner enters both values in their own installation.
            Return here to confirm after they accept.
          </p>
        </Section>
      )}
      <Section
        title={workspace?.name || "Current installation"}
        description="A domain alone never grants access to another store."
      >
        <Table
          headings={[
            "Store",
            "Installation",
            "Pairing",
            "Last seen",
            "Last verified",
            "Actions",
          ]}
        >
          {(connections.length ? connections : [current]).map((connection) => (
            <tr key={connection.shopDomain}>
              <td>
                <strong>{connection.shopDomain}</strong>
                {connection.shopDomain === current.shopDomain && (
                  <div className="sp-muted">This installation</div>
                )}
              </td>
              <td>
                <Status value={connection.status} />
              </td>
              <td>
                <Status
                  value={connection.workspaceId ? "VERIFIED" : "NOT_PAIRED"}
                />
              </td>
              <td>
                <Time value={connection.lastSeenAt} />
              </td>
              <td>
                <Time value={connection.verifiedAt} />
                {connection.lastError && (
                  <div className="sp-risk">{connection.lastError}</div>
                )}
              </td>
              <td>
                <div className="sp-actions">
                  <InlineAction
                    intent="verify"
                    id={connection.shopDomain}
                    label="Verify"
                    disabled={!canVerify}
                  />
                  {connection.workspaceId && (
                    <InlineAction
                      intent="disconnect"
                      id={connection.shopDomain}
                      label="Disconnect"
                      danger
                      disabled={!canManage}
                      confirm="Disconnect this store? Policies will be paused and pending jobs cancelled. Reconnecting requires both owners to approve again."
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Section>
      {!workspace && (
        <div className="sp-grid">
          <Section
            title="1. Request a connection"
            description="Install this same app in both eligible development stores or stores in the same Shopify Plus organization before pairing."
          >
            <Form method="post" className="sp-stack">
              <Field
                name="destinationShop"
                label="Other store’s Shopify domain"
                hint="Use the permanent myshopify.com domain."
              >
                <input
                  id="destinationShop"
                  name="destinationShop"
                  placeholder="your-other-store.myshopify.com"
                  required
                  disabled={!canManage}
                  autoComplete="off"
                />
              </Field>
              <label className="sp-checkbox">
                <input
                  name="organizationConfirmed"
                  type="checkbox"
                  required
                  disabled={!canManage}
                />
                I confirm these installations are eligible development stores or
                belong to the same Shopify Plus organization, and both owners
                authorize this connection.
              </label>
              <div className="sp-actions">
                <Submit intent="initiate" disabled={!canManage}>
                  Create pairing request
                </Submit>
              </div>
            </Form>
          </Section>
          <Section
            title="2. Accept an invitation"
            description="Use the request ID and challenge shared by the initiating store owner."
          >
            <Form method="post">
              <Field name="requestId" label="Request ID">
                <input
                  id="requestId"
                  name="requestId"
                  required
                  disabled={!canManage}
                  autoComplete="off"
                />
              </Field>
              <Field name="challenge" label="One-time challenge">
                <input
                  id="challenge"
                  name="challenge"
                  required
                  disabled={!canManage}
                  autoComplete="off"
                />
              </Field>
              <label className="sp-checkbox">
                <input
                  name="organizationConfirmed"
                  type="checkbox"
                  required
                  disabled={!canManage}
                />
                I authorize this pairing and confirm these stores are eligible
                to share this custom app.
              </label>
              <div className="sp-actions">
                <Submit intent="accept" disabled={!canManage}>
                  Accept pairing
                </Submit>
              </div>
            </Form>
          </Section>
        </div>
      )}
      <Section
        title="Pairing requests"
        description="Both owners must approve. Requests expire automatically; expired or rejected requests never grant access."
      >
        {pairings.length === 0 ? (
          <EmptyState title="No pairing requests yet">
            Create a request after the app is installed in your second
            authorized store.
          </EmptyState>
        ) : (
          <Table
            headings={["Request", "Stores", "Status", "Expires", "Actions"]}
          >
            {pairings.map((pairing) => (
              <tr key={pairing.id}>
                <td>
                  <span className="sp-gid">{pairing.id}</span>
                </td>
                <td>
                  <div className="sp-stack">
                    <span>{pairing.initiatingShop}</span>
                    <span className="sp-muted">
                      → {pairing.destinationShop}
                    </span>
                  </div>
                </td>
                <td>
                  <Status value={pairing.state} />
                </td>
                <td>
                  <Time value={pairing.expiresAt} />
                </td>
                <td>
                  <div className="sp-actions">
                    {pairing.initiatingShop === current.shopDomain &&
                      pairing.state === "ACCEPTED" && (
                        <InlineAction
                          intent="confirm"
                          id={pairing.id}
                          label="Confirm connection"
                          disabled={!canManage}
                          confirm="Confirm that both store owners approve this workspace connection?"
                        />
                      )}
                    {["PENDING", "ACCEPTED"].includes(pairing.state) && (
                      <InlineAction
                        intent="reject"
                        id={pairing.id}
                        label="Reject"
                        disabled={!canManage}
                        danger
                      />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </Page>
  );
}
