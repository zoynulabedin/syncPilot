import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { useState } from "react";
import { Pagination, QueryFields } from "../components/list-navigation";
import { authenticate } from "../shopify.server";
import { requireActor } from "../services/authorization.server";
import {
  deleteMapping,
  getMappings,
  saveMapping,
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
  const result = await getMappings(
    requireActor(await authenticate.admin(request)),
    new URL(request.url).searchParams,
  );
  return result;
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const form = await readActionForm(request);
  try {
    const kind = textField(form, "kind");
    if (kind !== "PRODUCT" && kind !== "VARIANT" && kind !== "LOCATION")
      return { error: "Choose a valid mapping type." };
    if (textField(form, "intent") === "delete") {
      await deleteMapping(actor, { kind, id: textField(form, "id") });
      return {
        success:
          "Mapping removed. Any execution requiring it will be held until a valid mapping is verified.",
      };
    }
    if (
      textField(form, "intent") !== "save" ||
      !checked(form, "identityConfirmed")
    )
      return {
        error:
          "Review both resources and confirm their identity before verifying a mapping.",
      };
    await saveMapping(actor, {
      kind,
      sourceShop: textField(form, "sourceShop"),
      targetShop: textField(form, "targetShop"),
      sourceGid: textField(form, "sourceGid"),
      targetGid: textField(form, "targetGid"),
    });
    return {
      success:
        "Mapping verified. Preview a policy to review the changes it would produce.",
    };
  } catch (error) {
    return actionFailure(error);
  }
}

export default function MappingsPage() {
  const { kind } = useLoaderData<typeof loader>();
  return <Mappings key={kind} />;
}

