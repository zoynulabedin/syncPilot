import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../db.server";
import type { Actor } from "./authorization.server";

type Database = Pick<PrismaClient | Prisma.TransactionClient, "$queryRaw">;
export const RATE_LIMITS = {
  shopRead: 600,
  shopWrite: 120,
  userRead: 180,
  userWrite: 30,
  shopCatalogWebhook: 1200,
} as const;
const WINDOW_SECONDS = 60;
const CLEANUP_BATCH = 1000;
/**
 * High-volume catalog topics, in the form @shopify/shopify-api returns after
 * verification ("products/update" becomes "PRODUCTS_UPDATE"). Lifecycle and
 * compliance topics are deliberately absent so they are never limited.
 */
export const LIMITED_WEBHOOK_TOPICS: ReadonlySet<string> = new Set([
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "INVENTORY_LEVELS_UPDATE",
]);
const actorRequests = new WeakMap<Request, Promise<void>>();

export function rateLimitKey(scope: string, identity: string) {
  return createHash("sha256")
    .update(JSON.stringify([scope, identity]))
    .digest("hex");
}

function unavailable() {
  return new Response(
    "Request protection is temporarily unavailable. Retry shortly.",
    {
      status: 503,
      headers: { "Retry-After": "10", "Cache-Control": "no-store" },
    },
  );
}

/** One atomic database operation; limits remain shared across web replicas. */
export async function consumeRateLimit(
  scope: string,
  identity: string,
  limit: number,
  db: Database = prisma,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000)
    throw new Error("Invalid request budget");
  const key = rateLimitKey(scope, identity);
  let accepted: Array<{ count: number }>;
  try {
    accepted = await db.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "RequestRateLimit" ("key", "count", "expiresAt")
      VALUES (${key}, 1, CURRENT_TIMESTAMP + INTERVAL '60 seconds')
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RequestRateLimit"."expiresAt" <= CURRENT_TIMESTAMP
          THEN 1 ELSE "RequestRateLimit"."count" + 1 END,
        "expiresAt" = CASE WHEN "RequestRateLimit"."expiresAt" <= CURRENT_TIMESTAMP
          THEN CURRENT_TIMESTAMP + INTERVAL '60 seconds'
          ELSE "RequestRateLimit"."expiresAt" END
      WHERE "RequestRateLimit"."expiresAt" <= CURRENT_TIMESTAMP
        OR "RequestRateLimit"."count" < ${limit}
      RETURNING "count"
    `;
  } catch {
    throw unavailable();
  }
  if (!accepted.length)
    throw new Response("Too many requests. Retry in one minute.", {
      status: 429,
      headers: {
        "Retry-After": String(WINDOW_SECONDS),
        "Cache-Control": "no-store",
      },
    });
}

/** Call only after Shopify authenticate.admin verified this actor's identity. */
export async function enforceActorLimit(
  request: Request,
  actor: Actor,
  db: Database = prisma,
) {
  const previous = actorRequests.get(request);
  if (previous) return previous;
  const pending = (async () => {
    const read = request.method === "GET" || request.method === "HEAD";
    const mode = read ? "read" : "write";
    await consumeRateLimit(
      `shop:${mode}`,
      actor.shop,
      read ? RATE_LIMITS.shopRead : RATE_LIMITS.shopWrite,
      db,
    );
    await consumeRateLimit(
      `user:${mode}`,
      JSON.stringify([actor.shop, actor.userId]),
      read ? RATE_LIMITS.userRead : RATE_LIMITS.userWrite,
      db,
    );
  })();
  actorRequests.set(request, pending);
  return pending;
}

/**
 * Call only with the shop/topic returned by Shopify authenticate.webhook after
 * HMAC verification. A limited delivery gets 429; Shopify retries it and
 * scheduled reconciliation repairs any drift.
 */
export async function enforceWebhookLimit(
  webhook: { shop: string; topic: string },
  db: Database = prisma,
) {
  if (!LIMITED_WEBHOOK_TOPICS.has(webhook.topic)) return;
  // The shop is the unsigned, unnormalized X-Shopify-Shop-Domain header, so
  // key it as requireActor does; varying its case must not open a new bucket.
  await consumeRateLimit(
    "webhook:catalog",
    webhook.shop.trim().toLowerCase(),
    RATE_LIMITS.shopCatalogWebhook,
    db,
  );
}

/**
 * Bounded worker housekeeping. Expired rows are reset in place on their next
 * request, so only windows idle for a day are removed; the expiry is rechecked
 * on delete so a window reset concurrently is kept.
 */
export async function cleanExpiredRateLimits(
  db: Pick<PrismaClient, "$executeRaw"> = prisma,
) {
  return db.$executeRaw`
    WITH expired AS (
      SELECT "key" FROM "RequestRateLimit"
      WHERE "expiresAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'
      ORDER BY "expiresAt" LIMIT ${CLEANUP_BATCH}
    )
    DELETE FROM "RequestRateLimit"
    WHERE "key" IN (SELECT "key" FROM expired)
      AND "expiresAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'
  `;
}
