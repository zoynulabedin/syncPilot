import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordVerifiedWebhook } from "../services/webhook-inbox.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const resourceId =
    payload && typeof payload === "object" && "inventory_item_id" in payload
      ? String(payload.inventory_item_id)
      : undefined;
  await recordVerifiedWebhook(request, shop, topic, resourceId);
  return new Response(null, { status: 200 });
};
