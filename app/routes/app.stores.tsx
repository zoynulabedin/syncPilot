import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shopConnection.upsert({
    where: { shopDomain: session.shop },
    create: { shopDomain: session.shop },
    update: { status: "CONNECTED", lastSeenAt: new Date(), uninstalledAt: null },
  });
  return { shopDomain: shop.shopDomain, status: shop.status, paired: Boolean(shop.workspaceId) };
}

export default function Stores() {
  const data = useLoaderData<typeof loader>();
  return (
    <s-page heading="Connected Stores">
      <s-section heading="Current installation">
        <s-paragraph>Shopify store: {data.shopDomain}</s-paragraph>
        <s-paragraph>Installation: {data.status}</s-paragraph>
        <s-paragraph>Workspace pairing: {data.paired ? "Verified workspace" : "Not paired"}</s-paragraph>
      </s-section>
      <s-section heading="Connect a second store">
        <s-paragraph>
          Install the SAME custom-distribution app on the second store using
          your Shopify custom installation link. For custom distribution, both
          stores must belong to the same Shopify Plus organization.
        </s-paragraph>
        <s-paragraph>
          Each store receives its own authenticated session. A secure
          two-party pairing flow is required before we allow one store
          to read or write another store's data.
        </s-paragraph>
        <s-paragraph>
          Pairing is intentionally not enabled in this foundation release.
          Domain entry alone is never sufficient authorization.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
