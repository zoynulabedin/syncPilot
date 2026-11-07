import { assertStockConserved } from "../domain/stock-ledger";
import { randomUUID } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { requireActor } from "../services/authorization.server";
import {
  adjustStockPool,
  allocateStock,
  completeStockReservation,
  createStockPool,
  getStockPools,
  reserveStock,
} from "../services/stock-ledger.server";
import {
  pageLoader,
  actionFailure,
  checked,
  numberField,
  readActionForm,
  textField,
} from "../components/actions.server";
import {
  EmptyState,
  Field,
  Form,
  Link,
  Notice,
  Page,
  ReadOnly,
  Section,
  Submit,
  Table,
  Time,
} from "../components/ui";

export const loader = pageLoader(async ({ request }: LoaderFunctionArgs) => {
  const actor = requireActor(await authenticate.admin(request));
  const url = new URL(request.url);
  return {
    ...(await getStockPools(
      actor,
      url.searchParams.get("pool") || undefined,
      Number(url.searchParams.get("page") || 1),
    )),
    actionKey: randomUUID(),
  };
});

export async function action({ request }: ActionFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const form = await readActionForm(request);
  try {
    const intent = textField(form, "intent");
    const operation = {
      poolId: textField(form, "poolId"),
      operationKey: textField(form, "operationKey"),
      expectedVersion: numberField(form, "expectedVersion"),
    };
    if (intent === "create")
      await createStockPool(actor, {
        name: textField(form, "name"),
        reference: textField(form, "reference"),
        physical: numberField(form, "physical"),
        safetyBuffer: numberField(form, "safetyBuffer"),
        centralLedgerConfirmed: checked(form, "centralLedgerConfirmed"),
      });
    else if (intent === "adjust")
      await adjustStockPool(actor, {
        ...operation,
        physical: numberField(form, "physical"),
        safetyBuffer: numberField(form, "safetyBuffer"),
      });
    else if (intent === "allocate")
      await allocateStock(actor, {
        ...operation,
        shopDomain: textField(form, "shopDomain"),
        inventoryItemGid: textField(form, "inventoryItemGid"),
        locationGid: textField(form, "locationGid"),
        quantity: numberField(form, "quantity"),
      });
    else if (intent === "reserve")
      await reserveStock(actor, {
        ...operation,
        allocationId: textField(form, "allocationId"),
        reference: textField(form, "reference"),
        quantity: numberField(form, "quantity"),
      });
    else if (intent === "complete")
      await completeStockReservation(actor, {
        ...operation,
        reservationId: textField(form, "reservationId"),
        outcome: textField(form, "outcome"),
      });
    else return { error: "Choose a valid stock action." };
    return { success: "Stock ledger updated. Store quantities are unchanged." };
  } catch (error) {
    return actionFailure(error);
  }
}

function StockInput({
  name,
  label,
  value = 0,
}: {
  name: string;
  label: string;
  value?: number;
}) {
  return (
    <Field name={name} label={label}>
      <input
        id={name}
        name={name}
        type="number"
        min="0"
        max="2147483647"
        step="1"
        defaultValue={value}
        required
      />
    </Field>
  );
}

