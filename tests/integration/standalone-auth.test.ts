import { createHmac, randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import type { Prisma } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createCookie } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The real routes, the real Shopify library and PostgreSQL run here. Only outbound
// fetch is replaced, and it refuses anything that is not a synthetic Shopify call.
const stub = vi.hoisted(() => {
  process.env.SHOPIFY_API_KEY = "synthetic-auth-key";
  process.env.SHOPIFY_API_SECRET = "synthetic-auth-secret";
  process.env.SHOPIFY_APP_URL = "https://app.example.invalid";
  process.env.SCOPES =
    "read_products,write_products,read_inventory,write_inventory,read_locations";
  process.env.LOG_LEVEL = "silent";
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const state = {
    json,
    grants: new Map<string, unknown>(),
    tokenEndpointDown: false,
    tokenEndpointHangs: false,
    tokenRequests: [] as Record<string, string>[],
    outbound: [] as { url: string; token: string | null }[],
    refresh: (() => json({ error: "invalid_request" }, 401)) as (
      body: Record<string, string>,
      shop: string,
    ) => Response | Promise<Response>,
    /** What Shopify does with a code, before it answers for it. */
    exchanging: (() => undefined) as () => void | Promise<void>,
    graphql: (() => json({ data: {} })) as (
      shop: string,
      token: string | null,
      init?: RequestInit,
    ) => Response | Promise<Response>,
  };
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const target = new URL(String(url));
    state.outbound.push({
      url: target.href,
      token: new Headers(init?.headers).get("X-Shopify-Access-Token"),
    });
    if (target.pathname === "/admin/oauth/access_token") {
      if (state.tokenEndpointDown) throw new TypeError("fetch failed");
      if (state.tokenEndpointHangs)
        return new Promise<Response>(() => undefined);
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      state.tokenRequests.push(body);
      if (body.refresh_token) return state.refresh(body, target.hostname);
      await state.exchanging();
      const grant = state.grants.get(body.code);
      return grant ? json(grant) : json({ error: "invalid_request" }, 400);
    }
    if (target.pathname.endsWith("/graphql.json"))
      return state.graphql(
        target.hostname,
        new Headers(init?.headers).get("X-Shopify-Access-Token"),
        init,
      );
    throw new Error(`Unexpected outbound request to ${target.origin}`);
  }) as typeof fetch;
  return state;
});

import prisma from "../../app/db.server";
import {
  addDocumentResponseHeaders,
  sessionStorage,
} from "../../app/shopify.server";
import {
  requireActor,
  requireOperator,
  requireWorkspace,
} from "../../app/services/authorization.server";
import type { Actor } from "../../app/services/authorization.server";
import {
  acceptPairing,
  confirmPairing,
  ensureInstallation,
  initiatePairing,
} from "../../app/services/control-plane.server";
import { logger } from "../../app/services/logger.server";
import {
  RATE_LIMITS,
  rateLimitKey,
} from "../../app/services/rate-limit.server";
import { cleanLapsedSignIns } from "../../app/services/retention.server";
import { assertJobConsent } from "../../app/services/automatic-sync.server";
import {
  offlineExecutor,
  shopifyRequest,
  TOKEN_DEADLINE_MS,
} from "../../app/services/shopify-client.server";
import { SESSION_CHECK_DEADLINE_MS } from "../../app/services/admin-auth.server";
import { cookieSigningKey } from "../../app/services/token-crypto.server";
import { runWorkerOnce } from "../../app/services/sync-engine.server";
import { storePath } from "../../app/domain/store-binding";
import { INSTALLATION_CHECK_QUERY } from "../../app/domain/sync-operations";
import { restoreProcessClock, skewProcessClock } from "./clock-skew";

const SECRET = "synthetic-auth-secret";
const ORIGIN = "https://app.example.invalid";
const ALL_SCOPES = process.env.SCOPES!;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
/** A method that is not GET or HEAD reaches a route's action. */
const STATE_CHANGING = ["POST", "PUT", "PATCH", "DELETE"];
const SESSION_PREFIX = "syncpilot_session.";
const sessionCookieName = (shop: string) => `${SESSION_PREFIX}${shop}`;
const flowCookieName = (shop: string) => `syncpilot_sign_in.${shop}`;
const stateCookieName = (shop: string) => `shopify_app_state.${shop}`;
/** One of the app's own signed cookies, for the tests that hold its key. */
const appCookie = (name: string, options: { path?: string } = {}) =>
  createCookie(name, { secrets: [cookieSigningKey()!], ...options });
const flowCookie = (shop: string) =>
  appCookie(flowCookieName(shop), { path: "/auth/callback" });
/** Where a sign-in to this store lands by default, or on this page. */
const dashboard = (shop: string, page = "/app") => storePath(page, shop);

type Route = (args: LoaderFunctionArgs & ActionFunctionArgs) => unknown;
type Outcome = {
  status: number;
  location: string | null;
  setCookies: string[];
  data?: unknown;
  retryAfter?: string | null;
  /** A whole-page load, which is the only way a browser can leave for Shopify. */
  reloadsDocument?: boolean;
};
/** A grant can say nothing about who owns the store, which is not saying "not them". */
type User = { id: number; account_owner?: boolean } | null;
let index: Route,
  login: Route,
  loginForm: Route,
  callback: Route,
  logout: Route;
let layout: Route,
  stores: Route,
  storesPage: Route,
  uninstalled: Route,
  scopesUpdate: Route;

/** What the HTTP layer would send: a returned or a thrown Response, or data(). */
async function run(route: Route, request: Request): Promise<Outcome> {
  let result: unknown;
  try {
    result = await route({
      request,
      params: {},
      context: {},
      url: new URL(request.url),
      pattern: new URL(request.url).pathname,
    } as unknown as LoaderFunctionArgs & ActionFunctionArgs);
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    result = thrown;
  }
  if (result instanceof Response)
    return {
      status: result.status,
      location: result.headers.get("Location"),
      setCookies: result.headers.getSetCookie(),
      data: (result.headers.get("Content-Type") ?? "").includes("json")
        ? await result.clone().json()
        : await result.clone().text(),
      retryAfter: result.headers.get("Retry-After"),
      reloadsDocument: result.headers.has("X-Remix-Reload-Document"),
    };
  const shaped = result as {
    type?: string;
    data?: unknown;
    init?: ResponseInit;
  };
  if (shaped?.type === "DataWithResponseInit")
    return {
      status: shaped.init?.status ?? 200,
      location: null,
      setCookies: [],
      data: shaped.data,
    };
  return { status: 200, location: null, setCookies: [], data: result };
}

type StoredCookie = { value: string; path: string; until: number };
/** One name can hold a cookie per path. A test asking by name gets the first. */
class CookieJar {
  private cookies: (StoredCookie & { name: string })[] = [];
  has(name: string) {
    return this.cookies.some((cookie) => cookie.name === name);
  }
  /** Whether this browser holds a session for any store at all. */
  hasSession() {
    return this.cookies.some(({ name }) => name.startsWith(SESSION_PREFIX));
  }
  get(name: string) {
    return this.cookies.find((cookie) => cookie.name === name);
  }
  /** The browser dropping it, whatever its path. */
  delete(name: string) {
    this.cookies = this.cookies.filter((cookie) => cookie.name !== name);
  }
  set(name: string, cookie: StoredCookie) {
    this.remove(name, cookie.path);
    this.cookies.push({ name, ...cookie });
  }
  /** What an expiring Set-Cookie does: it reaches only the same name and path. */
  remove(name: string, path: string) {
    this.cookies = this.cookies.filter(
      (cookie) => cookie.name !== name || cookie.path !== path,
    );
  }
  *[Symbol.iterator]() {
    for (const cookie of this.cookies) yield [cookie.name, cookie] as const;
  }
}
const pathMatches = (pathname: string, scope: string) =>
  scope === "/" || pathname === scope || pathname.startsWith(`${scope}/`);

/** Keeps cookies the way a browser would: by name and path, until they expire. */
class Browser {
  jar = new CookieJar();
  /** The store the latest tab is on, which its dashboard addresses go on to name. */
  showing?: string;
  absorb(lines: string[]) {
    for (const line of lines) {
      const [pair, ...attributes] = line.split(";");
      const equals = pair.indexOf("=");
      const name = pair.slice(0, equals).trim();
      const options = Object.fromEntries(
        attributes.map((attribute) => {
          const [key, ...value] = attribute.trim().split("=");
          return [key.toLowerCase(), value.join("=")];
        }),
      );
      const until =
        options["max-age"] !== undefined
          ? Date.now() + Number(options["max-age"]) * 1000
          : options.expires
            ? new Date(options.expires).getTime()
            : Infinity;
      const path = options.path || "/";
      if (until <= Date.now()) this.jar.remove(name, path);
      else
        this.jar.set(name, {
          value: pair.slice(equals + 1).trim(),
          path,
          until,
        });
    }
  }
  /** Exactly this address, as someone typing it or following a link would ask. */
  raw(path: string, init: RequestInit = {}) {
    const url = new URL(path, ORIGIN);
    const cookie = [...this.jar]
      .filter(([, { path: scope, until }]) => {
        return until > Date.now() && pathMatches(url.pathname, scope);
      })
      .map(([name, { value }]) => `${name}=${value}`)
      .join("; ");
    const headers = new Headers(init.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", BROWSER);
    if (cookie) headers.set("Cookie", cookie);
    return new Request(url, { ...init, headers });
  }
  /** What the latest tab asks for: an address in the dashboard names its store. */
  request(path: string, init: RequestInit = {}) {
    return this.raw(
      new URL(path, ORIGIN).searchParams.has("shop")
        ? path
        : storePath(path, this.showing),
      init,
    );
  }
  async visit(route: Route, path: string, init: RequestInit = {}) {
    const outcome = await run(route, this.request(path, init));
    this.absorb(outcome.setCookies);
    return outcome;
  }
  /** A same-origin form post, as a browser sends it. */
  post(route: Route, path: string, body: string, headers: HeadersInit = {}) {
    return this.visit(route, path, {
      method: "POST",
      headers: { ...FORM, Origin: ORIGIN, ...headers },
      body,
    });
  }
}

const shopName = (label = "auth") =>
  `${label}-${randomUUID().slice(0, 8)}.myshopify.com`;
const OWNER: User = { id: 101, account_owner: true };
const STAFF: User = { id: 202, account_owner: false };
const offlineGrant = (scope = ALL_SCOPES) => ({
  access_token: `shpat_${randomUUID().replaceAll("-", "")}`,
  scope,
  expires_in: 3600,
  refresh_token: `shprt_${randomUUID().replaceAll("-", "")}`,
  refresh_token_expires_in: 7_776_000,
});
const onlineGrant = (user: User, scope = ALL_SCOPES) => ({
  access_token: `shpua_${randomUUID().replaceAll("-", "")}`,
  scope,
  expires_in: 86_399,
  associated_user_scope: scope,
  ...(user
    ? {
        associated_user: {
          ...user,
          first_name: "Synthetic",
          last_name: "Person",
          email: "fixture@example.invalid",
          email_verified: true,
          locale: "en",
          collaborator: false,
        },
      }
    : {}),
});
/** Signs a query the way Shopify documents: sorted, encoded, hex HMAC-SHA256. */
function signedQuery(params: Record<string, string>, secret = SECRET) {
  const query = new URLSearchParams(
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
  );
  query.set(
    "hmac",
    createHmac("sha256", secret).update(query.toString()).digest("hex"),
  );
  return query;
}
const now = () => String(Math.trunc(Date.now() / 1000));
/** Where Shopify sends the browser back after approving this authorize URL. */
function shopifyCallback(
  authorize: URL,
  code: string,
  extra: Record<string, string> = {},
) {
  return `/auth/callback?${signedQuery({
    code,
    host: Buffer.from(`${authorize.hostname}/admin`).toString("base64url"),
    shop: authorize.hostname,
    state: authorize.searchParams.get("state") ?? "",
    timestamp: now(),
    ...extra,
  })}`;
}
const authorizeUrl = (outcome: Outcome) => {
  expect(outcome.status).toBe(302);
  const url = new URL(outcome.location!);
  expect(url.pathname).toBe("/admin/oauth/authorize");
  return url;
};
const isOnlineAsk = (url: URL) =>
  url.searchParams.get("grant_options[]") === "per-user";
/** Plays Shopify until it sends the browser back to the app for good. */
async function atShopify(browser: Browser, start: Outcome, user: User = OWNER) {
  const trips: string[] = [];
  const grants: ReturnType<typeof offlineGrant>[] = [];
  let step = start;
  while (step.location?.includes("/admin/oauth/authorize")) {
    const authorize = new URL(step.location);
    const online = isOnlineAsk(authorize);
    trips.push(online ? "online" : "offline");
    const code = `code-${randomUUID()}`;
    const grant = online ? onlineGrant(user) : offlineGrant();
    stub.grants.set(code, grant);
    grants.push(grant as ReturnType<typeof offlineGrant>);
    step = await browser.visit(callback, shopifyCallback(authorize, code));
  }
  // Landing on the dashboard: this tab now shows the store it asked for.
  if (trips.length && step.location?.startsWith("/app"))
    browser.showing = new URL(start.location!).hostname;
  return { final: step, trips, grants };
}
/** The person chose this store on one of the app's own pages. */
const startSignIn = (browser: Browser, shop: string, returnTo?: string) =>
  browser.post(
    loginForm,
    "/auth/login",
    new URLSearchParams({
      shop,
      ...(returnTo ? { return_to: returnTo } : {}),
    }).toString(),
  );
/** Any link, from anywhere, to the page that starts a sign-in. */
const linkTo = (browser: Browser, shop: string, returnTo?: string) =>
  browser.visit(
    login,
    `/auth/login?${new URLSearchParams({
      shop,
      ...(returnTo ? { return_to: returnTo } : {}),
    })}`,
  );
async function signIn(
  shop = shopName(),
  user: User = OWNER,
  browser = new Browser(),
) {
  const flow = await atShopify(browser, await startSignIn(browser, shop), user);
  expect(flow.final).toMatchObject({
    status: 302,
    location: dashboard(shop),
  });
  return { shop, browser, ...flow };
}
/** A delivery triggered "now" must not race the clock that dated this installation. */
const installedLongAgo = (shop: string) =>
  prisma.shopConnection.update({
    where: { shopDomain: shop },
    data: {
      installedAt: new Date(Date.now() - 48 * HOUR),
      lastSeenAt: new Date(Date.now() - 24 * HOUR),
    },
  });
/** The row id inside a session cookie, which holds nothing else. */
const sessionId = (browser: Browser, shop = browser.showing!) => {
  const cookie = browser.jar.get(sessionCookieName(shop));
  return cookie
    ? (JSON.parse(
        atob(decodeURIComponent(cookie.value).split(".")[0]),
      ) as string)
    : "";
};
const expireOnline = (browser: Browser, shop = browser.showing!) =>
  prisma.session.update({
    where: { id: sessionId(browser, shop) },
    data: { expires: new Date(Date.now() - 60_000) },
  });
const deliver = (
  route: Route,
  path: string,
  topic: string,
  shop: string,
  body: unknown,
  triggeredAt = new Date(),
) => {
  const raw = JSON.stringify(body);
  return run(
    route,
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Shop-Domain": shop,
        "X-Shopify-Topic": topic,
        "X-Shopify-Webhook-Id": randomUUID(),
        "X-Shopify-API-Version": "2026-10",
        "X-Shopify-Triggered-At": triggeredAt.toISOString(),
        "X-Shopify-Event-Id": randomUUID(),
        "X-Shopify-Hmac-Sha256": createHmac("sha256", SECRET)
          .update(raw)
          .digest("base64"),
      },
      body: raw,
    }),
  );
};
const uninstall = (shop: string, triggeredAt?: Date) =>
  deliver(
    uninstalled,
    "/webhooks/app/uninstalled",
    "app/uninstalled",
    shop,
    { id: 1, domain: shop, myshopify_domain: shop },
    triggeredAt,
  );
const connection = (shop: string) =>
  prisma.shopConnection.findUnique({ where: { shopDomain: shop } });
const pairingsFrom = (shop: string) =>
  prisma.storePairingRequest.count({ where: { initiatingShop: shop } });
const initiate = (destination: string) =>
  new URLSearchParams({
    intent: "initiate",
    destinationShop: destination,
    organizationConfirmed: "on",
  }).toString();
async function pairedWorkspace(a: string, b: string) {
  const first: Actor = { shop: a, userId: "101", role: "OWNER" };
  const second: Actor = { shop: b, userId: "102", role: "OWNER" };
  await ensureInstallation(first);
  await ensureInstallation(second);
  const pairing = await initiatePairing(first, {
    destinationShop: b,
    organizationConfirmed: true,
  });
  await acceptPairing(second, {
    requestId: pairing.request.id,
    challenge: pairing.challenge,
    organizationConfirmed: true,
  });
  return (await confirmPairing(first, { requestId: pairing.request.id }))
    .workspace.id;
}

/** Every action under /app, found rather than listed, so a new one cannot be missed. */
async function everyAction() {
  const modules = import.meta.glob<{ action?: Route }>(
    "../../app/routes/app*.tsx",
  );
  const found: [string, Route][] = [];
  for (const [file, load] of Object.entries(modules)) {
    const { action } = await load();
    if (action) found.push([file, action]);
  }
  expect(found.length).toBeGreaterThanOrEqual(10);
  return found;
}
/**
 * A digest of each table, so "nothing was applied" is checked rather than assumed.
 * The limiter counts requests whatever becomes of them, and is about the app itself.
 */
async function databaseState(...except: string[]) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const digests: Record<string, string> = {};
  for (const { tablename } of tables) {
    if (
      ["_prisma_migrations", "RequestRateLimit", ...except].includes(tablename)
    )
      continue;
    const [row] = await prisma.$queryRawUnsafe<{ digest: string | null }[]>(
      `SELECT md5(string_agg(t::text, ',' ORDER BY t::text)) AS digest FROM "${tablename}" t`,
    );
    digests[tablename] = row.digest ?? "";
  }
  return digests;
}
/** Only the wait the library's token calls get: the rest of the clock is left alone. */
function shortenTokenDeadline() {
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    run: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => real(run, ms === TOKEN_DEADLINE_MS ? 20 : ms, ...rest)) as never);
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Waits for something another call is doing, rather than for a guess at how long. */
async function until(condition: () => unknown) {
  for (let tries = 0; tries < 1000; tries++) {
    if (await condition()) return;
    await pause(10);
  }
  throw new Error("What this test was waiting for never happened");
}
/** A call this test decides the moment of. */
function held<T>() {
  let release!: (value: T) => void;
  const answer = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { answer, release };
}
const offlineRow = (shop: string) =>
  prisma.session.findUniqueOrThrow({ where: { id: `offline_${shop}` } });
/** Decrypted, as the worker will present it. */
const workerRefreshToken = async (shop: string) =>
  (await sessionStorage.loadSession(`offline_${shop}`))?.refreshToken;
const refreshesPresented = () =>
  stub.tokenRequests.filter((body) => body.refresh_token);
const codesPresented = () => stub.tokenRequests.filter((body) => body.code);
const due = (shop: string) =>
  prisma.session.update({
    where: { id: `offline_${shop}` },
    data: { expires: new Date(Date.now() - MINUTE) },
  });
const catalogJob = async (shop: string) => {
  const snapshot = await prisma.catalogSnapshot.create({
    data: { shopDomain: shop, status: "QUEUED" },
  });
  return prisma.syncJob.create({
    data: {
      workspaceId: "",
      policyId: "",
      sourceShop: shop,
      targetShop: shop,
      operation: "CATALOG_IMPORT",
      payload: { snapshotId: snapshot.id },
      availableAt: new Date("1999-01-01"),
    },
  });
};
/** The worker takes the oldest job first, which these are, then this one is judged. */
const runJob = async (id: string) => {
  await runWorkerOnce("worker:standalone-auth");
  return prisma.syncJob.findUniqueOrThrow({ where: { id } });
};
const putAside = (id: string) =>
  prisma.syncJob.update({ where: { id }, data: { status: "CANCELLED" } });
/** How many are queued behind a token operation in this database right now. */
const tokenLockWaiters = async () =>
  (
    await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS "waiting" FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
  )[0].waiting;
