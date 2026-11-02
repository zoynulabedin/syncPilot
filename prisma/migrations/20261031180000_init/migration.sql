-- SyncPilot foundation migration for PostgreSQL
CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "isOnline" BOOLEAN NOT NULL DEFAULT false,
  "scope" TEXT,
  "expires" TIMESTAMP(3),
  "accessToken" TEXT NOT NULL,
  "userId" BIGINT,
  "firstName" TEXT,
  "lastName" TEXT,
  "email" TEXT,
  "accountOwner" BOOLEAN NOT NULL DEFAULT false,
  "locale" TEXT,
  "collaborator" BOOLEAN DEFAULT false,
  "emailVerified" BOOLEAN DEFAULT false,
  "refreshToken" TEXT,
  "refreshTokenExpires" TIMESTAMP(3),
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Workspace" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopConnection" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "workspaceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'CONNECTED',
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uninstalledAt" TIMESTAMP(3),
  CONSTRAINT "ShopConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorePairingRequest" (
  "id" TEXT NOT NULL,
  "initiatingShop" TEXT NOT NULL,
  "destinationShop" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StorePairingRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncPolicy" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceShopDomain" TEXT NOT NULL,
  "targetShopDomain" TEXT NOT NULL,
  "direction" TEXT NOT NULL DEFAULT 'ONE_WAY',
  "syncProduct" BOOLEAN NOT NULL DEFAULT false,
  "syncPrices" BOOLEAN NOT NULL DEFAULT false,
  "syncInventory" BOOLEAN NOT NULL DEFAULT false,
  "inventoryAuthority" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SyncPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductMapping" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceShopDomain" TEXT NOT NULL,
  "sourceProductGid" TEXT NOT NULL,
  "targetShopDomain" TEXT NOT NULL,
  "targetProductGid" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VariantMapping" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceShopDomain" TEXT NOT NULL,
  "sourceVariantGid" TEXT NOT NULL,
  "sourceInventoryGid" TEXT,
  "targetShopDomain" TEXT NOT NULL,
  "targetVariantGid" TEXT NOT NULL,
  "targetInventoryGid" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VariantMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LocationMapping" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceShopDomain" TEXT NOT NULL,
  "sourceLocationGid" TEXT NOT NULL,
  "targetShopDomain" TEXT NOT NULL,
  "targetLocationGid" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LocationMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "resourceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncJob" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "sourceShop" TEXT NOT NULL,
  "targetShop" TEXT NOT NULL,
  "eventId" TEXT,
  "operation" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncConflict" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "jobId" TEXT,
  "code" TEXT NOT NULL,
  "details" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "SyncConflict_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT,
  "shopDomain" TEXT,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "resourceType" TEXT,
  "resourceId" TEXT,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Session_shop_idx" ON "Session"("shop");
CREATE UNIQUE INDEX "ShopConnection_shopDomain_key" ON "ShopConnection"("shopDomain");
CREATE INDEX "ShopConnection_workspaceId_idx" ON "ShopConnection"("workspaceId");
CREATE INDEX "StorePairingRequest_initiatingShop_destinationShop_idx" ON "StorePairingRequest"("initiatingShop", "destinationShop");
CREATE INDEX "SyncPolicy_workspaceId_idx" ON "SyncPolicy"("workspaceId");
CREATE UNIQUE INDEX "ProductMapping_source_target_unique" ON "ProductMapping"("sourceShopDomain", "sourceProductGid", "targetShopDomain");
CREATE INDEX "ProductMapping_workspaceId_idx" ON "ProductMapping"("workspaceId");
CREATE UNIQUE INDEX "VariantMapping_source_target_unique" ON "VariantMapping"("sourceShopDomain", "sourceVariantGid", "targetShopDomain");
CREATE INDEX "VariantMapping_workspaceId_idx" ON "VariantMapping"("workspaceId");
CREATE UNIQUE INDEX "LocationMapping_source_target_unique" ON "LocationMapping"("sourceShopDomain", "sourceLocationGid", "targetShopDomain");
CREATE INDEX "LocationMapping_workspaceId_idx" ON "LocationMapping"("workspaceId");
CREATE UNIQUE INDEX "WebhookEvent_shopDomain_deliveryId_key" ON "WebhookEvent"("shopDomain", "deliveryId");
CREATE INDEX "WebhookEvent_shopDomain_receivedAt_idx" ON "WebhookEvent"("shopDomain", "receivedAt");
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");
CREATE INDEX "SyncJob_workspaceId_status_createdAt_idx" ON "SyncJob"("workspaceId", "status", "createdAt");
CREATE INDEX "SyncConflict_workspaceId_status_idx" ON "SyncConflict"("workspaceId", "status");
CREATE INDEX "AuditEvent_workspaceId_createdAt_idx" ON "AuditEvent"("workspaceId", "createdAt");

ALTER TABLE "ShopConnection" ADD CONSTRAINT "ShopConnection_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
