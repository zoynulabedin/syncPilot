import prisma from "../db.server";

// Only call after authenticate.webhook(request) has verified the Shopify HMAC.
// The delivery ID deduplicates retries; no raw payload or credentials are stored.
export async function recordVerifiedWebhook(
  request: Request,
  shopDomain: string,
  topic: string,
  resourceId?: string,
) {
  const deliveryId = request.headers.get("x-shopify-webhook-id");
  if (!deliveryId) {
    throw new Response("Missing Shopify webhook delivery identifier", { status: 400 });
  }
  return prisma.webhookEvent.upsert({
    where: { shopDomain_deliveryId: { shopDomain, deliveryId } },
    create: {
      shopDomain,
      deliveryId,
      topic,
      resourceId,
      status: "RECEIVED",
    },
    update: {},
  });
}
