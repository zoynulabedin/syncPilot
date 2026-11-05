import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), error: vi.fn() }));
vi.mock("../app/db.server", () => ({ default: { $queryRaw: mocks.query } }));
vi.mock("../app/services/logger.server", () => ({
  logger: { error: mocks.error },
}));

import {
  databaseClockRemedy,
  isUtcTimeZone,
  readDatabaseClock,
} from "../app/services/database-clock.server";
import { loader } from "../app/routes/ready";

describe("database time zone decision", () => {
  it("accepts UTC and every tz database alias of it by name, ignoring case", () => {
    for (const name of [
      "UTC",
      "Etc/UTC",
      "UCT",
      "Etc/UCT",
      "GMT",
      "Etc/GMT",
      "GMT0",
      "Etc/GMT0",
      "GMT+0",
      "GMT-0",
      "Etc/GMT+0",
      "Etc/GMT-0",
      "Greenwich",
      "Etc/Greenwich",
      "Universal",
      "Etc/Universal",
      "Zulu",
      "Etc/Zulu",
      "utc",
      "etc/utc",
      "ZULU",
      " UTC ",
    ])
      expect(isUtcTimeZone(name), name).toBe(true);
  });

  it("rejects local zones, including ones whose current offset is zero, and POSIX offsets", () => {
    for (const name of [
      "Asia/Dhaka",
      "America/New_York",
      "Europe/London",
      "Europe/Lisbon",
      "Africa/Abidjan",
      "Atlantic/Reykjavik",
      "Etc/GMT+1",
      "Etc/GMT-14",
      "UTC0",
      "UTC+0",
      "<+00>-00",
      "localtime",
      "",
    ])
      expect(isUtcTimeZone(name), name).toBe(false);
  });

  it("reads the session zone and builds a remedy that quotes the database identifier", async () => {
    mocks.query.mockResolvedValueOnce([
      { database: 'sync"pilot', timeZone: "Asia/Dhaka" },
    ]);
    const clock = await readDatabaseClock();
    expect(clock).toEqual({
      database: 'sync"pilot',
      timeZone: "Asia/Dhaka",
      utc: false,
    });
    const remedy = databaseClockRemedy(clock);
    expect(remedy).toContain(
      `ALTER DATABASE "sync""pilot" SET timezone TO 'UTC'`,
    );
    expect(remedy).toContain("timezone = 'UTC'");
    expect(remedy).toContain("restart the web and worker processes");
    mocks.query.mockResolvedValueOnce([]);
    await expect(readDatabaseClock()).rejects.toThrow();
  });
});

describe("readiness database time zone gate", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
    vi.stubEnv("REDIS_URL", "");
    mocks.query.mockReset();
    mocks.error.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  const probe = (timeZone: string) => {
    mocks.query
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([{ database: "syncpilot", timeZone }]);
    return loader();
  };

  it("does not depend on Redis, which holds no job or request state", async () => {
    // Nothing listens here. A health-aware proxy would stop sending webhooks to
    // this process if an outage of something it does not use failed readiness.
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
    const response = await probe("UTC");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("is ready when the database session uses a UTC alias", async () => {
    const response = await probe("Etc/UTC");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("reports the generic unavailable body for a local zone and logs a throttled remedy", async () => {
    const response = await probe("Asia/Dhaka");
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "unavailable" });
    expect(body).not.toMatch(/Dhaka|syncpilot|timezone/i);
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(mocks.error.mock.calls[0][0]).toEqual({
      code: "DATABASE_TIME_ZONE_NOT_UTC",
      timeZone: "Asia/Dhaka",
    });
    expect(mocks.error.mock.calls[0][1]).toContain(
      `ALTER DATABASE "syncpilot" SET timezone TO 'UTC'`,
    );

    vi.setSystemTime(new Date("2026-11-03T00:00:59Z"));
    expect((await probe("Europe/London")).status).toBe(503);
    expect(mocks.error).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-11-03T00:01:00Z"));
    expect((await probe("Europe/London")).status).toBe(503);
    expect(mocks.error).toHaveBeenCalledTimes(2);
  });

  it("keeps the generic body when the time zone cannot be read", async () => {
    mocks.query
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockRejectedValueOnce(new Error("connection reset by 10.0.0.5"));
    const response = await loader();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });
});
