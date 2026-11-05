import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { LogSeverity, shopifyApi } from "@shopify/shopify-api";
import { EncryptedSessionStorage } from "./services/session-storage.server";
import prisma from "./db.server";
import { resolveShopifyAppUrl } from "./services/environment.server";
import { requireActor } from "./services/authorization.server";
import {
  enforceActorLimit,
  enforceWebhookLimit,
} from "./services/rate-limit.server";
import {
  LOGIN_BODY_LIMIT,
  anonymousBodies,
  withBoundedBody,
} from "./services/request-body.server";
import { verifyWebhook } from "./services/webhook-verification.server";

const appUrl = resolveShopifyAppUrl();
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  appUrl,
  authPathPrefix: "/auth",
  sessionStorage: new EncryptedSessionStorage(prisma),
  useOnlineTokens: true,
  distribution: AppDistribution.SingleMerchant,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

// shopifyApp keeps its API object private, and its authenticate.webhook loads,
// decrypts and refreshes the offline session before a route runs, answering 500
// if any of that fails. That loses uninstall and compliance deliveries for idle
// stores. This instance is used only for webhooks.validate and holds no session.
const webhookApi = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  hostName: new URL(appUrl).host,
  isEmbeddedApp: true,
  logger: { level: LogSeverity.Error },
  _logDisabledFutureFlags: false,
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
// Budgets apply only after Shopify authentication succeeds (session token for
// admin, body HMAC for webhooks), so rejected traffic never consumes a budget
// or reaches the limiter's table. Webhook shop/topic come from unsigned headers:
// each route names the topics it accepts, and destructive routes also prove the
// shop from the signed body. Per-IP limits belong at the reverse proxy;
// forwarding headers are not trusted.
export const authenticate = {
  ...shopify.authenticate,
  admin: async (request: Request) => {
    const result = await shopify.authenticate.admin(request);
    await enforceActorLimit(request, requireActor(result));
    return result;
  },
  webhook: async (request: Request, topics: readonly string[]) => {
    const result = await verifyWebhook(webhookApi.webhooks, request, topics);
    await enforceWebhookLimit(result);
    return result;
  },
};
export const unauthenticated = shopify.unauthenticated;
// Login only validates the shop parameter and redirects; it does no database
// work. The library reads the form unbounded, so it gets a copy that fits.
export const login = async (request: Request) => {
  if (request.method === "GET" || request.method === "HEAD")
    return shopify.login(request);
  const contentType = request.headers.get("Content-Type") || "";
  if (
    !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
  )
    throw new Response("Unsupported form encoding", { status: 415 });
  const body = await withBoundedBody(
    request,
    LOGIN_BODY_LIMIT,
    (text) => text,
    anonymousBodies,
  );
  return shopify.login(
    new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    }),
  );
};
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
