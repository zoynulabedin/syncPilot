-- AlterTable
ALTER TABLE "ShopConnection" ADD COLUMN     "scopesUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "eventId" TEXT,
ADD COLUMN     "triggeredAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "WebhookEvent_shopDomain_eventId_idx" ON "WebhookEvent"("shopDomain", "eventId");

-- verifiedAt was stamped on every page load, without asking Shopify anything. It
-- now records only a real check, so the old values would read as false assurance.
UPDATE "ShopConnection" SET "verifiedAt" = NULL;
