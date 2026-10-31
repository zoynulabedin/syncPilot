import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  await prisma.shopConnection.upsert({
    where: { shopDomain: session.shop },
    create: { shopDomain: session.shop },
    update: { status: "CONNECTED", lastSeenAt: new Date(), uninstalledAt: null },
  });
  const receivedEvents = await prisma.webhookEvent.count({
    where: { shopDomain: session.shop },
  });
  return { shop: session.shop, receivedEvents };
}

export default function Overview() {
  const { shop, receivedEvents } = useLoaderData<typeof loader>();
  return (
    <s-page heading="SyncPilot Overview">
      <s-banner tone="info">
        This is the safe foundation release. Automatic product and inventory
        writes are disabled until store pairing, mapping and reconciliation
        have passed verification.
      </s-banner>
      <s-section heading="Authenticated Shopify Store">
        <s-paragraph>{shop}</s-paragraph>
        <s-paragraph>
          Your store is authenticated. This does not mean that it has been
          linked or synchronized with another Shopify store.
        </s-paragraph>
      </s-section>
      <s-section heading="Activity Inbox">
        <s-paragraph>{receivedEvents} webhook deliveries recorded for this store.</s-paragraph>
        <s-link href="/app/activity">View activity</s-link>
      </s-section>
      <s-section heading="Getting Started">
        <s-paragraph>1. Install the custom app on both authorized Shopify stores.</s-paragraph>
        <s-paragraph>2. Verify ownership and pair the installations securely.</s-paragraph>
        <s-paragraph>3. Import products, variants and locations; review mappings.</s-paragraph>
        <s-paragraph>4. Run a dry-run comparison before enabling write operations.</s-paragraph>
        <s-link href="/app/stores">View store onboarding</s-link>
      </s-section>
    </s-page>
  );
}
