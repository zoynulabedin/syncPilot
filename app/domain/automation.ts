import { stableHash, SyncError, type SyncChange } from "./sync";

// Standing consent excludes stock, prices, lifecycle, handles and structural changes.
export const AUTOMATIC_FIELDS = [
  "title", "descriptionHtml", "vendor", "productType", "tags",
  "seoTitle", "seoDescription",
] as const;

export function automationFingerprint(policy: unknown, mappings: unknown) {
  return stableHash({ policy, mappings });
}

export function assertAutomaticChanges(
  changes: SyncChange[], fields: string[], remaining: number, perRun: number,
) {
  if (!changes.length) return;
  if (changes.length > perRun || changes.length > remaining)
    throw new SyncError("CONSENT_BUDGET", "This comparison exceeds the owner's remaining automatic change budget.");
  if (changes.some((change) => change.kind !== "PRODUCT" || !change.field ||
    !fields.includes(change.field) ||
    !(AUTOMATIC_FIELDS as readonly string[]).includes(change.field)))
    throw new SyncError("CONSENT_SCOPE", "This comparison requires a separate exact owner approval.");
}
