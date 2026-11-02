CREATE TABLE "StockPool" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "physical" INTEGER NOT NULL,
  "reserved" INTEGER NOT NULL DEFAULT 0,
  "safetyBuffer" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StockPool_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockPool_nonnegative" CHECK ("physical" >= 0 AND "reserved" >= 0 AND "safetyBuffer" >= 0 AND "version" >= 0 AND "reserved" <= "physical")
);
CREATE TABLE "StockAllocation" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "inventoryItemGid" TEXT NOT NULL,
  "locationGid" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "StockAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockAllocation_nonnegative" CHECK ("quantity" >= 0)
);
CREATE TABLE "StockReservation" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "allocationId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockReservation_positive" CHECK ("quantity" > 0),
  CONSTRAINT "StockReservation_status" CHECK ("status" IN ('ACTIVE', 'RELEASED', 'FULFILLED'))
);
CREATE TABLE "StockLedgerOperation" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockLedgerOperation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockPool_workspaceId_reference_key" ON "StockPool"("workspaceId", "reference");
CREATE INDEX "StockPool_workspaceId_createdAt_id_idx" ON "StockPool"("workspaceId", "createdAt", "id");
CREATE UNIQUE INDEX "StockAllocation_shopDomain_inventoryItemGid_locationGid_key" ON "StockAllocation"("shopDomain", "inventoryItemGid", "locationGid");
CREATE INDEX "StockAllocation_poolId_idx" ON "StockAllocation"("poolId");
CREATE UNIQUE INDEX "StockReservation_poolId_reference_key" ON "StockReservation"("poolId", "reference");
CREATE INDEX "StockReservation_poolId_status_idx" ON "StockReservation"("poolId", "status");
CREATE UNIQUE INDEX "StockLedgerOperation_poolId_operationKey_key" ON "StockLedgerOperation"("poolId", "operationKey");
CREATE INDEX "StockLedgerOperation_poolId_createdAt_id_idx" ON "StockLedgerOperation"("poolId", "createdAt", "id");
ALTER TABLE "StockAllocation" ADD CONSTRAINT "StockAllocation_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "StockPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "StockPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "StockAllocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockLedgerOperation" ADD CONSTRAINT "StockLedgerOperation_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "StockPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
