import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { requireActor } from "../services/authorization.server";
import { getWorkspace } from "../services/control-plane.server";
import {
  EmptyState,
  Field,
  Gid,
  Page,
  Section,
  Table,
  Time,
} from "../components/ui";
import { clampPage, parsePage } from "../components/pagination";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const { connections } = await getWorkspace(actor);
  const shops = [
    ...new Set([
      actor.shop,
      ...connections.map((connection) => connection.shopDomain),
    ]),
  ];
  const url = new URL(request.url);
  const shop = url.searchParams.get("store") || actor.shop;
  if (!shops.includes(shop))
    throw new Response("Store access denied", { status: 403 });
  const q = (url.searchParams.get("q") || "").slice(0, 120);
  const location = url.searchParams.get("location") || "";
  const requestedPage = parsePage(url.searchParams.get("page"));
  const searchProducts = q
    ? await db.productSnapshot.findMany({
        where: {
          shopDomain: shop,
          title: { contains: q, mode: "insensitive" },
        },
        select: { productGid: true },
      })
    : [];
  const searchVariants = q
    ? await db.variantSnapshot.findMany({
        where: {
          shopDomain: shop,
          OR: [
            { sku: { contains: q, mode: "insensitive" } },
            { barcode: { contains: q, mode: "insensitive" } },
            {
              productGid: {
                in: searchProducts.map((product) => product.productGid),
              },
            },
          ],
        },
        select: { inventoryItemGid: true },
        distinct: ["inventoryItemGid"],
      })
    : [];
  const where = {
    shopDomain: shop,
    ...(location ? { locationGid: location } : {}),
    ...(q
      ? {
          inventoryItemGid: {
            in: searchVariants
              .map((variant) => variant.inventoryItemGid)
              .filter((id): id is string => Boolean(id)),
          },
        }
      : {}),
  };
  const total = await db.inventorySnapshot.count({ where });
  const page = clampPage(requestedPage, total, 50);
  const [inventory, locations] = await Promise.all([
    db.inventorySnapshot.findMany({
      where,
      orderBy: [{ quantity: "asc" }, { id: "asc" }],
      take: 50,
      skip: (page - 1) * 50,
    }),
    db.locationSnapshot.findMany({
      where: { shopDomain: shop },
      orderBy: { name: "asc" },
    }),
  ]);
  const variants = await db.variantSnapshot.findMany({
    where: {
      shopDomain: shop,
      inventoryItemGid: { in: inventory.map((item) => item.inventoryItemGid) },
    },
  });
  const products = await db.productSnapshot.findMany({
    where: {
      shopDomain: shop,
      productGid: { in: variants.map((variant) => variant.productGid) },
    },
    select: { productGid: true, title: true },
  });
  return {
    shop,
    shops,
    inventory,
    total,
    locations,
    variants,
    products,
    q,
    location,
    page,
    observedNow: Date.now(),
  };
}

