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
  enforceIngressLimit,
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
export const authenticate = {
  ...shopify.authenticate,
  admin: async (request: Request) => {
    await enforceIngressLimit(request, "admin");
    const result = await shopify.authenticate.admin(request);
    await enforceActorLimit(request, requireActor(result));
    return result;
  },
  webhook: async (request: Request) => {
    await enforceIngressLimit(request, "webhook");
    return shopify.authenticate.webhook(request);
  },
};
export const unauthenticated = shopify.unauthenticated;
export const login: typeof shopify.login = async (request) => {
  await enforceIngressLimit(request, "login");
  return shopify.login(request);
};
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
