CREATE TABLE "CatalogOperation" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "input" JSONB NOT NULL,
  "precondition" JSONB NOT NULL,
  "stateHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "stage" INTEGER NOT NULL DEFAULT 0,
  "result" JSONB,
  "approvedBy" TEXT,
  "approvedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "CatalogOperation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CatalogOperation_shopDomain_createdAt_idx" ON "CatalogOperation"("shopDomain", "createdAt");
