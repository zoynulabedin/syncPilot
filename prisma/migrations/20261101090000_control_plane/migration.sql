-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "reconciliationMinutes" INTEGER NOT NULL DEFAULT 360,
ADD COLUMN     "retentionDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "state" TEXT NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "ShopConnection" ADD COLUMN     "currency" TEXT,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastImportAt" TIMESTAMP(3),
ADD COLUMN     "scopes" TEXT,
ADD COLUMN     "shopGid" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "StorePairingRequest" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "challengeHash" TEXT,
ADD COLUMN     "destinationActor" TEXT,
ADD COLUMN     "destinationApprovedAt" TIMESTAMP(3),
ADD COLUMN     "initiatingActor" TEXT,
ADD COLUMN     "initiatingApprovedAt" TIMESTAMP(3),
ADD COLUMN     "organizationConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "SyncPolicy" ADD COLUMN     "allowNegative" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "buffer" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "inventoryMode" TEXT NOT NULL DEFAULT 'DISABLED',
ADD COLUMN     "reconciliationMinutes" INTEGER NOT NULL DEFAULT 360,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT;

-- AlterTable
ALTER TABLE "SyncJob" ADD COLUMN     "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "leaseOwner" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "previewId" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SyncConflict" ADD COLUMN     "field" TEXT,
ADD COLUMN     "policyId" TEXT,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "resolvedBy" TEXT,
ADD COLUMN     "resourceId" TEXT,
ADD COLUMN     "sourceValue" JSONB,
ADD COLUMN     "targetValue" JSONB;

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VIEWER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorePair" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "targetShop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'VERIFIED',
    "requestId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "StorePair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogSnapshot" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "cursor" TEXT,
    "products" INTEGER NOT NULL DEFAULT 0,
    "variants" INTEGER NOT NULL DEFAULT 0,
    "locations" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CatalogSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSnapshot" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "descriptionHtml" TEXT NOT NULL DEFAULT '',
    "vendor" TEXT NOT NULL DEFAULT '',
    "productType" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currency" TEXT,
    "data" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "shopifyUpdatedAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantSnapshot" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "inventoryItemGid" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "price" TEXT NOT NULL,
    "compareAtPrice" TEXT,
    "options" JSONB NOT NULL,
    "tracked" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariantSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationSnapshot" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "locationGid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySnapshot" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "inventoryItemGid" TEXT NOT NULL,
    "locationGid" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncPreview" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncPreview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "details" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SyncAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "findings" JSONB,
    "total" INTEGER NOT NULL DEFAULT 0,
    "drifted" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "details" JSONB,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationSetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "failureThreshold" INTEGER NOT NULL DEFAULT 3,
    "lagMinutes" INTEGER NOT NULL DEFAULT 15,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceMember_workspaceId_status_idx" ON "WorkspaceMember"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_shopDomain_userId_key" ON "WorkspaceMember"("workspaceId", "shopDomain", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "StorePair_requestId_key" ON "StorePair"("requestId");

-- CreateIndex
CREATE INDEX "StorePair_workspaceId_status_idx" ON "StorePair"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StorePair_workspaceId_sourceShop_targetShop_key" ON "StorePair"("workspaceId", "sourceShop", "targetShop");

-- CreateIndex
CREATE INDEX "CatalogSnapshot_shopDomain_startedAt_idx" ON "CatalogSnapshot"("shopDomain", "startedAt");

-- CreateIndex
CREATE INDEX "ProductSnapshot_shopDomain_title_idx" ON "ProductSnapshot"("shopDomain", "title");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSnapshot_shopDomain_productGid_key" ON "ProductSnapshot"("shopDomain", "productGid");

-- CreateIndex
CREATE INDEX "VariantSnapshot_shopDomain_productGid_idx" ON "VariantSnapshot"("shopDomain", "productGid");

-- CreateIndex
CREATE INDEX "VariantSnapshot_shopDomain_sku_idx" ON "VariantSnapshot"("shopDomain", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "VariantSnapshot_shopDomain_variantGid_key" ON "VariantSnapshot"("shopDomain", "variantGid");

-- CreateIndex
CREATE UNIQUE INDEX "LocationSnapshot_shopDomain_locationGid_key" ON "LocationSnapshot"("shopDomain", "locationGid");

-- CreateIndex
CREATE INDEX "InventorySnapshot_shopDomain_locationGid_idx" ON "InventorySnapshot"("shopDomain", "locationGid");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySnapshot_shopDomain_inventoryItemGid_locationGid_key" ON "InventorySnapshot"("shopDomain", "inventoryItemGid", "locationGid");

-- CreateIndex
CREATE INDEX "SyncPreview_workspaceId_status_createdAt_idx" ON "SyncPreview"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncAttempt_jobId_attempt_key" ON "SyncAttempt"("jobId", "attempt");

-- CreateIndex
CREATE INDEX "ReconciliationRun_workspaceId_startedAt_idx" ON "ReconciliationRun"("workspaceId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationSetting_workspaceId_key" ON "NotificationSetting"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_target_source_unique" ON "ProductMapping"("targetShopDomain", "targetProductGid", "sourceShopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "VariantMapping_target_source_unique" ON "VariantMapping"("targetShopDomain", "targetVariantGid", "sourceShopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "LocationMapping_target_source_unique" ON "LocationMapping"("targetShopDomain", "targetLocationGid", "sourceShopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "SyncJob_idempotencyKey_key" ON "SyncJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SyncJob_status_availableAt_leaseUntil_idx" ON "SyncJob"("status", "availableAt", "leaseUntil");

-- AddForeignKey
ALTER TABLE "SyncPolicy" ADD CONSTRAINT "SyncPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantMapping" ADD CONSTRAINT "VariantMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationMapping" ADD CONSTRAINT "LocationMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncConflict" ADD CONSTRAINT "SyncConflict_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorePair" ADD CONSTRAINT "StorePair_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncPreview" ADD CONSTRAINT "SyncPreview_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncAttempt" ADD CONSTRAINT "SyncAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationSetting" ADD CONSTRAINT "NotificationSetting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Runtime-independent guardrails for policy and challenge limits.
ALTER TABLE "SyncPolicy" ADD CONSTRAINT "SyncPolicy_buffer_nonnegative" CHECK ("buffer" >= 0);
ALTER TABLE "SyncPolicy" ADD CONSTRAINT "SyncPolicy_reconciliation_interval" CHECK ("reconciliationMinutes" BETWEEN 5 AND 10080);
ALTER TABLE "StorePairingRequest" ADD CONSTRAINT "StorePairingRequest_attempts_nonnegative" CHECK ("attempts" >= 0);
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_retention_bounds" CHECK ("retentionDays" BETWEEN 7 AND 3650);