function Mappings() {
  const {
    products,
    variants,
    locations,
    snapshots,
    connections,
    canManage,
    kind,
    q,
    resourceQ,
    mappingPage,
    resourcePage,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [sourceShop, setSourceShop] = useState(
    connections[0]?.shopDomain || "",
  );
  const [targetShop, setTargetShop] = useState(
    connections[1]?.shopDomain || "",
  );
  const [sourceGid, setSourceGid] = useState("");
  const [targetGid, setTargetGid] = useState("");
  const resources =
    kind === "PRODUCT"
      ? snapshots.products.map((item) => ({
          shop: item.shopDomain,
          gid: item.productGid,
          label: item.title,
          detail: `${item.status} · ${item.vendor || "No vendor"}`,
        }))
      : kind === "VARIANT"
        ? snapshots.variants.map((item) => ({
            shop: item.shopDomain,
            gid: item.variantGid,
            label: `${item.sku || "No SKU"} · ${item.price}`,
            detail: `Barcode ${item.barcode || "—"} · Options ${JSON.stringify(item.options)}`,
          }))
        : snapshots.locations.map((item) => ({
            shop: item.shopDomain,
            gid: item.locationGid,
            label: item.name,
            detail: item.isActive ? "Active location" : "Inactive location",
          }));
  const gidType =
    kind === "PRODUCT"
      ? "Product"
      : kind === "VARIANT"
        ? "ProductVariant"
        : "Location";
  const source = resources.find(
    (item) => item.shop === sourceShop && item.gid === sourceGid,
  );
  const target = resources.find(
    (item) => item.shop === targetShop && item.gid === targetGid,
  );
  const mappings = [
    ...products.map((item) => ({
      id: item.id,
      kind: "PRODUCT",
      sourceShop: item.sourceShopDomain,
      targetShop: item.targetShopDomain,
      sourceGid: item.sourceProductGid,
      targetGid: item.targetProductGid,
      verifiedAt: item.verifiedAt,
    })),
    ...variants.map((item) => ({
      id: item.id,
      kind: "VARIANT",
      sourceShop: item.sourceShopDomain,
      targetShop: item.targetShopDomain,
      sourceGid: item.sourceVariantGid,
      targetGid: item.targetVariantGid,
      verifiedAt: item.verifiedAt,
    })),
    ...locations.map((item) => ({
      id: item.id,
      kind: "LOCATION",
      sourceShop: item.sourceShopDomain,
      targetShop: item.targetShopDomain,
      sourceGid: item.sourceLocationGid,
      targetGid: item.targetLocationGid,
      verifiedAt: item.verifiedAt,
    })),
  ];
  return (
    <Page
      title="Product, variant & location mappings"
      subtitle="Verify the identity of each resource before any cross-store change."
      action={
        <Link className="sp-button sp-button-secondary" to="/app/products">
          Import catalogs
        </Link>
      }
    >
      <Notice data={actionData} />
      <ReadOnly canManage={canManage} />
      <Section title="Find imported resources and mappings">
        <Form method="get" className="sp-search">
          <QueryFields
            exclude={["kind", "q", "resourceQ", "mappingPage", "resourcePage"]}
          />
          <Field name="kind" label="Resource type">
            <select id="kind" name="kind" defaultValue={kind}>
              <option value="PRODUCT">Products</option>
              <option value="VARIANT">Variants</option>
              <option value="LOCATION">Locations</option>
            </select>
          </Field>
          <Field name="resourceQ" label="Find imported resources">
            <input
              type="search"
              id="resourceQ"
              name="resourceQ"
              defaultValue={resourceQ}
              maxLength={120}
              placeholder="Title, SKU, barcode or full GID"
            />
          </Field>
          <Field name="q" label="Find verified mappings">
            <input
              type="search"
              id="q"
              name="q"
              defaultValue={q}
              maxLength={120}
              placeholder="GID or store"
            />
          </Field>
          <button type="submit" className="sp-button sp-button-secondary">
            Search
          </button>
        </Form>
        <Pagination
          info={resourcePage}
          param="resourcePage"
          label="imported resources"
        />
      </Section>
      {connections.length < 2 ? (
        <Section title="Pair stores first">
          <EmptyState
            title="A verified workspace is required"
            href="/app/stores"
            label="Connect stores"
          >
            Mappings only reference resources imported from two explicitly
            paired installations.
          </EmptyState>
        </Section>
      ) : (
        <Section
          title="Verify a resource pair"
          description="Map products first, their variants second, and locations before inventory. A matching SKU is a clue, not proof of identity."
        >
          <Form method="post" key={kind}>
            <input type="hidden" name="kind" value={kind} />
            <div className="sp-form-grid">
              <Field name="sourceShop" label="Source store">
                <select
                  id="sourceShop"
                  name="sourceShop"
                  value={sourceShop}
                  onChange={(event) => {
                    setSourceShop(event.currentTarget.value);
                    setSourceGid("");
                  }}
                >
                  {connections.map((connection) => (
                    <option
                      key={connection.shopDomain}
                      value={connection.shopDomain}
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
                  value={targetShop}
                  onChange={(event) => {
                    setTargetShop(event.currentTarget.value);
                    setTargetGid("");
                  }}
                >
                  <option value="">Select store</option>
                  {connections
                    .filter(
                      (connection) => connection.shopDomain !== sourceShop,
                    )
                    .map((connection) => (
                      <option
                        key={connection.shopDomain}
                        value={connection.shopDomain}
                      >
                        {connection.shopDomain}
                      </option>
                    ))}
                </select>
              </Field>
              <Field
                name="sourceGid"
                label={`Source ${kind.toLowerCase()} GID`}
                hint="Choose a suggestion or paste the full Shopify GID from your imported catalog."
              >
                <input
                  id="sourceGid"
                  name="sourceGid"
                  list="source-resources"
                  value={sourceGid}
                  onChange={(event) => setSourceGid(event.currentTarget.value)}
                  placeholder={`gid://shopify/${gidType}/123`}
                  pattern={`gid://shopify/${gidType}/[0-9]+`}
                  required
                  disabled={!canManage}
                  autoComplete="off"
                />
                <datalist id="source-resources">
                  {resources
                    .filter((item) => item.shop === sourceShop)
                    .map((item) => (
                      <option
                        key={item.gid}
                        value={item.gid}
                        label={item.label}
                      />
                    ))}
                </datalist>
              </Field>
              <Field
                name="targetGid"
                label={`Destination ${kind.toLowerCase()} GID`}
                hint="Every submitted GID is checked against this paired store’s imported records."
              >
                <input
                  id="targetGid"
                  name="targetGid"
                  list="target-resources"
                  value={targetGid}
                  onChange={(event) => setTargetGid(event.currentTarget.value)}
                  placeholder={`gid://shopify/${gidType}/456`}
                  pattern={`gid://shopify/${gidType}/[0-9]+`}
                  required
                  disabled={!canManage}
                  autoComplete="off"
                />
                <datalist id="target-resources">
                  {resources
                    .filter((item) => item.shop === targetShop)
                    .map((item) => (
                      <option
                        key={item.gid}
                        value={item.gid}
                        label={item.label}
                      />
                    ))}
                </datalist>
              </Field>
            </div>
            {(sourceGid || targetGid) && (
              <div className="sp-grid" style={{ marginTop: 18 }}>
                <div className="sp-inline-note">
                  <strong>
                    {source?.label ||
                      (sourceGid
                        ? "Full source ID entered"
                        : "Select a source")}
                  </strong>
                  <p>
                    {source?.detail ||
                      (sourceGid
                        ? "Confirm identity in the catalog. The server verifies that this ID was imported from the selected store."
                        : "")}
                  </p>
                  <Gid value={sourceGid} />
                </div>
                <div className="sp-inline-note">
                  <strong>
                    {target?.label ||
                      (targetGid
                        ? "Full destination ID entered"
                        : "Select a destination")}
                  </strong>
                  <p>
                    {target?.detail ||
                      (targetGid
                        ? "Confirm identity in the catalog. The server verifies that this ID was imported from the selected store."
                        : "")}
                  </p>
                  <Gid value={targetGid} />
                </div>
              </div>
            )}
            <p className="sp-muted">
              Suggestions use the resource search and page above. Search the
              full catalog or enter a full imported GID.
            </p>
            <label className="sp-checkbox">
              <input
                type="checkbox"
                name="identityConfirmed"
                required
                disabled={!canManage}
              />
              I verified these resources refer to the same product, option
              combination, or physical stock location. I did not rely on SKU
              alone.
            </label>
            <div className="sp-actions">
              <Submit
                intent="save"
                disabled={
                  !canManage ||
                  !sourceGid ||
                  !targetGid ||
                  sourceShop === targetShop
                }
              >
                Verify mapping
              </Submit>
            </div>
          </Form>
        </Section>
      )}
      <Section
        title="Verified mappings"
        description="Identity is stored with Shopify GIDs. Removing a mapping prevents subsequent writes that depend on it."
      >
        {mappings.length ? (
          <Table
            headings={[
              "Source",
              "Destination",
              "Verification",
              "Verified",
              "Actions",
            ]}
          >
            {mappings.map((mapping) => (
              <tr key={mapping.id}>
                <td>
                  <div className="sp-stack">
                    <strong>
                      <Gid value={mapping.sourceGid} />
                    </strong>
                    <span className="sp-muted">{mapping.sourceShop}</span>
                  </div>
                </td>
                <td>
                  <div className="sp-stack">
                    <strong>
                      <Gid value={mapping.targetGid} />
                    </strong>
                    <span className="sp-muted">{mapping.targetShop}</span>
                  </div>
                </td>
                <td>
                  <Status
                    value={mapping.verifiedAt ? "VERIFIED" : "NEEDS_REVIEW"}
                  />
                </td>
                <td>
                  <Time value={mapping.verifiedAt} />
                </td>
                <td>
                  <Form
                    method="post"
                    onSubmit={(event) => {
                      if (
                        !window.confirm(
                          "Remove this mapping? Queued work requiring it will be held.",
                        )
                      )
                        event.preventDefault();
                    }}
                  >
                    <input type="hidden" name="kind" value={mapping.kind} />
                    <input type="hidden" name="id" value={mapping.id} />
                    <Submit
                      intent="delete"
                      secondary
                      danger
                      disabled={!canManage}
                    >
                      Remove
                    </Submit>
                  </Form>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="No mappings for this view">
            Import both catalogs, compare the identities above, and verify each
            pair. Ambiguous items should remain unmapped.
          </EmptyState>
        )}
        <Pagination info={mappingPage} param="mappingPage" label="mappings" />
      </Section>
    </Page>
  );
}
