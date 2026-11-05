import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  PRIVACY_TOPICS,
  receivePrivacyRequest,
} from "../services/privacy.server";
import {
  rejectWebhook,
  requireSignedShop,
} from "../services/webhook-verification.server";

export async function action({ request }: ActionFunctionArgs) {
  const webhook = await authenticate.webhook(request, PRIVACY_TOPICS);
  requireSignedShop(webhook, "shop_domain");
  // The topic header is unsigned and a customer request names the same shop, so
  // its body must not be able to start the irreversible shop erasure.
  if (
    webhook.topic === "SHOP_REDACT" &&
    "customer" in (webhook.payload as object)
  )
    throw rejectWebhook("WEBHOOK_BODY_INVALID", webhook);
  await receivePrivacyRequest(webhook.shop, webhook.topic, webhook.webhookId);
  return new Response(null, { status: 200 });
}
