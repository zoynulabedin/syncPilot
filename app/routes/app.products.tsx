import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { requireActor } from "../services/authorization.server";
import { getWorkspace } from "../services/control-plane.server";
import { importCatalog } from "../services/catalog.server";
import {
  readActionForm,
  actionFailure,
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
  const shop = url.searchParams.get("shop") || actor.shop;
  if (!shops.includes(shop))
    throw new Response("Store access denied", { status: 403 });
  const q = (url.searchParams.get("q") || "").slice(0, 120);
  const status = url.searchParams.get("status") || "";
  const requestedPage = parsePage(url.searchParams.get("page"));
  const variants = q
    ? await db.variantSnapshot.findMany({
        where: {
          shopDomain: shop,
          OR: [
            { sku: { contains: q, mode: "insensitive" } },
            { barcode: { contains: q, mode: "insensitive" } },
          ],
        },
        select: { productGid: true },
        distinct: ["productGid"],
      })
    : [];
  const where = {
    shopDomain: shop,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { handle: { contains: q, mode: "insensitive" as const } },
            {
              productGid: { in: variants.map((variant) => variant.productGid) },
            },
          ],
        }
      : {}),
  };
  const total = await db.productSnapshot.count({ where });
  const page = clampPage(requestedPage, total, 25);
  const [products, latestImport] = await Promise.all([
    db.productSnapshot.findMany({
      where,
      orderBy: [{ title: "asc" }, { id: "asc" }],
      take: 25,
      skip: (page - 1) * 25,
    }),
    db.catalogSnapshot.findFirst({
      where: { shopDomain: shop },
      orderBy: { startedAt: "desc" },
    }),
  ]);
  const productVariants = await db.variantSnapshot.findMany({
    where: {
      shopDomain: shop,
      productGid: { in: products.map((product) => product.productGid) },
    },
    orderBy: { sku: "asc" },
  });
  return {
    shop,
    shops,
    products,
    variants: productVariants,
    latestImport,
    total,
    page,
    q,
    status,
    canManage: actor.role === "OWNER",
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = requireActor(await authenticate.admin(request));
  const form = await readActionForm(request);
  try {
    if (textField(form, "intent") !== "import")
      return { error: "Choose a valid catalog action." };
    await importCatalog(actor, textField(form, "shop") || actor.shop);
    return {
      success:
        "Catalog import queued. The worker will import products, all variants, locations, and tracked quantities.",
    };
  } catch (error) {
    return actionFailure(error);
  }
}

export default function Products() {
  const {
    shop,
    shops,
    products,
    variants,
    latestImport,
    total,
    page,
    q,
    status,
    canManage,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  const importing =
    latestImport &&
    ["PENDING", "QUEUED", "RUNNING"].includes(latestImport.status);
  useEffect(() => {
    if (!importing) return;
    const timer = setInterval(() => revalidator.revalidate(), 10_000);
    return () => clearInterval(timer);
  }, [importing, revalidator]);
  const pageLink = (next: number) =>
    `?${new URLSearchParams({ shop, q, status, page: String(next) })}`;
  return (
    <Page
      title="Product catalog"
      subtitle="Imported Shopify products and every variant, with source freshness and explicit mapping."
      action={
        <>
          <Form method="post">
            <input name="shop" type="hidden" value={shop} />
            <Submit intent="import" disabled={!canManage || Boolean(importing)}>
              {importing ? "Import in progress" : "Import catalog"}
            </Submit>
          </Form>
          <Link className="sp-button sp-button-secondary" to="/app/mappings">
            Review mappings
          </Link>
        </>
      }
    >
      <Notice data={actionData} />
      <ReadOnly canManage={canManage} />
      <Section
        title="Catalog"
        description="Imports only read Shopify. Synchronization changes require a separate reviewed plan."
      >
        <Form method="get" className="sp-search">
          <Field name="shop" label="Store">
            <select id="shop" name="shop" defaultValue={shop}>
              {shops.map((domain) => (
                <option key={domain} value={domain}>
                  {domain}
                </option>
              ))}
            </select>
          </Field>
          <Field name="q" label="Search title, handle, SKU, or barcode">
            <input
              id="q"
              name="q"
              defaultValue={q}
              placeholder="Search catalog"
              type="search"
            />
          </Field>
          <Field name="status" label="Product status">
            <select id="status" name="status" defaultValue={status}>
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="DRAFT">Draft</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </Field>
          <button className="sp-button sp-button-secondary" type="submit">
            Apply filters
          </button>
        </Form>
        {latestImport && (
          <div className="sp-inline-note">
            <div className="sp-actions">
              <Status value={latestImport.status} />
              <span>
                {latestImport.products} products · {latestImport.variants}{" "}
                variants · {latestImport.locations} locations
              </span>
              <button
                className="sp-button sp-button-secondary"
                onClick={() => revalidator.revalidate()}
                disabled={revalidator.state !== "idle"}
              >
                Refresh
              </button>
            </div>
            <span className="sp-muted">
              Last import started <Time value={latestImport.startedAt} />
              {latestImport.lastError ? ` · ${latestImport.lastError}` : ""}
            </span>
          </div>
        )}
        {products.length === 0 ? (
          <EmptyState
            title={
              q || status
                ? "No matching products"
                : "Your catalog is ready to import"
            }
          >
            {q || status
              ? "Try a different title, SKU, barcode, or product status."
              : "Start an import to discover products, variants, locations, and inventory. The worker saves progress and can resume after interruption."}
          </EmptyState>
        ) : (
          <>
            <Table
              headings={[
                "Product",
                "Status",
                "Variants",
                "Observed",
                "Details",
              ]}
            >
              {products.map((product) => {
                const rows = variants.filter(
                  (variant) => variant.productGid === product.productGid,
                );
                return (
                  <tr key={product.id}>
                    <td>
                      <strong>{product.title}</strong>
                      <div className="sp-muted">
                        {product.vendor || "No vendor"} ·{" "}
                        <Gid value={product.productGid} />
                      </div>
                    </td>
                    <td>
                      <Status value={product.status} />
                    </td>
                    <td>{rows.length}</td>
                    <td>
                      <Time value={product.observedAt} />
                    </td>
                    <td>
                      <details>
                        <summary>Inspect variants</summary>
                        <p className="sp-gid">
                          Product ID: {product.productGid}
                        </p>
                        <div className="sp-stack" style={{ marginTop: 12 }}>
                          {rows.map((variant) => (
                            <div key={variant.id} className="sp-inline-note">
                              <strong>{variant.sku || "No SKU"}</strong>
                              <div>
                                {variant.price} {product.currency || ""} ·{" "}
                                {variant.tracked
                                  ? "Tracked inventory"
                                  : "Untracked inventory"}
                              </div>
                              <div className="sp-muted">
                                Barcode: {variant.barcode || "—"} · Variant ID:{" "}
                                {variant.variantGid}
                              </div>
                              <div className="sp-muted">
                                Options: {JSON.stringify(variant.options)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </Table>
            <div className="sp-pagination">
              <span>
                {total} products · Page {page} of{" "}
                {Math.max(1, Math.ceil(total / 25))}
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
                {page * 25 < total && (
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
    </Page>
  );
}
