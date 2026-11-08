import { createHmac } from "node:crypto";
import type { Session, Shopify } from "@shopify/shopify-api";
import {
  BotActivityDetected,
  CookieNotFound,
  InvalidHmacError,
  InvalidOAuthError,
  InvalidShopError,
  STATE_COOKIE_NAME,
  ShopifyError,
} from "@shopify/shopify-api";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";
import { createCookie, data, redirect, redirectDocument } from "react-router";
import prisma from "../db.server";
import { DomainError, normalizeShop } from "../domain/guards";
import { storePath } from "../domain/store-binding";
import { SyncError } from "../domain/sync";
import { INSTALLATION_CHECK_QUERY } from "../domain/sync-operations";
import { requireActor } from "./authorization.server";
import { ensureInstallation } from "./control-plane.server";
import {
  endFormerOwnerAuthority,
  recordSignedVisit,
} from "./installation.server";
import { logger } from "./logger.server";
import { UnreadableSessionError } from "./session-storage.server";
import {
  shopifyFailureStatus,
  shopifyRequest,
  TOKEN_DEADLINE_MS,
  withDeadline,
  withOfflineTokenLock,
} from "./shopify-client.server";
import { cookieSigningKey } from "./token-crypto.server";

const CALLBACK_PATH = "/auth/callback";
const LOGIN_PATH = "/auth/login";
const DEFAULT_RETURN = "/app";
const MAX_RETURN_LENGTH = 1024;
/**
 * One browser works in several stores at once, so what it holds is per store: a
 * session here and a sign-in in progress there never touch another store's.
 */
const SESSION_COOKIE = "syncpilot_session";
const FLOW_COOKIE = "syncpilot_sign_in";
/** The stores this browser signed in to and has not signed out of, latest first. */
const REMEMBERED_COOKIE = "syncpilot_stores";
const REMEMBER_SECONDS = 30 * 24 * 3600;
const MAX_REMEMBERED = 10;
/**
 * The library gives its state cookie one minute, which a person typing a password
 * and a two-step code at Shopify can outlast. Only the lifetime and the name change:
 * the value and its signature are the library's, and the code still comes back signed.
 */
const SIGN_IN_WINDOW_SECONDS = 10 * 60;
/**
 * The smallest thing a token can be asked: `shop` needs no access scope. Every
 * state-changing request asks it, and a person waits on that before their action runs.
 * Pages ask it too, for far less: see checkPageLive.
 */
const SESSION_CHECK_QUERY = `#graphql
  query SessionStillLive {
    shop {
      id
    }
  }
`;
export const SESSION_CHECK_DEADLINE_MS = 8_000;
/** One answer holds this long for every page a session opens, whatever it was. */
const PAGE_CHECK_WINDOW_MS = 3 * 60_000;
const PAGE_CHECK_DEADLINE_MS = 3_000;
/** Each process keeps its own, and one it has dropped or never had is only asked again. */
export const PAGE_CHECK_RECORDS = 1_000;
/** Never kept in a return path: Shopify's signatures, and what an embedded load carried. */
const SIGNED_PARAMS = [
  "_routes",
  "code",
  "embedded",
  "hmac",
  "host",
  "id_token",
  "locale",
  "session",
  "shop",
  "signature",
  "state",
  "timestamp",
];

/** "repair" asks for the app's offline token, once Shopify has signed the way back. */
type SignInStep = "online" | "repair";
type SignInFlow = { shop: string; returnTo: string; step: SignInStep };
type ShopifyAnswer = "live" | "refused" | "unavailable";
type SessionStore = {
  loadSession(id: string): Promise<Session | undefined>;
  storeSession(session: Session): Promise<boolean>;
};
export type AdminContext = { session: Session };

const SIGN_IN_PROBLEMS = {
  EXPIRED:
    "This sign-in took too long, or your browser blocked its cookies. Nothing was changed. Sign in again.",
  INVALID:
    "Shopify's answer could not be verified, so you were not signed in. Sign in again.",
  EXCHANGE_FAILED:
    "Shopify did not complete the sign-in. Nothing was changed. Sign in again.",
  TOKEN_BUSY:
    "SyncPilot could not renew this store's access just now. Nothing was changed. Sign in again.",
  SUPERSEDED:
    "Another sign-in to this store started in this browser, so this one was not completed. Nothing was changed. Sign in again.",
  UNEXPECTED_TOKEN:
    "Shopify answered for a different store or kind of access, so you were not signed in. Sign in again.",
  SCOPES_NOT_GRANTED:
    "SyncPilot needs every permission it asks for. Approve them all when you sign in again.",
} as const;
type SignInProblem = keyof typeof SIGN_IN_PROBLEMS;

