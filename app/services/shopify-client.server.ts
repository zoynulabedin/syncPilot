import prisma from "../db.server";
import { normalizeShop } from "../domain/guards";
import { assertWriteGates, SyncError } from "../domain/sync";

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
  // The official library refreshes expiring offline tokens and decrypts via the configured session adapter.
  const { unauthenticated } = await import("../shopify.server");
  try {
    const { admin } = await unauthenticated.admin(shop);
    return (document, options) => admin.graphql(document, options);
  } catch {
    throw new SyncError(
      "AUTH_FAILURE",
      "Shopify authorization expired. Reopen the app in the affected store to reconnect.",
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
    // Shopify can throw its GraphqlQueryError rather than returning an envelope.
    const status =
      typeof error === "object" && error && "response" in error
        ? (error.response as { status?: number })?.status
        : undefined;
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
