import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { revokeInstallation } from "../services/installation.server";
import { requireSignedShop } from "../services/webhook-verification.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhook = await authenticate.webhook(request, ["APP_UNINSTALLED"]);
  requireSignedShop(webhook, "myshopify_domain");
  await revokeInstallation(webhook.shop, webhook);

  return new Response();
};