export default function StockPools() {
  const { pools, total, page, selected, connections, canManage, actionKey } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const state = selected
    ? assertStockConserved(
        selected,
        selected.allocations.map((allocation) => allocation.quantity),
      )
    : null;
  const hidden = (suffix: string) =>
    selected && (
      <>
        <input type="hidden" name="poolId" value={selected.id} />
        <input type="hidden" name="expectedVersion" value={selected.version} />
        <input
          type="hidden"
          name="operationKey"
          value={`${actionKey}:${suffix}`}
        />
      </>
    );
  return (
    <Page
      title="Shared stock ledger"
      subtitle="Manual planning ledger: split one physical stock pool into store allowances. Shopify quantities never change here."
      action={
        <Link className="sp-button sp-button-secondary" to="/app/inventory">
          Inventory monitor
        </Link>
      }
    >
      <Notice data={result} />
      <ReadOnly canManage={canManage} />
      <s-banner tone="info">
        This ledger records owner-approved allowances and reservations. It does
        not publish quantities to Shopify or import sales automatically. Record
        every reservation, release and fulfillment here before relying on its
        available stock.
      </s-banner>
      <Section
        title="Physical pools"
        description="New allowances cannot exceed what remains of physical stock after active reservations and its safety buffer. A later count or buffer change can leave existing reservations inside the buffer."
      >
        {!pools.length ? (
          <EmptyState title="No shared stock pools">
            A pool can be configured after both owners have approved a shared
            workspace. Separate store installations continue to operate
            independently.
          </EmptyState>
        ) : (
          <>
            <Table
              headings={[
                "Physical pool",
                "Physical",
                "Reserved",
                "Safety buffer",
                "Allocated",
                "Unallocated",
              ]}
            >
              {pools.map((pool) => {
                const balance = assertStockConserved(
                  pool,
                  pool.allocations.map((row) => row.quantity),
                );
                return (
                  <tr key={pool.id}>
                    <td>
                      <Link
                        to={`?pool=${encodeURIComponent(pool.id)}&page=${page}`}
                      >
                        {pool.name}
                      </Link>
                      <div className="sp-muted">{pool.reference}</div>
                    </td>
                    <td>{pool.physical}</td>
                    <td>{pool.reserved}</td>
                    <td>{pool.safetyBuffer}</td>
                    <td>{balance.allocated}</td>
                    <td>{balance.unallocated}</td>
                  </tr>
                );
              })}
            </Table>
            <div className="sp-pagination">
              <span>
                {total} pools · Page {page}
              </span>
              <div className="sp-actions">
                {page > 1 && <Link to={`?page=${page - 1}`}>Previous</Link>}
                {page * 25 < total && (
                  <Link to={`?page=${page + 1}`}>Next</Link>
                )}
              </div>
            </div>
          </>
        )}
      </Section>
      {canManage && connections.length > 0 && (
        <Section
          title="Create a physical pool"
          description="Use one reference for each physical item and warehouse. Confirm the physical count with your stock authority."
        >
          <Form method="post">
            <div className="sp-form-grid">
              <Field name="name" label="Pool name">
                <input id="name" name="name" maxLength={100} required />
              </Field>
              <Field
                name="reference"
                label="Physical item / warehouse reference"
              >
                <input
                  id="reference"
                  name="reference"
                  maxLength={100}
                  required
                />
              </Field>
              <StockInput name="physical" label="Physical stock" />
              <StockInput name="safetyBuffer" label="Safety buffer" />
            </div>
            <label className="sp-check">
              <input type="checkbox" name="centralLedgerConfirmed" required /> I
              confirm that this central ledger will account for this physical
              stock, reservations and fulfillment.
            </label>
            <Submit intent="create">Create stock pool</Submit>
          </Form>
        </Section>
      )}
      {selected && state && (
        <>
          <Section
            title={selected.name}
            description={`Physical ${selected.physical} · reserved ${selected.reserved} · allocated ${state.allocated} · unallocated ${state.unallocated}`}
          >
            {canManage && (
              <Form method="post">
                {hidden("adjust")}
                <div className="sp-form-grid">
                  <StockInput
                    name="physical"
                    label="Confirmed physical stock"
                    value={selected.physical}
                  />
                  <StockInput
                    name="safetyBuffer"
                    label="Safety buffer"
                    value={selected.safetyBuffer}
                  />
                </div>
                <Submit intent="adjust">
                  Confirm physical count and buffer
                </Submit>
              </Form>
            )}
          </Section>
          <Section
            title="Store allowances"
            description="A tracked inventory item at an active imported location can belong to only one physical pool. These allowances are planning values; Shopify quantities remain unchanged."
          >
            {selected.allocations.length > 0 && (
              <Table
                headings={[
                  "Store",
                  "Inventory item / location",
                  "Unreserved allowance",
                ]}
              >
                {selected.allocations.map((allocation) => (
                  <tr key={allocation.id}>
                    <td>{allocation.shopDomain}</td>
                    <td>
                      <div className="sp-gid">
                        {allocation.inventoryItemGid}
                      </div>
                      <div className="sp-gid">{allocation.locationGid}</div>
                    </td>
                    <td>{allocation.quantity}</td>
                  </tr>
                ))}
              </Table>
            )}
            {canManage && (
              <Form method="post">
                {hidden("allocate")}
                <div className="sp-form-grid">
                  <Field name="shopDomain" label="Store">
                    <select id="shopDomain" name="shopDomain" required>
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
                  <Field
                    name="inventoryItemGid"
                    label="Imported inventory item GID"
                  >
                    <input
                      id="inventoryItemGid"
                      name="inventoryItemGid"
                      pattern="gid://shopify/InventoryItem/[0-9]+"
                      required
                    />
                  </Field>
                  <Field name="locationGid" label="Imported location GID">
                    <input
                      id="locationGid"
                      name="locationGid"
                      pattern="gid://shopify/Location/[0-9]+"
                      required
                    />
                  </Field>
                  <StockInput
                    name="quantity"
                    label="Set unreserved allowance"
                  />
                </div>
                <Submit intent="allocate">Approve allowance</Submit>
              </Form>
            )}
          </Section>
          {canManage && selected.allocations.length > 0 && (
            <Section
              title="Reserve allocated stock"
              description="A reservation moves units from a store allowance into reserved stock. Use a unique external reference without customer information."
            >
              <Form method="post">
                {hidden("reserve")}
                <div className="sp-form-grid">
                  <Field name="allocationId" label="Store allowance">
                    <select id="allocationId" name="allocationId" required>
                      {selected.allocations.map((allocation) => (
                        <option key={allocation.id} value={allocation.id}>
                          {allocation.shopDomain} ·{" "}
                          {allocation.inventoryItemGid.split("/").pop()} ·{" "}
                          {allocation.quantity} available
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field name="reference" label="Reservation reference">
                    <input
                      id="reference"
                      name="reference"
                      maxLength={100}
                      required
                    />
                  </Field>
                  <StockInput name="quantity" label="Units to reserve" />
                </div>
                <Submit intent="reserve">Reserve units</Submit>
              </Form>
            </Section>
          )}
          <Section
            title="Active reservations"
            description="Up to 100 most recent active reservations. Release returns stock to its original allowance; fulfillment removes it from physical stock."
          >
            {!selected.reservations.length ? (
              <p className="sp-muted">No active reservations.</p>
            ) : (
              <Table headings={["Reference", "Units", "Created", "Complete"]}>
                {selected.reservations.map((reservation) => (
                  <tr key={reservation.id}>
                    <td>{reservation.reference}</td>
                    <td>{reservation.quantity}</td>
                    <td>
                      <Time value={reservation.createdAt} />
                    </td>
                    <td>
                      {canManage && (
                        <Form method="post">
                          {hidden(reservation.id)}
                          <input
                            type="hidden"
                            name="reservationId"
                            value={reservation.id}
                          />
                          <input type="hidden" name="intent" value="complete" />
                          <button
                            className="sp-button sp-button-secondary"
                            name="outcome"
                            value="RELEASED"
                          >
                            Release units
                          </button>{" "}
                          <button
                            className="sp-button"
                            name="outcome"
                            value="FULFILLED"
                          >
                            Confirm fulfilled
                          </button>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
          <Section title="Recent stock changes">
            <Table headings={["Change", "Resulting version", "Recorded"]}>
              {selected.operations.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.kind.toLowerCase()}</td>
                  <td>{(entry.result as { version?: number }).version}</td>
                  <td>
                    <Time value={entry.createdAt} />
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
        </>
      )}
    </Page>
  );
}
