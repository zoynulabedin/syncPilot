CREATE TABLE "RequestRateLimit" (
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RequestRateLimit_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "RequestRateLimit_expiresAt_idx" ON "RequestRateLimit"("expiresAt");
