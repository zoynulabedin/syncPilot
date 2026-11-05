import { describe, expect, it } from "vitest";
import { consentExhausted, nextAutomaticRun } from "../app/domain/automation";

const budget = { usedJobs: 0, maxJobs: 3, usedChanges: 0, maxChanges: 10 };
const now = new Date("2026-11-03T10:00:00.000Z");
const expiresAt = new Date("2026-11-03T12:00:00.000Z");

describe("automatic consent scheduling", () => {
  it("treats a spent job or change budget as exhausted", () => {
    expect(consentExhausted(budget)).toBe(false);
    expect(consentExhausted({ ...budget, usedJobs: 2, usedChanges: 9 })).toBe(
      false,
    );
    expect(consentExhausted({ ...budget, usedJobs: 3 })).toBe(true);
    expect(consentExhausted({ ...budget, usedChanges: 10 })).toBe(true);
  });

  it("parks an exhausted consent until expiry and moves others to the next interval", () => {
    const consent = { ...budget, intervalMinutes: 15, expiresAt };
    expect(nextAutomaticRun(consent, now)).toEqual(
      new Date("2026-11-03T10:15:00.000Z"),
    );
    expect(nextAutomaticRun({ ...consent, usedJobs: 3 }, now)).toBe(expiresAt);
    expect(nextAutomaticRun({ ...consent, usedChanges: 10 }, now)).toBe(
      expiresAt,
    );
  });

  it("always moves a due consent past now, so its idempotency key cannot repeat", () => {
    // The scheduler only selects consents with nextRunAt <= now < expiresAt.
    const soon = new Date(now.getTime() + 1);
    for (const usedJobs of [0, 3])
      expect(
        nextAutomaticRun(
          { ...budget, usedJobs, intervalMinutes: 5, expiresAt: soon },
          now,
        ).getTime(),
      ).toBeGreaterThan(now.getTime());
  });
});
