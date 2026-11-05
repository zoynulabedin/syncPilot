import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { EncryptedSessionStorage } from "./services/session-storage.server";
import prisma from "./db.server";
import { resolveShopifyAppUrl } from "./services/environment.server";
import { requireActor } from "./services/authorization.server";
import {
  enforceActorLimit,
  enforceWebhookLimit,
} from "./services/rate-limit.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: resolveShopifyAppUrl(),
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

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
// Budgets apply only after Shopify authentication succeeds (session token for
// admin, body HMAC for webhooks), so rejected traffic never consumes a budget
// or reaches the limiter's table. Webhook shop/topic come from unsigned headers
// and are trusted as the library trusts them. Per-IP limits belong at the
// reverse proxy; forwarding headers are not trusted.
export const authenticate = {
  ...shopify.authenticate,
  admin: async (request: Request) => {
    const result = await shopify.authenticate.admin(request);
    await enforceActorLimit(request, requireActor(result));
    return result;
  },
  webhook: async (request: Request) => {
    const result = await shopify.authenticate.webhook(request);
    await enforceWebhookLimit(result);
    return result;
  },
};
export const unauthenticated = shopify.unauthenticated;
// Login only validates the shop parameter and redirects; it does no database work.
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
