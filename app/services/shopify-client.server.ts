import type { Session } from "@shopify/shopify-api";
import prisma from "../db.server";
import { normalizeShop } from "../domain/guards";
import { assertWriteGates, SyncError } from "../domain/sync";
import { UnreadableSessionError } from "./session-storage.server";

export type GraphQLExecutor = (
  document: string,
  options: { variables?: Record<string, unknown>; signal?: AbortSignal },
) => Promise<Response>;
type RequestOptions = {
  write?: boolean;
  inventory?: boolean;
  execute?: GraphQLExecutor;
};
type Envelope<T> = {
  data?: T;
  errors?: { extensions?: { code?: string } }[];
  extensions?: {
    cost?: {
      throttleStatus?: { currentlyAvailable: number; restoreRate: number };
      requestedQueryCost?: number;
    };
  };
};
const budgets = new Map<string, number>();
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The library's calls to the token endpoint take no signal, so this stands in. */
export const TOKEN_DEADLINE_MS = 15_000;
/**
 * unauthenticated.admin refreshes a token by itself within five minutes of expiry, and
 * takes no lock to do it. Starting a minute sooner leaves it nothing to do.
 */
const REFRESH_WINDOW_MS = 6 * 60_000;
const TOKEN_LOCK_CONNECTION_WAIT_MS = 5_000;
/**
 * As long as one holder can take. PostgreSQL goes on waiting for a lock after Prisma's
 * timeout has passed, so a waiter has this limit of its own, and gets in with at least
 * a whole deadline of the timeout left. What is added to each is reading and storing.
 */
const TOKEN_LOCK_WAIT_MS = TOKEN_DEADLINE_MS + 5_000;
const TOKEN_LOCK_TIMEOUT_MS = TOKEN_LOCK_WAIT_MS + TOKEN_DEADLINE_MS + 5_000;

export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Shopify timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The library throws rather than returning an envelope: GraphqlQueryError holds a
 * fetch response, and HttpResponseError holds its status as `code`.
 */
export function shopifyFailureStatus(error: unknown) {
  const failed =
    typeof error === "object" && error && "response" in error
      ? (error.response as { status?: number; code?: number } | undefined)
      : undefined;
  return failed?.status ?? failed?.code;
}

const authorizationExpired = () =>
  new SyncError(
    "AUTH_FAILURE",
    "Shopify authorization expired. Open SyncPilot from the affected store's Shopify admin to reconnect.",
  );

/**
 * One token operation for a store at a time, across every process. Shopify documents
 * why: two refreshes at once can leave one holder with a token the other has replaced,
 * and a grant during a refresh makes one of the two answers invalid as it arrives.
 * `work` must not call anything that wants this lock, which offlineExecutor does.
 * The session adapter takes connections of its own, so this needs two at once, and
 * three inside another transaction, which is where the worker's writes reach it. A
 * pool of fewer fails every refresh due there. Prisma's default pool is never fewer.
 */
export function withOfflineTokenLock<T>(
  shop: string,
  work: (stillHeld: () => Promise<unknown>) => Promise<T>,
) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${String(TOKEN_LOCK_WAIT_MS)}, true)`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`offline-token:${shop}`}))::text`;
      return work(() => tx.$queryRaw`SELECT 1`);
    },
    { maxWait: TOKEN_LOCK_CONNECTION_WAIT_MS, timeout: TOKEN_LOCK_TIMEOUT_MS },
  );
}

/**
 * The library's refresh helper turns almost every failure into a bare 500, so a 503
 * would read like a dead token: the job gives up and the next sign-in mints a new
 * grant, which retires the refresh token that was fine. So a refresh that is due
 * happens here. Every way a token can be finished, Shopify answers with a 401, and
 * only that counts as refusing it. A 429, a 5xx or no answer at all can be retried
 * with the same token, as Shopify documents. Anything else, such as a 400 for a
 * malformed body or a 403 for bad client credentials, is about this app's request
 * rather than the store's token, so no new grant would mend it, and it looks the same
 * however often it is sent.
 */
async function refreshWhenDue(
  runtime: typeof import("../shopify.server"),
  shop: string,
) {
  const load = () =>
    runtime.sessionStorage
      .loadSession(runtime.offlineAccess.id(shop))
      .catch((error: unknown) => {
        if (error instanceof UnreadableSessionError) return undefined;
        throw error;
      });
  const dueToken = (session: Session) =>
    session.isExpired(REFRESH_WINDOW_MS) ? session.refreshToken : undefined;
  const seen = await load();
  if (!seen) throw authorizationExpired();
  if (!dueToken(seen)) return;
  await withOfflineTokenLock(shop, async (stillHeld) => {
    // The row again: another process may have renewed it during the wait.
    const stored = await load();
    if (!stored) throw authorizationExpired();
    const refreshToken = dueToken(stored);
    if (!refreshToken) return;
    // Sent, and its answer read, only while the lock is held. A transaction past its
    // timeout has let the lock go, and anything Shopify said may have been overtaken
    // since, a 401 included, so it comes out as a retry. Shopify keeps the token it
    // was given usable until the newer one is used, so that retry is safe.
    await stillHeld();
    const answer = await withDeadline(
      runtime.offlineAccess.refresh(shop, refreshToken),
      TOKEN_DEADLINE_MS,
    ).then(
      (session) => ({ session }),
      (error: unknown) => ({ error }),
    );
    await stillHeld();
    if ("error" in answer) {
      const status = shopifyFailureStatus(answer.error);
      if (status === 401) throw authorizationExpired();
      if (status !== undefined && status !== 429 && status < 500)
        throw new SyncError(
          "CONFIGURATION_ERROR",
          "Shopify refused to renew this store's access token. Check the app's API credentials.",
        );
      throw new SyncError(
        "NETWORK_TIMEOUT",
        "Shopify could not renew this store's access token. The worker will retry.",
        true,
      );
    }
    await runtime.sessionStorage.storeSession(answer.session);
  });
}

