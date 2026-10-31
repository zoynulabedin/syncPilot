import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

type InventoryVariant = { id: string; sku: string | null; inventoryQuantity: number | null; product: { title: string } };
type GraphQLResponse = { data?: { productVariants?: { nodes: InventoryVariant[] } }; errors?: unknown[] };

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(
    "#graphql query SyncPilotInventory { productVariants(first: 30) { nodes { id sku inventoryQuantity product { title } } } }",
  );
  const body = (await response.json()) as GraphQLResponse;
  if (body.errors?.length || !body.data?.productVariants) throw new Response("Unable to read inventory", { status: 502 });
  return { variants: body.data.productVariants.nodes };
}

export default function Inventory() {
  const { variants } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Inventory Monitor">
      <s-banner tone="info">
        This page reads aggregate Shopify variant inventory only. Per-location
        availability, allocation and quantity writes require verified mappings.
      </s-banner>
      <s-section heading="Reported inventory quantities">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th align="left">Product</th><th align="left">SKU</th><th align="right">Shopify quantity</th></tr></thead>
            <tbody>
              {variants.map((v) => (
                <tr key={v.id}>
                  <td style={{ padding: 10, borderBottom: "1px solid #ddd" }}>{v.product.title}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #ddd" }}>{v.sku || "No SKU"}</td>
                  <td style={{ padding: 10, textAlign: "right", borderBottom: "1px solid #ddd" }}>{v.inventoryQuantity ?? "Not tracked"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </s-section>
    </s-page>
  );
}
