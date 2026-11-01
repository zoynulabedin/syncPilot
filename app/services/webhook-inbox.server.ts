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
  if (!deliveryId || deliveryId.length > 200) {
    throw new Response("Missing Shopify webhook delivery identifier", {
      status: 400,
    });
  }
  // PostgreSQL INSERT ... ON CONFLICT avoids Prisma's emulated read/create upsert race.
  await prisma.webhookEvent.createMany({
    data: {
      shopDomain,
      deliveryId,
      topic,
      resourceId,
      status: "RECEIVED",
    },
    skipDuplicates: true,
  });
  return prisma.webhookEvent.findUniqueOrThrow({
    where: { shopDomain_deliveryId: { shopDomain, deliveryId } },
  });
}