/** Another process in the middle of a token operation for this store. */
async function tokenLockHeldElsewhere(shop: string) {
  const got = held<void>();
  const finish = held<void>();
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`offline-token:${shop}`}))::text`;
      got.release();
      await finish.answer;
    },
    { timeout: 25_000 },
  );
  await got.answer;
  return async () => {
    finish.release();
    await done;
  };
}
type TransactionWork = (tx: Prisma.TransactionClient) => Promise<unknown>;
/** Every transaction from here on still runs for real, as this test changes it. */
function reachIntoTransactions(
  change: (
    work: TransactionWork,
    options?: object,
  ) => [TransactionWork, object?],
) {
  const real = prisma.$transaction.bind(prisma) as unknown as (
    work: TransactionWork,
    options?: object,
  ) => Promise<unknown>;
  return vi
    .spyOn(prisma, "$transaction")
    .mockImplementation(((work: TransactionWork, options?: object) =>
      real(...change(work, options))) as never);
}
/**
 * The lock's transaction with a shorter life or a shorter wait, so a test need not
 * sit through them. Prisma and PostgreSQL still do the timing out.
 */
function shortenTokenLock(limits: { timeout?: number; lockWait?: number }) {
  reachIntoTransactions((work, options) => [
    (tx) =>
      work(
        new Proxy(tx, {
          get: (target, name) =>
            name === "$queryRaw"
              ? (sql: TemplateStringsArray, ...values: unknown[]) =>
                  target.$queryRaw(
                    sql,
                    ...(limits.lockWait && sql.join("").includes("lock_timeout")
                      ? [String(limits.lockWait)]
                      : values),
                  )
              : Reflect.get(target, name),
        }),
      ),
    { ...options, ...(limits.timeout ? { timeout: limits.timeout } : {}) },
  ]);
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "the dashboard's own sign-in, with the real library and PostgreSQL",
  () => {
    beforeAll(async () => {
      ({ loader: index } =
        (await import("../../app/routes/_index/route")) as never);
      ({ loader: login, action: loginForm } =
        (await import("../../app/routes/auth.login/route")) as never);
      ({ loader: callback } =
        (await import("../../app/routes/auth.callback")) as never);
      ({ action: logout } =
        (await import("../../app/routes/auth.logout")) as never);
      ({ loader: layout } = (await import("../../app/routes/app")) as never);
      ({ action: stores, loader: storesPage } =
        (await import("../../app/routes/app.stores")) as never);
      ({ action: uninstalled } =
        (await import("../../app/routes/webhooks.app.uninstalled")) as never);
      ({ action: scopesUpdate } =
        (await import("../../app/routes/webhooks.app.scopes_update")) as never);
    });
    beforeEach(() => {
      stub.outbound.length = 0;
      stub.tokenRequests.length = 0;
      stub.grants.clear();
      stub.tokenEndpointDown = false;
      stub.tokenEndpointHangs = false;
      stub.refresh = () => stub.json({ error: "invalid_request" }, 401);
      stub.exchanging = () => undefined;
      stub.graphql = (shop) =>
        stub.json({
          data: {
            shop: {
              id: "gid://shopify/Shop/1",
              myshopifyDomain: shop,
              currencyCode: "USD",
            },
            currentAppInstallation: {
              accessScopes: ALL_SCOPES.split(",").map((handle) => ({ handle })),
            },
          },
        });
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await prisma.$disconnect();
    });

    describe("beginning", () => {
      it("redirects to Shopify with a signed state cookie, asking for the person first, and calls nothing", async () => {
        const shop = shopName();
        const browser = new Browser();
        const outcome = await startSignIn(browser, shop);
        const authorize = authorizeUrl(outcome);
        expect(authorize.hostname).toBe(shop);
        expect(authorize.searchParams.get("client_id")).toBe(
          "synthetic-auth-key",
        );
        expect(authorize.searchParams.get("redirect_uri")).toBe(
          `${ORIGIN}/auth/callback`,
        );
        expect(authorize.searchParams.get("scope")).toContain("write_products");
        expect(isOnlineAsk(authorize)).toBe(true);
        const state = browser.jar.get(stateCookieName(shop));
        expect(state?.value).toBe(authorize.searchParams.get("state"));
        expect(browser.jar.has(`${stateCookieName(shop)}.sig`)).toBe(true);
        expect(state?.path).toBe("/auth/callback");
        for (const cookie of outcome.setCookies) {
          expect(cookie).toMatch(/httponly/i);
          expect(cookie).toMatch(/secure/i);
          expect(cookie).toMatch(/samesite=lax/i);
        }
        expect(stub.outbound).toEqual([]);
        expect(await prisma.session.count({ where: { shop } })).toBe(0);
      });

      it("gives a person ten minutes at Shopify's login, not the library's one", async () => {
        const browser = new Browser();
        const shop = shopName();
        await startSignIn(browser, shop);
        for (const name of [
          stateCookieName(shop),
          `${stateCookieName(shop)}.sig`,
          flowCookieName(shop),
        ]) {
          const left = browser.jar.get(name)!.until - Date.now();
          expect(left, name).toBeGreaterThan(9 * 60_000);
          expect(left, name).toBeLessThanOrEqual(10 * 60_000);
        }
      });

      it("looks the same to an anonymous visitor whether or not the app holds a token for that store", async () => {
        const installed = await signIn();
        const unknown = shopName();
        const spy = vi.spyOn(sessionStorage, "loadSession");
        // A link is asked to confirm, for either store, with the same answer.
        const linked = async (shop: string) => {
          const outcome = await linkTo(new Browser(), shop);
          expect(outcome.status).toBe(200);
          expect(outcome.setCookies).toEqual([]);
          return JSON.stringify(outcome.data).replaceAll(shop, "STORE");
        };
        expect(await linked(installed.shop)).toBe(await linked(unknown));
        // Confirmed, both go to Shopify the same way.
        const ask = async (shop: string) => {
          const url = authorizeUrl(await startSignIn(new Browser(), shop));
          url.searchParams.delete("state");
          return url.search;
        };
        const [forInstalled, forUnknown] = [
          await ask(installed.shop),
          await ask(unknown),
        ];
        expect(forInstalled).toBe(forUnknown);
        expect(new URLSearchParams(forUnknown).get("grant_options[]")).toBe(
          "per-user",
        );
        expect(spy).not.toHaveBeenCalled();
      });

      it("answers a crawler with the library's refusal and no cookies", async () => {
        const browser = new Browser();
        const outcome = await browser.post(
          loginForm,
          "/auth/login",
          `shop=${shopName()}`,
          { "User-Agent": "Googlebot/2.1" },
        );
        expect(outcome.status).toBe(410);
        expect(outcome.setCookies).toEqual([]);
      });
    });

    describe("completing", () => {
      it("saves both sessions encrypted, sets a cookie holding only an id, and records the installation", async () => {
        const { shop, browser, trips, grants } = await signIn();
        expect(trips).toEqual(["online", "offline"]);
        expect(stub.tokenRequests.map((body) => body.expiring)).toEqual([
          "1",
          "1",
        ]);

        const rows = await prisma.session.findMany({ where: { shop } });
        expect(rows).toHaveLength(2);
        const offline = rows.find((row) => !row.isOnline)!;
        const online = rows.find((row) => row.isOnline)!;
        expect(offline.id).toBe(`offline_${shop}`);
        expect(offline.accessToken).toMatch(/^enc:v1:/);
        expect(offline.refreshToken).toMatch(/^enc:v1:/);
        expect(offline.refreshTokenExpires).not.toBeNull();
        expect(online.accessToken).toMatch(/^enc:v1:/);
        expect(online.accountOwner).toBe(true);
        expect(online.id).toMatch(/^[0-9a-f-]{36}$/);

        expect(sessionId(browser)).toBe(online.id);
        const set = browser.jar.get(sessionCookieName(shop))!;
        expect(set.path).toBe("/");
        expect(set.until).toBeLessThanOrEqual(online.expires!.getTime());
        expect(browser.jar.has(stateCookieName(shop))).toBe(false);
        expect(browser.jar.has(`${stateCookieName(shop)}.sig`)).toBe(false);
        expect(browser.jar.has(flowCookieName(shop))).toBe(false);
        for (const [name, { value }] of browser.jar)
          for (const grant of grants) {
            expect(`${name}=${value}`).not.toContain(grant.access_token);
          }

        expect(await connection(shop)).toMatchObject({
          status: "CONNECTED",
          uninstalledAt: null,
        });
        expect(await run(layout, browser.request("/app"))).toMatchObject({
          status: 200,
          data: { shop },
        });
      });

      it("marks the session cookie HttpOnly, Secure and Lax, and it expires with the token", async () => {
        const shop = shopName();
        const browser = new Browser();
        let step = await startSignIn(browser, shop);
        stub.grants.set("first", onlineGrant(OWNER));
        step = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "first"),
        );
        const cookies = step.setCookies.filter((cookie) =>
          cookie.startsWith(SESSION_PREFIX),
        );
        expect(cookies).toHaveLength(1);
        const row = await prisma.session.findUniqueOrThrow({
          where: { id: sessionId(browser, shop) },
        });
        for (const cookie of cookies) {
          const expires = /expires=([^;]+)/i.exec(cookie)![1];
          expect(new Date(expires).getTime()).toBeLessThanOrEqual(
            row.expires!.getTime(),
          );
        }
        // Everything else a sign-in leaves in a browser is held the same way.
        expect(step.setCookies.length).toBeGreaterThan(cookies.length);
        for (const cookie of step.setCookies) {
          expect(cookie).toMatch(/httponly/i);
          expect(cookie).toMatch(/secure/i);
          expect(cookie).toMatch(/samesite=lax/i);
        }
        // An offline grant's session is the worker's: it never reaches a browser.
        stub.grants.set("second", offlineGrant());
        const done = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "second"),
        );
        expect(done.location).toBe(dashboard(shop));
        expect(
          done.setCookies.filter((cookie) => cookie.startsWith(SESSION_PREFIX)),
        ).toEqual([]);
        expect(sessionId(browser, shop)).toBe(row.id);
      });

      it("asks only for an online token when the shop's offline one is usable, and leaves it alone", async () => {
        const { shop, browser } = await signIn();
        const before = await prisma.session.findUniqueOrThrow({
          where: { id: `offline_${shop}` },
        });
        const { trips } = await signIn(shop, OWNER, new Browser());
        expect(trips).toEqual(["online"]);
        const after = await prisma.session.findUniqueOrThrow({
          where: { id: `offline_${shop}` },
        });
        expect(after.accessToken).toBe(before.accessToken);
        expect(after.refreshToken).toBe(before.refreshToken);
        expect(sessionId(browser)).not.toBe("");
      });

      it("gives each sign-in a new id and ends the one this browser had", async () => {
        const { shop, browser } = await signIn();
        const first = sessionId(browser);
        const stale = browser.request("/app");
        await signIn(shop, OWNER, browser);
        expect(sessionId(browser)).not.toBe(first);
        expect(await prisma.session.count({ where: { id: first } })).toBe(0);
        expect((await run(layout, stale)).status).toBe(302);
        expect((await run(layout, browser.request("/app"))).status).toBe(200);
      });

      it("removes lapsed online sessions of that store, and never an offline one", async () => {
        const { shop, browser } = await signIn();
        const lapsed = sessionId(browser);
        await expireOnline(browser);
        await signIn(shop, OWNER, new Browser());
        expect(await prisma.session.count({ where: { id: lapsed } })).toBe(0);
        expect(
          await prisma.session.count({ where: { id: `offline_${shop}` } }),
        ).toBe(1);
      });

      it.each<[string, Record<string, unknown>, string[]]>([
        [
          "expired with a live refresh token is usable: refreshing is the worker's job",
          { expires: new Date(Date.now() - HOUR) },
          ["online"],
        ],
        [
          "expired with an expired refresh token is replaced",
          {
            expires: new Date(Date.now() - HOUR),
            refreshTokenExpires: new Date(Date.now() - HOUR),
          },
          ["online", "offline"],
        ],
        [
          "expired with no refresh token is replaced",
          { expires: new Date(Date.now() - HOUR), refreshToken: null },
          ["online", "offline"],
        ],
        [
          "missing a scope is replaced",
          { scope: "read_products" },
          ["online", "offline"],
        ],
        [
          "unreadable with this key is replaced",
          { accessToken: "enc:v1:bm90LWEtcmVhbC1jaXBoZXJ0ZXh0LWF0LWFsbC1zbw" },
          ["online", "offline"],
        ],
      ])("an offline token %s", async (_, change, expected) => {
        const { shop } = await signIn();
        await prisma.session.update({
          where: { id: `offline_${shop}` },
          data: change,
        });
        stub.refresh = () =>
          stub.json({ ...offlineGrant(), access_token: "shpat_refreshed" });
        const { trips } = await signIn(shop, OWNER, new Browser());
        expect(trips).toEqual(expected);
      });

      it("refuses a grant with fewer scopes than asked for, and keeps nothing from it", async () => {
        const shop = shopName();
        const browser = new Browser();
        const step = await startSignIn(browser, shop);
        stub.grants.set("narrow", onlineGrant(OWNER, "read_products"));
        const refused = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "narrow"),
        );
        expect(refused.status).toBe(403);
        expect(refused.location).toBeNull();
        expect(await prisma.session.count({ where: { shop } })).toBe(0);
        expect(browser.jar.hasSession()).toBe(false);
      });

      it("refuses an offline token narrower than asked for, on the trip that asks for it", async () => {
        const shop = shopName();
        const browser = new Browser();
        let step = await startSignIn(browser, shop);
        stub.grants.set("person", onlineGrant(OWNER));
        step = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "person"),
        );
        stub.grants.set("narrow", offlineGrant("read_products"));
        const refused = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "narrow"),
        );
        expect(refused.status).toBe(403);
        expect(
          await prisma.session.count({ where: { id: `offline_${shop}` } }),
        ).toBe(0);
      });

      it("counts a write scope as covering its read scope, as Shopify's answers do", async () => {
        const shop = shopName();
        const browser = new Browser();
        const step = await startSignIn(browser, shop);
        const compressed = "write_products,write_inventory,read_locations";
        stub.grants.set("compressed", onlineGrant(OWNER, compressed));
        const next = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "compressed"),
        );
        expect(isOnlineAsk(authorizeUrl(next))).toBe(false);
        stub.grants.set("offline-compressed", offlineGrant(compressed));
        const done = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(next), "offline-compressed"),
        );
        expect(done.location).toBe(dashboard(shop));
      });

      it("does not take an online answer with no associated_user for a person", async () => {
        const { shop } = await signIn();
        const before = await prisma.session.findUniqueOrThrow({
          where: { id: `offline_${shop}` },
        });
        const browser = new Browser();
        const step = await startSignIn(browser, shop);
        stub.grants.set("nobody", onlineGrant(null));
        const refused = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "nobody"),
        );
        expect(refused.status).toBe(400);
        expect(browser.jar.hasSession()).toBe(false);
        // Without the user it reads as an offline token, and is not one: it has no
        // refresh token, so it must not replace the real one.
        expect(
          await prisma.session.findUniqueOrThrow({
            where: { id: `offline_${shop}` },
          }),
        ).toMatchObject({ accessToken: before.accessToken });
      });

      describe("when Shopify answers a person's trip with an offline token", () => {
        // Per-user taken out of the authorize URL. The grant retires every other
        // refresh token at once, so throwing this one away strands the worker.
        const started = async () => {
          const { shop } = await signIn();
          const browser = new Browser();
          const step = await startSignIn(browser, shop);
          return { shop, browser, authorize: authorizeUrl(step) };
        };

        it("keeps it, because it is now the app's working token, and signs nobody in", async () => {
          const { shop, browser, authorize } = await started();
          const grant = offlineGrant();
          stub.grants.set("edited-url", grant);
          const refused = await browser.visit(
            callback,
            shopifyCallback(authorize, "edited-url"),
          );
          expect(refused.status).toBe(400);
          expect(browser.jar.hasSession()).toBe(false);
          expect(
            await prisma.session.count({
              where: { shop, isOnline: true, email: null },
            }),
          ).toBe(0);
          stub.outbound.length = 0;
          await shopifyRequest(shop, INSTALLATION_CHECK_QUERY);
          expect(stub.outbound.at(-1)?.token).toBe(grant.access_token);
          const stored = await sessionStorage.loadSession(`offline_${shop}`);
          expect(stored?.refreshToken).toBe(grant.refresh_token);
        });

        it("does not keep one that is missing a scope", async () => {
          const { shop, browser, authorize } = await started();
          const before = await prisma.session.findUniqueOrThrow({
            where: { id: `offline_${shop}` },
          });
          stub.grants.set("edited-url", offlineGrant("read_products"));
          const refused = await browser.visit(
            callback,
            shopifyCallback(authorize, "edited-url"),
          );
          expect(refused.status).toBe(400);
          expect(
            await prisma.session.findUniqueOrThrow({
              where: { id: `offline_${shop}` },
            }),
          ).toMatchObject({ accessToken: before.accessToken });
        });
      });

      it("reports a token endpoint it cannot reach, on the same page, and signs nobody in", async () => {
        const browser = new Browser();
        const step = await startSignIn(browser, shopName());
        stub.tokenEndpointDown = true;
        const outcome = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "any-code"),
        );
        expect(outcome.status).toBe(502);
        expect(outcome.data).toMatchObject({
          problem: expect.stringContaining("Sign in again"),
        });
        expect(browser.jar.hasSession()).toBe(false);
      });

      it("reports a token endpoint that fails, and signs nobody in", async () => {
        const browser = new Browser();
        const step = await startSignIn(browser, shopName());
        const outcome = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "unknown-code"),
        );
        expect(outcome.status).toBe(502);
        expect(browser.jar.hasSession()).toBe(false);
      });
    });

    describe("refusing a forged callback", () => {
      const started = async () => {
        const shop = shopName();
        const browser = new Browser();
        const authorize = authorizeUrl(await startSignIn(browser, shop));
        stub.grants.set("good", offlineGrant());
        return { shop, browser, authorize };
      };
      const refusedWithoutExchange = async (
        browser: Browser,
        shop: string,
        path: string,
        status = 400,
      ) => {
        const outcome = await browser.visit(callback, path);
        expect(outcome.status).toBe(status);
        expect(outcome.location).toBeNull();
        expect(stub.tokenRequests).toEqual([]);
        expect(await prisma.session.count({ where: { shop } })).toBe(0);
        expect(browser.jar.hasSession()).toBe(false);
      };

      it("a state that does not match the cookie", async () => {
        const { shop, browser, authorize } = await started();
        await refusedWithoutExchange(
          browser,
          shop,
          shopifyCallback(authorize, "good", { state: "forged-state" }),
        );
      });
      it("no state cookie, as for another browser's callback", async () => {
        const { shop, browser, authorize } = await started();
        browser.jar.delete(stateCookieName(shop));
        browser.jar.delete(`${stateCookieName(shop)}.sig`);
        await refusedWithoutExchange(
          browser,
          shop,
          shopifyCallback(authorize, "good"),
        );
      });
      it("a state cookie whose signature does not match", async () => {
        const { shop, browser, authorize } = await started();
        browser.jar.get(`${stateCookieName(shop)}.sig`)!.value = "dGFtcGVyZWQ";
        await refusedWithoutExchange(
          browser,
          shop,
          shopifyCallback(authorize, "good"),
        );
      });
      it("a signature made with another secret", async () => {
        const { shop, browser, authorize } = await started();
        const query = signedQuery(
          {
            code: "good",
            shop,
            state: authorize.searchParams.get("state")!,
            timestamp: now(),
          },
          "not-the-secret",
        );
        await refusedWithoutExchange(browser, shop, `/auth/callback?${query}`);
      });
      it("no signature at all", async () => {
        const { shop, browser, authorize } = await started();
        const query = new URLSearchParams({
          code: "good",
          shop,
          state: authorize.searchParams.get("state")!,
          timestamp: now(),
        });
        await refusedWithoutExchange(browser, shop, `/auth/callback?${query}`);
      });
      it("a signature older than Shopify's tolerance", async () => {
        const { shop, browser, authorize } = await started();
        await refusedWithoutExchange(
          browser,
          shop,
          shopifyCallback(authorize, "good", {
            timestamp: String(Math.trunc(Date.now() / 1000) - 600),
          }),
        );
      });
      it("a callback for a store other than the one this browser asked for", async () => {
        const { shop, browser, authorize } = await started();
        const other = shopName("other");
        await refusedWithoutExchange(
          browser,
          shop,
          shopifyCallback(authorize, "good", { shop: other }),
        );
        expect(await prisma.session.count({ where: { shop: other } })).toBe(0);
      });
      it("a repeated parameter, which the library would read two ways", async () => {
        const { shop, browser, authorize } = await started();
        const other = shopName("other");
        await refusedWithoutExchange(
          browser,
          shop,
          `${shopifyCallback(authorize, "good")}&shop=${other}`,
        );
        await refusedWithoutExchange(
          browser,
          shop,
          `/auth/callback?shop=${other}&${shopifyCallback(authorize, "good").split("?")[1]}`,
        );
      });
      it("Shopify's real signature for another store, with this store added in front", async () => {
        // The library checks the last copy of each parameter and sends the code to
        // the first copy of shop. Shopify really would sign the attacker's own store.
        const { shop, browser, authorize } = await started();
        const signed = signedQuery({
          code: "good",
          shop: shopName("attacker"),
          state: authorize.searchParams.get("state")!,
          timestamp: now(),
        });
        await refusedWithoutExchange(
          browser,
          shop,
          `/auth/callback?shop=${shop}&${signed}`,
        );
      });
      it("a sign-in cookie that was tampered with or is gone", async () => {
        const { shop, browser, authorize } = await started();
        const path = shopifyCallback(authorize, "good");
        const flow = browser.jar.get(flowCookieName(shop))!;
        flow.value = `${flow.value.slice(0, -2)}xx`;
        await refusedWithoutExchange(browser, shop, path);
        browser.jar.delete(flowCookieName(shop));
        await refusedWithoutExchange(browser, shop, path);
      });
      it("something that is not a store, or no store at all", async () => {
        const { shop, browser, authorize } = await started();
        await refusedWithoutExchange(
          browser,
          shop,
          shopifyCallback(authorize, "good", { shop: "evil.example" }),
        );
        await refusedWithoutExchange(
          browser,
          shop,
          `/auth/callback?${signedQuery({ code: "good", state: "x", timestamp: now() })}`,
        );
      });
      it("a sign-in cookie made for another store, under this store's name", async () => {
        // The signature covers the value and not the name, which a person can change.
        const { shop, browser, authorize } = await started();
        browser.absorb([
          await flowCookie(shop).serialize({
            shop: shopName("other"),
            returnTo: "/app",
            step: "online",
          }),
        ]);
        await refusedWithoutExchange(
          browser,
          shop,
          shopifyCallback(authorize, "good"),
        );
      });
    });

    describe("the session cookie", () => {
      const refused = async (cookie: string, path: string) => {
        const request = new Request(`${ORIGIN}${path}`, {
          headers: { Cookie: cookie, "User-Agent": BROWSER },
        });
        const outcome = await run(layout, request);
        expect(outcome.status).toBe(302);
        expect(outcome.location).toContain("/auth/login");
        return outcome;
      };
      const signedAs = (name: string, id: string, secret: string) =>
        createCookie(name, { secrets: [secret] }).serialize(id);
      const pair = (line: string) => line.split(";")[0];

      it("is refused with no signature, a changed value or a changed signature", async () => {
        const { shop, browser } = await signIn();
        const name = sessionCookieName(shop);
        const [body, signature] = decodeURIComponent(
          browser.jar.get(name)!.value,
        ).split(".");
        const page = dashboard(shop);
        await refused(`${name}=${encodeURIComponent(body)}`, page);
        const other = btoa(JSON.stringify(randomUUID()));
        await refused(
          `${name}=${encodeURIComponent(`${other}.${signature}`)}`,
          page,
        );
        await refused(
          `${name}=${encodeURIComponent(`${body}.${signature.slice(0, -3)}AAA`)}`,
          page,
        );
      });

      it("is refused when signed with another secret", async () => {
        const { shop, browser } = await signIn();
        await refused(
          pair(
            await signedAs(
              sessionCookieName(shop),
              sessionId(browser),
              "not-the-secret",
            ),
          ),
          dashboard(shop),
        );
      });

      it("never opens the worker's offline session, even correctly signed", async () => {
        const { shop } = await signIn();
        await refused(
          pair(
            await signedAs(
              sessionCookieName(shop),
              `offline_${shop}`,
              cookieSigningKey()!,
            ),
          ),
          dashboard(shop),
        );
      });

      it("never opens another store's session under this store's name", async () => {
        // The signature covers the value and not the name, which a person can change.
        const a = await signIn(shopName("renamed-a"));
        const b = shopName("renamed-b");
        await refused(
          `${sessionCookieName(b)}=${a.browser.jar.get(sessionCookieName(a.shop))!.value}`,
          dashboard(b),
        );
      });

      it("never opens an online row that lost its token", async () => {
        const { browser } = await signIn();
        await prisma.session.update({
          where: { id: sessionId(browser) },
          data: { accessToken: "" },
        });
        expect((await run(layout, browser.request("/app"))).status).toBe(302);
      });

      it("is not accepted from a bearer token or a query parameter", async () => {
        const { shop, browser } = await signIn();
        const id = sessionId(browser);
        await refused(`x=y`, `${dashboard(shop)}&session=${id}&id_token=${id}`);
        const bearer = await run(
          layout,
          new Request(`${ORIGIN}${dashboard(shop)}`, {
            headers: { Authorization: `Bearer ${id}`, "User-Agent": BROWSER },
          }),
        );
        expect(bearer.status).toBe(302);
      });

      it("is signed with this server's key, not one app's secret", async () => {
        // One custom app per store comes next, and these cookies must not change with it.
        const { shop, browser } = await signIn();
        const id = sessionId(browser);
        const name = sessionCookieName(shop);
        const resigned = pair(await signedAs(name, id, cookieSigningKey()!));
        expect((await run(layout, browser.request("/app"))).status).toBe(200);
        expect(browser.jar.get(name)!.value).toBe(resigned.split("=")[1]);
        for (const secret of [
          SECRET,
          createHmac("sha256", SECRET)
            .update("syncpilot/sign-in-cookies/v1")
            .digest("base64url"),
        ])
          await refused(
            pair(await signedAs(name, id, secret)),
            dashboard(shop),
          );
      });

      it("a cookie for one store reads that store, and a request for another goes to sign in to it", async () => {
        const { shop, browser } = await signIn(shopName("a"));
        const other = shopName("b");
        await signIn(other, OWNER, new Browser());
        expect(await run(layout, browser.request("/app"))).toMatchObject({
          status: 200,
          data: { shop },
        });
        const asked = await run(layout, browser.raw(dashboard(other)));
        expect(asked.status).toBe(302);
        const target = new URL(asked.location!, ORIGIN);
        expect(target.pathname).toBe("/auth/login");
        expect(target.searchParams.get("shop")).toBe(other);
        expect(target.searchParams.get("return_to")).toBe("/app");
        // An action cannot be pointed at the other store either.
        const pointed = await browser.post(
          stores,
          dashboard(other, "/app/stores"),
          initiate(shop),
        );
        expect(pointed.status).toBe(401);
        expect(pointed.data).toEqual({ signIn: true, shop: other });
        expect(await pairingsFrom(other)).toBe(0);
      });

      it.each([
        ["no store", ""],
        ["something that is not a store", "?shop=not-a-store"],
        ["two stores", "?shop=a.myshopify.com&shop=b.myshopify.com"],
      ])(
        "an address naming %s opens the store this browser has, and then says so",
        async (_, query) => {
          const { shop, browser } = await signIn();
          const page = await run(layout, browser.raw(`/app/stores${query}`));
          expect(page).toMatchObject({
            status: 302,
            location: dashboard(shop, "/app/stores"),
          });
        },
      );

      it("an address spelled differently still names the same store", async () => {
        const { shop, browser } = await signIn();
        expect(
          await run(layout, browser.raw(`/app?shop=${shop.toUpperCase()}`)),
        ).toMatchObject({ status: 200, data: { shop } });
      });
    });

    describe("return paths", () => {
      it.each([
        "https://evil.example/",
        "//evil.example/",
        "/\\evil.example",
        "\\\\evil.example",
        "/app/../../evil.example",
        "/auth/logout",
        "javascript:alert(1)",
        "/\t/evil.example",
      ])("never lands on %s", async (returnTo) => {
        const shop = shopName();
        const browser = new Browser();
        const { final } = await atShopify(
          browser,
          await startSignIn(browser, shop, returnTo),
        );
        expect(final).toMatchObject({
          status: 302,
          location: dashboard(shop),
        });
      });

      it("is checked before it is kept for the way back", async () => {
        const browser = new Browser();
        const shop = shopName();
        await startSignIn(browser, shop, "https://evil.example/");
        const kept = await flowCookie(shop).parse(
          `${flowCookieName(shop)}=${browser.jar.get(flowCookieName(shop))!.value}`,
        );
        expect(kept.returnTo).toBe("/app");
      });

      it("is checked again on the way back, even in a correctly signed cookie", async () => {
        const shop = shopName();
        const browser = new Browser();
        const step = await startSignIn(browser, shop);
        browser.absorb([
          await flowCookie(shop).serialize({
            shop,
            returnTo: "https://evil.example/",
            step: "repair",
          }),
        ]);
        stub.grants.set("repair-code", offlineGrant());
        const done = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "repair-code"),
        );
        expect(done).toMatchObject({
          status: 302,
          location: dashboard(shop),
        });
      });

      it("comes back to the page that asked, from the form too", async () => {
        const browser = new Browser();
        const shop = shopName();
        const { final } = await atShopify(
          browser,
          await startSignIn(browser, shop, "/app/rules?edit=abc"),
        );
        expect(final.location).toBe(dashboard(shop, "/app/rules?edit=abc"));
      });

      it("lands on the store it signed in to, whichever store the page named", async () => {
        const browser = new Browser();
        const shop = shopName();
        const { final } = await atShopify(
          browser,
          await startSignIn(
            browser,
            shop,
            `/app/rules?shop=${shopName("other")}`,
          ),
        );
        expect(final.location).toBe(dashboard(shop, "/app/rules"));
      });
    });

    describe("the login form", () => {
      const submit = (shop: string) =>
        new Browser().post(
          loginForm,
          "/auth/login",
          new URLSearchParams({ shop }).toString(),
        );
      it("takes a domain, a bare store name, a URL or an admin URL", async () => {
        const name = `form-${randomUUID().slice(0, 8)}`;
        for (const typed of [
          `${name}.myshopify.com`,
          name,
          `https://${name}.myshopify.com/`,
          `admin.shopify.com/store/${name}`,
        ])
          expect(authorizeUrl(await submit(typed)).hostname, typed).toBe(
            `${name}.myshopify.com`,
          );
      });
      it("answers anything else without leaving the page", async () => {
        for (const typed of [
          "evil.example",
          `evil.example/.myshopify.com`,
          "shop.myshopify.com.evil.example",
          "a b",
        ])
          expect(await submit(typed), typed).toMatchObject({
            status: 200,
            location: null,
            data: {
              errors: { shop: expect.stringContaining(".myshopify.com") },
              typed,
            },
          });
        expect(await submit("")).toMatchObject({
          status: 200,
          data: {
            errors: { shop: "Enter your store domain to continue." },
          },
        });
      });
      it("takes what was typed over a bad shop in the page's own address", async () => {
        const shop = shopName();
        const outcome = await new Browser().post(
          loginForm,
          "/auth/login?shop=not-a-store!",
          new URLSearchParams({ shop }).toString(),
        );
        expect(authorizeUrl(outcome).hostname).toBe(shop);
      });
      it("shows the form for a plain visit", async () => {
        expect(await new Browser().visit(login, "/auth/login")).toMatchObject({
          status: 200,
          data: { errors: {}, signedIn: [] },
        });
      });
      it("says which stores this browser is still signed in to", async () => {
        const a = await signIn(shopName("listed-a"));
        const b = await signIn(shopName("listed-b"), OWNER, a.browser);
        expect(await b.browser.visit(login, "/auth/login")).toMatchObject({
          status: 200,
          data: { signedIn: [b.shop, a.shop] },
        });
      });
      it("still asks Shopify who is there when a person types a store they are signed in to", async () => {
        const { shop, browser } = await signIn();
        const first = sessionId(browser);
        const { trips } = await atShopify(
          browser,
          await startSignIn(browser, shop),
          STAFF,
        );
        expect(trips).toEqual(["online"]);
        expect(sessionId(browser)).not.toBe(first);
        const { authenticate } = await import("../../app/shopify.server");
        expect(
          requireActor(await authenticate.admin(browser.request("/app"))).role,
        ).toBe("VIEWER");
      });
    });

    describe("opening the app from Shopify", () => {
      const appLoad = (shop: string, extra: Record<string, string> = {}) =>
        `/?${signedQuery({
          host: Buffer.from(`admin.shopify.com/store/${shop}`).toString(
            "base64url",
          ),
          shop,
          timestamp: now(),
          ...extra,
        })}`;

      it("asks Shopify who is there even when this browser is signed in to that store", async () => {
        const { shop, browser } = await signIn();
        const first = sessionId(browser);
        stub.tokenRequests.length = 0;
        const asked = await browser.visit(index, appLoad(shop));
        const authorize = authorizeUrl(asked);
        expect(authorize.hostname).toBe(shop);
        expect(isOnlineAsk(authorize)).toBe(true);
        expect(stub.tokenRequests).toEqual([]);
        const { trips, final } = await atShopify(browser, asked);
        expect(trips).toEqual(["online"]);
        expect(final.location).toBe(dashboard(shop));
        expect(sessionId(browser)).not.toBe(first);
        expect(await prisma.session.count({ where: { id: first } })).toBe(0);
      });

      it("gives the next person at this browser their own rights, not the last person's", async () => {
        // The owner signed in earlier and logged out of Shopify. Staff log in to the
        // same admin in the same browser and click SyncPilot.
        const { shop, browser } = await signIn();
        const dest = shopName("dest");
        await ensureInstallation({ shop: dest, userId: "9", role: "OWNER" });
        const { final } = await atShopify(
          browser,
          await browser.visit(index, appLoad(shop)),
          STAFF,
        );
        expect(final.location).toBe(dashboard(shop));
        const { authenticate } = await import("../../app/shopify.server");
        expect(
          requireActor(await authenticate.admin(browser.request("/app"))),
        ).toMatchObject({ userId: "202", role: "VIEWER" });
        const refused = await browser.post(
          stores,
          "/app/stores",
          initiate(dest),
        );
        expect(refused.status).toBe(403);
        expect(await pairingsFrom(shop)).toBe(0);
        // The header says whose session it is now.
        expect(await run(layout, browser.request("/app"))).toMatchObject({
          data: { owner: false },
        });
      });

      it("begins sign-in when it is not signed in, and for another store's link, without ending this one's session", async () => {
        const shop = shopName();
        expect(
          authorizeUrl(await new Browser().visit(index, appLoad(shop)))
            .hostname,
        ).toBe(shop);
        // Both installed, or the offline token alone could explain the redirect.
        const other = await signIn(shopName("other"));
        const { browser, shop: here } = await signIn(shopName("signed-in"));
        const asked = await browser.visit(index, appLoad(other.shop));
        expect(authorizeUrl(asked).hostname).toBe(other.shop);
        await atShopify(browser, asked);
        expect(
          await run(layout, browser.raw(dashboard(other.shop))),
        ).toMatchObject({ status: 200, data: { shop: other.shop } });
        expect(await run(layout, browser.raw(dashboard(here)))).toMatchObject({
          status: 200,
          data: { shop: here },
        });
      });

      it("refuses a forged, stale or doctored link and offers the form", async () => {
        const shop = shopName();
        const good = appLoad(shop);
        for (const path of [
          good.replace(/hmac=[0-9a-f]+/, `hmac=${"0".repeat(64)}`),
          `${good}&extra=1`,
          good.replace(`shop=${shop}`, `shop=${shopName("other")}`),
          appLoad(shop, {
            timestamp: String(Math.trunc(Date.now() / 1000) - 600),
          }),
          // Which copy would be believed? Neither.
          `${good}&shop=${shopName("other")}`,
          `/?${signedQuery({ shop: "evil.example", timestamp: now() })}`,
        ]) {
          const outcome = await new Browser().visit(index, path);
          expect(outcome.status, path).toBe(400);
          expect(outcome.location, path).toBeNull();
          expect(outcome.data, path).toMatchObject({
            problem: expect.stringContaining("could not be verified"),
          });
        }
      });

      it("treats an unsigned shop as typing it into the form", async () => {
        const shop = shopName();
        const outcome = await new Browser().visit(index, `/?shop=${shop}`);
        expect(outcome.status).toBe(302);
        expect(outcome.location).toBe(`/auth/login?shop=${shop}`);
      });

      it("moves the time a late uninstall is compared with, only for a store still connected", async () => {
        const { shop, browser } = await signIn();
        await installedLongAgo(shop);
        const before = (await connection(shop))!.lastSeenAt;
        await browser.visit(index, appLoad(shop));
        expect((await connection(shop))!.lastSeenAt.getTime()).toBeGreaterThan(
          before.getTime(),
        );
        expect((await uninstall(shop)).status).toBe(200);
        const gone = (await connection(shop))!.lastSeenAt;
        await new Browser().visit(index, appLoad(shop));
        expect((await connection(shop))!.lastSeenAt).toEqual(gone);
      });

      it("sends a signed-in visitor to the dashboard of the store they last signed in to, and shows others the landing page", async () => {
        const first = await signIn(shopName("first"));
        const { shop, browser } = await signIn(
          shopName("latest"),
          OWNER,
          first.browser,
        );
        expect(await browser.visit(index, "/")).toMatchObject({
          status: 302,
          location: dashboard(shop),
        });
        expect(await new Browser().visit(index, "/")).toMatchObject({
          status: 200,
          location: null,
        });
      });
    });

    describe("cross-site requests", () => {
      const forgeries: [string, HeadersInit][] = [
        ["another site's Origin", { Origin: "https://evil.example" }],
        ["a similar Origin", { Origin: `${ORIGIN}.evil.example` }],
        ["an http Origin", { Origin: ORIGIN.replace("https:", "http:") }],
        ["a null Origin", { Origin: "null" }],
        ["no Origin", { Origin: "" }],
        [
          "no Origin and a cross-site fetch",
          { Origin: "", "Sec-Fetch-Site": "cross-site" },
        ],
        [
          "no Origin and a same-site fetch",
          { Origin: "", "Sec-Fetch-Site": "same-site" },
        ],
        [
          "a bad Origin that claims same-origin",
          { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" },
        ],
      ];
      const post = (
        browser: Browser,
        destination: string,
        headers: HeadersInit,
      ) => {
        const merged = new Headers(headers);
        const request = browser.request("/app/stores", {
          method: "POST",
          headers: FORM,
          body: initiate(destination),
        });
        const final = new Headers(request.headers);
        for (const [name, value] of merged) if (value) final.set(name, value);
        return run(stores, new Request(request, { headers: final }));
      };

      it.each(forgeries)(
        "an owner-only action is refused with %s, and changes nothing",
        async (_, headers) => {
          const { shop, browser } = await signIn();
          const before = await prisma.auditEvent.count({
            where: { shopDomain: shop },
          });
          const outcome = await post(browser, shopName("dest"), headers);
          expect(outcome.status).toBe(403);
          expect(await pairingsFrom(shop)).toBe(0);
          expect(
            await prisma.auditEvent.count({ where: { shopDomain: shop } }),
          ).toBe(before);
        },
      );

      it("the same action runs for this origin, or for same-origin with no Origin", async () => {
        const { shop, browser } = await signIn();
        const dest = shopName("dest");
        await ensureInstallation({ shop: dest, userId: "9", role: "OWNER" });
        expect(await post(browser, dest, { Origin: ORIGIN })).toMatchObject({
          status: 200,
          data: { success: expect.stringContaining("Pairing request") },
        });
        expect(await pairingsFrom(shop)).toBe(1);
        const second = await signIn();
        const otherDest = shopName("dest");
        await ensureInstallation({
          shop: otherDest,
          userId: "9",
          role: "OWNER",
        });
        const outcome = await post(second.browser, otherDest, {
          "Sec-Fetch-Site": "same-origin",
        });
        expect(outcome.status).toBe(200);
        expect(await pairingsFrom(second.shop)).toBe(1);
      });

      it("every action under /app is refused before it runs, and a new one cannot forget", async () => {
        const { shop, browser } = await signIn();
        const modules = import.meta.glob<{ action?: Route }>(
          "../../app/routes/app*.tsx",
        );
        const checked: string[] = [];
        const before = await prisma.auditEvent.count({
          where: { shopDomain: shop },
        });
        for (const [file, load] of Object.entries(modules)) {
          const { action } = await load();
          if (!action) continue;
          checked.push(file);
          const outcome = await run(
            action,
            browser.request("/app/anything", {
              method: "POST",
              headers: { ...FORM, Origin: "https://evil.example" },
              body: "intent=anything",
            }),
          );
          expect(outcome.status, file).toBe(403);
        }
        expect(checked.length).toBeGreaterThanOrEqual(10);
        expect(
          await prisma.auditEvent.count({ where: { shopDomain: shop } }),
        ).toBe(before);
      });

      it("spends no budget on a refused request", async () => {
        const { browser } = await signIn();
        const spy = vi.spyOn(prisma, "$queryRaw");
        const outcome = await post(browser, shopName("dest"), {
          Origin: "https://evil.example",
        });
        expect(outcome.status).toBe(403);
        expect(spy).not.toHaveBeenCalled();
        // Nor on a form naming no store, or a store it has no session for.
        const unnamed = await run(
          stores,
          browser.raw("/app/stores", {
            method: "POST",
            headers: { ...FORM, Origin: ORIGIN },
            body: "intent=anything",
          }),
        );
        expect(unnamed.status).toBe(400);
        const elsewhere = await browser.post(
          stores,
          dashboard(shopName("other"), "/app/stores"),
          "intent=anything",
        );
        expect(elsewhere.status).toBe(401);
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe("headers on documents", () => {
      it("no document can be framed or kept", () => {
        const headers = new Headers();
        addDocumentResponseHeaders(headers);
        expect(headers.get("Content-Security-Policy")).toBe(
          "frame-ancestors 'none'",
        );
        expect(headers.get("X-Frame-Options")).toBe("DENY");
        expect(headers.get("Cache-Control")).toBe("no-store");
      });
    });

    describe("who the person is", () => {
      const actorOf = async (browser: Browser) => {
        const { authenticate } = await import("../../app/shopify.server");
        return requireActor(await authenticate.admin(browser.request("/app")));
      };

      it("the page says whose session it is and what they are, with no email or surname", async () => {
        const owner = await signIn(shopName(), OWNER);
        const page = await run(layout, owner.browser.request("/app"));
        expect(page.data).toEqual({
          shop: owner.shop,
          person: "Synthetic P.",
          owner: true,
          otherStores: [],
        });
        expect(JSON.stringify(page.data)).not.toContain("example.invalid");
        expect(JSON.stringify(page.data)).not.toContain("Person");
        const staff = await signIn(shopName(), STAFF);
        expect(await run(layout, staff.browser.request("/app"))).toMatchObject({
          data: { person: "Synthetic P.", owner: false },
        });
      });

      it("the account owner is OWNER, and can run an owner-only action", async () => {
        const { shop, browser } = await signIn(shopName(), OWNER);
        expect(await actorOf(browser)).toEqual({
          shop,
          userId: "101",
          role: "OWNER",
        });
        const dest = shopName("dest");
        await ensureInstallation({ shop: dest, userId: "9", role: "OWNER" });
        expect(
          (await browser.post(stores, "/app/stores", initiate(dest))).data,
        ).toMatchObject({ success: expect.any(String) });
      });

      it("staff are not OWNER and cannot run an owner-only action", async () => {
        const { shop, browser } = await signIn(shopName(), STAFF);
        expect(await actorOf(browser)).toEqual({
          shop,
          userId: "202",
          role: "VIEWER",
        });
        const dest = shopName("dest");
        await ensureInstallation({ shop: dest, userId: "9", role: "OWNER" });
        const outcome = await browser.post(
          stores,
          "/app/stores",
          initiate(dest),
        );
        expect(outcome.status).toBe(403);
        expect(await pairingsFrom(shop)).toBe(0);
      });

      it("staff get what their WorkspaceMember row says, and nothing without one", async () => {
        const a = shopName("pair-a");
        const b = shopName("pair-b");
        const workspaceId = await pairedWorkspace(a, b);
        const { browser } = await signIn(a, STAFF);
        const staff = await actorOf(browser);
        await expect(requireWorkspace(staff)).rejects.toMatchObject({
          code: "MEMBERSHIP_REQUIRED",
        });

        const member = await prisma.workspaceMember.create({
          data: {
            workspaceId,
            shopDomain: a,
            userId: staff.userId,
            role: "VIEWER",
            status: "ACTIVE",
          },
        });
        await expect(requireWorkspace(staff)).resolves.toMatchObject({
          role: "VIEWER",
        });
        await expect(requireOperator(staff)).rejects.toMatchObject({
          code: "OPERATOR_REQUIRED",
        });

        await prisma.workspaceMember.update({
          where: { id: member.id },
          data: { role: "OPERATOR" },
        });
        await expect(requireOperator(staff)).resolves.toMatchObject({
          role: "OPERATOR",
        });

        // A member row can never make someone an owner.
        await prisma.workspaceMember.update({
          where: { id: member.id },
          data: { role: "OWNER" },
        });
        expect((await actorOf(browser)).role).toBe("VIEWER");
      });

      it("a stored person with no user id gets no session, whatever the flag says", async () => {
        const { browser } = await signIn(shopName(), OWNER);
        await prisma.session.update({
          where: { id: sessionId(browser) },
          data: { userId: null },
        });
        const page = await run(layout, browser.request("/app"));
        expect(page.status).toBe(302);
        expect(page.location).toContain("/auth/login");
      });

      it("a grant naming an owner with no id signs nobody in", async () => {
        const shop = shopName();
        const browser = new Browser();
        const step = await startSignIn(browser, shop);
        const grant = onlineGrant(OWNER);
        delete (grant.associated_user as { id?: number }).id;
        stub.grants.set("no-id", grant);
        const refused = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(step), "no-id"),
        );
        expect(refused.status).toBe(400);
        expect(browser.jar.hasSession()).toBe(false);
        expect(
          await prisma.session.count({ where: { shop, isOnline: true } }),
        ).toBe(0);
      });

      it("an account_owner that is not exactly true is not OWNER", () => {
        const session = new Session({
          id: "x",
          shop: "x.myshopify.com",
          state: "",
          isOnline: true,
          onlineAccessInfo: {
            associated_user: { id: 1, account_owner: "true" },
          } as never,
        });
        expect(requireActor({ session }).role).toBe("VIEWER");
      });
    });

    describe("when the sign-in has lapsed", () => {
      it("a page comes back to itself through Shopify, with no prompt needed", async () => {
        const { shop, browser } = await signIn();
        await expireOnline(browser);
        const page = "/app/rules?edit=abc";
        const asked = await run(layout, browser.request(page));
        expect(asked.status).toBe(302);
        const target = new URL(asked.location!, ORIGIN);
        expect(target.pathname).toBe("/auth/login");
        expect(target.searchParams.get("shop")).toBe(shop);
        expect(target.searchParams.get("return_to")).toBe(page);
        const { final, trips } = await atShopify(
          browser,
          await browser.visit(login, `${target.pathname}${target.search}`),
        );
        expect(trips).toEqual(["online"]);
        expect(final.location).toBe(dashboard(shop, page));
        expect((await run(layout, browser.request(page))).status).toBe(200);
      });

      it("does so when the browser has already dropped the session cookie too", async () => {
        const { shop, browser } = await signIn();
        browser.jar.delete(sessionCookieName(shop));
        for (const asked of [
          // A tab that still names the store, and a bookmark that does not.
          await run(layout, browser.request("/app/stores")),
          await run(layout, browser.raw("/app/stores")),
        ]) {
          const target = new URL(asked.location!, ORIGIN);
          expect(target.searchParams.get("shop")).toBe(shop);
          expect(target.searchParams.get("return_to")).toBe("/app/stores");
        }
      });

      it("the app's first visit in a browser goes to the form, and keeps the page", async () => {
        const asked = await run(
          layout,
          new Browser().raw("/app/stores?store=x"),
        );
        expect(asked.status).toBe(302);
        const target = new URL(asked.location!, ORIGIN);
        expect(target.pathname).toBe("/auth/login");
        expect(target.searchParams.has("shop")).toBe(false);
        expect(target.searchParams.get("return_to")).toBe(
          "/app/stores?store=x",
        );
      });

      it("a forged reminder of the store is ignored", async () => {
        const browser = new Browser();
        browser.jar.set("syncpilot_stores", {
          value: Buffer.from(JSON.stringify([shopName()])).toString("base64"),
          path: "/",
          until: Infinity,
        });
        const asked = await run(layout, browser.raw("/app"));
        expect(new URL(asked.location!, ORIGIN).searchParams.has("shop")).toBe(
          false,
        );
      });

      it("a form post is told to sign in again, and nothing is applied", async () => {
        const { shop, browser } = await signIn();
        await expireOnline(browser);
        const dest = shopName("dest");
        await ensureInstallation({ shop: dest, userId: "9", role: "OWNER" });
        const outcome = await browser.post(
          stores,
          "/app/stores",
          initiate(dest),
        );
        expect(outcome.status).toBe(401);
        expect(outcome.location).toBeNull();
        expect(outcome.data).toEqual({ signIn: true, shop });
        expect(await pairingsFrom(shop)).toBe(0);
      });

      it("a scope Shopify took away ends the session, and signing in asks for it again", async () => {
        const { shop, browser } = await signIn();
        await installedLongAgo(shop);
        expect(
          (
            await deliver(
              scopesUpdate,
              "/webhooks/app/scopes_update",
              "app/scopes_update",
              shop,
              {
                id: 1,
                shop_id: "gid://shopify/Shop/1",
                previous: ALL_SCOPES.split(","),
                current: ["read_products"],
                updated_at: new Date().toISOString(),
              },
            )
          ).status,
        ).toBe(200);
        const asked = await run(layout, browser.request("/app"));
        expect(asked.status).toBe(302);
        expect(new URL(asked.location!, ORIGIN).searchParams.get("shop")).toBe(
          shop,
        );
        const { trips, final } = await atShopify(
          browser,
          await startSignIn(browser, shop),
        );
        expect(trips).toEqual(["online", "offline"]);
        expect(final.location).toBe(dashboard(shop));
        expect((await run(layout, browser.request("/app"))).status).toBe(200);
      });
    });

    describe("after an uninstall", () => {
      it("the cookie stops working at once, for pages and for actions", async () => {
        const { shop, browser } = await signIn();
        await installedLongAgo(shop);
        expect((await uninstall(shop)).status).toBe(200);
        expect(await prisma.session.count({ where: { shop } })).toBe(0);
        const page = await run(layout, browser.request("/app"));
        expect(page.status).toBe(302);
        expect(new URL(page.location!, ORIGIN).pathname).toBe("/auth/login");
        // The landing page does not send anyone to a store that has gone either.
        expect(await browser.visit(index, "/")).toMatchObject({ status: 200 });
        const dest = shopName("dest");
        await ensureInstallation({ shop: dest, userId: "9", role: "OWNER" });
        expect(
          (await browser.post(stores, "/app/stores", initiate(dest))).status,
        ).toBe(401);
        expect(await pairingsFrom(shop)).toBe(0);
      });

      it("signing in again starts a new installation", async () => {
        const { shop, browser } = await signIn();
        await installedLongAgo(shop);
        expect((await uninstall(shop)).status).toBe(200);
        expect(await connection(shop)).toMatchObject({ status: "UNINSTALLED" });
        const { trips } = await signIn(shop, OWNER, browser);
        expect(trips).toEqual(["online", "offline"]);
        expect(await connection(shop)).toMatchObject({
          status: "CONNECTED",
          uninstalledAt: null,
        });
        expect(
          await prisma.auditEvent.count({
            where: { shopDomain: shop, action: "APP_REINSTALLED" },
          }),
        ).toBe(1);
      });

      it("a page opened on the cookie does not make a late uninstall look stale", async () => {
        // The delivery failed. The cookie still opens pages, and nothing about that
        // shows the app is installed, so Shopify's retry must still end it.
        const { shop, browser } = await signIn();
        await installedLongAgo(shop);
        expect((await run(layout, browser.request("/app"))).status).toBe(200);
        await ensureInstallation(
          requireActor(
            await (
              await import("../../app/shopify.server")
            ).authenticate.admin(browser.request("/app")),
          ),
        );
        expect(
          (await uninstall(shop, new Date(Date.now() - HOUR))).status,
        ).toBe(200);
        expect(await connection(shop)).toMatchObject({ status: "UNINSTALLED" });
        expect((await run(layout, browser.request("/app"))).status).toBe(302);
      });

      it("signing in through the form shows it too: an older retry loses to that", async () => {
        const { shop } = await signIn();
        await installedLongAgo(shop);
        await signIn(shop, OWNER, new Browser());
        expect(
          (await uninstall(shop, new Date(Date.now() - HOUR))).status,
        ).toBe(200);
        expect(await connection(shop)).toMatchObject({ status: "CONNECTED" });
        expect(
          await prisma.auditEvent.count({
            where: { shopDomain: shop, action: "APP_UNINSTALL_IGNORED" },
          }),
        ).toBe(1);
      });

      it("opening it from Shopify does show it: an older retry loses to that", async () => {
        const { shop, browser } = await signIn();
        await installedLongAgo(shop);
        const load = `/?${signedQuery({ shop, timestamp: now() })}`;
        expect((await browser.visit(index, load)).status).toBe(302);
        expect(
          (await uninstall(shop, new Date(Date.now() - HOUR))).status,
        ).toBe(200);
        expect(await connection(shop)).toMatchObject({ status: "CONNECTED" });
        expect(
          await prisma.auditEvent.count({
            where: { shopDomain: shop, action: "APP_UNINSTALL_IGNORED" },
          }),
        ).toBe(1);
      });
    });

    describe("signing out", () => {
      const signOut = (browser: Browser, path: string) =>
        browser.visit(logout, path, {
          method: "POST",
          headers: { Origin: ORIGIN },
        });

      it("ends the session, clears the cookies and does not sign straight back in", async () => {
        const { shop, browser } = await signIn();
        const id = sessionId(browser);
        const stale = browser.request("/app");
        const outcome = await signOut(browser, `/auth/logout?shop=${shop}`);
        expect(outcome).toMatchObject({
          status: 302,
          location: "/auth/login",
        });
        expect(await prisma.session.count({ where: { id } })).toBe(0);
        expect(browser.jar.hasSession()).toBe(false);
        expect(browser.jar.has("syncpilot_stores")).toBe(false);
        // The old cookie, replayed, is worth nothing.
        expect((await run(layout, stale)).status).toBe(302);
        // A tab still on that store's address is asked, and nothing starts by itself.
        const after = await run(layout, browser.request("/app"));
        expect(new URL(after.location!, ORIGIN).pathname).toBe("/auth/login");
        const asked = await browser.visit(login, after.location!);
        expect(asked).toMatchObject({
          status: 200,
          data: { confirming: shop },
        });
        expect(browser.jar.has(flowCookieName(shop))).toBe(false);
        // And the bare address no longer knows the store at all.
        const bare = await run(layout, browser.raw("/app"));
        expect(new URL(bare.location!, ORIGIN).searchParams.has("shop")).toBe(
          false,
        );
        // The worker keeps the store's access.
        expect(
          await prisma.session.count({ where: { id: `offline_${shop}` } }),
        ).toBe(1);
      });

      it("ends only the store it names: the other stays signed in, remembered and working", async () => {
        const a = shopName("out-a");
        const b = shopName("out-b");
        const browser = new Browser();
        await signIn(a, OWNER, browser);
        await signIn(b, OWNER, browser);
        const idA = sessionId(browser, a);
        const idB = sessionId(browser, b);
        await signOut(browser, `/auth/logout?shop=${a}`);
        expect(await prisma.session.count({ where: { id: idA } })).toBe(0);
        expect(await prisma.session.count({ where: { id: idB } })).toBe(1);
        expect((await run(layout, browser.raw(dashboard(a)))).status).toBe(302);
        expect(await run(layout, browser.raw(dashboard(b)))).toMatchObject({
          status: 200,
          data: { shop: b, otherStores: [] },
        });
        // The page it lands on says what is still signed in.
        expect(await browser.visit(login, "/auth/login")).toMatchObject({
          data: { signedIn: [b] },
        });
        // A lapse of the other store still comes back without a question.
        await expireOnline(browser, b);
        expect(
          authorizeUrl(await browser.visit(login, `/auth/login?shop=${b}`))
            .hostname,
        ).toBe(b);
      });

      it("naming no store ends them all", async () => {
        const a = shopName("all-a");
        const b = shopName("all-b");
        const browser = new Browser();
        await signIn(a, OWNER, browser);
        await signIn(b, OWNER, browser);
        const ids = [sessionId(browser, a), sessionId(browser, b)];
        await signOut(browser, "/auth/logout");
        expect(await prisma.session.count({ where: { id: { in: ids } } })).toBe(
          0,
        );
        expect(browser.jar.hasSession()).toBe(false);
        expect(browser.jar.has("syncpilot_stores")).toBe(false);
        expect(await browser.visit(login, "/auth/login")).toMatchObject({
          data: { signedIn: [] },
        });
      });

      it("cannot be forced from another site", async () => {
        const { shop, browser } = await signIn();
        const outcome = await browser.visit(
          logout,
          `/auth/logout?shop=${shop}`,
          {
            method: "POST",
            headers: { Origin: "https://evil.example" },
          },
        );
        expect(outcome.status).toBe(403);
        expect((await run(layout, browser.request("/app"))).status).toBe(200);
      });

      it("cannot delete the offline session with a signed cookie naming it", async () => {
        const { shop } = await signIn();
        const signed = await appCookie(sessionCookieName(shop)).serialize(
          `offline_${shop}`,
        );
        const outcome = await run(
          logout,
          new Request(`${ORIGIN}/auth/logout?shop=${shop}`, {
            method: "POST",
            headers: {
              Origin: ORIGIN,
              Cookie: signed.split(";")[0],
            },
          }),
        );
        expect(outcome.status).toBe(302);
        expect(
          await prisma.session.count({ where: { id: `offline_${shop}` } }),
        ).toBe(1);
      });

      it("is harmless with no session", async () => {
        expect(
          await new Browser().visit(logout, "/auth/logout", {
            method: "POST",
            headers: { Origin: ORIGIN },
          }),
        ).toMatchObject({ status: 302, location: "/auth/login" });
      });

      it("does not take something that is not a store for a store: it ends them all", async () => {
        const { browser } = await signIn();
        const id = sessionId(browser);
        await signOut(browser, "/auth/logout?shop=not-a-store");
        expect(await prisma.session.count({ where: { id } })).toBe(0);
        expect(browser.jar.hasSession()).toBe(false);
      });

      it("the reminder of the stores stays small however many a browser signs in to", async () => {
        const browser = new Browser();
        const stores = Array.from({ length: 11 }, () => shopName("many"));
        for (const shop of stores) await signIn(shop, OWNER, browser);
        const remembered = (await appCookie("syncpilot_stores").parse(
          `syncpilot_stores=${browser.jar.get("syncpilot_stores")!.value}`,
        )) as string[];
        expect(remembered).toEqual(stores.slice(1).reverse());
        // The sessions do not depend on it: the eleventh still opens, and is offered.
        expect(
          await run(layout, browser.raw(dashboard(stores[0]))),
        ).toMatchObject({ status: 200 });
        expect(await browser.visit(login, "/auth/login")).toMatchObject({
          data: { signedIn: expect.arrayContaining(stores) },
        });
      });
    });

    describe("secrets", () => {
      it("no token, refresh token, code or state reaches a URL, a log line or a cookie", async () => {
        const logged: unknown[][] = [];
        for (const method of ["log", "info", "warn", "error", "debug"] as const)
          vi.spyOn(console, method).mockImplementation((...args) => {
            logged.push(args);
          });
        for (const method of ["info", "warn", "error", "debug"] as const)
          vi.spyOn(logger, method).mockImplementation(((...args: unknown[]) => {
            logged.push(args);
          }) as never);

        const shop = shopName();
        const browser = new Browser();
        const seen: string[] = [];
        const trail = (outcome: Outcome) => {
          seen.push(outcome.location ?? "", ...outcome.setCookies);
          return outcome;
        };
        let step = trail(await startSignIn(browser, shop));
        // A forged state makes the library log what it held; that must not get out.
        const forged = authorizeUrl(step);
        const heldState = forged.searchParams.get("state")!;
        trail(
          await browser.visit(
            callback,
            shopifyCallback(forged, "offered", { state: "forged-state" }),
          ),
        );
        step = trail(await startSignIn(browser, shop));
        const online = onlineGrant(OWNER);
        stub.grants.set("online-code", online);
        const onlineState = authorizeUrl(step).searchParams.get("state")!;
        step = trail(
          await browser.visit(
            callback,
            shopifyCallback(authorizeUrl(step), "online-code"),
          ),
        );
        const offline = offlineGrant();
        stub.grants.set("offline-code", offline);
        const done = trail(
          await browser.visit(
            callback,
            shopifyCallback(authorizeUrl(step), "offline-code"),
          ),
        );
        expect(done.location).toBe(dashboard(shop));
        browser.showing = shop;
        const page = await run(layout, browser.request("/app"));
        expect(page.status).toBe(200);
        // An action shows the person's token to Shopify, in a header and nowhere else.
        const acted = await browser.post(
          stores,
          "/app/stores",
          "intent=nothing",
        );
        expect(acted.status).toBe(200);
        // The worker path, with a refresh, logs through the same places.
        await prisma.session.update({
          where: { id: `offline_${shop}` },
          data: { expires: new Date(Date.now() - HOUR) },
        });
        const refreshed = offlineGrant();
        stub.refresh = () => stub.json(refreshed);
        await shopifyRequest(shop, INSTALLATION_CHECK_QUERY);

        const secrets = [
          offline.access_token,
          offline.refresh_token,
          online.access_token,
          refreshed.access_token,
          refreshed.refresh_token,
        ];
        const everything = JSON.stringify([
          logged.map((args) => args.map(String)),
          logged,
        ]);
        for (const secret of [
          ...secrets,
          "offline-code",
          "online-code",
          heldState,
          onlineState,
        ])
          expect(everything).not.toContain(secret);
        const urlsAndCookies = seen.join("\n");
        for (const secret of secrets)
          expect(urlsAndCookies).not.toContain(secret);
        expect(JSON.stringify(page.data)).not.toContain("shp");
        // The tokens are in the database, encrypted, and nowhere plain.
        const rows = await prisma.session.findMany({ where: { shop } });
        for (const secret of secrets)
          expect(
            JSON.stringify(rows, (_, value) =>
              typeof value === "bigint" ? String(value) : value,
            ),
          ).not.toContain(secret);
      });
    });

    describe("two stores in one browser", () => {
      const OTHER_OWNER: User = { id: 102, account_owner: true };
      /** Store A in one tab, then store B signed in to in another, in one browser. */
      const twoStores = async () => {
        const a = shopName("tab-a");
        const b = shopName("tab-b");
        const browser = new Browser();
        const first = await signIn(a, OWNER, browser);
        const second = await signIn(b, OTHER_OWNER, browser);
        return {
          a,
          b,
          browser,
          tokens: {
            [a]: first.grants[0].access_token,
            [b]: second.grants[0].access_token,
          },
        };
      };
      const postTo = (
        browser: Browser,
        path: string,
        body = "intent=anything",
        method = "POST",
      ) =>
        browser.raw(path, {
          method,
          headers: { ...FORM, Origin: ORIGIN },
          body,
        });

      it("signing in to the second leaves the first store's session and its pages as they were", async () => {
        const a = shopName("tab-a");
        const b = shopName("tab-b");
        const browser = new Browser();
        await signIn(a, OWNER, browser);
        const first = sessionId(browser, a);
        await signIn(b, OWNER, browser);
        expect(sessionId(browser, a)).toBe(first);
        expect(sessionId(browser, b)).not.toBe(first);
        expect(await prisma.session.count({ where: { id: first } })).toBe(1);
        expect(await run(layout, browser.raw(dashboard(a)))).toMatchObject({
          status: 200,
          data: { shop: a, otherStores: [b] },
        });
        expect(await run(layout, browser.raw(dashboard(b)))).toMatchObject({
          status: 200,
          data: { shop: b, otherStores: [a] },
        });
      });

      it("every action runs on the store its own address names, with that store's token, whichever was opened last", async () => {
        const { a, b, browser, tokens } = await twoStores();
        for (const [file, action] of await everyAction())
          for (const shop of [a, b, a]) {
            stub.outbound.length = 0;
            const request = postTo(browser, dashboard(shop, "/app/anything"));
            const outcome = await run(action, request);
            expect(outcome.status, file).not.toBe(401);
            expect(request.bodyUsed, file).toBe(true);
            expect(stub.outbound, file).toEqual([
              {
                url: `https://${shop}/admin/api/2026-10/graphql.json`,
                token: tokens[shop],
              },
            ]);
          }
      });

      describe.each(STATE_CHANGING)("with a %s", (method) => {
        it.each([
          ["names no store", ""],
          ["names something that is not a store", "?shop=not-a-store"],
          ["names no store it can believe", "?shop=A&shop=B"],
        ])(
          "every action refuses an address that %s, and nothing is applied",
          async (_, query) => {
            const { a, b, browser } = await twoStores();
            const before = await databaseState();
            stub.outbound.length = 0;
            for (const [file, action] of await everyAction()) {
              const request = postTo(
                browser,
                `/app/anything${query.replace("A", a).replace("B", b)}`,
                undefined,
                method,
              );
              const outcome = await run(action, request);
              expect(outcome.status, file).toBe(400);
              expect(outcome.data, file).toEqual({ storeMissing: true });
              expect(request.bodyUsed, file).toBe(false);
            }
            expect(stub.outbound).toEqual([]);
            expect(await databaseState()).toEqual(before);
          },
        );

        it("every action refuses a store this browser has no session for, and nothing is applied", async () => {
          const { browser } = await twoStores();
          const third = (await signIn(shopName("tab-c"))).shop;
          const before = await databaseState();
          stub.outbound.length = 0;
          for (const [file, action] of await everyAction()) {
            const request = postTo(
              browser,
              dashboard(third, "/app/anything"),
              undefined,
              method,
            );
            const outcome = await run(action, request);
            expect(outcome.status, file).toBe(401);
            expect(outcome.data, file).toEqual({ signIn: true, shop: third });
            expect(request.bodyUsed, file).toBe(false);
          }
          expect(stub.outbound).toEqual([]);
          expect(await databaseState()).toEqual(before);
        });
      });

      it("a store's lapsed session stops only that store's actions", async () => {
        const { a, b, browser } = await twoStores();
        await expireOnline(browser, a);
        const lapsed = await run(
          stores,
          postTo(browser, dashboard(a, "/app/stores")),
        );
        expect(lapsed.status).toBe(401);
        expect(lapsed.data).toEqual({ signIn: true, shop: a });
        expect(
          (await run(stores, postTo(browser, dashboard(b, "/app/stores"))))
            .status,
        ).toBe(200);
      });

      it("a form body it cannot read as a form is refused outright, and one too large", async () => {
        const { shop, browser } = await signIn();
        const before = await databaseState();
        for (const [file, action] of await everyAction()) {
          expect(
            (
              await run(
                action,
                browser.request("/app/anything", {
                  method: "POST",
                  headers: {
                    Origin: ORIGIN,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ shop }),
                }),
              )
            ).status,
            file,
          ).toBe(415);
          expect(
            (
              await run(
                action,
                postTo(
                  browser,
                  dashboard(shop, "/app/anything"),
                  `filler=${"x".repeat(70_000)}`,
                ),
              )
            ).status,
            file,
          ).toBe(413);
        }
        expect(await databaseState()).toEqual(before);
      });

      it("settings and a stock pool land on the workspace of the store the tab was on, not the one opened last", async () => {
        const a = shopName("set-a");
        const b = shopName("set-b");
        const first = await pairedWorkspace(a, shopName("set-a2"));
        const second = await pairedWorkspace(b, shopName("set-b2"));
        const browser = new Browser();
        await signIn(a, OWNER, browser);
        await signIn(b, OWNER, browser);
        const { action: settings } =
          (await import("../../app/routes/app.settings")) as unknown as {
            action: Route;
          };
        const { action: pools } =
          (await import("../../app/routes/app.stock-pools")) as unknown as {
            action: Route;
          };
        const typed = new URLSearchParams({
          intent: "settings",
          name: "Typed for the first store",
          retentionDays: "7",
          retentionEnabled: "on",
          reconciliationMinutes: "360",
          failureThreshold: "3",
          lagMinutes: "15",
        }).toString();
        const pool = new URLSearchParams({
          intent: "create",
          name: "Typed for the first store",
          reference: "first",
          physical: "10",
          safetyBuffer: "0",
          centralLedgerConfirmed: "on",
        }).toString();
        expect(
          (
            await run(
              settings,
              postTo(browser, dashboard(a, "/app/settings"), typed),
            )
          ).data,
        ).toEqual({ success: expect.any(String) });
        expect(
          (
            await run(
              pools,
              postTo(browser, dashboard(a, "/app/stock-pools"), pool),
            )
          ).status,
        ).toBe(200);
        const named = async (id: string) =>
          (await prisma.workspace.findUniqueOrThrow({ where: { id } })).name;
        expect(await named(first)).toBe("Typed for the first store");
        expect(await named(second)).not.toBe("Typed for the first store");
        expect(
          await prisma.stockPool.count({ where: { workspaceId: first } }),
        ).toBe(1);
        expect(
          await prisma.stockPool.count({ where: { workspaceId: second } }),
        ).toBe(0);
      });

      it("pairs the two stores in one browser, with no signing in between, each step as the right store's owner", async () => {
        const { a, b, browser } = await twoStores();
        stub.tokenRequests.length = 0;
        const tabA = dashboard(a, "/app/stores");
        const tabB = dashboard(b, "/app/stores");
        const created = await run(stores, postTo(browser, tabA, initiate(b)));
        const { requestId, challenge } = created.data as {
          requestId: string;
          challenge: string;
        };
        expect(challenge).toEqual(expect.any(String));
        expect(await pairingsFrom(a)).toBe(1);
        expect(await pairingsFrom(b)).toBe(0);
        const accepted = await run(
          stores,
          postTo(
            browser,
            tabB,
            new URLSearchParams({
              intent: "accept",
              requestId,
              challenge,
              organizationConfirmed: "on",
            }).toString(),
          ),
        );
        expect(accepted.status).toBe(200);
        expect(
          await prisma.storePairingRequest.findUniqueOrThrow({
            where: { id: requestId },
          }),
        ).toMatchObject({
          state: "ACCEPTED",
          initiatingShop: a,
          initiatingActor: "101",
          destinationShop: b,
          destinationActor: "102",
        });
        // The first tab was left on A all this time, and its Confirm still runs as A.
        const confirmed = await run(
          stores,
          postTo(browser, tabA, `intent=confirm&id=${requestId}`),
        );
        expect(confirmed.status).toBe(200);
        expect(
          await prisma.storePairingRequest.findUniqueOrThrow({
            where: { id: requestId },
          }),
        ).toMatchObject({ state: "VERIFIED" });
        const workspaces = await prisma.shopConnection.findMany({
          where: { shopDomain: { in: [a, b] } },
        });
        expect(workspaces.map(({ workspaceId }) => workspaceId)).toEqual([
          workspaces[0].workspaceId,
          workspaces[0].workspaceId,
        ]);
        expect(workspaces[0].workspaceId).not.toBeNull();
        // Nothing asked Shopify for a token, and both tabs carry on as they were.
        expect(stub.tokenRequests).toEqual([]);
        for (const shop of [a, b])
          expect(await run(layout, browser.raw(dashboard(shop)))).toMatchObject(
            { status: 200, data: { shop, owner: true } },
          );
      });

      it("an action in a browser signed in to nothing reads as signed out, whichever store it names", async () => {
        const browser = new Browser();
        const shop = shopName();
        expect(
          await run(stores, postTo(browser, dashboard(shop, "/app/stores"))),
        ).toMatchObject({ status: 401, data: { signIn: true, shop } });
      });
    });

    const personGets = (
      answer: (init?: RequestInit) => Response | Promise<Response>,
    ) => {
      const normal = stub.graphql;
      stub.graphql = (shop, token, init) =>
        token?.startsWith("shpua_") ? answer(init) : normal(shop, token, init);
    };
    const refused = () =>
      stub.json({ errors: "[API] Invalid API key or access token" }, 401);
    const stillLive = () =>
      stub.json({ data: { shop: { id: "gid://shopify/Shop/1" } } });
    /** Every answer but a 401: none of them says the person's token works, or that it does not. */
    const provesNothing: [string, () => Response][] = [
      ["a 500", () => stub.json({ errors: "broken" }, 500)],
      ["a 429", () => stub.json({ errors: "slow down" }, 429)],
      ["a 402, which means a frozen store", () => stub.json({}, 402)],
      ["a 403, which means a fraud flag", () => stub.json({}, 403)],
      ["a 404", () => stub.json({}, 404)],
      ["a 423, which means a locked store", () => stub.json({}, 423)],
      [
        "ACCESS_DENIED, which is not a read that worked",
        () =>
          stub.json({
            data: null,
            errors: [
              {
                message: "Access denied",
                extensions: { code: "ACCESS_DENIED" },
              },
            ],
          }),
      ],
      [
        "a throttle in a 200",
        () =>
          stub.json({
            errors: [
              { message: "Throttled", extensions: { code: "THROTTLED" } },
            ],
          }),
      ],
      ["an answer with no shop in it", () => stub.json({ data: {} })],
      [
        "an answer that is not JSON",
        () => new Response("<html></html>", { status: 200 }),
      ],
      [
        "a failure to connect",
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    ];

    describe("proving a person's sign-in to Shopify before an action", () => {
      const post = (browser: Browser, shop: string, method = "POST") =>
        browser.raw(dashboard(shop, "/app/anything"), {
          method,
          headers: { ...FORM, Origin: ORIGIN },
          body: "intent=anything",
        });

      describe.each(STATE_CHANGING)("with a %s", (method) => {
        it("every action, for a token Shopify refuses: the session ends and nothing is applied", async () => {
          personGets(refused);
          for (const [file, action] of await everyAction()) {
            const { shop, browser } = await signIn();
            const id = sessionId(browser);
            const before = await databaseState("Session");
            const request = post(browser, shop, method);
            const outcome = await run(action, request);
            browser.absorb(outcome.setCookies);
            expect(outcome.status, file).toBe(401);
            expect(outcome.data, file).toEqual({ signIn: true, shop });
            expect(request.bodyUsed, file).toBe(false);
            expect(await prisma.session.count({ where: { id } })).toBe(0);
            expect(browser.jar.hasSession(), file).toBe(false);
            expect(await databaseState("Session"), file).toEqual(before);
            // The worker's access is a different matter.
            expect(
              await prisma.session.count({ where: { id: `offline_${shop}` } }),
            ).toBe(1);
          }
        });

        it("every action, when Shopify cannot answer: still signed in, nothing is applied", async () => {
          personGets(() => stub.json({ errors: "unavailable" }, 503));
          const { shop, browser } = await signIn();
          const id = sessionId(browser);
          const before = await databaseState();
          for (const [file, action] of await everyAction()) {
            const request = post(browser, shop, method);
            const outcome = await run(action, request);
            expect(outcome.status, file).toBe(503);
            expect(outcome.data, file).toEqual({ tryAgain: true });
            expect(outcome.retryAfter, file).toBe("10");
            expect(outcome.setCookies, file).toEqual([]);
            expect(request.bodyUsed, file).toBe(false);
          }
          expect(await prisma.session.count({ where: { id } })).toBe(1);
          expect(await databaseState()).toEqual(before);
        });
      });

      it.each(provesNothing)(
        "%s proves nothing: nothing is applied and the session stays",
        async (_, answer) => {
          const { shop, browser } = await signIn();
          const dest = shopName("dest");
          await ensureInstallation({ shop: dest, userId: "9", role: "OWNER" });
          personGets(answer);
          const id = sessionId(browser);
          const outcome = await browser.post(
            stores,
            "/app/stores",
            initiate(dest),
          );
          expect(outcome.status).toBe(503);
          expect(outcome.data).toEqual({ tryAgain: true });
          expect(await pairingsFrom(shop)).toBe(0);
          expect(await prisma.session.count({ where: { id } })).toBe(1);
          expect((await run(layout, browser.request("/app"))).status).toBe(200);
        },
      );

      it("Shopify not answering in time counts as not answering, with one attempt", async () => {
        const { shop, browser } = await signIn();
        const real = AbortSignal.timeout.bind(AbortSignal);
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
          real(ms === SESSION_CHECK_DEADLINE_MS ? 20 : ms),
        );
        let asked = 0;
        personGets(
          (init) =>
            new Promise((_, reject) => {
              asked += 1;
              init?.signal?.addEventListener("abort", () =>
                reject(init.signal!.reason),
              );
            }),
        );
        const outcome = await browser.post(
          stores,
          "/app/stores",
          initiate(shopName("dest")),
        );
        expect(outcome.status).toBe(503);
        expect(asked).toBe(1);
        expect(await pairingsFrom(shop)).toBe(0);
      });

      it("a person who was refused signs in again and lands on the same page", async () => {
        personGets(refused);
        const { shop, browser } = await signIn();
        await browser.post(stores, "/app/stores", "intent=anything");
        const page = await run(layout, browser.request("/app/stores"));
        expect(page.status).toBe(302);
        const target = new URL(page.location!, ORIGIN);
        expect(target.searchParams.get("shop")).toBe(shop);
        const { final, trips } = await atShopify(
          browser,
          await browser.visit(login, `${target.pathname}${target.search}`),
        );
        expect(trips).toEqual(["online"]);
        expect(final.location).toBe(dashboard(shop, "/app/stores"));
      });

      it("a refusal ends that store's session and no other", async () => {
        const a = shopName("refused-a");
        const b = shopName("refused-b");
        const browser = new Browser();
        const first = await signIn(a, OWNER, browser);
        await signIn(b, OWNER, browser);
        personGets((init) =>
          new Headers(init?.headers).get("X-Shopify-Access-Token") ===
          first.grants[0].access_token
            ? refused()
            : stillLive(),
        );
        const idB = sessionId(browser, b);
        const outcome = await run(stores, post(browser, a));
        browser.absorb(outcome.setCookies);
        expect(outcome.status).toBe(401);
        expect(outcome.data).toEqual({ signIn: true, shop: a });
        expect(browser.jar.has(sessionCookieName(a))).toBe(false);
        expect(sessionId(browser, b)).toBe(idB);
        expect((await run(stores, post(browser, b))).status).toBe(200);
      });

      it("asks once for a request, however often it is authenticated", async () => {
        const { shop, browser } = await signIn();
        const { authenticate } = await import("../../app/shopify.server");
        const request = post(browser, shop);
        stub.outbound.length = 0;
        await Promise.all([
          authenticate.admin(request),
          authenticate.admin(request),
        ]);
        await authenticate.admin(request);
        expect(stub.outbound).toHaveLength(1);
        // Nothing has touched the action's copy of the form.
        expect((await request.formData()).get("intent")).toBe("anything");
      });

      it("an action over its limit does not ask", async () => {
        const { shop, browser } = await signIn();
        await prisma.requestRateLimit.create({
          data: {
            key: rateLimitKey(
              "user:write",
              JSON.stringify([shop, String(OWNER!.id)]),
            ),
            count: RATE_LIMITS.userWrite,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        stub.outbound.length = 0;
        const outcome = await run(stores, post(browser, shop));
        expect(outcome.status).toBe(429);
        expect(stub.outbound).toEqual([]);
      });

      it("nothing about the check reaches a log, and a refusal says only what happened", async () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation((() => {
          return undefined;
        }) as never);
        personGets(refused);
        const { shop, browser, grants } = await signIn();
        await run(stores, post(browser, shop));
        expect(warn).toHaveBeenCalledWith(
          { shop, answer: "refused" },
          expect.any(String),
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          grants[0].access_token,
        );
      });
    });

    describe("asking Shopify about a person's sign-in when a page opens", () => {
      afterEach(restoreProcessClock);
      /** A page opened when the last answer no longer holds, as any will be in time. */
      const threeMinutesOn = () => skewProcessClock(3 * MINUTE);
      const tokenSent = (init?: RequestInit) =>
        new Headers(init?.headers).get("X-Shopify-Access-Token");
      const personAsked = () =>
        stub.outbound.filter(({ token }) => token?.startsWith("shpua_"));
      /** Shopify takes the question and answers when this test says. */
      const personKeptWaiting = () => {
        const answer = held<Response>();
        personGets(() => answer.answer);
        return answer;
      };

      it.each(["GET", "HEAD"])(
        "on a %s, a token Shopify refuses ends that store's session and goes to sign in, keeping the page",
        async (method) => {
          const browser = new Browser();
          const a = await signIn(shopName("page-a"), OWNER, browser);
          const b = await signIn(shopName("page-b"), OWNER, browser);
          const [idA, idB] = [
            sessionId(browser, a.shop),
            sessionId(browser, b.shop),
          ];
          personGets((init) =>
            tokenSent(init) === a.grants[0].access_token
              ? refused()
              : stillLive(),
          );
          threeMinutesOn();
          stub.outbound.length = 0;
          const outcome = await run(
            layout,
            browser.raw(dashboard(a.shop, "/app/rules?edit=abc"), { method }),
          );
          browser.absorb(outcome.setCookies);
          expect(outcome.status).toBe(302);
          expect(outcome.reloadsDocument).toBe(true);
          const target = new URL(outcome.location!, ORIGIN);
          expect(target.pathname).toBe("/auth/login");
          expect(target.searchParams.get("shop")).toBe(a.shop);
          expect(target.searchParams.get("return_to")).toBe(
            "/app/rules?edit=abc",
          );
          expect(personAsked()).toHaveLength(1);
          expect(await prisma.session.count({ where: { id: idA } })).toBe(0);
          expect(browser.jar.has(sessionCookieName(a.shop))).toBe(false);
          // The other store has not been touched, and neither has the worker's access.
          expect(await prisma.session.count({ where: { id: idB } })).toBe(1);
          expect(sessionId(browser, b.shop)).toBe(idB);
          expect(
            await run(layout, browser.raw(dashboard(b.shop))),
          ).toMatchObject({ status: 200, data: { shop: b.shop } });
          expect(
            await prisma.session.count({ where: { id: `offline_${a.shop}` } }),
          ).toBe(1);
        },
      );

      it("ends one person's sign-in to a store, and no one else's there", async () => {
        const { shop, browser, grants } = await signIn();
        const staff = await signIn(shop, STAFF);
        personGets((init) =>
          tokenSent(init) === grants[0].access_token ? refused() : stillLive(),
        );
        threeMinutesOn();
        expect((await run(layout, browser.request("/app"))).status).toBe(302);
        expect((await run(layout, staff.browser.request("/app"))).status).toBe(
          200,
        );
      });

      it("asks at most once in three minutes for a session, and again after that", async () => {
        const { browser } = await signIn();
        personGets(stillLive);
        const page = async () =>
          expect((await run(layout, browser.request("/app"))).status).toBe(200);
        threeMinutesOn();
        stub.outbound.length = 0;
        await page();
        await page();
        expect(personAsked()).toHaveLength(1);
        skewProcessClock(3 * MINUTE - 1000);
        await page();
        expect(personAsked()).toHaveLength(1);
        skewProcessClock(1000);
        await page();
        await page();
        expect(personAsked()).toHaveLength(2);
      });

      it("asks for each session on its own", async () => {
        const first = await signIn();
        const second = await signIn(first.shop, STAFF);
        personGets(stillLive);
        threeMinutesOn();
        stub.outbound.length = 0;
        for (const { browser } of [first, second, first, second])
          expect((await run(layout, browser.request("/app"))).status).toBe(200);
        expect(personAsked().map(({ token }) => token)).toEqual([
          first.grants[0].access_token,
          second.grants[0].access_token,
        ]);
      });

      it.each(provesNothing)(
        "%s lets the page through as if nothing had been asked, and holds for three minutes",
        async (_, answer) => {
          const { browser } = await signIn();
          const id = sessionId(browser);
          personGets(answer);
          threeMinutesOn();
          stub.outbound.length = 0;
          for (let page = 0; page < 3; page += 1)
            expect(await run(layout, browser.request("/app"))).toMatchObject({
              status: 200,
              setCookies: [],
            });
          expect(personAsked()).toHaveLength(1);
          expect(await prisma.session.count({ where: { id } })).toBe(1);
          // It is only that long: a token refused later is still noticed.
          personGets(refused);
          skewProcessClock(3 * MINUTE);
          expect((await run(layout, browser.request("/app"))).status).toBe(302);
        },
      );

      it("waits three seconds at most, once, so a slow Shopify does not slow every navigation", async () => {
        const { browser } = await signIn();
        const real = AbortSignal.timeout.bind(AbortSignal);
        const deadlines = vi
          .spyOn(AbortSignal, "timeout")
          .mockImplementation((ms) => real(ms === 3_000 ? 20 : ms));
        personGets(
          (init) =>
            new Promise((_, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(init.signal!.reason),
              );
            }),
        );
        threeMinutesOn();
        stub.outbound.length = 0;
        for (let page = 0; page < 3; page += 1)
          expect((await run(layout, browser.request("/app"))).status).toBe(200);
        expect(personAsked()).toHaveLength(1);
        expect(deadlines).toHaveBeenCalledWith(3_000);
      });

      it("one page load's loaders share one question, as does any other request for that session meanwhile", async () => {
        const { browser } = await signIn();
        const answer = personKeptWaiting();
        threeMinutesOn();
        stub.outbound.length = 0;
        const page = Promise.all([
          run(layout, browser.request("/app/stores")),
          run(storesPage, browser.request("/app/stores")),
        ]);
        await until(() => personAsked().length);
        await pause(200);
        expect(personAsked()).toHaveLength(1);
        answer.release(stillLive());
        for (const outcome of await page) expect(outcome.status).toBe(200);
        expect(personAsked()).toHaveLength(1);
      });

      it("when that one answer is a refusal, each loader goes to sign in on it", async () => {
        const { shop, browser } = await signIn();
        const id = sessionId(browser);
        const answer = personKeptWaiting();
        threeMinutesOn();
        stub.outbound.length = 0;
        const page = Promise.all([
          run(layout, browser.request("/app/stores")),
          run(storesPage, browser.request("/app/stores")),
        ]);
        await until(() => personAsked().length);
        await pause(200);
        answer.release(refused());
        for (const outcome of await page) {
          expect(outcome.status).toBe(302);
          expect(
            new URL(outcome.location!, ORIGIN).searchParams.get("shop"),
          ).toBe(shop);
          expect(outcome.setCookies.join()).toContain(sessionCookieName(shop));
        }
        expect(personAsked()).toHaveLength(1);
        expect(await prisma.session.count({ where: { id } })).toBe(0);
      });

      it("the first page after a sign-in does not ask: Shopify has only just answered", async () => {
        personGets(refused);
        const { browser } = await signIn();
        stub.outbound.length = 0;
        expect((await run(layout, browser.request("/app"))).status).toBe(200);
        skewProcessClock(2 * MINUTE);
        expect((await run(layout, browser.request("/app"))).status).toBe(200);
        expect(stub.outbound).toEqual([]);
        skewProcessClock(MINUTE);
        expect((await run(layout, browser.request("/app"))).status).toBe(302);
      });

      it("a person sent to sign in comes back to the same page, and is not sent round again", async () => {
        personGets(refused);
        const { shop, browser } = await signIn();
        threeMinutesOn();
        const asked = await browser.visit(layout, "/app/rules?edit=abc");
        const { final, trips } = await atShopify(
          browser,
          await browser.visit(login, asked.location!),
        );
        expect(trips).toEqual(["online"]);
        expect(final.location).toBe(dashboard(shop, "/app/rules?edit=abc"));
        stub.outbound.length = 0;
        expect(
          (await run(layout, browser.request("/app/rules?edit=abc"))).status,
        ).toBe(200);
        expect(stub.outbound).toEqual([]);
      });

      it("every page answers to it, not only the layout", async () => {
        const modules = import.meta.glob<{ loader?: Route }>(
          "../../app/routes/app.*.tsx",
        );
        expect(Object.keys(modules).length).toBeGreaterThanOrEqual(13);
        personGets(refused);
        for (const [file, load] of Object.entries(modules)) {
          const { loader } = await load();
          const { browser } = await signIn();
          threeMinutesOn();
          const outcome = await run(loader!, browser.request("/app/page"));
          restoreProcessClock();
          expect(outcome.status, file).toBe(302);
          expect(outcome.reloadsDocument, file).toBe(true);
        }
      });

      it("a page over its limit does not ask", async () => {
        const { shop, browser } = await signIn();
        await prisma.requestRateLimit.create({
          data: {
            key: rateLimitKey(
              "user:read",
              JSON.stringify([shop, String(OWNER!.id)]),
            ),
            count: RATE_LIMITS.userRead,
            expiresAt: new Date(Date.now() + MINUTE),
          },
        });
        threeMinutesOn();
        stub.outbound.length = 0;
        expect((await run(layout, browser.request("/app"))).status).toBe(429);
        expect(stub.outbound).toEqual([]);
      });

      it("an action still asks every time, whatever the pages were told", async () => {
        const { shop, browser } = await signIn();
        personGets(stillLive);
        threeMinutesOn();
        stub.outbound.length = 0;
        const post = () =>
          browser.post(stores, "/app/stores", "intent=nothing");
        expect((await run(layout, browser.request("/app"))).status).toBe(200);
        expect((await post()).status).toBe(200);
        expect((await post()).status).toBe(200);
        expect(personAsked()).toHaveLength(3);
        // A page has just been told this token works, and an action is still refused.
        personGets(refused);
        expect((await post()).status).toBe(401);
        expect((await run(layout, browser.request("/app"))).status).toBe(302);
        expect(
          await prisma.session.count({ where: { shop, isOnline: true } }),
        ).toBe(0);
      });

      it("nothing about the check reaches a log but the store and what happened", async () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation((() => {
          return undefined;
        }) as never);
        personGets(refused);
        const { shop, browser, grants } = await signIn();
        threeMinutesOn();
        await run(layout, browser.request("/app"));
        expect(warn).toHaveBeenCalledWith(
          { shop, answer: "refused" },
          expect.any(String),
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          grants[0].access_token,
        );
      });
    });

    describe("a link naming a store", () => {
      const crossSite = { headers: { "Sec-Fetch-Site": "cross-site" } };
      const noOAuthStarted = (browser: Browser, shop: string) => {
        expect(browser.jar.has(stateCookieName(shop))).toBe(false);
        expect(browser.jar.has(flowCookieName(shop))).toBe(false);
      };
      /** A browser signed in to one store, and another store that uses the app. */
      const signedInToOne = async () => {
        const other = await signIn(shopName("link-b"));
        const here = await signIn(shopName("link-a"));
        return { a: here.shop, b: other.shop, browser: here.browser };
      };

      it("asks first and changes nothing, however the link arrives", async () => {
        const { a, b, browser } = await signedInToOne();
        const id = sessionId(browser);
        stub.outbound.length = 0;
        for (const path of [
          `/auth/login?shop=${b}`,
          `/auth/login?shop=${b}&return_to=${encodeURIComponent("/app/rules")}`,
        ]) {
          const outcome = await browser.visit(login, path, crossSite);
          expect(outcome, path).toMatchObject({
            status: 200,
            location: null,
            setCookies: [],
            data: { errors: {}, confirming: b },
          });
        }
        // The two other doors lead to the same question.
        const fromApp = await browser.visit(
          layout,
          `/app?shop=${b}`,
          crossSite,
        );
        expect(new URL(fromApp.location!, ORIGIN).pathname).toBe("/auth/login");
        const fromLanding = await browser.visit(
          index,
          `/?shop=${b}`,
          crossSite,
        );
        expect(new URL(fromLanding.location!, ORIGIN).pathname).toBe(
          "/auth/login",
        );
        noOAuthStarted(browser, b);
        expect(stub.outbound).toEqual([]);
        expect(sessionId(browser, a)).toBe(id);
        expect(await prisma.session.count({ where: { id } })).toBe(1);
        expect(await run(layout, browser.raw(dashboard(a)))).toMatchObject({
          status: 200,
          data: { shop: a },
        });
      });

      it("asks a browser that is signed in to nothing as well", async () => {
        const shop = shopName();
        const browser = new Browser();
        expect(await linkTo(browser, shop, "/app/rules")).toMatchObject({
          status: 200,
          setCookies: [],
          data: { confirming: shop },
        });
        noOAuthStarted(browser, shop);
      });

      it("the person's own post from that page signs in to it, comes back to the page, and leaves the first store signed in", async () => {
        const { a, b, browser } = await signedInToOne();
        const id = sessionId(browser, a);
        const started = await browser.post(
          loginForm,
          `/auth/login?shop=${b}&return_to=${encodeURIComponent("/app/rules")}`,
          new URLSearchParams({
            shop: b,
            return_to: "/app/rules",
          }).toString(),
        );
        expect(authorizeUrl(started).hostname).toBe(b);
        const { final } = await atShopify(browser, started);
        expect(final.location).toBe(dashboard(b, "/app/rules"));
        expect(await prisma.session.count({ where: { id } })).toBe(1);
        for (const shop of [a, b])
          expect(await run(layout, browser.raw(dashboard(shop)))).toMatchObject(
            { status: 200, data: { shop } },
          );
      });

      it.each<[string, Record<string, string>]>([
        ["another site's Origin", { Origin: "https://evil.example" }],
        ["no Origin at all", { Origin: "" }],
        ["a cross-site fetch", { Origin: "", "Sec-Fetch-Site": "cross-site" }],
      ])("a post with %s cannot start a sign-in", async (_, headers) => {
        const { a, b, browser } = await signedInToOne();
        const id = sessionId(browser, a);
        const request = browser.raw("/auth/login", {
          method: "POST",
          headers: FORM,
          body: `shop=${b}`,
        });
        const sent = new Headers(request.headers);
        for (const [name, value] of Object.entries(headers))
          if (value) sent.set(name, value);
        const outcome = await run(
          loginForm,
          new Request(request, { headers: sent }),
        );
        expect(outcome.status).toBe(403);
        expect(outcome.setCookies).toEqual([]);
        expect(sessionId(browser, a)).toBe(id);
      });

      it("a post from another site is refused with no cookie as well, as SameSite would send it", async () => {
        const outcome = await new Browser().visit(loginForm, "/auth/login", {
          method: "POST",
          headers: { ...FORM, Origin: "https://evil.example" },
          body: `shop=${shopName()}`,
        });
        expect(outcome.status).toBe(403);
      });

      it("a store this browser has a live session for opens at once, with no trip to Shopify", async () => {
        const { a, browser } = await signedInToOne();
        const id = sessionId(browser, a);
        expect(await linkTo(browser, a, "/app/rules")).toMatchObject({
          status: 302,
          location: dashboard(a, "/app/rules"),
          setCookies: [],
        });
        expect(sessionId(browser, a)).toBe(id);
      });

      it.each([undefined, "none", "same-origin"])(
        "a store it was signed in to comes back through Shopify with no question once its session has lapsed, with Sec-Fetch-Site %s",
        async (sentBy) => {
          const { a, browser } = await signedInToOne();
          await expireOnline(browser, a);
          const { trips, final } = await atShopify(
            browser,
            await browser.visit(
              login,
              `/auth/login?shop=${a}&return_to=${encodeURIComponent("/app/rules")}`,
              { headers: sentBy ? { "Sec-Fetch-Site": sentBy } : {} },
            ),
          );
          expect(trips).toEqual(["online"]);
          expect(final.location).toBe(dashboard(a, "/app/rules"));
        },
      );

      it.each(["cross-site", "same-site"])(
        "a %s link still asks, even for a store it was signed in to",
        async (sentBy) => {
          const { a, browser } = await signedInToOne();
          await expireOnline(browser, a);
          stub.tokenRequests.length = 0;
          const headers = { "Sec-Fetch-Site": sentBy };
          const page = await browser.visit(layout, dashboard(a), { headers });
          expect(new URL(page.location!, ORIGIN).pathname).toBe("/auth/login");
          expect(
            await browser.visit(login, page.location!, { headers }),
          ).toMatchObject({
            status: 200,
            setCookies: [],
            data: { confirming: a },
          });
          noOAuthStarted(browser, a);
          // A live session has nothing to start, so it opens wherever the link is from.
          await signIn(a, OWNER, browser);
          expect(
            await browser.visit(login, `/auth/login?shop=${a}`, { headers }),
          ).toMatchObject({ status: 302, location: dashboard(a) });
        },
      );

      it("a forged reminder of a store does not stand in for the person's post", async () => {
        const shop = shopName();
        const browser = new Browser();
        browser.jar.set("syncpilot_stores", {
          value: encodeURIComponent(btoa(JSON.stringify([shop]))),
          path: "/",
          until: Infinity,
        });
        expect(await linkTo(browser, shop)).toMatchObject({
          status: 200,
          data: { confirming: shop },
        });
        noOAuthStarted(browser, shop);
      });

      it("a Shopify-signed link does not stop to ask", async () => {
        const { b, browser } = await signedInToOne();
        const load = `/?${signedQuery({ shop: b, timestamp: now() })}`;
        expect(authorizeUrl(await browser.visit(index, load)).hostname).toBe(b);
      });
    });

    describe("two sign-ins at once in one browser", () => {
      it.each([
        ["the earlier", [0, 1]],
        ["the later", [1, 0]],
      ])(
        "for two stores: both finish whichever comes back first, here %s",
        async (_, order) => {
          const stores = [shopName("over-a"), shopName("over-b")];
          const browser = new Browser();
          const started = [
            await startSignIn(browser, stores[0]),
            await startSignIn(browser, stores[1]),
          ];
          for (const index of order) {
            const { final } = await atShopify(browser, started[index]);
            expect(final.location).toBe(dashboard(stores[index]));
          }
          for (const shop of stores)
            expect(
              await run(layout, browser.raw(dashboard(shop))),
            ).toMatchObject({ status: 200, data: { shop } });
        },
      );

      it("two stores that also need an offline token still do not touch each other", async () => {
        const a = await signIn(shopName("over-a"));
        const b = await signIn(shopName("over-b"));
        await prisma.session.deleteMany({
          where: { id: { in: [`offline_${a.shop}`, `offline_${b.shop}`] } },
        });
        const browser = new Browser();
        const started = [
          await startSignIn(browser, a.shop),
          await startSignIn(browser, b.shop),
        ];
        const trips = [
          await atShopify(browser, started[0]),
          await atShopify(browser, started[1]),
        ];
        expect(trips.map((flow) => flow.trips)).toEqual([
          ["online", "offline"],
          ["online", "offline"],
        ]);
      });

      it("for one store: the earlier is told what happened and spends nothing, then comes to the dashboard once the later has finished", async () => {
        const { shop } = await signIn();
        const browser = new Browser();
        const earlier = await startSignIn(browser, shop);
        const later = await startSignIn(browser, shop);
        stub.tokenRequests.length = 0;
        const earlyAnswer = shopifyCallback(authorizeUrl(earlier), "spent");
        const told = await browser.visit(callback, earlyAnswer);
        expect(told.status).toBe(400);
        expect(told.data).toEqual({
          problem: expect.stringContaining("Another sign-in to this store"),
        });
        expect(stub.tokenRequests).toEqual([]);
        await atShopify(browser, later);
        stub.tokenRequests.length = 0;
        expect(await browser.visit(callback, earlyAnswer)).toMatchObject({
          status: 302,
          location: dashboard(shop),
        });
        expect(stub.tokenRequests).toEqual([]);
      });

      it("an answer without Shopify's signature is never called an overlap", async () => {
        const shop = shopName();
        const browser = new Browser();
        const authorize = authorizeUrl(await startSignIn(browser, shop));
        await startSignIn(browser, shop);
        const params = {
          code: "forged",
          shop,
          state: authorize.searchParams.get("state")!,
          timestamp: now(),
        };
        for (const answer of [
          new URLSearchParams(params),
          signedQuery(params, "not-the-secret"),
        ]) {
          const told = await browser.visit(
            callback,
            `/auth/callback?${answer}`,
          );
          expect(told.status).toBe(400);
          expect(told.data).toEqual({
            problem: expect.stringContaining("could not be verified"),
          });
        }
      });
    });

    describe("diagnosing a sign-in Shopify did not complete", () => {
      const logged = () =>
        vi.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
      const failing = async () => {
        const shop = shopName();
        const browser = new Browser();
        return {
          shop,
          browser,
          answer: shopifyCallback(
            authorizeUrl(await startSignIn(browser, shop)),
            "code",
          ),
        };
      };

      it("logs the kind of failure and Shopify's status, and not what it said", async () => {
        const warn = logged();
        const { shop, browser, answer } = await failing();
        const outcome = await browser.visit(callback, answer);
        expect(outcome.status).toBe(502);
        expect(warn).toHaveBeenCalledWith(
          {
            problem: "EXCHANGE_FAILED",
            shop,
            failure: "HttpResponseError",
            status: 400,
          },
          "Sign-in refused",
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          "invalid_request",
        );
      });

      it("logs a failure to connect as that", async () => {
        const warn = logged();
        const { shop, browser, answer } = await failing();
        stub.tokenEndpointDown = true;
        expect((await browser.visit(callback, answer)).status).toBe(502);
        expect(warn).toHaveBeenCalledWith(
          {
            problem: "EXCHANGE_FAILED",
            shop,
            failure: "TypeError",
            status: undefined,
          },
          "Sign-in refused",
        );
      });

      it("gives up on a token endpoint that does not answer", async () => {
        const { browser, answer } = await failing();
        shortenTokenDeadline();
        stub.tokenEndpointHangs = true;
        expect((await browser.visit(callback, answer)).status).toBe(502);
        expect(browser.jar.hasSession()).toBe(false);
      });
    });

    describe("when Shopify says someone no longer owns the store", () => {
      const FORMER: User = { id: 101, account_owner: false };
      const consent = (
        workspaceId: string,
        policyId: string,
        approvedBy: string,
      ) =>
        prisma.automaticConsent.create({
          data: {
            workspaceId,
            policyId,
            fingerprint: "synthetic-fingerprint",
            approvedBy,
            fields: ["title"],
            intervalMinutes: 15,
            maxJobs: 3,
            maxChanges: 10,
            perRunChanges: 5,
            expiresAt: new Date(Date.now() + HOUR),
          },
        });
      const paired = async () => {
        const a = shopName("former-a");
        const b = shopName("former-b");
        const workspaceId = await pairedWorkspace(a, b);
        const policy = await prisma.syncPolicy.create({
          data: {
            workspaceId,
            sourceShopDomain: a,
            targetShopDomain: b,
            fields: ["title"],
            syncProduct: true,
          },
        });
        return { a, b, workspaceId, policyId: policy.id };
      };
      const member = (
        workspaceId: string,
        shopDomain: string,
        userId: string,
      ) =>
        prisma.workspaceMember.findUniqueOrThrow({
          where: {
            workspaceId_shopDomain_userId: { workspaceId, shopDomain, userId },
          },
        });

      it("ends their owner row, the consents they gave and what those queued, and leaves the other owner's", async () => {
        const { a, b, workspaceId, policyId } = await paired();
        const theirs = await consent(workspaceId, policyId, `${a}:101`);
        const otherPolicy = await prisma.syncPolicy.create({
          data: {
            workspaceId,
            sourceShopDomain: b,
            targetShopDomain: a,
            fields: ["title"],
            syncProduct: true,
          },
        });
        const others = await consent(workspaceId, otherPolicy.id, `${b}:102`);
        const job = await prisma.syncJob.create({
          data: {
            workspaceId,
            policyId,
            sourceShop: a,
            targetShop: b,
            operation: "AUTO_PREVIEW",
            payload: { consentId: theirs.id },
            availableAt: new Date("2000-01-01"),
          },
        });
        await signIn(a, FORMER);
        expect(await member(workspaceId, a, "101")).toMatchObject({
          role: "VIEWER",
          status: "REVOKED",
        });
        expect(await member(workspaceId, b, "102")).toMatchObject({
          role: "OWNER",
          status: "ACTIVE",
        });
        expect(
          await prisma.automaticConsent.findUniqueOrThrow({
            where: { id: theirs.id },
          }),
        ).toMatchObject({ status: "REVOKED" });
        expect(
          await prisma.automaticConsent.findUniqueOrThrow({
            where: { id: others.id },
          }),
        ).toMatchObject({ status: "ACTIVE" });
        expect(
          await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } }),
        ).toMatchObject({ status: "CANCELLED" });
        expect(
          await prisma.auditEvent.count({
            where: { shopDomain: a, action: "OWNER_ROLE_ENDED" },
          }),
        ).toBe(1);
        expect(
          await prisma.auditEvent.count({
            where: {
              shopDomain: a,
              action: "AUTOMATIC_CONSENT_REVOKED",
              resourceId: theirs.id,
            },
          }),
        ).toBe(1);
      });

      it("the worker's own check then refuses a run under that consent, even one left active", async () => {
        const { a, b, workspaceId, policyId } = await paired();
        await signIn(a, FORMER);
        vi.stubEnv("SYNC_WRITE_ENABLED", "true");
        vi.stubEnv("AUTOMATIC_SYNC_ENABLED", "true");
        try {
          const left = await consent(workspaceId, policyId, `${a}:101`);
          await expect(
            assertJobConsent({
              workspaceId,
              policyId,
              sourceShop: a,
              targetShop: b,
              payload: { consentId: left.id },
            } as never),
          ).rejects.toMatchObject({ code: expect.stringMatching(/^CONSENT_/) });
        } finally {
          vi.unstubAllEnvs();
        }
      });

      it("ends that person's other sign-ins, which say they are still the owner", async () => {
        const { a } = await paired();
        const elsewhere = await signIn(a, OWNER);
        const here = await signIn(a, FORMER);
        expect(
          (await run(layout, elsewhere.browser.request("/app"))).status,
        ).toBe(302);
        const { authenticate } = await import("../../app/shopify.server");
        expect(
          requireActor(await authenticate.admin(here.browser.request("/app")))
            .role,
        ).toBe("VIEWER");
      });

      it("leaves another person's sign-in, and the same person's that still tell the truth", async () => {
        const { a } = await paired();
        const staff = await signIn(a, STAFF);
        const phone = await signIn(a, OWNER);
        const desktop = await signIn(a, OWNER);
        for (const browser of [staff.browser, phone.browser, desktop.browser])
          expect((await run(layout, browser.request("/app"))).status).toBe(200);
      });

      describe("a grant that does not say", () => {
        const SILENT: User = { id: 101 };
        const queued = async (a: string, b: string, consentId: string) =>
          prisma.syncJob.create({
            data: {
              workspaceId: (await connection(a))!.workspaceId!,
              policyId: (
                await prisma.automaticConsent.findUniqueOrThrow({
                  where: { id: consentId },
                })
              ).policyId,
              sourceShop: a,
              targetShop: b,
              operation: "AUTO_PREVIEW",
              payload: { consentId },
              availableAt: new Date("2000-01-01"),
            },
          });

        it("leaves the owner row, the consents and the queued jobs alone, and then a grant saying false ends them", async () => {
          const { a, b, workspaceId, policyId } = await paired();
          const theirs = await consent(workspaceId, policyId, `${a}:101`);
          const job = await queued(a, b, theirs.id);
          const consentStatus = async () =>
            (
              await prisma.automaticConsent.findUniqueOrThrow({
                where: { id: theirs.id },
              })
            ).status;
          const jobStatus = async () =>
            (await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } }))
              .status;

          await signIn(a, SILENT);
          expect(await member(workspaceId, a, "101")).toMatchObject({
            role: "OWNER",
            status: "ACTIVE",
          });
          expect(await consentStatus()).toBe("ACTIVE");
          expect(await jobStatus()).toBe("PENDING");
          expect(
            await prisma.auditEvent.count({
              where: { shopDomain: a, action: "OWNER_ROLE_ENDED" },
            }),
          ).toBe(0);

          await signIn(a, FORMER);
          expect(await member(workspaceId, a, "101")).toMatchObject({
            role: "VIEWER",
            status: "REVOKED",
          });
          expect(await consentStatus()).toBe("REVOKED");
          expect(await jobStatus()).toBe("CANCELLED");
          await prisma.syncJob.delete({ where: { id: job.id } });
        });

        it("leaves that person's other sign-ins alone, whichever they say", async () => {
          const { a } = await paired();
          const owner = await signIn(a, OWNER);
          const staffElsewhere = await signIn(a, {
            id: 303,
            account_owner: false,
          });
          await signIn(a, SILENT);
          await signIn(a, { id: 303 });
          expect(
            (await run(layout, owner.browser.request("/app"))).status,
          ).toBe(200);
          expect(
            (await run(layout, staffElsewhere.browser.request("/app"))).status,
          ).toBe(200);
        });

        it("still gives this sign-in no owner's rights, and is not asked to undo them", async () => {
          const { a, workspaceId } = await paired();
          const { browser } = await signIn(a, SILENT);
          const { authenticate } = await import("../../app/shopify.server");
          expect(
            requireActor(await authenticate.admin(browser.request("/app"))),
          ).toMatchObject({ userId: "101", role: "VIEWER" });
          expect(await member(workspaceId, a, "101")).toMatchObject({
            role: "OWNER",
          });
        });

        it("reads a null the same way", async () => {
          const { a, workspaceId } = await paired();
          await signIn(a, { id: 101, account_owner: null as never });
          expect(await member(workspaceId, a, "101")).toMatchObject({
            role: "OWNER",
            status: "ACTIVE",
          });
        });
      });

      it("a later grant saying owner does not bring back what was ended", async () => {
        const { a, workspaceId } = await paired();
        await signIn(a, FORMER);
        await signIn(a, OWNER);
        expect(await member(workspaceId, a, "101")).toMatchObject({
          role: "VIEWER",
          status: "REVOKED",
        });
      });

      it("the owner signing in changes nothing, and neither does staff with no owner row", async () => {
        const { a, workspaceId, policyId } = await paired();
        const theirs = await consent(workspaceId, policyId, `${a}:101`);
        await signIn(a, OWNER);
        await signIn(a, STAFF);
        // The same person being staff on some other store says nothing about this one.
        await signIn(shopName("former-elsewhere"), FORMER);
        expect(await member(workspaceId, a, "101")).toMatchObject({
          role: "OWNER",
          status: "ACTIVE",
        });
        expect(
          await prisma.automaticConsent.findUniqueOrThrow({
            where: { id: theirs.id },
          }),
        ).toMatchObject({ status: "ACTIVE" });
        expect(
          await prisma.auditEvent.count({
            where: { shopDomain: a, action: "OWNER_ROLE_ENDED" },
          }),
        ).toBe(0);
      });
    });

    describe("lapsed sign-ins", () => {
      it("the worker removes them with the person's details, after a day's grace, and never an offline row", async () => {
        const { shop, browser } = await signIn();
        const gone = sessionId(browser);
        const recent = await signIn(shop, STAFF);
        await prisma.session.update({
          where: { id: gone },
          data: { expires: new Date(Date.now() - 25 * HOUR) },
        });
        await prisma.session.update({
          where: { id: sessionId(recent.browser) },
          data: { expires: new Date(Date.now() - 23 * HOUR) },
        });
        await prisma.session.update({
          where: { id: `offline_${shop}` },
          data: { expires: new Date(Date.now() - 48 * HOUR) },
        });
        expect(
          await prisma.session.count({
            where: { id: gone, email: { not: null } },
          }),
        ).toBe(1);
        expect(await cleanLapsedSignIns()).toBeGreaterThanOrEqual(1);
        expect(await prisma.session.count({ where: { id: gone } })).toBe(0);
        expect(
          await prisma.session.count({
            where: { id: sessionId(recent.browser) },
          }),
        ).toBe(1);
        expect(
          await prisma.session.count({ where: { id: `offline_${shop}` } }),
        ).toBe(1);
      });

      it("a browser whose row has gone is sent to sign in, to the store it last knew", async () => {
        const { shop, browser } = await signIn();
        await prisma.session.delete({ where: { id: sessionId(browser) } });
        const asked = await run(layout, browser.request("/app/stores"));
        expect(asked.status).toBe(302);
        expect(new URL(asked.location!, ORIGIN).searchParams.get("shop")).toBe(
          shop,
        );
      });
    });

    describe("staff with no access on a paired store", () => {
      it("every page answers with the reason, never a server error, and the worst a page does is refuse", async () => {
        const a = shopName("no-member-a");
        await pairedWorkspace(a, shopName("no-member-b"));
        const { browser } = await signIn(a, STAFF);
        const refused: string[] = [];
        const modules = import.meta.glob<{ loader?: Route }>(
          "../../app/routes/app.*.tsx",
        );
        expect(Object.keys(modules).length).toBeGreaterThanOrEqual(13);
        for (const [file, load] of Object.entries(modules)) {
          const { loader } = await load();
          // run() rethrows anything that is not a response, which fails this test.
          const outcome = await run(loader!, browser.request("/app/page"));
          if (outcome.status === 200) continue;
          expect(outcome.status, file).toBe(403);
          expect(outcome.data, file).toContain("A workspace owner must grant");
          refused.push(file);
        }
        expect(refused.length).toBeGreaterThanOrEqual(5);
      });
    });

    describe("a refresh of the worker's token that fails", () => {
      const transient: [string, () => Response | Promise<Response>][] = [
        ["a 503", () => stub.json({ errors: "unavailable" }, 503)],
        ["a 500", () => stub.json({ errors: "broken" }, 500)],
        ["a 429", () => stub.json({ errors: "slow down" }, 429)],
        [
          "a 502 that is not JSON",
          () => new Response("<html>", { status: 502 }),
        ],
        [
          "a failure to connect",
          () => {
            throw new TypeError("fetch failed");
          },
        ],
      ];

      it.each(transient)(
        "%s is worth retrying: nothing says the token is dead",
        async (_, answer) => {
          const { shop } = await signIn();
          await due(shop);
          const before = await offlineRow(shop);
          stub.refresh = answer;
          await expect(
            shopifyRequest(shop, INSTALLATION_CHECK_QUERY),
          ).rejects.toMatchObject({
            code: "NETWORK_TIMEOUT",
            retryable: true,
            uncertain: false,
          });
          // No new grant, which would retire the refresh token that is still fine.
          const again = new Browser();
          const { trips } = await atShopify(
            again,
            await startSignIn(again, shop),
          );
          expect(trips).toEqual(["online"]);
          expect(
            await prisma.session.findUniqueOrThrow({
              where: { id: `offline_${shop}` },
            }),
          ).toMatchObject({
            accessToken: before.accessToken,
            refreshToken: before.refreshToken,
          });
        },
      );

      it("a token endpoint that does not answer is the same", async () => {
        const { shop } = await signIn();
        await due(shop);
        shortenTokenDeadline();
        stub.refresh = () => new Promise<Response>(() => undefined);
        await expect(
          shopifyRequest(shop, INSTALLATION_CHECK_QUERY),
        ).rejects.toMatchObject({ code: "NETWORK_TIMEOUT", retryable: true });
      });

      it("a 401 is the one refusal Shopify documents: it is final, and the next sign-in mends it", async () => {
        const { shop } = await signIn();
        await due(shop);
        stub.refresh = () => stub.json({ error: "invalid_request" }, 401);
        await expect(
          shopifyRequest(shop, INSTALLATION_CHECK_QUERY),
        ).rejects.toMatchObject({ code: "AUTH_FAILURE", retryable: false });
        const again = new Browser();
        const { trips } = await atShopify(
          again,
          await startSignIn(again, shop),
        );
        expect(trips).toEqual(["online", "offline"]);
      });

      // Sent again it looks the same, and a new grant would retire a token that works.
      it.each<[number, string]>([
        [400, "a malformed body"],
        [403, "bad client credentials"],
        [404, "nothing there"],
        [422, "a request it cannot take"],
      ])(
        "a %i is about this app's own request, here %s: it is reported, not retried, and no new grant is asked for",
        async (status) => {
          const { shop } = await signIn();
          await due(shop);
          const before = await offlineRow(shop);
          stub.refresh = () => stub.json({ error: "invalid_client" }, status);
          await expect(
            shopifyRequest(shop, INSTALLATION_CHECK_QUERY),
          ).rejects.toMatchObject({
            code: "CONFIGURATION_ERROR",
            retryable: false,
            uncertain: false,
          });
          const again = new Browser();
          const { trips } = await atShopify(
            again,
            await startSignIn(again, shop),
          );
          expect(trips).toEqual(["online"]);
          expect(await offlineRow(shop)).toMatchObject({
            accessToken: before.accessToken,
            refreshToken: before.refreshToken,
          });
        },
      );

      it("a row this key cannot open reads as authorization that has to be granted again", async () => {
        const { shop } = await signIn();
        await prisma.session.update({
          where: { id: `offline_${shop}` },
          data: {
            accessToken: "enc:v1:bm90LWEtcmVhbC1jaXBoZXJ0ZXh0LWF0LWFsbC1zbw",
          },
        });
        await expect(offlineExecutor(shop)).rejects.toMatchObject({
          code: "AUTH_FAILURE",
        });
      });

      it("a database that is down is not a dead token either", async () => {
        const { shop } = await signIn();
        vi.spyOn(sessionStorage, "loadSession").mockRejectedValueOnce(
          new Error("connection refused"),
        );
        await expect(offlineExecutor(shop)).rejects.toMatchObject({
          code: "NETWORK_TIMEOUT",
          retryable: true,
        });
      });

      it.each(transient)(
        "the worker keeps a job for a retry through %s",
        async (_, answer) => {
          const { shop } = await signIn();
          await due(shop);
          stub.refresh = answer;
          const job = await catalogJob(shop);
          expect(await runJob(job.id)).toMatchObject({
            status: "RETRY",
            lastError: expect.stringContaining("NETWORK_TIMEOUT"),
          });
          await prisma.syncJob.update({
            where: { id: job.id },
            data: { status: "CANCELLED" },
          });
        },
      );

      it("the worker gives up on a 401, as an authorization failure", async () => {
        const { shop } = await signIn();
        await due(shop);
        stub.refresh = () => stub.json({ error: "invalid_request" }, 401);
        const job = await catalogJob(shop);
        expect(await runJob(job.id)).toMatchObject({
          status: "DEAD_LETTER",
          lastError: expect.stringContaining("AUTH_FAILURE"),
        });
      });

      it.each([400, 403])(
        "the worker gives up on a %i too, as a problem with this app rather than with the token",
        async (status) => {
          const { shop } = await signIn();
          await due(shop);
          stub.refresh = () => stub.json({ error: "invalid_client" }, status);
          const job = await catalogJob(shop);
          expect(await runJob(job.id)).toMatchObject({
            status: "DEAD_LETTER",
            lastError: expect.stringContaining("CONFIGURATION_ERROR"),
          });
        },
      );

      describe("two minutes before it expires, which is already inside the window", () => {
        const nearlyDue = (shop: string) =>
          prisma.session.update({
            where: { id: `offline_${shop}` },
            data: { expires: new Date(Date.now() + 2 * MINUTE) },
          });

        it("a 401 is still read here, and is final", async () => {
          const { shop } = await signIn();
          await nearlyDue(shop);
          stub.refresh = () => stub.json({ error: "invalid_request" }, 401);
          await expect(offlineExecutor(shop)).rejects.toMatchObject({
            code: "AUTH_FAILURE",
            retryable: false,
          });
          expect(refreshesPresented()).toHaveLength(1);
        });

        it("a 503 is still read here, and is worth retrying", async () => {
          const { shop } = await signIn();
          await nearlyDue(shop);
          stub.refresh = () => stub.json({ errors: "unavailable" }, 503);
          await expect(offlineExecutor(shop)).rejects.toMatchObject({
            code: "NETWORK_TIMEOUT",
            retryable: true,
            message: expect.stringContaining("could not renew"),
          });
          expect(refreshesPresented()).toHaveLength(1);
        });
      });
    });

    describe("one token operation for a store at a time", () => {
      it("two calls for a due token refresh it once, and both go on with the new token", async () => {
        const { shop } = await signIn();
        await due(shop);
        const rotated = offlineGrant();
        const answer = held<Response>();
        stub.refresh = () => answer.answer;
        const both = Promise.all([
          offlineExecutor(shop),
          offlineExecutor(shop),
        ]);
        await until(() => refreshesPresented().length);
        await until(tokenLockWaiters);
        expect(refreshesPresented()).toHaveLength(1);
        answer.release(stub.json(rotated));
        const executors = await both;
        expect(refreshesPresented()).toHaveLength(1);
        for (const execute of executors) {
          await execute(INSTALLATION_CHECK_QUERY, {});
          expect(stub.outbound.at(-1)?.token).toBe(rotated.access_token);
        }
        expect(await workerRefreshToken(shop)).toBe(rotated.refresh_token);
      });

      it("two stores do not wait on each other", async () => {
        const a = await signIn(shopName("lock-a"));
        const b = await signIn(shopName("lock-b"));
        await due(a.shop);
        await due(b.shop);
        const rotatedA = offlineGrant();
        const rotatedB = offlineGrant();
        const answerA = held<Response>();
        stub.refresh = (_, shop) =>
          shop === a.shop ? answerA.answer : stub.json(rotatedB);
        const first = offlineExecutor(a.shop);
        await until(() => refreshesPresented().length);
        await offlineExecutor(b.shop);
        expect(refreshesPresented()).toHaveLength(2);
        expect(await workerRefreshToken(b.shop)).toBe(rotatedB.refresh_token);
        answerA.release(stub.json(rotatedA));
        await first;
        expect(await workerRefreshToken(a.shop)).toBe(rotatedA.refresh_token);
      });

      it("the next in line tries for itself after a failure, one at a time and with the same token", async () => {
        const { shop } = await signIn();
        await due(shop);
        const refreshToken = await workerRefreshToken(shop);
        const rotated = offlineGrant();
        let calls = 0;
        let running = 0;
        let mostRunning = 0;
        stub.refresh = async () => {
          calls += 1;
          const call = calls;
          running += 1;
          mostRunning = Math.max(mostRunning, running);
          await pause(50);
          running -= 1;
          return call === 1
            ? stub.json({ errors: "unavailable" }, 503)
            : stub.json(rotated);
        };
        const outcomes = await Promise.allSettled([
          offlineExecutor(shop),
          offlineExecutor(shop),
        ]);
        expect(mostRunning).toBe(1);
        expect(refreshesPresented().map((body) => body.refresh_token)).toEqual([
          refreshToken,
          refreshToken,
        ]);
        expect(outcomes.map(({ status }) => status).sort()).toEqual([
          "fulfilled",
          "rejected",
        ]);
        const failed = outcomes.find(({ status }) => status === "rejected");
        expect((failed as PromiseRejectedResult).reason).toMatchObject({
          code: "NETWORK_TIMEOUT",
          retryable: true,
        });
        expect(await workerRefreshToken(shop)).toBe(rotated.refresh_token);
      });

      it("a refresh answering after the deadline leaves the job to retry and the old row as it was", async () => {
        const { shop } = await signIn();
        await due(shop);
        const before = await offlineRow(shop);
        shortenTokenDeadline();
        let answered = false;
        stub.refresh = async () => {
          await pause(100);
          answered = true;
          return stub.json(offlineGrant());
        };
        const job = await catalogJob(shop);
        expect(await runJob(job.id)).toMatchObject({
          status: "RETRY",
          lastError: expect.stringContaining("NETWORK_TIMEOUT"),
        });
        await putAside(job.id);
        await until(() => answered);
        await pause(50);
        expect(await offlineRow(shop)).toMatchObject({
          accessToken: before.accessToken,
          refreshToken: before.refreshToken,
        });
        // Nothing is left holding the lock, and the same token goes again.
        const rotated = offlineGrant();
        stub.refresh = () => stub.json(rotated);
        await offlineExecutor(shop);
        expect(await workerRefreshToken(shop)).toBe(rotated.refresh_token);
      });

      /** A person whose sign-in found the offline token dead, about to get a new one. */
      const atRepairTrip = async (shop: string) => {
        const normal = stub.graphql;
        stub.graphql = () => stub.json({ errors: "Invalid token" }, 401);
        const browser = new Browser();
        const started = await startSignIn(browser, shop);
        stub.grants.set("person", onlineGrant(OWNER));
        const repair = await browser.visit(
          callback,
          shopifyCallback(authorizeUrl(started), "person"),
        );
        stub.graphql = normal;
        const authorize = authorizeUrl(repair);
        expect(isOnlineAsk(authorize)).toBe(false);
        stub.tokenRequests.length = 0;
        return { browser, authorize };
      };
      /**
       * Shopify's rules as documented: a grant retires every other refresh token at
       * once, and a refresh that a grant overtakes answers with one already retired.
       */
      const shopifyRotation = (
        first: string,
        grant: { refresh_token: string },
      ) => {
        const usable = new Set([first]);
        const gate = {
          refresh: Promise.resolve(),
          exchange: Promise.resolve(),
        };
        stub.exchanging = async () => {
          usable.clear();
          usable.add(grant.refresh_token);
          await gate.exchange;
        };
        stub.refresh = async (body) => {
          if (!usable.has(body.refresh_token))
            return stub.json({ error: "invalid_request" }, 401);
          const next = offlineGrant();
          await gate.refresh;
          if (usable.has(body.refresh_token)) usable.add(next.refresh_token);
          return stub.json(next);
        };
        return { usable, gate };
      };

      it("a repair that comes back during a refresh waits for it, and its own token is the one kept", async () => {
        const { shop } = await signIn();
        const refreshToken = await workerRefreshToken(shop);
        const { browser, authorize } = await atRepairTrip(shop);
        const grant = offlineGrant();
        stub.grants.set("repair", grant);
        const { gate, usable } = shopifyRotation(refreshToken!, grant);
        const answer = held<void>();
        gate.refresh = answer.answer;
        await due(shop);
        const refreshing = offlineExecutor(shop);
        await until(() => refreshesPresented().length);
        const repairing = browser.visit(
          callback,
          shopifyCallback(authorize, "repair"),
        );
        await until(tokenLockWaiters);
        expect(codesPresented()).toEqual([]);
        answer.release();
        await refreshing;
        expect((await repairing).location).toBe(dashboard(shop));
        expect(codesPresented()).toHaveLength(1);
        expect(await workerRefreshToken(shop)).toBe(grant.refresh_token);
        expect(usable.has(grant.refresh_token)).toBe(true);
        // What the worker holds now is what Shopify will take next time.
        await due(shop);
        await expect(offlineExecutor(shop)).resolves.toBeDefined();
      });

      it("a refresh that comes during a repair waits for it, and then has nothing to do", async () => {
        const { shop } = await signIn();
        const refreshToken = await workerRefreshToken(shop);
        const { browser, authorize } = await atRepairTrip(shop);
        const grant = offlineGrant();
        stub.grants.set("repair", grant);
        const { gate } = shopifyRotation(refreshToken!, grant);
        const answer = held<void>();
        gate.exchange = answer.answer;
        await due(shop);
        const repairing = browser.visit(
          callback,
          shopifyCallback(authorize, "repair"),
        );
        await until(() => codesPresented().length);
        const refreshing = offlineExecutor(shop);
        await until(tokenLockWaiters);
        answer.release();
        expect((await repairing).location).toBe(dashboard(shop));
        const execute = await refreshing;
        expect(refreshesPresented()).toEqual([]);
        await execute(INSTALLATION_CHECK_QUERY, {});
        expect(stub.outbound.at(-1)?.token).toBe(grant.access_token);
      });

      it("a person's trip answered with an offline token keeps it over a refresh still in flight", async () => {
        const { shop } = await signIn();
        const browser = new Browser();
        const authorize = authorizeUrl(await startSignIn(browser, shop));
        const grant = offlineGrant();
        stub.grants.set("edited-url", grant);
        const answer = held<Response>();
        stub.refresh = () => answer.answer;
        await due(shop);
        const refreshing = offlineExecutor(shop);
        await until(() => refreshesPresented().length);
        const refusing = browser.visit(
          callback,
          shopifyCallback(authorize, "edited-url"),
        );
        await until(tokenLockWaiters);
        answer.release(stub.json(offlineGrant()));
        await refreshing;
        expect((await refusing).status).toBe(400);
        expect(await workerRefreshToken(shop)).toBe(grant.refresh_token);
      });

      it("keeps such a token even if the wait comes to nothing, since the old one is already gone", async () => {
        const { shop } = await signIn();
        const browser = new Browser();
        const authorize = authorizeUrl(await startSignIn(browser, shop));
        const grant = offlineGrant();
        stub.grants.set("edited-url", grant);
        const release = await tokenLockHeldElsewhere(shop);
        try {
          shortenTokenLock({ lockWait: 50 });
          const told = await browser.visit(
            callback,
            shopifyCallback(authorize, "edited-url"),
          );
          expect(told.status).toBe(400);
          expect(await workerRefreshToken(shop)).toBe(grant.refresh_token);
        } finally {
          await release();
        }
      });

      it("a person's own trip does not wait for it", async () => {
        const { shop } = await signIn();
        const release = await tokenLockHeldElsewhere(shop);
        try {
          const browser = new Browser();
          const { trips, final } = await atShopify(
            browser,
            await startSignIn(browser, shop),
          );
          expect(trips).toEqual(["online"]);
          expect(final.location).toBe(dashboard(shop));
          expect(await tokenLockWaiters()).toBe(0);
        } finally {
          await release();
        }
      });

      it("a sign-in that has to refresh, or to repair, is not holding the lock it wants", async () => {
        const { shop } = await signIn();
        await due(shop);
        const rotated = offlineGrant();
        stub.refresh = () => stub.json(rotated);
        const first = await signIn(shop, OWNER, new Browser());
        expect(first.trips).toEqual(["online"]);
        expect(await workerRefreshToken(shop)).toBe(rotated.refresh_token);
        await due(shop);
        stub.refresh = () => stub.json({ error: "invalid_request" }, 401);
        const second = await signIn(shop, OWNER, new Browser());
        expect(second.trips).toEqual(["online", "offline"]);
      });

      it("a transaction that runs out during a refresh is worth retrying, drops the answer, and leaves the row", async () => {
        const { shop } = await signIn();
        await due(shop);
        const before = await offlineRow(shop);
        shortenTokenLock({ timeout: 100 });
        stub.refresh = async () => {
          await pause(400);
          return stub.json(offlineGrant());
        };
        await expect(offlineExecutor(shop)).rejects.toMatchObject({
          code: "NETWORK_TIMEOUT",
          retryable: true,
        });
        expect(await offlineRow(shop)).toMatchObject({
          accessToken: before.accessToken,
          refreshToken: before.refreshToken,
        });
        // The token it presented still works, so the retry is safe.
        vi.restoreAllMocks();
        const rotated = offlineGrant();
        stub.refresh = () => stub.json(rotated);
        await offlineExecutor(shop);
        expect(await workerRefreshToken(shop)).toBe(rotated.refresh_token);
      });

      it("a 401 that comes back once the transaction has run out is worth retrying: a repair may have taken the lock and overtaken it", async () => {
        const { shop } = await signIn();
        const refreshToken = await workerRefreshToken(shop);
        const { browser, authorize } = await atRepairTrip(shop);
        const grant = offlineGrant();
        stub.grants.set("repair", grant);
        // Shopify reads the token when it answers, by which time the grant has retired it.
        const usable = new Set([refreshToken]);
        stub.exchanging = () => {
          usable.clear();
          usable.add(grant.refresh_token);
        };
        const answer = held<void>();
        stub.refresh = async (body) => {
          await answer.answer;
          return usable.has(body.refresh_token)
            ? stub.json(offlineGrant())
            : stub.json({ error: "invalid_request" }, 401);
        };
        // Only the refresh's transaction is short.
        let first = true;
        reachIntoTransactions((work, options) => {
          const shorter = first ? { timeout: 100 } : {};
          first = false;
          return [work, { ...options, ...shorter }];
        });
        await due(shop);
        const refreshing = offlineExecutor(shop);
        await until(() => refreshesPresented().length);
        await pause(300);
        expect(
          (await browser.visit(callback, shopifyCallback(authorize, "repair")))
            .location,
        ).toBe(dashboard(shop));
        answer.release();
        await expect(refreshing).rejects.toMatchObject({
          code: "NETWORK_TIMEOUT",
          retryable: true,
        });
        expect(await workerRefreshToken(shop)).toBe(grant.refresh_token);
        // And the retry has nothing to do but use it.
        vi.restoreAllMocks();
        const execute = await offlineExecutor(shop);
        await execute(INSTALLATION_CHECK_QUERY, {});
        expect(stub.outbound.at(-1)?.token).toBe(grant.access_token);
      });

      it("a transaction that runs out before the refresh is sent sends nothing, and is worth retrying", async () => {
        const { shop } = await signIn();
        await due(shop);
        shortenTokenLock({ timeout: 100 });
        const read = sessionStorage.loadSession.bind(sessionStorage);
        let reads = 0;
        vi.spyOn(sessionStorage, "loadSession").mockImplementation(
          async (id) => {
            reads += 1;
            // The second is the read under the lock, on a slow database, say.
            if (reads === 2) await pause(300);
            return read(id);
          },
        );
        await expect(offlineExecutor(shop)).rejects.toMatchObject({
          code: "NETWORK_TIMEOUT",
          retryable: true,
        });
        expect(reads).toBe(2);
        expect(refreshesPresented()).toEqual([]);
      });

      it("a transaction that runs out while it waits for the lock is worth retrying, and sends nothing", async () => {
        const { shop } = await signIn();
        await due(shop);
        const release = await tokenLockHeldElsewhere(shop);
        shortenTokenLock({ timeout: 100 });
        const waiting = expect(offlineExecutor(shop)).rejects.toMatchObject({
          code: "NETWORK_TIMEOUT",
          retryable: true,
        });
        await pause(300);
        await release();
        await waiting;
        expect(refreshesPresented()).toEqual([]);
      });

      it("a wait for the lock that runs out is worth retrying, and sends nothing", async () => {
        const { shop } = await signIn();
        await due(shop);
        const release = await tokenLockHeldElsewhere(shop);
        try {
          shortenTokenLock({ lockWait: 50 });
          await expect(offlineExecutor(shop)).rejects.toMatchObject({
            code: "NETWORK_TIMEOUT",
            retryable: true,
          });
          expect(refreshesPresented()).toEqual([]);
        } finally {
          await release();
        }
      });

      it("a sign-in that cannot get the lock for its repair spends no code, says so, and can try again", async () => {
        const { shop } = await signIn();
        const { browser, authorize } = await atRepairTrip(shop);
        const release = await tokenLockHeldElsewhere(shop);
        try {
          shortenTokenLock({ lockWait: 50 });
          stub.grants.set("repair", offlineGrant());
          const told = await browser.visit(
            callback,
            shopifyCallback(authorize, "repair"),
          );
          expect(told.status).toBe(503);
          expect(told.data).toEqual({
            problem: expect.stringContaining("Sign in again"),
          });
          expect(codesPresented()).toEqual([]);
        } finally {
          await release();
        }
        vi.restoreAllMocks();
        stub.graphql = () => stub.json({ errors: "Invalid token" }, 401);
        const again = await atShopify(
          browser,
          await startSignIn(browser, shop),
        );
        expect(again.trips).toEqual(["online", "offline"]);
      });

      it("a sign-in whose repair cannot even start the lock's transaction spends no code either", async () => {
        const { shop } = await signIn();
        const { browser, authorize } = await atRepairTrip(shop);
        stub.grants.set("repair", offlineGrant());
        // What Prisma says when no connection comes within maxWait.
        vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
          new Error(
            "Transaction API error: Unable to start a transaction in the given time.",
          ),
        );
        const told = await browser.visit(
          callback,
          shopifyCallback(authorize, "repair"),
        );
        expect(told.status).toBe(503);
        expect(told.data).toEqual({
          problem: expect.stringContaining("Nothing was changed"),
        });
        expect(codesPresented()).toEqual([]);
      });

      it("a repair whose grant cannot be stored is an error and not a busy lock: the code is spent by then", async () => {
        const { shop } = await signIn();
        const { browser, authorize } = await atRepairTrip(shop);
        stub.grants.set("repair", offlineGrant());
        const warn = vi.spyOn(logger, "warn");
        vi.spyOn(sessionStorage, "storeSession").mockRejectedValueOnce(
          new Error("The session table went away"),
        );
        await expect(
          browser.visit(callback, shopifyCallback(authorize, "repair")),
        ).rejects.toThrow("The session table went away");
        expect(codesPresented()).toHaveLength(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("TOKEN_BUSY");
      });

      it("a repair whose transaction runs out once the grant is stored still signs in, and keeps the grant", async () => {
        const { shop } = await signIn();
        const { browser, authorize } = await atRepairTrip(shop);
        const grant = offlineGrant();
        stub.grants.set("repair", grant);
        shortenTokenLock({ timeout: 100 });
        stub.exchanging = () => pause(300);
        expect(
          await browser.visit(callback, shopifyCallback(authorize, "repair")),
        ).toMatchObject({ status: 302, location: dashboard(shop) });
        expect(codesPresented()).toHaveLength(1);
        expect(await workerRefreshToken(shop)).toBe(grant.refresh_token);
      });

      it("gives whoever gets the lock a whole deadline, and a waiter as long as one holder takes", async () => {
        const { shop } = await signIn();
        await due(shop);
        let inside!: Prisma.TransactionClient;
        let lockWait = 0;
        const started = reachIntoTransactions((work, options) => [
          (tx) => {
            inside = tx;
            return work(tx);
          },
          options,
        ]);
        stub.refresh = async () => {
          const [{ setting }] = await inside.$queryRaw<{ setting: string }[]>`
            SELECT setting FROM pg_settings WHERE name = 'lock_timeout'`;
          lockWait = Number(setting);
          return stub.json(offlineGrant());
        };
        await offlineExecutor(shop);
        const options = started.mock.calls[0][1] as {
          maxWait: number;
          timeout: number;
        };
        expect(lockWait).toBeGreaterThan(TOKEN_DEADLINE_MS);
        expect(options.timeout).toBeGreaterThan(lockWait + TOKEN_DEADLINE_MS);
        expect(options.maxWait).toBeGreaterThan(0);
      });

      it("leaves that limit behind with the transaction, so no other lock on these connections gets it", async () => {
        const { shop } = await signIn();
        await due(shop);
        stub.refresh = () => stub.json(offlineGrant());
        await offlineExecutor(shop);
        // Enough at once, each taking a moment, to reach every connection in the pool:
        // Prisma's default is two for each processor and one more.
        const everyConnection = await Promise.all(
          Array.from(
            { length: availableParallelism() * 2 + 1 },
            () =>
              prisma.$queryRaw<{ setting: string }[]>`
                SELECT setting, pg_sleep(0.05)::text FROM pg_settings WHERE name = 'lock_timeout'`,
          ),
        );
        expect(
          new Set(everyConnection.map(([{ setting }]) => setting)),
        ).toEqual(new Set(["0"]));
      });

      it("the lock is this store's and this purpose's", async () => {
        const { shop } = await signIn();
        await due(shop);
        const rotated = offlineGrant();
        stub.refresh = () => stub.json(rotated);
        // Another advisory lock on this store's name is another matter.
        const other = held<void>();
        const got = held<void>();
        const elsewhere = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`catalog:${shop}`}))::text`;
            got.release();
            await other.answer;
          },
          { timeout: 10_000 },
        );
        await got.answer;
        await offlineExecutor(shop);
        other.release();
        await elsewhere;
        expect(await workerRefreshToken(shop)).toBe(rotated.refresh_token);
      });

      it("a refresh that comes due inside another transaction, which is where the worker's writes reach it, gets through", async () => {
        const { shop } = await signIn();
        await due(shop);
        const rotated = offlineGrant();
        stub.refresh = () => stub.json(rotated);
        // That transaction, the lock's and the session adapter's: three at once.
        await prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1`;
            const execute = await offlineExecutor(shop);
            await execute(INSTALLATION_CHECK_QUERY, {});
          },
          { timeout: 20_000 },
        );
        expect(refreshesPresented()).toHaveLength(1);
        expect(stub.outbound.at(-1)?.token).toBe(rotated.access_token);
      });

      it("a token just outside what the library would refresh by itself is renewed here, under the lock", async () => {
        const { shop } = await signIn();
        await prisma.session.update({
          where: { id: `offline_${shop}` },
          data: { expires: new Date(Date.now() + 5.5 * MINUTE) },
        });
        const started = vi.spyOn(prisma, "$transaction");
        stub.refresh = () => stub.json(offlineGrant());
        await offlineExecutor(shop);
        expect(refreshesPresented()).toHaveLength(1);
        expect(started).toHaveBeenCalled();
      });
    });

    describe("the worker", () => {
      it("uses the offline token from the new callback, never the person's", async () => {
        const { shop, grants } = await signIn();
        const [online, offline] = grants;
        stub.outbound.length = 0;
        const execute = await offlineExecutor(shop);
        const response = await execute(INSTALLATION_CHECK_QUERY, {});
        expect(response.ok).toBe(true);
        expect(stub.outbound).toHaveLength(1);
        expect(stub.outbound[0].url).toBe(
          `https://${shop}/admin/api/2026-10/graphql.json`,
        );
        expect(stub.outbound[0].token).toBe(offline.access_token);
        expect(stub.outbound[0].token).not.toBe(online.access_token);
      });

      it("refreshes it through the library, storing the rotated tokens encrypted", async () => {
        const { shop, grants } = await signIn();
        await prisma.session.update({
          where: { id: `offline_${shop}` },
          data: { expires: new Date(Date.now() - 60_000) },
        });
        const rotated = offlineGrant();
        stub.refresh = () => stub.json(rotated);
        stub.outbound.length = 0;
        stub.tokenRequests.length = 0;
        const answer = await shopifyRequest<{
          shop: { myshopifyDomain: string };
        }>(shop, INSTALLATION_CHECK_QUERY);
        expect(answer.shop.myshopifyDomain).toBe(shop);
        expect(stub.tokenRequests).toHaveLength(1);
        expect(stub.tokenRequests[0].refresh_token).toBe(
          grants[1].refresh_token,
        );
        expect(stub.outbound.at(-1)?.token).toBe(rotated.access_token);
        const row = await prisma.session.findUniqueOrThrow({
          where: { id: `offline_${shop}` },
        });
        expect(row.accessToken).toMatch(/^enc:v1:/);
        expect(row.refreshToken).toMatch(/^enc:v1:/);
        expect(row.isOnline).toBe(false);
        const stored = await sessionStorage.loadSession(`offline_${shop}`);
        expect(stored?.refreshToken).toBe(rotated.refresh_token);
      });

      it.each<[number, string]>([
        [401, "AUTH_FAILURE"],
        [403, "AUTH_FAILURE"],
        [429, "THROTTLED"],
      ])(
        "a real %i from Shopify through the library is %s, not a network failure",
        async (status, code) => {
          const { shop } = await signIn();
          stub.graphql = () => stub.json({ errors: "refused" }, status);
          await expect(
            shopifyRequest(shop, INSTALLATION_CHECK_QUERY),
          ).rejects.toMatchObject({ code });
        },
      );
    });

    describe("an offline token Shopify has retired", () => {
      const retired = () => stub.json({ errors: "Invalid token" }, 401);

      it("is replaced straight after the person's sign-in, and the person lands where they asked", async () => {
        const { shop, browser } = await signIn();
        const before = await prisma.session.findUniqueOrThrow({
          where: { id: `offline_${shop}` },
        });
        stub.graphql = retired;
        const again = new Browser();
        const flow = await atShopify(
          again,
          await startSignIn(again, shop, "/app/stores"),
        );
        expect(flow.trips).toEqual(["online", "offline"]);
        expect(flow.final).toMatchObject({
          status: 302,
          location: dashboard(shop, "/app/stores"),
        });
        const after = await prisma.session.findUniqueOrThrow({
          where: { id: `offline_${shop}` },
        });
        expect(after.accessToken).not.toBe(before.accessToken);
        expect(after.isOnline).toBe(false);
        expect(again.jar.hasSession()).toBe(true);
        expect(again.jar.has(flowCookieName(shop))).toBe(false);
        expect((await run(layout, again.request("/app"))).status).toBe(200);
        expect((await run(layout, browser.request("/app"))).status).toBe(200);
      });

      it("is noticed when the refresh token behind it was retired by another server", async () => {
        const { shop } = await signIn();
        await prisma.session.update({
          where: { id: `offline_${shop}` },
          data: { expires: new Date(Date.now() - 60_000) },
        });
        const again = new Browser();
        const { trips } = await atShopify(
          again,
          await startSignIn(again, shop),
        );
        expect(trips).toEqual(["online", "offline"]);
      });

      it("is noticed when opening the app from Shopify, with a valid session or none", async () => {
        const { shop, browser } = await signIn();
        stub.graphql = retired;
        const load = `/?${signedQuery({ shop, timestamp: now() })}`;
        const flow = await atShopify(browser, await browser.visit(index, load));
        expect(flow.trips).toEqual(["online", "offline"]);
        expect(flow.final.location).toBe(dashboard(shop));
      });

      it.each<[string, () => Response]>([
        ["a 503", () => stub.json({ errors: "unavailable" }, 503)],
        ["a 429", () => stub.json({ errors: "slow down" }, 429)],
        [
          "a failure to connect",
          () => {
            throw new TypeError("fetch failed");
          },
        ],
      ])(
        "is left alone when Shopify is only having trouble, here %s, which a new grant could not fix",
        async (_, answer) => {
          const { shop } = await signIn();
          stub.graphql = answer;
          const again = new Browser();
          const { trips, final } = await atShopify(
            again,
            await startSignIn(again, shop),
          );
          expect(trips).toEqual(["online"]);
          expect(final.location).toBe(dashboard(shop));
        },
      );

      it("costs an anonymous visitor no Shopify call", async () => {
        const { shop } = await signIn();
        stub.outbound.length = 0;
        authorizeUrl(await startSignIn(new Browser(), shop));
        expect(stub.outbound).toEqual([]);
      });
    });
  },
);
