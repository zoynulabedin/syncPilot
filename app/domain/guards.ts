import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PRODUCT_FIELDS, VARIANT_FIELDS } from "./sync";
export { PRODUCT_FIELDS, VARIANT_FIELDS } from "./sync";

import { DomainError } from "./errors";
export { DomainError } from "./errors";

export const PRICE_FIELDS = ["price", "compareAtPrice"] as const;
export const SYNC_FIELDS = [
  ...PRODUCT_FIELDS,
  ...PRICE_FIELDS,
  ...VARIANT_FIELDS,
] as const;
export function normalizeShop(value: unknown) {
  if (typeof value !== "string")
    throw new DomainError(
      "INVALID_SHOP",
      "Enter a valid myshopify.com store domain.",
    );
  const shop = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(shop)) {
    throw new DomainError(
      "INVALID_SHOP",
      "Enter a valid myshopify.com store domain without a URL or path.",
    );
  }
  return shop;
}
export const createChallenge = () => randomBytes(32).toString("base64url");
export const challengeHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function validChallenge(value: string, expected: string | null) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || value.length > 256)
    return false;
  return timingSafeEqual(
    Buffer.from(challengeHash(value), "hex"),
    Buffer.from(expected, "hex"),
  );
}
export function assertPairingUsable(
  request: { state: string; expiresAt: Date; attempts: number },
  now: Date,
) {
  if (request.expiresAt <= now)
    throw new DomainError(
      "PAIRING_EXPIRED",
      "The pairing request has expired. Create a new request.",
      409,
    );
  if (request.attempts >= 5)
    throw new DomainError(
      "PAIRING_LOCKED",
      "Too many incorrect pairing attempts. Create a new request.",
      429,
    );
  if (!["PENDING", "ACCEPTED"].includes(request.state))
    throw new DomainError(
      "PAIRING_USED",
      "This pairing request is no longer available.",
      409,
    );
}
export function assertWriteGates(
  inventory = false,
  env: Record<string, string | undefined> = process.env,
) {
  if (env.SYNC_WRITE_ENABLED !== "true")
    throw new DomainError(
      "WRITES_DISABLED",
      "Writes are disabled by the deployment safety switch.",
      409,
    );
  if (inventory && env.INVENTORY_WRITE_ENABLED !== "true")
    throw new DomainError(
      "INVENTORY_DISABLED",
      "Inventory writes are disabled by the deployment safety switch.",
      409,
    );
}
export function assertSafePreview(changes: unknown) {
  if (!Array.isArray(changes) || !changes.length)
    throw new DomainError(
      "EMPTY_PREVIEW",
      "There are no changes to approve.",
      409,
    );
  if (
    changes.some(
      (change) =>
        typeof change !== "object" ||
        change === null ||
        !["PRODUCT", "PRICE", "VARIANT", "INVENTORY"].includes(change.kind),
    )
  ) {
    throw new DomainError(
      "PREVIEW_HELD",
      "Resolve every held record before approving this preview.",
      409,
    );
  }
  if (changes.length > 1000)
    throw new DomainError(
      "PREVIEW_TOO_LARGE",
      "Limit each approval to 1,000 changes.",
      409,
    );
}
export function validateGid(
  value: string,
  resource: "Product" | "ProductVariant" | "Location",
) {
  if (!new RegExp(`^gid://shopify/${resource}/[0-9]+$`).test(value)) {
    throw new DomainError(
      "INVALID_RESOURCE",
      `Select a valid Shopify ${resource} identifier.`,
    );
  }
}
