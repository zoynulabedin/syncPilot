import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import {
  UTC_TIME_ZONE_NAMES,
  databaseNow,
  readDatabaseClock,
} from "../../app/services/database-clock.server";
import { receivePrivacyRequest } from "../../app/services/privacy.server";
import {
  HOUR,
  SECOND,
  SKEWS,
  databaseTime,
  fromDatabase,
  remaining,
  restoreProcessClock,
  skewProcessClock,
  withMachineClockSkewed,
} from "./clock-skew";

async function freshClock() {
  // Database-level defaults apply only to sessions opened after they change.
  const client = new PrismaClient();
  try {
    return await readDatabaseClock(client);
  } finally {
    await client.$disconnect();
  }
}

function logEntries(output: string) {
  return output.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/** No worker claims it, and availableAt is left for the database to stamp. */
const closedJob = (db: Pick<Prisma.TransactionClient, "syncJob"> = prisma) =>
  db.syncJob.create({
    data: {
      workspaceId: "",
      policyId: "",
      sourceShop: "clock.myshopify.com",
      targetShop: "clock.myshopify.com",
      operation: "RECONCILE",
      status: "CANCELLED",
    },
  });

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "the clock every process shares",
  () => {
    afterEach(restoreProcessClock);
    it.each(SKEWS)(
      "is the database's, with this process's clock an hour %s it",
      async (_, direction) => {
        const before = await databaseTime();
        skewProcessClock(direction * HOUR);
        const now = await databaseNow();
        expect(now.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(now.getTime() - before.getTime()).toBeLessThan(10 * SECOND);
      },
    );
    it("never reads earlier than a database default stamped before it, in or out of a transaction", async () => {
      // Such a default rounds to the column's milliseconds, up as well as down.
      for (let i = 0; i < 100; i++) {
        const { availableAt } = await closedJob();
        expect((await databaseNow()).getTime()).toBeGreaterThanOrEqual(
          availableAt.getTime(),
        );
        await prisma.$transaction(async (tx) => {
          const inside = await closedJob(tx);
          expect((await databaseNow(tx)).getTime()).toBeGreaterThanOrEqual(
            inside.availableAt.getTime(),
          );
        });
      }
    });
  },
);

// Prisma's engine binds @default(now()) and @updatedAt from this machine's clock,
// so PostgreSQL never stamps those. The columns a later comparison reads must not
// be among them; this fails for any that goes back.
describe.skipIf(!process.env.TEST_DATABASE_URL).each(SKEWS)(
  "with this machine really an hour %s the database",
  (_, direction) => {
    withMachineClockSkewed(direction * HOUR);

    it("moves PostgreSQL's clock while Prisma's engine stays on this machine's", async () => {
      const { createdAt } = await prisma.workspace.create({
        data: { name: "Synthetic clock workspace" },
      });
      expect(Math.abs(createdAt.getTime() - Date.now())).toBeLessThan(
        10 * SECOND,
      );
      expect(
        Math.abs(await remaining(new Date(Date.now() - direction * HOUR))),
      ).toBeLessThan(10 * SECOND);
    });

    const shop = () => `clock-${randomUUID()}.myshopify.com`;
    const connection = () => {
      const shopDomain = shop();
      return prisma.shopConnection.upsert({
        where: { shopDomain },
        create: { shopDomain },
        update: {},
      });
    };
    const workspaceId = async () =>
      (
        await prisma.workspace.create({
          data: { name: "Synthetic clock workspace" },
        })
      ).id;
    it.each<[string, () => Promise<Date>]>([
      ["a store's installedAt", async () => (await connection()).installedAt],
      ["a store's lastSeenAt", async () => (await connection()).lastSeenAt],
      ["a job's availableAt", async () => (await closedJob()).availableAt],
      [
        "a worker's first heartbeat",
        async () => {
          const id = randomUUID();
          return (
            await prisma.workerHeartbeat.upsert({
              where: { id },
              create: { id, status: "STOPPED" },
              update: {},
            })
          ).seenAt;
        },
      ],
      [
        "a privacy request's receivedAt",
        async () =>
          (await receivePrivacyRequest(shop(), "SHOP_REDACT", randomUUID()))
            .receivedAt,
      ],
      [
        "a notification's availableAt",
        async () =>
          (
            await prisma.notificationDelivery.create({
              data: {
                workspaceId: await workspaceId(),
                dedupKey: randomUUID(),
                payload: {},
                status: "CANCELLED",
              },
            })
          ).availableAt,
      ],
      [
        "a consent's nextRunAt",
        async () =>
          (
            await prisma.automaticConsent.create({
              data: {
                workspaceId: await workspaceId(),
                policyId: "",
                fingerprint: "synthetic-fingerprint",
                approvedBy: "synthetic",
                fields: [],
                status: "EXPIRED",
                expiresAt: await fromDatabase(HOUR),
                intervalMinutes: 15,
                maxJobs: 1,
                maxChanges: 1,
                perRunChanges: 1,
              },
            })
          ).nextRunAt,
      ],
    ])("has the database stamp %s", async (_, stamp) => {
      const age = -(await remaining(await stamp()));
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(10 * SECOND);
    });
  },
);

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "PostgreSQL session time zone guard",
  () => {
    afterAll(async () => {
      await prisma.$disconnect();
    });

    it("reports the disposable database session as UTC", async () => {
      expect(await readDatabaseClock()).toMatchObject({ utc: true });
    });

    it("decides by the zone name PostgreSQL reports, not by its current offset", async () => {
      await prisma.$transaction(
        async (tx) => {
          const sessionIn = async (zone: string) => {
            // Transaction-local, so the pooled session keeps its own zone.
            await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
            return readDatabaseClock(tx);
          };
          for (const zone of [
            "Asia/Dhaka",
            "America/New_York",
            "Europe/London",
            "Africa/Abidjan",
          ])
            expect(await sessionIn(zone)).toMatchObject({
              timeZone: zone,
              utc: false,
            });
          expect(await sessionIn("UTC0")).toMatchObject({ utc: false });
          // Lower-case input proves each alias is a real zone that PostgreSQL
          // reports back under exactly the name the helper lists.
          for (const zone of UTC_TIME_ZONE_NAMES)
            expect(await sessionIn(zone.toLowerCase())).toMatchObject({
              timeZone: zone,
              utc: true,
            });
        },
        { timeout: 20_000 },
      );
      expect(await readDatabaseClock()).toMatchObject({ utc: true });
    });

    it.each(["Asia/Dhaka", "America/New_York"])(
      "keeps reading and stamping UTC in a session set to %s",
      async (zone) => {
        const before = await databaseTime();
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
          for (const time of [
            await databaseNow(tx),
            (await closedJob(tx)).availableAt,
          ]) {
            expect(time.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(time.getTime() - before.getTime()).toBeLessThan(10 * SECOND);
          }
        });
      },
    );

    it("refuses a local database default: fresh sessions report it and the worker exits before any job or heartbeat", async () => {
      const { database } = await readDatabaseClock();
      // Interpolated below; the setup guard already limits it to this shape.
      expect(database).toMatch(/^syncpilot_test_[a-f0-9]+$/);
      const workspace = await prisma.workspace.create({
        data: { name: "Synthetic clock workspace" },
      });
      const job = await prisma.syncJob.create({
        data: {
          workspaceId: workspace.id,
          policyId: "",
          sourceShop: `clock-${randomUUID()}.myshopify.com`,
          targetShop: "synthetic.myshopify.com",
          operation: "RECONCILE",
        },
      });
      const heartbeats = await prisma.workerHeartbeat.count();
      await prisma.$executeRawUnsafe(
        `ALTER DATABASE "${database}" SET timezone TO 'Asia/Dhaka'`,
      );
      let worker: ReturnType<typeof spawnSync>;
      try {
        expect(await freshClock()).toEqual({
          database,
          timeZone: "Asia/Dhaka",
          utc: false,
        });
        worker = spawnSync(
          process.execPath,
          ["--import", "tsx", "scripts/worker.ts"],
          { env: process.env, encoding: "utf8", timeout: 60_000 },
        );
      } finally {
        await prisma.$executeRawUnsafe(
          `ALTER DATABASE "${database}" RESET timezone`,
        );
      }
      expect(worker.status).toBe(1);
      const refusal = logEntries(String(worker.stdout)).find(
        (entry) => entry.code === "DATABASE_TIME_ZONE_NOT_UTC",
      );
      expect(refusal).toMatchObject({ level: 60, timeZone: "Asia/Dhaka" });
      expect(refusal?.msg).toContain(
        `ALTER DATABASE "${database}" SET timezone TO 'UTC'`,
      );
      expect(
        await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } }),
      ).toMatchObject({ status: "PENDING", attempts: 0, leaseOwner: null });
      expect(await prisma.workerHeartbeat.count()).toBe(heartbeats);
      expect(await freshClock()).toMatchObject({ utc: true });
    }, 90_000);
  },
);