/**
 * Where a sign-in may land: a path of this app's dashboard and nothing else.
 * Browsers read "\" as "/" and drop tabs and newlines, so this judges the URL a
 * browser would build, and hands back only that URL's own path and query. The store
 * is left out: a sign-in lands on the store it was for, whatever the link said.
 */
export function safeReturnPath(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > MAX_RETURN_LENGTH ||
    !value.startsWith("/")
  )
    return DEFAULT_RETURN;
  const base = "https://return-path.invalid";
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return DEFAULT_RETURN;
  }
  if (url.origin !== base || !/^\/app(?:\/|$)/.test(url.pathname))
    return DEFAULT_RETURN;
  for (const name of SIGNED_PARAMS) url.searchParams.delete(name);
  // Measured again once encoded, which can grow it ninefold: this goes in a cookie.
  const path = `${url.pathname}${url.search}`;
  return path.length > MAX_RETURN_LENGTH ? DEFAULT_RETURN : path;
}

/**
 * The session cookie goes along with a form posted from another site unless
 * SameSite stops it, and owner-only actions sit behind this. Browsers set Origin
 * on every POST; Sec-Fetch-Site covers one that left it out. It is compared with
 * the configured app URL, because a proxy decides what request.url says.
 */
export function assertSameOrigin(request: Request, appOrigin: string) {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("Origin");
  const same = origin
    ? origin === appOrigin
    : request.headers.get("Sec-Fetch-Site") === "same-origin";
  if (!same)
    throw new Response("Invalid request origin", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
}

const changesState = (request: Request) =>
  request.method !== "GET" && request.method !== "HEAD";

/**
 * Every page is a top-level document now, so nothing may frame any of them. None
 * is kept either: the back button must not bring a dashboard back after signing
 * out, and judging by the path would miss /APP and /%61pp, which still route here.
 */
export function addDocumentResponseHeaders(headers: Headers) {
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "no-store");
}

/** The library's log text puts the spent state value in its context. */
export function logSignInLibraryMessage(_severity: unknown, message: string) {
  logger.warn({ source: "shopify-api" }, message.split(" | ")[0]);
}

