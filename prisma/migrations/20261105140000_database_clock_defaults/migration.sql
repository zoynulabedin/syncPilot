-- Prisma's engine fills a @default(now()) column itself, in the web or worker
-- process, and binds the value, so CURRENT_TIMESTAMP here never ran. These columns
-- are later compared with the database's clock, so the database now stamps them,
-- in UTC whatever the session's zone. Existing rows keep their values.
ALTER TABLE "ShopConnection"
  ALTER COLUMN "installedAt" SET DEFAULT timezone('UTC'::text, clock_timestamp()),
  ALTER COLUMN "lastSeenAt" SET DEFAULT timezone('UTC'::text, clock_timestamp());
ALTER TABLE "SyncJob" ALTER COLUMN "availableAt" SET DEFAULT timezone('UTC'::text, clock_timestamp());
ALTER TABLE "WorkerHeartbeat" ALTER COLUMN "seenAt" SET DEFAULT timezone('UTC'::text, clock_timestamp());
ALTER TABLE "PrivacyRequest" ALTER COLUMN "receivedAt" SET DEFAULT timezone('UTC'::text, clock_timestamp());
ALTER TABLE "NotificationDelivery" ALTER COLUMN "availableAt" SET DEFAULT timezone('UTC'::text, clock_timestamp());
ALTER TABLE "AutomaticConsent" ALTER COLUMN "nextRunAt" SET DEFAULT timezone('UTC'::text, clock_timestamp());
