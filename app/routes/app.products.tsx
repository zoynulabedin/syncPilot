import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

type Variant = { id: string; sku: string | null; price: string; inventoryQuantity: number | null };
type Product = { id: string; title: string; status: string; variants: { nodes: Variant[] } };
type GraphQLResponse = { data?: { products?: { nodes: Product[] } }; errors?: unknown[] };

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(
    "#graphql query SyncPilotCatalog { products(first: 25) { nodes { id title status variants(first: 5) { nodes { id sku price inventoryQuantity } } } } }",
  );
  const body = (await response.json()) as GraphQLResponse;
  if (body.errors?.length || !body.data?.products) throw new Response("Unable to read product catalog", { status: 502 });
  return { products: body.data.products.nodes };
}

export default function Products() {
  const { products } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Product Catalog">
      <s-banner tone="info">
        Read-only catalog preview from the current authenticated store.
        Cross-store mapping and write synchronization are not enabled.
      </s-banner>
      <s-section heading="Products and variants">
        {products.length === 0 ? <s-paragraph>No products found.</s-paragraph> : null}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th align="left">Product</th><th align="left">Status</th><th align="left">Variant SKU</th><th align="right">Price</th></tr></thead>
            <tbody>
              {products.flatMap((p) => p.variants.nodes.length
                ? p.variants.nodes.map((v) => (
                  <tr key={v.id}>
                    <td style={{ padding: 10, borderBottom: "1px solid #ddd" }}>{p.title}</td>
                    <td style={{ padding: 10, borderBottom: "1px solid #ddd" }}>{p.status}</td>
                    <td style={{ padding: 10, borderBottom: "1px solid #ddd" }}>{v.sku || "No SKU"}</td>
                    <td style={{ padding: 10, textAlign: "right", borderBottom: "1px solid #ddd" }}>{v.price}</td>
                  </tr>
                ))
                : [<tr key={p.id}><td style={{ padding: 10 }}>{p.title}</td><td>{p.status}</td><td>—</td><td>—</td></tr>]
              )}
            </tbody>
          </table>
        </div>
      </s-section>
    </s-page>
  );
}
