import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../db.server";
import type { Actor } from "./authorization.server";

type Database = Pick<PrismaClient | Prisma.TransactionClient, "$queryRaw">;
export const RATE_LIMITS = {
  adminIngress: 1200,
  webhookIngress: 2400,
  loginIngress: 120,
  shopRead: 600,
  shopWrite: 120,
  userRead: 180,
  userWrite: 30,
} as const;
const WINDOW_SECONDS = 60;
const ingressRequests = new WeakMap<Request, Promise<void>>();
const actorRequests = new WeakMap<Request, Promise<void>>();
let cleanupAfter = 0;

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

export async function enforceIngressLimit(
  request: Request,
  kind: "admin" | "webhook" | "login",
  db: Database = prisma,
) {
  const previous = ingressRequests.get(request);
  if (previous) return previous;
  const pending = (async () => {
    // No unverified shop query, IP/forwarding header or token chooses this key.
    const limit = RATE_LIMITS[`${kind}Ingress`];
    await consumeRateLimit(`ingress:${kind}`, "application", limit, db);
    if (Date.now() >= cleanupAfter) {
      cleanupAfter = Date.now() + 60_000;
      try {
        await db.$queryRaw`
          WITH expired AS (
            SELECT "key" FROM "RequestRateLimit"
            WHERE "expiresAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'
            ORDER BY "expiresAt" LIMIT 1000
          ) DELETE FROM "RequestRateLimit" WHERE "key" IN (SELECT "key" FROM expired)
        `;
      } catch {
        // Cleanup is bounded and best effort; enforcement above still succeeded.
      }
    }
  })();
  ingressRequests.set(request, pending);
  return pending;
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