export async function offlineExecutor(
  shopDomain: string,
): Promise<GraphQLExecutor> {
  const shop = normalizeShop(shopDomain);
  const connection = await prisma.shopConnection.findUnique({
    where: { shopDomain: shop },
  });
  if (
    !connection ||
    connection.status !== "CONNECTED" ||
    connection.uninstalledAt
  )
    throw new SyncError("UNINSTALLED", "The shop installation is inactive.");
  // The official library decrypts via the configured session adapter.
  let runtime: typeof import("../shopify.server");
  try {
    runtime = await import("../shopify.server");
  } catch {
    throw new SyncError(
      "CONFIGURATION_ERROR",
      "The worker could not initialize Shopify. Check its app URL, API credentials and session encryption key.",
    );
  }
  try {
    await refreshWhenDue(runtime, shop);
    const { admin } = await runtime.unauthenticated.admin(shop);
    return (document, options) => admin.graphql(document, options);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    // Nothing reached the Admin API: the database, the token lock running out of time,
    // or the library's own refresh after a long stall here, with the status already lost.
    throw new SyncError(
      "NETWORK_TIMEOUT",
      "SyncPilot could not load this store's Shopify access. The worker will retry.",
      true,
    );
  }
}

/** Only accepts an installed shop; callers additionally enforce workspace/actor access. Never returns tokens. */
export async function shopifyRequest<T>(
  shopDomain: string,
  document: string,
  variables: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<T> {
  if (options.write) assertWriteGates(options.inventory);
  const shop = normalizeShop(shopDomain);
  const execute = options.execute ?? (await offlineExecutor(shop));
  const defer = (budgets.get(shop) ?? 0) - Date.now();
  if (defer > 0) await wait(Math.min(defer, 5000));
  let response: Response;
  try {
    response = await execute(document, {
      variables,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    if (error instanceof SyncError) throw error;
    const status = shopifyFailureStatus(error);
    if (status === 401 || status === 403)
      throw new SyncError(
        "AUTH_FAILURE",
        "Shopify access was revoked or required scopes are missing.",
      );
    if (status === 429)
      throw new SyncError(
        "THROTTLED",
        "Shopify rate limit reached. The worker will retry.",
        true,
      );
    const code =
      typeof error === "object" && error && "body" in error
        ? JSON.stringify((error.body as { errors?: unknown })?.errors ?? {})
        : "";
    if (code.includes("THROTTLED"))
      throw new SyncError(
        "THROTTLED",
        "Shopify query cost budget was exhausted.",
        true,
      );
    throw new SyncError(
      options.write ? "UNKNOWN_OUTCOME" : "NETWORK_TIMEOUT",
      options.write
        ? "The mutation outcome is uncertain. Review live state and create a fresh preview."
        : "Shopify did not respond. The worker will retry.",
      !options.write,
      !!options.write,
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new SyncError(
      "AUTH_FAILURE",
      "Shopify authorization or a required API scope is missing.",
    );
  if (response.status === 429)
    throw new SyncError(
      "THROTTLED",
      "Shopify rate limit reached. The worker will retry.",
      true,
    );
  if (!response.ok)
    throw new SyncError(
      "SHOPIFY_5XX",
      "Shopify returned an unsuccessful response.",
      !options.write,
      !!options.write,
    );
  let body: Envelope<T>;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    throw new SyncError(
      "PARTIAL_GRAPHQL_ERROR",
      "Shopify returned an unreadable response.",
      !options.write,
      !!options.write,
    );
  }
  if (body.errors?.length) {
    if (body.errors.every((error) => error.extensions?.code === "THROTTLED"))
      throw new SyncError(
        "THROTTLED",
        "Shopify query cost budget was exhausted.",
        true,
      );
    throw new SyncError(
      "PARTIAL_GRAPHQL_ERROR",
      "Shopify reported a GraphQL error. No partial data is treated as success.",
      false,
      !!options.write,
    );
  }
  if (!body.data)
    throw new SyncError(
      "PARTIAL_GRAPHQL_ERROR",
      "Shopify response omitted required data.",
      false,
      !!options.write,
    );
  const budget = body.extensions?.cost?.throttleStatus;
  if (budget && budget.restoreRate > 0) {
    const cost = body.extensions?.cost?.requestedQueryCost ?? 100;
    budgets.set(
      shop,
      Date.now() +
        Math.min(
          5000,
          Math.max(
            0,
            ((cost - budget.currentlyAvailable) / budget.restoreRate) * 1000,
          ),
        ),
    );
  }
  return body.data;
}
