ALTER TABLE "NotificationSetting" ADD COLUMN "externalEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationSetting" ADD COLUMN "lastEvaluatedAt" TIMESTAMP(3);
CREATE TABLE "OperationalAlert" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "observedValue" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "OperationalAlert_workspaceId_kind_key" ON "OperationalAlert"("workspaceId", "kind");
CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "dedupKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deliveredAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "NotificationDelivery_dedupKey_key" ON "NotificationDelivery"("dedupKey");
CREATE INDEX "NotificationDelivery_status_availableAt_leaseUntil_idx" ON "NotificationDelivery"("status", "availableAt", "leaseUntil");
CREATE INDEX "NotificationDelivery_workspaceId_createdAt_idx" ON "NotificationDelivery"("workspaceId", "createdAt");