export default function Inventory() {
  const {
    shop,
    shops,
    inventory,
    total,
    locations,
    variants,
    products,
    q,
    location,
    page,
    observedNow,
  } = useLoaderData<typeof loader>();
  const pageLink = (next: number) =>
    `?${new URLSearchParams({ store: shop, q, location, page: String(next) })}`;
  return (
    <Page
      title="Inventory monitor"
      subtitle="Location-level available quantities from the latest imported observations."
      action={
        <>
          <Link className="sp-button" to="/app/mappings?kind=LOCATION">
            Map locations
          </Link>
          <Link className="sp-button sp-button-secondary" to="/app/products">
            Refresh catalog
          </Link>
        </>
      }
    >
      <s-banner tone="info">
        Inventory is reported per location. Available stock can change between
        observations; this view does not reserve stock or guarantee zero
        overselling across stores.
      </s-banner>
      <Section
        title="Available stock"
        description="Safety buffers and the authoritative source are configured in Sync Rules. Absolute writes always compare against a fresh target quantity."
      >
        <Form method="get" className="sp-search">
          <Field name="store" label="Store">
            <select id="store" name="store" defaultValue={shop}>
              {shops.map((domain) => (
                <option key={domain} value={domain}>
                  {domain}
                </option>
              ))}
            </select>
          </Field>
          <Field name="q" label="Search product, SKU, or barcode">
            <input
              id="q"
              name="q"
              type="search"
              placeholder="Search inventory"
              defaultValue={q}
            />
          </Field>
          <Field name="location" label="Location">
            <select id="location" name="location" defaultValue={location}>
              <option value="">All locations</option>
              {locations.map((item) => (
                <option key={item.id} value={item.locationGid}>
                  {item.name}
                  {item.isActive ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className="sp-button sp-button-secondary">
            Apply filters
          </button>
        </Form>
        {inventory.length === 0 ? (
          <EmptyState
            title={
              q || location
                ? "No matching inventory"
                : "No location inventory imported"
            }
            href="/app/products"
            label="Open catalog"
          >
            Import the catalog to read tracked inventory items and their
            available quantity at every location.
          </EmptyState>
        ) : (
          <>
            <Table
              headings={[
                "Product / SKU",
                "Location",
                "Available",
                "Inventory item",
                "Observed",
              ]}
            >
              {inventory.map((item) => {
                const variant = variants.find(
                  (value) => value.inventoryItemGid === item.inventoryItemGid,
                );
                const product = products.find(
                  (value) => value.productGid === variant?.productGid,
                );
                const warehouse = locations.find(
                  (value) => value.locationGid === item.locationGid,
                );
                const stale =
                  observedNow - new Date(item.observedAt).getTime() > 3_600_000;
                return (
                  <tr key={item.id}>
                    <td>
                      <strong>{product?.title || "Unknown product"}</strong>
                      <div className="sp-muted">{variant?.sku || "No SKU"}</div>
                    </td>
                    <td>
                      {warehouse?.name || <Gid value={item.locationGid} />}
                      {warehouse && !warehouse.isActive && (
                        <div className="sp-risk">Inactive location</div>
                      )}
                    </td>
                    <td>
                      <strong className={item.quantity <= 0 ? "sp-risk" : ""}>
                        {item.quantity}
                      </strong>
                      <div className="sp-muted">
                        {item.quantity <= 0
                          ? "Out of stock"
                          : item.quantity <= 5
                            ? "Low stock"
                            : "Available"}
                      </div>
                    </td>
                    <td>
                      <Gid value={item.inventoryItemGid} />
                    </td>
                    <td>
                      <Time value={item.observedAt} />
                      {stale && (
                        <div className="sp-risk">
                          Observation older than 1 hour
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
            <div className="sp-pagination">
              <span>
                {total} location quantities · Page {page} of{" "}
                {Math.max(1, Math.ceil(total / 50))}
              </span>
              <div className="sp-actions">
                {page > 1 && (
                  <Link
                    className="sp-button sp-button-secondary"
                    to={pageLink(page - 1)}
                  >
                    Previous
                  </Link>
                )}
                {page * 50 < total && (
                  <Link
                    className="sp-button sp-button-secondary"
                    to={pageLink(page + 1)}
                  >
                    Next
                  </Link>
                )}
              </div>
            </div>
          </>
        )}
      </Section>
      <Section title="Inventory terminology">
        <div className="sp-grid">
          <div>
            <h3>Available</h3>
            <p className="sp-muted">
              The quantity Shopify currently makes available for sale at a
              specific inventory item and location.
            </p>
          </div>
          <div>
            <h3>Authoritative source</h3>
            <p className="sp-muted">
              The designated store whose available quantity drives one-way
              inventory synchronization. Shared-pool allocation requires a
              separate ledger and is unavailable here.
            </p>
          </div>
        </div>
      </Section>
    </Page>
  );
}