const validShop = (value: unknown) => {
  try {
    return normalizeShop(value);
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
};
/** The one store an address names. Two copies name none: which would be believed? */
const namedStore = (url: URL) => {
  const named = url.searchParams.getAll("shop");
  return named.length === 1 ? validShop(named[0]) : null;
};
/**
 * Session.fromPropertyArray turns a missing user id into NaN, which passes for an id.
 * With no real id there is no person to hold authority or to attribute anything to.
 */
const isPerson = (session: Session) =>
  Number.isSafeInteger(session.onlineAccessInfo?.associated_user?.id);
const expired = (name: string, path: string) =>
  `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
const stateCookieName = (shop: string) => `${STATE_COOKIE_NAME}.${shop}`;
const cookiesIn = (request: Request) => {
  const found = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const equals = part.indexOf("=");
    const name = part.slice(0, Math.max(equals, 0)).trim();
    if (name && !found.has(name))
      found.set(name, part.slice(equals + 1).trim());
  }
  return found;
};
const signInPath = (shop: string | null | undefined, url: URL) => {
  const query = new URLSearchParams({
    return_to: safeReturnPath(`${url.pathname}${url.search}`),
  });
  if (shop) query.set("shop", shop);
  return `${LOGIN_PATH}?${query}`;
};
const refused = (
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });

export function createAdminAuth({
  api,
  sessionStorage,
  appUrl,
}: {
  api: Pick<Shopify, "auth" | "clients" | "session" | "utils" | "config">;
  sessionStorage: SessionStore;
  appUrl: string;
}) {
  const appOrigin = new URL(appUrl).origin;
  // These cookies outlive any one app's secret, and a signature made with that secret
  // itself could be asked of Shopify, which signs webhook bodies with it. Only a
  // server with no encryption key, which production refuses to be, falls back to it.
  const cookieKey =
    cookieSigningKey() ??
    createHmac("sha256", api.config.apiSecretKey)
      .update("syncpilot/sign-in-cookies/v1")
      .digest("base64url");
  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    secrets: [cookieKey],
  };
  /**
   * Holds only a signed, random session id. The signature does not cover the cookie's
   * name, so sessionFor below also checks that the row it opens is this store's.
   */
  const sessionCookie = (shop: string) =>
    createCookie(`${SESSION_COOKIE}.${shop}`, { ...cookieOptions, path: "/" });
  const flowCookie = (shop: string) =>
    createCookie(`${FLOW_COOKIE}.${shop}`, {
      ...cookieOptions,
      path: CALLBACK_PATH,
      maxAge: SIGN_IN_WINDOW_SECONDS,
    });
  const rememberedCookie = createCookie(REMEMBERED_COOKIE, {
    ...cookieOptions,
    path: "/",
    maxAge: REMEMBER_SECONDS,
  });
  const actionsChecked = new WeakMap<Request, Promise<AdminContext>>();
  const proofs = new WeakMap<Request, Promise<void>>();
  /** By session, oldest first, which is the order a Map keeps. */
  const pageChecks = new Map<
    string,
    { until: number; answer: Promise<ShopifyAnswer> }
  >();

  /**
   * A row the key cannot open ends that sign-in. Any other failure is an outage, and
   * must not read as "signed out" and send the person off to sign in during it.
   */
  const readable = (loading: Promise<Session | undefined>) =>
    loading.catch((error: unknown) => {
      if (error instanceof UnreadableSessionError) return undefined;
      throw error;
    });

  async function sessionIdFor(request: Request, shop: string) {
    const id: unknown = await sessionCookie(shop).parse(
      request.headers.get("Cookie"),
    );
    return typeof id === "string" && id ? id : null;
  }

  /**
   * This browser's session for a store. The row has to exist, so an uninstall ends it,
   * has to be this store's, and has to name a person, so the worker's offline session
   * is never a way in. Another store's session is no business of this request.
   */
  async function sessionFor(request: Request, shop: string) {
    const id = await sessionIdFor(request, shop);
    if (!id) return undefined;
    const stored = await readable(sessionStorage.loadSession(id));
    return stored?.shop === shop &&
      stored.isActive(api.config.scopes) &&
      isPerson(stored)
      ? stored
      : undefined;
  }

  async function remembered(request: Request) {
    const value: unknown = await rememberedCookie.parse(
      request.headers.get("Cookie"),
    );
    if (!Array.isArray(value)) return [];
    return value
      .map(validShop)
      .filter((shop): shop is string => !!shop)
      .slice(0, MAX_REMEMBERED);
  }

  /** The stores this browser holds a genuine session cookie for, latest first. */
  async function storesHeld(request: Request) {
    const prefix = `${SESSION_COOKIE}.`;
    const named = [...cookiesIn(request).keys()]
      .filter((name) => name.startsWith(prefix))
      .map((name) => validShop(name.slice(prefix.length)))
      .filter((shop): shop is string => !!shop);
    const held: string[] = [];
    for (const shop of new Set([...(await remembered(request)), ...named]))
      if (await sessionIdFor(request, shop)) held.push(shop);
    return held;
  }

  async function latestLiveStore(request: Request) {
    for (const shop of await storesHeld(request))
      if (await sessionFor(request, shop)) return shop;
    return null;
  }

  /** Only the stored facts: a token that is gone, narrowed or past refreshing. */
  async function offlineTokenUsable(shop: string) {
    const offline = await readable(
      sessionStorage.loadSession(api.session.getOfflineId(shop)),
    );
    if (!offline?.accessToken || offline.isScopeChanged(api.config.scopes))
      return false;
    if (!offline.isExpired()) return true;
    return (
      !!offline.refreshToken &&
      (!offline.refreshTokenExpires || offline.refreshTokenExpires > new Date())
    );
  }

  /**
   * Stored facts cannot show a token Shopify has retired, and a new grant from any
   * server sharing this app retires the old refresh token at once. Only called once
   * Shopify has vouched for the request. Only a refusal counts: anything else is
   * not worth a new grant, which would retire whatever the worker holds right now.
   */
  async function offlineAccessAlive(shop: string) {
    try {
      await shopifyRequest(shop, INSTALLATION_CHECK_QUERY);
      return true;
    } catch (error) {
      return !(
        error instanceof SyncError &&
        ["AUTH_FAILURE", "UNINSTALLED"].includes(error.code)
      );
    }
  }

  /**
   * Starts as the same request for every store: an anonymous visitor sees this
   * redirect, and what the app holds for a store is no business of theirs. Whether
   * the store also needs an offline token is decided in the callback, once Shopify
   * has signed the way back. The library's state cookie gets the store in its name,
   * so that a sign-in to another store at the same moment cannot overwrite it.
   */
  async function begin(
    request: Request,
    shop: string,
    returnTo: string,
    step: SignInStep = "online",
  ) {
    if (!api.config.scopes?.toArray().length)
      throw new Error("Configure SCOPES so sign-in can ask for them.");
    const started = (await api.auth.begin({
      shop,
      callbackPath: CALLBACK_PATH,
      isOnline: step === "online",
      rawRequest: request,
    })) as Response;
    // A crawler is told to go away by the library, with nothing to carry on with.
    const location = started.headers.get("Location");
    if (!location) return started;
    const headers = new Headers({
      Location: location,
      "Cache-Control": "no-store",
    });
    const until = new Date(
      Date.now() + SIGN_IN_WINDOW_SECONDS * 1000,
    ).toUTCString();
    for (const cookie of started.headers.getSetCookie())
      headers.append(
        "Set-Cookie",
        cookie
          .replace(STATE_COOKIE_NAME, stateCookieName(shop))
          .replace(/expires=[^;]*/i, `expires=${until}`),
      );
    headers.append(
      "Set-Cookie",
      await flowCookie(shop).serialize({
        shop,
        returnTo,
        step,
      } satisfies SignInFlow),
    );
    return new Response(null, { status: 302, headers });
  }

  function refuse(
    problem: SignInProblem,
    status: number,
    shop?: string | null,
    cause?: Record<string, unknown>,
  ) {
    logger.warn(
      { problem, shop: shop ?? undefined, ...cause },
      "Sign-in refused",
    );
    return data({ problem: SIGN_IN_PROBLEMS[problem] }, { status });
  }

  /** Given the whole query: a repeated shop then fails rather than choosing. */
  async function signedByShopify(params: URLSearchParams) {
    try {
      return await api.utils.validateHmac(
        params as unknown as Parameters<Shopify["utils"]["validateHmac"]>[0],
      );
    } catch (error) {
      if (!(error instanceof ShopifyError)) throw error;
      return false;
    }
  }

  /**
   * Of two sign-ins to one store running at once, only the last to begin can finish.
   * Nothing is spent here and its cookies are left for it. When this browser is
   * already signed in to that store, the other tab did the work: nothing to report.
   */
  async function overlapped(
    request: Request,
    shop: string,
    problem: SignInProblem,
  ) {
    if (await sessionFor(request, shop))
      return redirect(storePath(DEFAULT_RETURN, shop), {
        headers: { "Cache-Control": "no-store" },
      });
    return refuse(problem, 400, shop);
  }

  /**
   * Spends the code. The library knows one state cookie by one name, so it is shown
   * this store's under that name, and nothing else this browser holds.
   */
  async function exchange(request: Request, shop: string) {
    const held = cookiesIn(request);
    const state = held.get(stateCookieName(shop));
    const signature = held.get(`${stateCookieName(shop)}.sig`);
    const headers = new Headers(request.headers);
    headers.delete("Cookie");
    if (state && signature)
      headers.set(
        "Cookie",
        `${STATE_COOKIE_NAME}=${state}; ${STATE_COOKIE_NAME}.sig=${signature}`,
      );
    try {
      return await withDeadline(
        api.auth.callback({
          rawRequest: new Request(request.url, { headers }),
          expiring: true,
        }),
        TOKEN_DEADLINE_MS,
      );
    } catch (error) {
      if (error instanceof BotActivityDetected) return refuse("INVALID", 410);
      if (error instanceof CookieNotFound)
        return overlapped(request, shop, "EXPIRED");
      // The library says this for a bad signature and for a state that is not the
      // cookie's. With Shopify's signature on it, the cookie has moved on.
      if (error instanceof InvalidOAuthError)
        return (await signedByShopify(new URL(request.url).searchParams))
          ? overlapped(request, shop, "SUPERSEDED")
          : refuse("INVALID", 400, shop);
      if (
        error instanceof InvalidHmacError ||
        error instanceof InvalidShopError
      )
        return refuse("INVALID", 400, shop);
      // Shopify refused the code, failed or could not be reached: nothing else
      // happens in here. Its body can name what it was sent, so it stays out.
      return refuse("EXCHANGE_FAILED", 502, shop, {
        failure: error instanceof Error ? error.constructor.name : typeof error,
        status: shopifyFailureStatus(error),
      });
    }
  }

  /**
   * Spends the code and keeps the token it bought, or says why not. The caller holds
   * the token lock when this was to be an offline grant.
   */
  async function receiveGrant(
    request: Request,
    shop: string,
    flow: SignInFlow,
  ) {
    const exchanged = await exchange(request, shop);
    if (!("session" in exchanged)) return exchanged;
    const { session } = exchanged;
    // Shopify lets a person approve less than was asked for.
    const everyScope = session.isScopeIncluded(api.config.scopes ?? "");
    if (
      session.shop !== shop ||
      session.isOnline !== (flow.step === "online") ||
      (session.isOnline && !isPerson(session))
    ) {
      // Per-user taken out of the URL, say. Shopify has now retired the token the
      // worker holds in favour of this one, so this is the one that works. An
      // answer with no refresh token is not an expiring offline token at all. Only a
      // person's trip, which holds no lock, gets here with one, and a refresh still
      // in flight must not store its answer over this afterwards. It is kept even if
      // that wait comes to nothing, since the old token is already gone.
      if (
        session.shop === shop &&
        !session.isOnline &&
        session.refreshToken &&
        everyScope
      )
        await withOfflineTokenLock(shop, () =>
          sessionStorage.storeSession(session),
        ).catch(() => sessionStorage.storeSession(session));
      return refuse("UNEXPECTED_TOKEN", 400, shop);
    }
    if (!everyScope) return refuse("SCOPES_NOT_GRANTED", 403, shop);
    await sessionStorage.storeSession(session);
    return { session };
  }

  type Received = Awaited<ReturnType<typeof receiveGrant>>;
  /**
   * An offline grant retires what the worker holds as it happens, so it waits for a
   * refresh and a refresh waits for it. Only a wait that never got the lock leaves the
   * code unspent, and only that is answered with "sign in again". Once the lock is
   * held, what the grant came to stands even if the transaction then ends badly, which
   * undoes nothing that was stored, and a failure inside the grant is thrown.
   */
  async function receiveOfflineGrant(
    request: Request,
    shop: string,
    flow: SignInFlow,
  ) {
    const attempt: { locked?: boolean; received?: Received } = {};
    try {
      return await withOfflineTokenLock(shop, async () => {
        attempt.locked = true;
        attempt.received = await receiveGrant(request, shop, flow);
        return attempt.received;
      });
    } catch (error) {
      if (attempt.received) return attempt.received;
      if (attempt.locked) throw error;
      return refuse("TOKEN_BUSY", 503, shop, {
        failure: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }

  /** Bookkeeping for a person Shopify just named, and the end of this browser's last session here. */
  async function afterOnlineGrant(request: Request, session: Session) {
    const actor = requireActor({ session });
    await ensureInstallation(actor);
    await recordSignedVisit(session.shop);
    // The only moment Shopify says what this person is now, if it does say. A grant
    // that leaves it out signs them in as staff, which is safe for what this session
    // may do, and is no reason to undo anything: ending an owner cannot be reversed.
    const said = session.onlineAccessInfo?.associated_user?.account_owner;
    if (said === false) await endFormerOwnerAuthority(actor.shop, actor.userId);
    const previous = await sessionIdFor(request, session.shop);
    await prisma.session.deleteMany({
      where: {
        isOnline: true,
        shop: session.shop,
        id: { not: session.id },
        OR: [
          ...(previous ? [{ id: previous }] : []),
          { expires: { lt: new Date() } },
          // Their sign-ins elsewhere stay, unless those now say something untrue.
          ...(typeof said === "boolean"
            ? [{ userId: BigInt(actor.userId), accountOwner: !said }]
            : []),
        ],
      },
    });
  }

  /**
   * Everything about an action that needs no call to Shopify. It runs on the store its
   * own address names, which is the store its tab was showing, and on this browser's
   * session for that store and no other: without both, there is nothing to run it on.
   */
  async function checkAction(request: Request): Promise<AdminContext> {
    assertSameOrigin(request, appOrigin);
    const named = namedStore(new URL(request.url));
    if (!named) {
      logger.warn("Action refused: its address names no store");
      throw refused(400, { storeMissing: true });
    }
    const session = await sessionFor(request, named);
    if (!session) throw refused(401, { signIn: true, shop: named });
    return { session };
  }

  /**
   * A page with no store in its address is a bookmark or someone typing it: it opens
   * on the store this browser was last signed in to, and from then on says so. One
   * naming a store it has no session for goes through sign-in for that store.
   */
  async function checkPage(request: Request): Promise<AdminContext> {
    const url = new URL(request.url);
    const named = namedStore(url);
    if (named) {
      const session = await sessionFor(request, named);
      if (session) return { session };
      // A whole-page load: the browser leaves for Shopify, and fetch could not follow.
      throw redirectDocument(signInPath(named, url));
    }
    const live = await latestLiveStore(request);
    if (live)
      throw redirectDocument(
        storePath(safeReturnPath(`${url.pathname}${url.search}`), live),
      );
    const [last] = await remembered(request);
    throw redirectDocument(signInPath(last, url));
  }

  /**
   * Only a 401 says the token is dead. No other answer proves anything: on the Admin
   * API a 403 means the store was marked fraudulent, a 402 frozen and a 423 locked,
   * none of which a new sign-in mends, and an ACCESS_DENIED is not a read that worked.
   */
  async function askShopify(
    session: Session,
    deadlineMs: number,
  ): Promise<ShopifyAnswer> {
    try {
      const client = new api.clients.Graphql({ session });
      const answer = await client.request<{ shop?: { id?: string } }>(
        SESSION_CHECK_QUERY,
        { signal: AbortSignal.timeout(deadlineMs) },
      );
      return answer.data?.shop?.id ? "live" : "unavailable";
    } catch (error) {
      return shopifyFailureStatus(error) === 401 ? "refused" : "unavailable";
    }
  }

  /** What a refusal ends: this session and its cookie, and no other store's. */
  async function endRefusedSession(session: Session) {
    await prisma.session.deleteMany({
      where: { id: session.id, isOnline: true },
    });
    return {
      "Set-Cookie": await sessionCookie(session.shop).serialize("", {
        maxAge: 0,
      }),
    };
  }

  async function prove(session: Session) {
    const answer = await askShopify(session, SESSION_CHECK_DEADLINE_MS);
    if (answer === "live") return;
    logger.warn(
      { shop: session.shop, answer },
      "Action stopped: Shopify did not confirm the sign-in",
    );
    if (answer === "unavailable")
      throw refused(503, { tryAgain: true }, { "Retry-After": "10" });
    throw refused(
      401,
      { signIn: true, shop: session.shop },
      await endRefusedSession(session),
    );
  }

  function recordPageCheck(id: string, answer: Promise<ShopifyAnswer>) {
    const check = { until: Date.now() + PAGE_CHECK_WINDOW_MS, answer };
    pageChecks.delete(id);
    pageChecks.set(id, check);
    for (const oldest of pageChecks.keys()) {
      if (pageChecks.size <= PAGE_CHECK_RECORDS) break;
      pageChecks.delete(oldest);
    }
    return check;
  }

  /**
   * Logging out of the admin ends a person's reading too, within minutes, but a page
   * must never pay for that: it waits on Shopify briefly, once in the window, and every
   * answer but a 401 lets it through and holds for the window, so a slow Shopify costs
   * one navigation. A page load runs its loaders at once, and another tab may be
   * loading too: all of them share this session's question while it is still out.
   */
  async function checkPageLive(request: Request, session: Session) {
    const known = pageChecks.get(session.id);
    const check =
      known && known.until > Date.now()
        ? known
        : recordPageCheck(
            session.id,
            askShopify(session, PAGE_CHECK_DEADLINE_MS),
          );
    if ((await check.answer) !== "refused") return;
    logger.warn(
      { shop: session.shop, answer: "refused" },
      "Page stopped: Shopify no longer accepts the sign-in",
    );
    throw redirectDocument(signInPath(session.shop, new URL(request.url)), {
      headers: {
        "Cache-Control": "no-store",
        ...(await endRefusedSession(session)),
      },
    });
  }

  return {
    /**
     * Replaces the library's strategy, which only knows Shopify's session tokens.
     * Every loader and action of the dashboard comes through here first, which is
     * what makes the checks on a state-changing request impossible to forget.
     */
    authenticate(request: Request): Promise<AdminContext> {
      if (!changesState(request)) return checkPage(request);
      let checked = actionsChecked.get(request);
      if (!checked) {
        checked = checkAction(request);
        actionsChecked.set(request, checked);
      }
      return checked;
    },

    /**
     * The row says who signed in, and only Shopify can say that still holds: logging
     * out of the admin revokes a person's online tokens, and nothing tells this app.
     * So a state-changing request runs only once their own token has just worked, and
     * asks at most once for a request, however often it is called. A page asks far
     * less, and only a refusal stops it: see checkPageLive.
     */
    proveLive(request: Request, session: Session): Promise<void> {
      if (!changesState(request)) return checkPageLive(request, session);
      let proof = proofs.get(request);
      if (!proof) {
        proof = prove(session);
        proofs.set(request, proof);
      }
      return proof;
    },

    /** The stores to offer next to this one. A cookie is enough: signing in checks the rest. */
    async otherStores(request: Request, current: string) {
      return (await storesHeld(request)).filter((shop) => shop !== current);
    },

    /**
     * application_url. Shopify opens it with signed parameters from the Apps list
     * and after an install; a person can also just open it. A signature names a
     * store and never a person, so whoever is at that admin now is asked for even
     * when this browser has a session: it may be someone else's.
     */
    async entry(request: Request) {
      const params = new URL(request.url).searchParams;
      if (!params.has("hmac")) {
        const asked = params.get("shop");
        if (asked)
          throw redirect(
            `${LOGIN_PATH}?${new URLSearchParams({ shop: asked })}`,
          );
        const live = await latestLiveStore(request);
        if (live) throw redirect(storePath(DEFAULT_RETURN, live));
        return null;
      }
      const shop = validShop(params.get("shop"));
      if (!shop || !(await signedByShopify(params))) {
        logger.warn({ shop: shop ?? undefined }, "Signed app load refused");
        return data(
          {
            problem:
              "This link from Shopify could not be verified or has expired. Enter your store domain, or open SyncPilot from your Shopify admin again.",
          },
          { status: 400 },
        );
      }
      await recordSignedVisit(shop);
      throw await begin(request, shop, DEFAULT_RETURN);
    },

    /**
     * The form, and links carrying a shop. Answers as the library's login did: the
     * failure as a value, the redirect thrown. `fields` is the bounded form body.
     */
    async login(request: Request, fields?: URLSearchParams) {
      const url = new URL(request.url);
      // What was typed comes first: the form posts back to a URL that may name a
      // shop already, and that one may be why the person is looking at the form.
      const typed = fields?.get("shop") || url.searchParams.get("shop");
      if (!typed)
        return changesState(request)
          ? { shop: LoginErrorType.MissingShop }
          : { signedIn: await storesHeld(request) };
      const domain = typed
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");
      const shop = validShop(
        api.utils.sanitizeShop(
          domain.includes(".") ? domain : `${domain}.myshopify.com`,
        ),
      );
      if (!shop) return { shop: LoginErrorType.InvalidShop, typed };
      const returnTo = safeReturnPath(
        fields?.get("return_to") ?? url.searchParams.get("return_to"),
      );
      // Any site can link here, so a request alone starts a sign-in only to a store
      // this browser has already been signed in to, and not when another site sent it:
      // that is a lapsed page coming back. For anything else the person says so on a
      // page of this app, and that post is checked to be same-origin before this runs.
      // The question looks the same whichever store it names.
      if (!changesState(request)) {
        if (await sessionFor(request, shop))
          throw redirect(storePath(returnTo, shop), {
            headers: { "Cache-Control": "no-store" },
          });
        const sentBy = request.headers.get("Sec-Fetch-Site");
        if (
          sentBy === "cross-site" ||
          sentBy === "same-site" ||
          !(await remembered(request)).includes(shop)
        )
          return { confirming: shop };
      }
      throw await begin(request, shop, returnTo);
    },

    /**
     * Shopify's redirect back. The library checks the state cookie and the HMAC and
     * exchanges the code. A request is one grant, so a person's online token and an
     * offline token take two trips: offline only when the shop has no usable one.
     */
    async callback(request: Request) {
      const url = new URL(request.url);
      // The library validates one copy of a repeated parameter and uses the other.
      const names = [...url.searchParams.keys()];
      if (new Set(names).size !== names.length) return refuse("INVALID", 400);
      const shop = validShop(url.searchParams.get("shop"));
      if (!shop) return refuse("INVALID", 400);
      const flow = (await flowCookie(shop).parse(
        request.headers.get("Cookie"),
      )) as SignInFlow | null;
      if (flow?.shop !== shop) return overlapped(request, shop, "EXPIRED");
      // A person's own token retires nothing that Shopify documents, so only the
      // offline grant takes the token lock. Nothing below runs under it, since
      // offlineAccessAlive wants it.
      const received =
        flow.step === "repair"
          ? await receiveOfflineGrant(request, shop, flow)
          : await receiveGrant(request, shop, flow);
      if (!("session" in received)) return received;
      const { session } = received;

      const returnTo = safeReturnPath(flow.returnTo);
      const cookies: string[] = [];
      if (flow.step === "online") {
        // Shopify has only just said this token works, so the first page need not ask.
        recordPageCheck(session.id, Promise.resolve("live"));
        await afterOnlineGrant(request, session);
        // This app's own cookies and none of the library's: an offline grant's session
        // must never reach a browser, and its one name could only hold one store.
        cookies.push(
          await sessionCookie(shop).serialize(session.id, {
            expires: session.expires,
          }),
          await rememberedCookie.serialize(
            [
              shop,
              ...(await remembered(request)).filter((known) => known !== shop),
            ].slice(0, MAX_REMEMBERED),
          ),
        );
        if (
          !(await offlineTokenUsable(shop)) ||
          !(await offlineAccessAlive(shop))
        ) {
          const repair = await begin(request, shop, returnTo, "repair");
          for (const cookie of cookies)
            repair.headers.append("Set-Cookie", cookie);
          return repair;
        }
      }
      for (const name of [
        stateCookieName(shop),
        `${stateCookieName(shop)}.sig`,
      ])
        cookies.push(expired(name, CALLBACK_PATH));
      cookies.push(await flowCookie(shop).serialize("", { maxAge: 0 }));
      const headers = new Headers({
        Location: storePath(returnTo, shop),
        "Cache-Control": "no-store",
      });
      for (const cookie of cookies) headers.append("Set-Cookie", cookie);
      logger.info({ shop, step: flow.step }, "Sign-in completed");
      return new Response(null, { status: 302, headers });
    },

    /**
     * Ends the session of the store it names, and forgets that store too, or the next
     * page would sign straight back in. The other stores stay signed in, and the page
     * this lands on says so. Naming no store ends them all.
     */
    async logout(request: Request) {
      assertSameOrigin(request, appOrigin);
      const named = namedStore(new URL(request.url));
      const headers = new Headers({
        Location: LOGIN_PATH,
        "Cache-Control": "no-store",
      });
      for (const shop of named ? [named] : await storesHeld(request)) {
        const id = await sessionIdFor(request, shop);
        if (id)
          await prisma.session.deleteMany({
            where: { id, shop, isOnline: true },
          });
        headers.append(
          "Set-Cookie",
          await sessionCookie(shop).serialize("", { maxAge: 0 }),
        );
      }
      const kept = named
        ? (await remembered(request)).filter((shop) => shop !== named)
        : [];
      headers.append(
        "Set-Cookie",
        kept.length
          ? await rememberedCookie.serialize(kept)
          : await rememberedCookie.serialize("", { maxAge: 0 }),
      );
      return new Response(null, { status: 302, headers });
    },
  };
}
