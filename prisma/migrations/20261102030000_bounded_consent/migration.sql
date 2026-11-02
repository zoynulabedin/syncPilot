CREATE TABLE "AutomaticConsent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "approvedBy" TEXT NOT NULL,
  "fields" TEXT[] NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "intervalMinutes" INTEGER NOT NULL,
  "maxJobs" INTEGER NOT NULL,
  "maxChanges" INTEGER NOT NULL,
  "perRunChanges" INTEGER NOT NULL,
  "usedJobs" INTEGER NOT NULL DEFAULT 0,
  "usedChanges" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "AutomaticConsent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AutomaticConsent_limits" CHECK (
    "intervalMinutes" BETWEEN 5 AND 1440 AND "maxJobs" BETWEEN 1 AND 100 AND
    "maxChanges" BETWEEN 1 AND 1000 AND "perRunChanges" BETWEEN 1 AND 100 AND
    "usedJobs" BETWEEN 0 AND "maxJobs" AND "usedChanges" BETWEEN 0 AND "maxChanges"
  )
);
CREATE INDEX "AutomaticConsent_status_nextRunAt_idx" ON "AutomaticConsent"("status", "nextRunAt");
CREATE INDEX "AutomaticConsent_workspaceId_createdAt_idx" ON "AutomaticConsent"("workspaceId", "createdAt");
CREATE UNIQUE INDEX "AutomaticConsent_one_active_policy" ON "AutomaticConsent"("policyId") WHERE "status" = 'ACTIVE';
