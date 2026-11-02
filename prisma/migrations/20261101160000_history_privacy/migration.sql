ALTER TABLE "Workspace" ADD COLUMN "retentionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Workspace" ADD COLUMN "lastRetentionAt" TIMESTAMP(3);
CREATE TABLE "PrivacyRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deliveryKey" TEXT NOT NULL,
  "shopDomain" TEXT,
  "topic" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "outcome" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "PrivacyRequest_deliveryKey_key" ON "PrivacyRequest"("deliveryKey");
CREATE INDEX "PrivacyRequest_status_receivedAt_idx" ON "PrivacyRequest"("status", "receivedAt");
CREATE INDEX "PrivacyRequest_shopDomain_receivedAt_idx" ON "PrivacyRequest"("shopDomain", "receivedAt");
CREATE INDEX "SyncConflict_workspaceId_createdAt_id_idx" ON "SyncConflict"("workspaceId", "createdAt", "id");
CREATE INDEX "ProductMapping_workspaceId_createdAt_id_idx" ON "ProductMapping"("workspaceId", "createdAt", "id");
CREATE INDEX "VariantMapping_workspaceId_createdAt_id_idx" ON "VariantMapping"("workspaceId", "createdAt", "id");
CREATE INDEX "LocationMapping_workspaceId_createdAt_id_idx" ON "LocationMapping"("workspaceId", "createdAt", "id");
CREATE INDEX "SyncJob_previewId_idx" ON "SyncJob"("previewId");
CREATE INDEX "SyncJob_eventId_idx" ON "SyncJob"("eventId");
CREATE INDEX "SyncConflict_jobId_status_idx" ON "SyncConflict"("jobId", "status");
