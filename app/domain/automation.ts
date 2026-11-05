import { stableHash, SyncError, type SyncChange } from "./sync";

// Standing consent excludes stock, prices, lifecycle, handles and structural changes.
export const AUTOMATIC_FIELDS = [
  "title",
  "descriptionHtml",
  "vendor",
  "productType",
  "tags",
  "seoTitle",
  "seoDescription",
] as const;

type ConsentBudget = {
  usedJobs: number;
  maxJobs: number;
  usedChanges: number;
  maxChanges: number;
};

export function automationFingerprint(policy: unknown, mappings: unknown) {
  return stableHash({ policy, mappings });
}

// Usage only grows and limits are fixed at grant, so exhaustion is permanent.
export function consentExhausted(consent: ConsentBudget) {
  return (
    consent.usedJobs >= consent.maxJobs ||
    consent.usedChanges >= consent.maxChanges
  );
}

/**
 * When the scheduler next examines a due consent, whether or not it queued a run.
 * The result is always later than `now` (the scheduler only selects consents with
 * nextRunAt <= now < expiresAt), so a skipped consent leaves the head of the queue
 * and every `automatic:${id}:${nextRunAt}` idempotency key stays unique.
 */
export function nextAutomaticRun(
  consent: ConsentBudget & { intervalMinutes: number; expiresAt: Date },
  now: Date,
) {
  // Parked until expiry, when the scheduler marks it EXPIRED.
  if (consentExhausted(consent)) return consent.expiresAt;
  // A busy or inactive policy skips this slot like a completed run would.
  return new Date(now.getTime() + consent.intervalMinutes * 60_000);
}

export function assertAutomaticChanges(
  changes: SyncChange[],
  fields: string[],
  remaining: number,
  perRun: number,
) {
  if (!changes.length) return;
  if (changes.length > perRun || changes.length > remaining)
    throw new SyncError(
      "CONSENT_BUDGET",
      "This comparison exceeds the owner's remaining automatic change budget.",
    );
  if (
    changes.some(
      (change) =>
        change.kind !== "PRODUCT" ||
        !change.field ||
        !fields.includes(change.field) ||
        !(AUTOMATIC_FIELDS as readonly string[]).includes(change.field),
    )
  )
    throw new SyncError(
      "CONSENT_SCOPE",
      "This comparison requires a separate exact owner approval.",
    );
}
