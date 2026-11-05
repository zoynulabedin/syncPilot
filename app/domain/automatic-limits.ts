// Grant form bounds for one standing automatic consent. They mirror the
// grantAutomaticConsent schema; tests/automatic-sync-route.test.ts fails if the
// two drift apart.
export const CONSENT_LIMITS = {
  durationMinutes: { min: 5, max: 1440 },
  intervalMinutes: { min: 5, max: 1440 },
  maxJobs: { min: 1, max: 100 },
  maxChanges: { min: 1, max: 1000 },
  perRunChanges: { min: 1, max: 100 },
} as const;

export type ConsentLimit = keyof typeof CONSENT_LIMITS;
