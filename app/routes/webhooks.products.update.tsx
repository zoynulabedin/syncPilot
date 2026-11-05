import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordVerifiedWebhook } from "../services/webhook-inbox.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhook = await authenticate.webhook(request, [
    "PRODUCTS_CREATE",
    "PRODUCTS_UPDATE",
    "PRODUCTS_DELETE",
  ]);
  const { shop, topic, payload } = webhook;
  const resourceId =
    payload && typeof payload === "object" && "id" in payload
      ? String(payload.id)
      : undefined;
  await recordVerifiedWebhook(request, shop, topic, resourceId, webhook);
  return new Response(null, { status: 200 });
};
