import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordVerifiedWebhook } from "../services/webhook-inbox.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhook = await authenticate.webhook(request, [
    "INVENTORY_LEVELS_UPDATE",
  ]);
  const { shop, topic, payload } = webhook;
  const resourceId =
    payload && typeof payload === "object" && "inventory_item_id" in payload
      ? String(payload.inventory_item_id)
      : undefined;
  await recordVerifiedWebhook(request, shop, topic, resourceId, webhook);
  return new Response(null, { status: 200 });
};
