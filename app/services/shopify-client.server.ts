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
/** How close to expiry unauthenticated.admin would refresh a token by itself. */
const REFRESH_WINDOW_MS = 5 * 60_000;

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
 * The library's refresh helper turns almost every failure into a bare 500, so a 503
 * would read like a dead token: the job gives up and the next sign-in mints a new
 * grant, which retires the refresh token that was fine. So a refresh that is due
 * happens here, and only a 400 or a 401 counts as Shopify refusing the token. A 429,
 * a 5xx or no answer at all can be retried with the same token, as Shopify documents.
 * Anything else is about this app's credentials rather than the store's token, so no
 * new grant would mend it, and it looks the same however often it is sent.
 */
async function refreshWhenDue(
  runtime: typeof import("../shopify.server"),
  shop: string,
) {
  const stored = await runtime.sessionStorage
    .loadSession(runtime.offlineAccess.id(shop))
    .catch((error: unknown) => {
      if (error instanceof UnreadableSessionError) return undefined;
      throw error;
    });
  if (!stored) throw authorizationExpired();
  if (!stored.refreshToken || !stored.isExpired(REFRESH_WINDOW_MS)) return;
  let session: Awaited<ReturnType<typeof runtime.offlineAccess.refresh>>;
  try {
    session = await withDeadline(
      runtime.offlineAccess.refresh(shop, stored.refreshToken),
      TOKEN_DEADLINE_MS,
    );
  } catch (error) {
    const status = shopifyFailureStatus(error);
    if (status === 400 || status === 401) throw authorizationExpired();
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
  await runtime.sessionStorage.storeSession(session);
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
    // Nothing reached the Admin API: the database, or the library's own refresh on
    // the instant a token entered its window, with the status already lost.
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
