import { randomUUID } from "node:crypto";
import type { LoaderFunctionArgs } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import prisma from "../../app/db.server";
import { loader as automaticSync } from "../../app/routes/app.automatic-sync";
import { loader as inventory } from "../../app/routes/app.inventory";
import { loader as overview } from "../../app/routes/app._index";
import { loader as rules } from "../../app/routes/app.rules";
import { loader as settings } from "../../app/routes/app.settings";
import {
  HOUR,
  MINUTE,
  SECOND,
  SKEWS,
  fromDatabase,
  remaining,
  restoreProcessClock,
  skewProcessClock,
} from "./clock-skew";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: mocks.auth },
}));

const url = "https://sync.example.invalid/app";
const get = () =>
  ({
    request: new Request(url),
    url: new URL(url),
    pattern: "/app",
    params: {},
    context: {},
  }) as LoaderFunctionArgs;

// A page decides from the time it was given: whether a plan can still be
// approved, a consent still runs, or a worker is alive. The server enforces all
// of that on the database's clock, so the page has to read the same one.
describe.skipIf(!process.env.TEST_DATABASE_URL).each(SKEWS)(
  "pages with the web process's clock an hour %s the database's",
  (_, direction) => {
    beforeEach(() => {
      mocks.auth.mockResolvedValue({
        session: {
          shop: `pages-${randomUUID().slice(0, 8)}.myshopify.com`,
          onlineAccessInfo: {
            associated_user: { id: 101, account_owner: true },
          },
        },
      });
      skewProcessClock(direction * HOUR);
    });
    afterEach(restoreProcessClock);
    afterAll(async () => {
      await prisma.$disconnect();
    });

    it.each([
      ["automatic sync", automaticSync],
      ["inventory", inventory],
      ["sync rules", rules],
      ["settings", settings],
    ] as const)("the %s page reads the database's time", async (_, loader) => {
      const { observedNow } = await loader(get());
      expect(Math.abs(await remaining(new Date(observedNow)))).toBeLessThan(
        10 * SECOND,
      );
    });

    it("the overview judges a worker's heartbeat by the database's time", async () => {
      await prisma.workerHeartbeat.deleteMany();
      const id = `pages-worker-${randomUUID()}`;
      await prisma.workerHeartbeat.create({
        data: {
          id,
          status: "RUNNING",
          seenAt: await fromDatabase(-MINUTE),
        },
      });
      expect((await overview(get())).workerHealthy).toBe(true);
      await prisma.workerHeartbeat.update({
        where: { id },
        data: { seenAt: await fromDatabase(-3 * MINUTE) },
      });
      expect((await overview(get())).workerHealthy).toBe(false);
    });
  },
);
