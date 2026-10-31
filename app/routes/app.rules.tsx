import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const connection = await prisma.shopConnection.findUnique({
    where: { shopDomain: session.shop },
    select: { workspaceId: true },
  });
  if (!connection?.workspaceId) return { rules: [], paired: false };
  const rules = await prisma.syncPolicy.findMany({
    where: {
      workspaceId: connection.workspaceId,
      OR: [{ sourceShopDomain: session.shop }, { targetShopDomain: session.shop }],
    },
    select: { id: true, sourceShopDomain: true, targetShopDomain: true, direction: true, enabled: true, syncProduct: true, syncPrices: true, syncInventory: true },
    take: 50,
  });
  return { rules, paired: true };
}

export default function Rules() {
  const { rules, paired } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Sync Rules">
      <s-banner tone="info">
        Safe mode: the settings below are read-only. Sync operations cannot
        be enabled until both Shopify installations, mappings and inventory
        authority have been validated.
      </s-banner>
      {!paired ? (
        <s-section heading="Pair stores first">
          <s-paragraph>No verified multi-store workspace has been linked to this installation.</s-paragraph>
          <s-link href="/app/stores">Store connection instructions</s-link>
        </s-section>
      ) : (
        <s-section heading="Configured policies">
          {rules.length === 0 ? <s-paragraph>No sync policies configured.</s-paragraph> : null}
          {rules.map((r) => (
            <s-paragraph key={r.id}>
              {r.sourceShopDomain} → {r.targetShopDomain} | {r.direction} |
              {r.enabled ? "Enabled" : "Disabled"} | Products: {String(r.syncProduct)} |
              Price: {String(r.syncPrices)} | Inventory: {String(r.syncInventory)}
            </s-paragraph>
          ))}
        </s-section>
      )}
    </s-page>
  );
}
