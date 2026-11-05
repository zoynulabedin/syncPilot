import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { z } from "zod";
import { updateInstallationScopes } from "../services/installation.server";
import {
  parseShopifyTime,
  rejectWebhook,
} from "../services/webhook-verification.server";

const payloadSchema = z.object({
  current: z.array(z.string().regex(/^[a-z_]+$/)).max(200),
  updated_at: z.string(),
  shop_id: z.union([z.string(), z.number()]).optional(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const webhook = await authenticate.webhook(request, ["APP_SCOPES_UPDATE"]);
  const parsed = payloadSchema.safeParse(webhook.payload);
  const updatedAt = parseShopifyTime(parsed.data?.updated_at);
  if (!parsed.data || !updatedAt)
    throw rejectWebhook("WEBHOOK_BODY_INVALID", webhook);
  await updateInstallationScopes(webhook.shop, parsed.data.current, {
    updatedAt,
    shopId: parsed.data.shop_id,
    webhookId: webhook.webhookId,
  });
  return new Response();
};
