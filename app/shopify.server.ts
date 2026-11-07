import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { LogSeverity, shopifyApi } from "@shopify/shopify-api";
import {
  addDocumentResponseHeaders as documentHeaders,
  assertSameOrigin,
  createAdminAuth,
  logSignInLibraryMessage,
} from "./services/admin-auth.server";
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
/** The one place the app's client ID and secret are read. */
const appCredentials = () => ({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
});
const shopify = shopifyApp({
  ...appCredentials(),
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  appUrl,
  authPathPrefix: "/auth",
  sessionStorage: new EncryptedSessionStorage(prisma),
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
  ...appCredentials(),
  apiVersion: ApiVersion.October26,
  hostName: new URL(appUrl).host,
  isEmbeddedApp: true,
  logger: { level: LogSeverity.Error },
  _logDisabledFutureFlags: false,
});

// shopifyApp always builds an embedded API object, which sets no session cookie.
// The dashboard runs outside the Shopify admin, so sign-in has this instance. It
// holds no session: the rows it saves are the ones the worker reaches through
// shopify.unauthenticated.
const app = new URL(appUrl);
const signInApi = shopifyApi({
  ...appCredentials(),
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  hostName: app.host,
  hostScheme: app.protocol === "http:" ? "http" : "https",
  isEmbeddedApp: false,
  logger: { level: LogSeverity.Error, log: logSignInLibraryMessage },
  _logDisabledFutureFlags: false,
});
const adminAuth = createAdminAuth({
  api: signInApi,
  sessionStorage: shopify.sessionStorage,
  appUrl,
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = documentHeaders;
// Budgets apply only after authentication succeeds (a signed session cookie for the
// store a request names, body HMAC for webhooks), so rejected traffic never consumes
// a budget or reaches the limiter's table. Webhook shop/topic come from unsigned
// headers: each route names the topics it accepts, and destructive routes also prove
// the shop from the signed body. Per-IP limits belong at the reverse proxy; forwarding
// headers are not trusted.
export const authenticate = {
  ...shopify.authenticate,
  admin: async (request: Request) => {
    const result = await adminAuth.authenticate(request);
    await enforceActorLimit(request, requireActor(result));
    // After the limit: this is the one check here that costs a call to Shopify.
    await adminAuth.proveLive(request, result.session);
    return result;
  },
  webhook: async (request: Request, topics: readonly string[]) => {
    const result = await verifyWebhook(webhookApi.webhooks, request, topics);
    await enforceWebhookLimit(result);
    return result;
  },
};
export const unauthenticated = shopify.unauthenticated;
/** The worker's token: where it is stored, and how a due one is renewed. */
export const offlineAccess = {
  id: (shop: string) => signInApi.session.getOfflineId(shop),
  refresh: async (shop: string, refreshToken: string) =>
    (await signInApi.auth.refreshToken({ shop, refreshToken })).session,
};
// Login validates the shop and sends the browser to Shopify, and reads a session only
// when a cookie names one. Anyone can reach it, so the form has to come from this app
// before its body is read, and that body is bounded. That post is what confirms a
// sign-in a link could only ask for, so another site must not be able to send it.
export const login = async (request: Request) => {
  if (request.method === "GET" || request.method === "HEAD")
    return adminAuth.login(request);
  assertSameOrigin(request, app.origin);
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
  return adminAuth.login(request, new URLSearchParams(body));
};
export const signIn = {
  entry: adminAuth.entry,
  callback: adminAuth.callback,
  logout: adminAuth.logout,
  otherStores: adminAuth.otherStores,
};
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
