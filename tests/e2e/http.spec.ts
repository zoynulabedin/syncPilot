import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { connect } from "node:net";

const SECRET = "synthetic-contract-test-secret-for-local-verification-only";
const sign = (body: string) =>
  createHmac("sha256", SECRET).update(body).digest("base64");
const shopifyHeaders = (shop: string, topic: string, body: string) => ({
  "Content-Type": "application/json",
  "X-Shopify-Shop-Domain": shop,
  "X-Shopify-Topic": topic,
  "X-Shopify-Webhook-Id": randomUUID(),
  "X-Shopify-Api-Version": "2026-10",
  "X-Shopify-Triggered-At": new Date().toISOString(),
  "X-Shopify-Hmac-Sha256": sign(body),
});
const FORGED_DELIVERY = {
  "Content-Type": "application/json",
  "X-Shopify-Shop-Domain": "forged.myshopify.com",
  "X-Shopify-Topic": "products/update",
  "X-Shopify-Webhook-Id": "forged-oversized",
  "X-Shopify-Api-Version": "2026-10",
  "X-Shopify-Hmac-Sha256": "invalid-hmac",
};
const LOGIN_FORM = { "Content-Type": "application/x-www-form-urlencoded" };
/** The login form as this app's own page posts it. */
const LOGIN_POST = { ...LOGIN_FORM, Origin: "http://127.0.0.1:3210" };
const KiB = 1024;
const requestHead = (
  path: string,
  headers: Record<string, string>,
  method = "POST",
) =>
  `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:3210\r\n${Object.entries(
    headers,
  )
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("")}\r\n`;
/** A connection the test holds open, to see when the server gives up on it. */
function heldConnection() {
  const startedAt = Date.now();
  const socket = connect(3210, "127.0.0.1");
  let received = "";
  socket.on("data", (data) => (received += data.toString("latin1")));
  socket.on("error", () => undefined);
  const closedAfterMs = new Promise<number>((resolve) => {
    socket.once("close", () => resolve(Date.now() - startedAt));
  });
  const status = () => Number(received.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
  return { socket, closedAfterMs, status };
}
/** Uploads this many 64 KiB chunks of a forged delivery, then stops sending. */
async function stalledUpload(chunks: number) {
  const held = heldConnection();
  const payload = Buffer.alloc(64 * KiB, 97);
  const frame = Buffer.concat([
    Buffer.from(`${payload.length.toString(16)}\r\n`),
    payload,
    Buffer.from("\r\n"),
  ]);
  held.socket.write(
    requestHead("/webhooks/products/update", {
      ...FORGED_DELIVERY,
      "Transfer-Encoding": "chunked",
    }),
  );
  for (let i = 0; i < chunks && !held.socket.destroyed; i++)
    if (!held.socket.write(frame))
      await Promise.race([
        new Promise((drained) => held.socket.once("drain", drained)),
        held.closedAfterMs,
      ]);
  return held;
}

/**
 * Speaks HTTP/1.1 directly so a test can keep uploading after the server has
 * answered, as a real client would. Resolves with the status line it was sent.
 */
function rawRequest(
  path: string,
  headers: Record<string, string>,
  upload?: { chunks: number; chunkBytes: number; complete?: boolean },
) {
  return new Promise<{ status: number; sentBytes: number; head: string }>(
    (resolve, reject) => {
      const socket = connect(3210, "127.0.0.1");
      let received = "",
        sentBytes = 0,
        answered = false;
      const chunk = `${(upload?.chunkBytes ?? 0).toString(16)}\r\n${"x".repeat(
        upload?.chunkBytes ?? 0,
      )}\r\n`;
      const finish = () => {
        const status = Number(received.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
        if (status) resolve({ status, sentBytes, head: received });
        else reject(new Error(`No HTTP response: ${received.slice(0, 80)}`));
      };
      socket.on("data", (data) => {
        received += data.toString("latin1");
        answered = true;
        finish();
        socket.destroy();
      });
      socket.on("error", finish);
      socket.on("close", finish);
      socket.write(requestHead(path, headers));
      const pump = async () => {
        for (let i = 0; upload && i < upload.chunks && !answered; i++) {
          if (!socket.write(chunk))
            await new Promise((drained) => socket.once("drain", drained));
          sentBytes += upload.chunkBytes;
          await new Promise((next) => setImmediate(next));
        }
        if (upload?.complete && !answered) socket.write("0\r\n\r\n");
      };
      void pump().catch(() => undefined);
    },
  );
}

test("public liveness and readiness reveal no configuration", async ({
  request,
}) => {
  const health = await request.get("/health");
  expect(health.status()).toBe(200);
  expect(await health.text()).toBe("ok");
  const ready = await request.get("/ready");
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toEqual({ status: "ready" });
});

test("signed privacy deliveries are accepted and the data handling page is public", async ({
  request,
}) => {
  const body = JSON.stringify({
    shop_id: 1,
    shop_domain: "privacy-http.myshopify.com",
    customer: { id: 10 },
  });
  const hmac = createHmac(
    "sha256",
    "synthetic-contract-test-secret-for-local-verification-only",
  )
    .update(body)
    .digest("base64");
  const response = await request.post("/webhooks/privacy", {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Shop-Domain": "privacy-http.myshopify.com",
      "X-Shopify-Topic": "customers/data_request",
      "X-Shopify-Webhook-Id": "synthetic-privacy-delivery",
      "X-Shopify-Api-Version": "2026-10",
      "X-Shopify-Hmac-Sha256": hmac,
    },
    data: body,
  });
  expect(response.status()).toBe(200);
  expect((await request.get("/privacy")).status()).toBe(200);
});

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
const expectNoFraming = (headers: Record<string, string>) => {
  expect(headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
};

test("landing page serves the real product and a signed-out dashboard goes to sign-in", async ({
  request,
}) => {
  const home = await request.get("/");
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain("Verified store connections");
  expectNoFraming(home.headers());
  const app = await request.get("/app/activity?status=FAILED", {
    maxRedirects: 0,
    headers: {
      "User-Agent": BROWSER,
      Authorization: "Bearer invalid-local-fixture",
    },
  });
  expect(app.status()).toBe(302);
  const target = new URL(app.headers().location, "http://127.0.0.1:3210");
  expect(target.pathname).toBe("/auth/login");
  expect(target.searchParams.get("return_to")).toBe(
    "/app/activity?status=FAILED",
  );
  expect(await app.text()).not.toContain("synthetic-contract-test-secret");
});

test("the login page has its form and the sign-in redirect goes to Shopify with a state cookie", async ({
  request,
}) => {
  const page = await request.get("/auth/login", {
    headers: { "User-Agent": BROWSER },
  });
  expect(page.status()).toBe(200);
  expectNoFraming(page.headers());
  const html = await page.text();
  expect(html).toContain('name="shop"');
  expect(html).not.toContain("polaris");
  expect(html).not.toContain("app-bridge");

  const shop = `http-login-${randomUUID().slice(0, 8)}.myshopify.com`;
  const started = await request.post("/auth/login", {
    headers: { ...LOGIN_POST, "User-Agent": BROWSER },
    data: `shop=${shop}&return_to=%2Fapp%2Frules`,
    maxRedirects: 0,
  });
  expect(started.status()).toBe(302);
  const authorize = new URL(started.headers().location);
  expect(authorize.origin).toBe(`https://${shop}`);
  expect(authorize.pathname).toBe("/admin/oauth/authorize");
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    "http://127.0.0.1:3210/auth/callback",
  );
  expect(authorize.searchParams.get("client_id")).toBe(
    "synthetic-contract-test-key",
  );
  const cookies = started
    .headersArray()
    .filter(({ name }) => name.toLowerCase() === "set-cookie")
    .map(({ value }) => value);
  expect(
    cookies.some((cookie) => cookie.startsWith(`shopify_app_state.${shop}=`)),
  ).toBe(true);
  for (const cookie of cookies) {
    expect(cookie).toMatch(/httponly/i);
    expect(cookie).toMatch(/secure/i);
    expect(cookie).toMatch(/samesite=lax/i);
  }

  const invalid = await request.post("/auth/login", {
    headers: { ...LOGIN_POST, "User-Agent": BROWSER },
    data: "shop=evil.example",
    maxRedirects: 0,
  });
  expect(invalid.status()).toBe(200);
  expect(await invalid.text()).toContain("not a Shopify store domain");

  // A link alone asks first, and starts nothing.
  const linked = await request.get(`/auth/login?shop=${shop}`, {
    headers: { "User-Agent": BROWSER },
    maxRedirects: 0,
  });
  expect(linked.status()).toBe(200);
  expect(linked.headers()["set-cookie"]).toBeUndefined();
  expect(await linked.text()).toContain("Sign in to this store?");

  // Only this app's own page can post it: that post is what starts a sign-in.
  for (const headers of [
    LOGIN_FORM,
    { ...LOGIN_FORM, Origin: "https://127.0.0.1:3210" },
  ]) {
    const forged = await request.post("/auth/login", {
      headers: { ...headers, "User-Agent": BROWSER },
      data: `shop=${shop}`,
      maxRedirects: 0,
    });
    expect(forged.status()).toBe(403);
    expect(forged.headers()["set-cookie"]).toBeUndefined();
  }
});

/** The screen's own markup, and what it would fetch from anywhere else. */
const anythingExternal = (html: string) =>
  [
    ...html.matchAll(/<(?:script|link|img|iframe)\b[^>]*>/gi),
    ...html.matchAll(/\burl\(\s*['"]?(?:https?:)?\/\//gi),
    ...html.matchAll(/@import/gi),
  ]
    .map(([tag]) => tag)
    .filter((tag) => /(?:https?:)?\/\/|@import/i.test(tag));

test("the first screen is one design that loads nothing from anywhere else", async ({
  request,
}) => {
  const get = (path: string) =>
    request.get(path, { headers: { "User-Agent": BROWSER }, maxRedirects: 0 });
  const refused = await get(
    "/auth/callback?code=forged&shop=forged.myshopify.com&state=forged&timestamp=1&hmac=forged",
  );
  const pages = {
    landing: await (await get("/")).text(),
    login: await (await get("/auth/login")).text(),
    refused: await refused.text(),
  };
  for (const [name, html] of Object.entries(pages)) {
    expect(html, name).toMatch(
      /<label[^>]*for="sign-in-shop"[^>]*>Store domain</,
    );
    const field = /<input[^>]*name="shop"[^>]*>/.exec(html)?.[0] ?? "";
    for (const attribute of [
      'id="sign-in-shop"',
      'type="text"',
      'placeholder="your-store.myshopify.com"',
      'autoCapitalize="off"',
      'autoCorrect="off"',
      'spellcheck="false"',
      'autoComplete="on"',
      'inputMode="url"',
      'required=""',
    ])
      expect(field.toLowerCase(), `${name} ${attribute}`).toContain(
        attribute.toLowerCase(),
      );
    expect(html, name).toContain("Sign in to SyncPilot");
    expect(html, name).toContain("SyncPilot never sees your");
    expect(html, name).toContain(">Continue with Shopify</button>");
    expect(html, name).toContain('href="/privacy"');
    expect(html, name).toContain("Verified store connections");
    expect(html, name).toContain("<svg");
    expect(anythingExternal(html), name).toEqual([]);
    expect(html, name).not.toContain("cdn.shopify.com");
    expect(html, name).not.toContain("<img");

    // Its stylesheets come from this server and call out to nothing themselves.
    const sheets = [
      ...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g),
    ].map(([, href]) => href);
    expect(sheets.length, name).toBeGreaterThan(0);
    for (const href of sheets) {
      expect(href, name).toMatch(/^\/assets\//);
      const css = await (await request.get(href)).text();
      expect(anythingExternal(css), href).toEqual([]);
      expect(css, href).not.toMatch(/font-face/i);
      expect(css, href).toContain("prefers-color-scheme:dark");
      expect(css, href).toContain("prefers-reduced-motion");
    }
  }

  // One shared design: the landing page and the login form are the same markup.
  const screen = (html: string) => /<main[\s\S]*<\/main>/.exec(html)?.[0];
  expect(screen(pages.landing)).toBeTruthy();
  expect(screen(pages.login)).toBe(screen(pages.landing));

  // A refusal shows inline, tied to the field, and posts away from Shopify's code.
  expect(refused.status()).toBe(400);
  expect(pages.refused).toMatch(/role="alert"/);
  expect(pages.refused).toMatch(/aria-describedby="sign-in-error"/);
  expect(pages.refused).toMatch(/<form[^>]*action="\/auth\/login"/);
});

test("a bad store domain is answered inline, tied to the field, and keeps what was typed", async ({
  request,
}) => {
  const post = (path: string, shop: string) =>
    request.post(path, {
      headers: { ...LOGIN_POST, "User-Agent": BROWSER },
      data: `shop=${encodeURIComponent(shop)}`,
      maxRedirects: 0,
    });
  const bad = await post("/auth/login?return_to=%2Fapp%2Frules", "not a store");
  expect(bad.status()).toBe(200);
  const html = await bad.text();
  const error = /<p[^>]*id="sign-in-error"[^>]*>([^<]*)</.exec(html);
  expect(error?.[0]).toContain('role="alert"');
  expect(error?.[1]).toContain("not a Shopify store domain");
  const field = /<input[^>]*name="shop"[^>]*>/.exec(html)?.[0] ?? "";
  expect(field).toContain('aria-describedby="sign-in-error"');
  expect(field).toContain('aria-invalid="true"');
  expect(field).toContain('value="not a store"');
  // The way back survives the mistake, in the form and in where it posts.
  expect(html).toMatch(/name="return_to" value="\/app\/rules"/);
  expect(html).toMatch(
    /<form[^>]*action="\/auth\/login\?return_to=%2Fapp%2Frules"/,
  );
  // What is typed is shown as text, whatever it is.
  const hostile = await post("/auth/login", '"><script>alert(1)</script>');
  expect(await hostile.text()).not.toContain("<script>alert(1)");

  // With nothing entered the server still says so; the browser normally stops first.
  const empty = await post("/auth/login", "");
  expect(await empty.text()).toContain("Enter your store domain");

  // A link from Shopify that does not verify shows the same way on the first page.
  const link = await request.get(
    "/?shop=forged.myshopify.com&timestamp=1&hmac=forged",
    { headers: { "User-Agent": BROWSER }, maxRedirects: 0 },
  );
  expect(link.status()).toBe(400);
  const linkHtml = await link.text();
  expect(linkHtml).toMatch(/<p[^>]*id="sign-in-error"[^>]*role="alert"/);
  expect(linkHtml).toContain("could not be verified");

  // So does a form the server refuses outright, through the route's error boundary.
  const tooLarge = await post("/auth/login", "x".repeat(8 * 1024));
  expect(tooLarge.status()).toBe(413);
  const tooLargeHtml = await tooLarge.text();
  expect(tooLargeHtml).toContain("Continue with Shopify");
  expect(tooLargeHtml).toMatch(/<p[^>]*id="sign-in-error"[^>]*role="alert"/);
  expect(anythingExternal(tooLargeHtml)).toEqual([]);
});

test("a callback nobody started is refused on a page that cannot be framed", async ({
  request,
}) => {
  const response = await request.get(
    "/auth/callback?code=forged&shop=forged.myshopify.com&state=forged&timestamp=1&hmac=forged",
    { headers: { "User-Agent": BROWSER }, maxRedirects: 0 },
  );
  expect(response.status()).toBe(400);
  expectNoFraming(response.headers());
  expect(await response.text()).toContain("Sign in again");
});

test("a dashboard post needs this origin and a store, and without a session asks to sign in", async ({
  request,
}) => {
  const store = "http-nobody.myshopify.com";
  const post = (
    headers: Record<string, string>,
    path = `/app/stores?shop=${store}`,
  ) =>
    request.post(path, {
      headers: { ...LOGIN_FORM, "User-Agent": BROWSER, ...headers },
      data: "intent=initiate",
      maxRedirects: 0,
    });
  // No Origin, and this host over another scheme: the app's own check stops these.
  expect((await post({})).status()).toBe(403);
  expect((await post({ Origin: "https://127.0.0.1:3210" })).status()).toBe(403);
  // Another host never reaches a route: React Router refuses it first, with 400.
  expect((await post({ Origin: "https://evil.example" })).status()).toBe(400);
  const signedOut = await post({ Origin: "http://127.0.0.1:3210" });
  expect(signedOut.status()).toBe(401);
  expectNoFraming(signedOut.headers());
  const html = await signedOut.text();
  expect(html).toContain("Your session has ended");
  expect(html).toContain(store);
  expect(html).toContain("Nothing was changed");
  expect(html).toContain("/auth/login?return_to=%2Fapp%2Fstores");
  // A post that names no store has nothing to run on, whoever sent it.
  const unnamed = await post(
    { Origin: "http://127.0.0.1:3210" },
    "/app/stores",
  );
  expect(unnamed.status()).toBe(400);
  expectNoFraming(unnamed.headers());
  const unnamedHtml = await unnamed.text();
  expect(unnamedHtml).toContain("did not say which store");
  expect(unnamedHtml).toContain("Nothing was changed");
});

test("signing out takes a post from this origin", async ({ request }) => {
  const forged = await request.post("/auth/logout", {
    headers: { "User-Agent": BROWSER },
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);
  const get = await request.get("/auth/logout", {
    headers: { "User-Agent": BROWSER },
    maxRedirects: 0,
  });
  expect(get.status()).not.toBe(302);
  expect(get.status()).toBeGreaterThanOrEqual(400);
});

test("the whole sign-in works on the production build, every page renders without App Bridge, and no token leaks", async () => {
  test.setTimeout(60_000);
  const port = 3212;
  const base = `http://127.0.0.1:${port}`;
  let output = "";
  const startServer = () => {
    const started = spawn(
      process.execPath,
      [
        "--import",
        "./tests/e2e/shopify-stub.mjs",
        "scripts/serve.mjs",
        "./build/server/index.js",
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          PORT: String(port),
          LOG_LEVEL: "debug",
          SHOPIFY_API_KEY: "synthetic-contract-test-key",
          SHOPIFY_API_SECRET: SECRET,
          SHOPIFY_APP_URL: base,
          SCOPES:
            "read_products,write_products,read_inventory,write_inventory,read_locations",
          SYNC_WRITE_ENABLED: "false",
          INVENTORY_WRITE_ENABLED: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    started.stdout.on("data", (data) => (output += data));
    started.stderr.on("data", (data) => (output += data));
    return started;
  };
  let server = startServer();
  const serverAnswers = () =>
    expect
      .poll(
        () =>
          fetch(`${base}/health`)
            .then((response) => response.status)
            .catch(() => 0),
        { timeout: 20_000 },
      )
      .toBe(200);
  /** As a browser keeps them: an expiring cookie reaches only its own name and path. */
  const jar = {
    cookies: new Map<string, { name: string; value: string; path: string }>(),
    get: (name: string) =>
      [...jar.cookies.values()].find((cookie) => cookie.name === name)?.value,
    has: (name: string) => jar.get(name) !== undefined,
    /** The row id in a store's session cookie, which holds nothing else. */
    sessionId: (store: string) => {
      const value = jar.get(`syncpilot_session.${store}`);
      return value
        ? (JSON.parse(atob(decodeURIComponent(value).split(".")[0])) as string)
        : "";
    },
    values: () => [...jar.cookies.values()].map(({ value }) => value),
    sentTo: (pathname: string) =>
      [...jar.cookies.values()]
        .filter(
          ({ path }) =>
            path === "/" ||
            pathname === path ||
            pathname.startsWith(`${path}/`),
        )
        .map(({ name, value }) => `${name}=${value}`)
        .join("; "),
  };
  const visit = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      redirect: "manual",
      ...init,
      headers: {
        "User-Agent": BROWSER,
        Cookie: jar.sentTo(new URL(path, base).pathname),
        ...init.headers,
      },
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const equals = pair.indexOf("=");
      const name = pair.slice(0, equals);
      const cookiePath = /;\s*path=([^;]*)/i.exec(line)?.[1] ?? "/";
      const key = `${name}|${cookiePath}`;
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(line))
        jar.cookies.delete(key);
      else
        jar.cookies.set(key, {
          name,
          value: pair.slice(equals + 1),
          path: cookiePath,
        });
    }
    return response;
  };
  /** Opens a store from its Shopify admin, through whatever grants it needs. */
  const signInFromShopify = async (store: string) => {
    let step = await visit(
      `/?${signed({ shop: store, timestamp: timestamp() })}`,
    );
    let trip = 0;
    while (step.headers.get("Location")?.includes("/admin/oauth/authorize")) {
      const authorize = new URL(step.headers.get("Location")!);
      const person =
        authorize.searchParams.get("grant_options[]") === "per-user";
      trip += 1;
      step = await returnFromShopify(
        authorize,
        `${person ? "online" : "offline"}-code-${trip}`,
      );
    }
    expect(step.headers.get("Location")).toBe(`/app?shop=${store}`);
  };
  /** A dashboard form as the page renders it: it posts to its own address. */
  const postForm = (path: string, store: string, body = "intent=none") =>
    visit(`${path}?shop=${store}`, {
      method: "POST",
      headers: { ...LOGIN_FORM, Origin: base },
      body,
    });
  const signed = (params: Record<string, string>) => {
    const query = new URLSearchParams(
      Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
    );
    query.set(
      "hmac",
      createHmac("sha256", SECRET).update(query.toString()).digest("hex"),
    );
    return query;
  };
  const timestamp = () => String(Math.trunc(Date.now() / 1000));
  /** Sends the browser back from Shopify, signed as Shopify documents. */
  const returnFromShopify = (authorize: URL, code: string) =>
    visit(
      `/auth/callback?${signed({
        code,
        shop: authorize.hostname,
        state: authorize.searchParams.get("state") ?? "",
        timestamp: timestamp(),
      })}`,
    );
  const database = new PrismaClient();
  try {
    await serverAnswers();
    const shop = `http-flow-${randomUUID().slice(0, 8)}.myshopify.com`;

    // Opening it from Shopify, then both grants, then the dashboard.
    let step = await visit(`/?${signed({ shop, timestamp: timestamp() })}`);
    expect(step.status).toBe(302);
    let authorize = new URL(step.headers.get("Location")!);
    expect(authorize.searchParams.get("grant_options[]")).toBe("per-user");
    step = await returnFromShopify(authorize, "online-code");
    expect(step.status).toBe(302);
    authorize = new URL(step.headers.get("Location")!);
    expect(authorize.searchParams.get("grant_options[]")).toBe("");
    step = await returnFromShopify(authorize, "offline-code");
    expect(step.status).toBe(302);
    expect(step.headers.get("Location")).toBe(`/app?shop=${shop}`);
    expect(jar.has(`syncpilot_session.${shop}`)).toBe(true);

    // A bare address opens the store this browser has, and then says so.
    const bare = await visit("/app/rules");
    expect(bare.status).toBe(302);
    expect(bare.headers.get("Location")).toBe(`/app/rules?shop=${shop}`);

    // Every page the menu offers, as an ordinary full page with plain links.
    const overview = await visit(`/app?shop=${shop}`);
    expect(overview.status).toBe(200);
    const links = [
      ...new Set(
        [...(await overview.text()).matchAll(/href="(\/app[^"#?]*)\?/g)].map(
          ([, href]) => href,
        ),
      ),
    ];
    expect(links).toEqual(
      expect.arrayContaining([
        "/app",
        "/app/stores",
        "/app/products",
        "/app/inventory",
        "/app/stock-pools",
        "/app/mappings",
        "/app/rules",
        "/app/automatic-sync",
        "/app/activity",
        "/app/conflicts",
        "/app/reconciliation",
        "/app/settings",
        "/app/help",
      ]),
    );
    const pages: string[] = [];
    let changingForms = 0;
    let searchForms = 0;
    for (const path of links) {
      const page = await visit(`${path}?shop=${shop}`);
      expect(page.status, path).toBe(200);
      expect(page.headers.get("Content-Security-Policy"), path).toBe(
        "frame-ancestors 'none'",
      );
      expect(page.headers.get("X-Frame-Options"), path).toBe("DENY");
      expect(page.headers.get("Cache-Control"), path).toBe("no-store");
      const html = await page.text();
      pages.push(html);
      expect(html, path).toContain("shopifycloud/polaris.js");
      expect(html, path).not.toContain("app-bridge");
      expect(html, path).not.toContain("ui-nav-menu");
      expect(html, path).toContain(shop);
      expect(html, path).toContain("Sign out");
      expect(html, path).toContain("Store owner");
      // Every link in the dashboard keeps this tab on its store, so no page can
      // send it to another one or leave a form with nothing to run on.
      const hrefs = [...html.matchAll(/href="(\/app[^"]*)"/g)].map(([, href]) =>
        href.replaceAll("&amp;", "&"),
      );
      expect(hrefs.length, path).toBeGreaterThan(12);
      for (const href of hrefs)
        expect(
          new URL(href, base).searchParams.getAll("shop"),
          `${path}: ${href}`,
        ).toEqual([shop]);
      // So does every form: a post by its address, a search by a field.
      for (const [form] of html.matchAll(
        /<form\b[^>]*method="post"[^>]*>[\s\S]*?<\/form>/g,
      )) {
        const action = /action="([^"]*)"/.exec(form)?.[1] ?? "";
        expect(
          new URL(action.replaceAll("&amp;", "&"), base).searchParams.getAll(
            "shop",
          ),
          `${path}: ${action}`,
        ).toEqual([shop]);
        if (!action.startsWith("/auth/logout")) changingForms += 1;
      }
      for (const [form] of html.matchAll(
        /<form\b[^>]*method="get"[^>]*>[\s\S]*?<\/form>/g,
      )) {
        expect(form.split(`name="shop" value="${shop}"`).length - 1, path).toBe(
          1,
        );
        searchForms += 1;
      }
    }
    expect(changingForms).toBeGreaterThan(0);
    expect(searchForms).toBeGreaterThan(0);

    // A menu click fetches data, with the same session and the same store.
    const data = await visit(`/app/rules.data?shop=${shop}`);
    expect(data.status).toBe(200);
    expect(data.headers.get("Cache-Control")).toBe("no-store");
    // React Router routes these spellings to the same page, so they are kept no more.
    for (const path of ["/APP/stores", "/App", "/%61pp/stores"]) {
      const spelled = await visit(`${path}?shop=${shop}`);
      expect(spelled.status, path).toBe(200);
      expect(spelled.headers.get("Cache-Control"), path).toBe("no-store");
    }

    // Cross-site posts are refused before the action, on both ways of posting: by
    // the app's check, and first by React Router when Origin names another host.
    for (const [origin, status] of [
      [undefined, 403],
      [base.replace("http:", "https:"), 403],
      ["https://evil.example", 400],
    ] as const)
      for (const path of [
        `/app/stores?shop=${shop}`,
        `/app/stores.data?shop=${shop}`,
      ]) {
        const refused = await visit(path, {
          method: "POST",
          headers: { ...LOGIN_FORM, ...(origin ? { Origin: origin } : {}) },
          body: `intent=initiate&destinationShop=${shop}`,
        });
        expect(refused.status, `${path} ${origin}`).toBe(status);
      }
    expect(
      await database.storePairingRequest.count({
        where: { initiatingShop: shop },
      }),
    ).toBe(0);
    const reached = await postForm("/app/stores", shop);
    expect(reached.status).toBe(200);

    // A form that names no store is refused, on both ways of posting.
    for (const path of ["/app/stores", "/app/stores.data"]) {
      const unbound = await visit(path, {
        method: "POST",
        headers: { ...LOGIN_FORM, Origin: base },
        body: "intent=initiate",
      });
      expect(unbound.status, path).toBe(400);
    }

    // A lapsed session: pages go back through Shopify, posts say so.
    const id = jar.sessionId(shop);
    await database.session.update({
      where: { id },
      data: { expires: new Date(Date.now() - 60_000) },
    });
    const page = await visit(`/app/rules?edit=abc&shop=${shop}`);
    expect(page.status).toBe(302);
    const again = new URL(page.headers.get("Location")!, base);
    expect(again.pathname).toBe("/auth/login");
    expect(again.searchParams.get("shop")).toBe(shop);
    expect(again.searchParams.get("return_to")).toBe("/app/rules?edit=abc");
    const clicked = await visit(
      `/app/rules.data?edit=abc&shop=${shop}&_routes=routes/app`,
    );
    expect(await clicked.text()).toContain("/auth/login");
    const lapsedPost = await visit(`/app/stores?shop=${shop}`, {
      method: "POST",
      headers: { ...LOGIN_FORM, Origin: base },
      body: `intent=initiate&destinationShop=other-${shop}`,
    });
    expect(lapsedPost.status).toBe(401);
    expect(await lapsedPost.text()).toContain("Your session has ended");
    const lapsedData = await visit(`/app/stores.data?shop=${shop}`, {
      method: "POST",
      headers: { ...LOGIN_FORM, Origin: base },
      body: `intent=initiate&destinationShop=other-${shop}`,
    });
    expect(lapsedData.status).toBe(401);
    expect(
      await database.storePairingRequest.count({
        where: { initiatingShop: shop },
      }),
    ).toBe(0);
    step = await visit(`${again.pathname}${again.search}`);
    authorize = new URL(step.headers.get("Location")!);
    expect(authorize.searchParams.get("grant_options[]")).toBe("per-user");
    step = await returnFromShopify(authorize, "online-code-2");
    expect(step.headers.get("Location")).toBe(
      `/app/rules?edit=abc&shop=${shop}`,
    );

    // Signing out ends it, and a link to it then asks before it starts anything.
    const stale = jar.sessionId(shop);
    const out = await visit(`/auth/logout?shop=${shop}`, {
      method: "POST",
      headers: { Origin: base },
    });
    expect(out.status).toBe(302);
    expect(out.headers.get("Location")).toBe("/auth/login");
    expect(jar.has(`syncpilot_session.${shop}`)).toBe(false);
    expect(await database.session.count({ where: { id: stale } })).toBe(0);
    const after = await visit("/app");
    expect(after.status).toBe(302);
    expect(after.headers.get("Location")).toBe("/auth/login?return_to=%2Fapp");
    const backToIt = await visit(`/auth/login?shop=${shop}`);
    expect(backToIt.status).toBe(200);
    expect(await backToIt.text()).toContain("Sign in to this store?");

    // Two stores in one browser: both go on working, each on its own, and the
    // pairing they need runs from start to finish with no signing in between.
    const first = `http-tab-a-${randomUUID().slice(0, 8)}.myshopify.com`;
    const second = `http-tab-b-${randomUUID().slice(0, 8)}.myshopify.com`;
    await signInFromShopify(first);
    const firstRow = jar.sessionId(first);
    await signInFromShopify(second);
    expect(jar.sessionId(first)).toBe(firstRow);
    const firstPage = await visit(`/app?shop=${first}`);
    expect(firstPage.status).toBe(200);
    const firstHtml = await firstPage.text();
    expect(firstHtml).toContain(`href="/app?shop=${second}"`);
    expect(firstHtml).toMatch(/Synthetic O\./);
    expect(firstHtml).not.toContain("fixture@example.invalid");
    const initiated = await postForm(
      "/app/stores",
      first,
      `intent=initiate&destinationShop=${second}&organizationConfirmed=on`,
    );
    expect(initiated.status).toBe(200);
    const codes = [
      ...(await initiated.text()).matchAll(/class="sp-code">([^<]+)</g),
    ].map(([, value]) => value);
    expect(codes).toHaveLength(2);
    const [requestId, challenge] = codes;
    const pairing = () =>
      database.storePairingRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
    expect(await pairing()).toMatchObject({
      initiatingShop: first,
      destinationShop: second,
      state: "PENDING",
    });
    const accepted = await postForm(
      "/app/stores.data",
      second,
      new URLSearchParams({
        intent: "accept",
        requestId,
        challenge,
        organizationConfirmed: "on",
      }).toString(),
    );
    expect(accepted.status).toBe(200);
    expect(await pairing()).toMatchObject({ state: "ACCEPTED" });
    const confirmed = await postForm(
      "/app/stores",
      first,
      `intent=confirm&id=${requestId}`,
    );
    expect(confirmed.status).toBe(200);
    expect(await pairing()).toMatchObject({ state: "VERIFIED" });
    for (const store of [first, second]) {
      const both = await visit(`/app?shop=${store}`);
      expect(both.status, store).toBe(200);
      expect(await both.text(), store).toContain(store);
    }

    // A link naming a store this browser never signed in to asks first, and leaves
    // every session as it was. Only the person's own post from that page goes on.
    const third = `http-tab-c-${randomUUID().slice(0, 8)}.myshopify.com`;
    const held = [jar.sessionId(first), jar.sessionId(second)];
    const asked = await visit(`/auth/login?shop=${third}`);
    expect(asked.status).toBe(200);
    expect(asked.headers.getSetCookie()).toEqual([]);
    const askedHtml = await asked.text();
    expect(askedHtml).toContain("Sign in to this store?");
    expect(askedHtml).toContain(third);
    const fromAnApp = await visit(`/app/rules?shop=${third}`);
    expect(fromAnApp.status).toBe(302);
    expect(new URL(fromAnApp.headers.get("Location")!, base).pathname).toBe(
      "/auth/login",
    );
    const chosen = await visit(`/auth/login?shop=${third}`, {
      method: "POST",
      headers: { ...LOGIN_FORM, Origin: base },
      body: `shop=${third}`,
    });
    expect(new URL(chosen.headers.get("Location")!).hostname).toBe(third);
    expect([jar.sessionId(first), jar.sessionId(second)]).toEqual(held);

    // What this browser is still signed in to shows on the sign-in page.
    const listing = await visit("/auth/login");
    const listingHtml = await listing.text();
    expect(listingHtml).toContain(`href="/app?shop=${first}"`);
    expect(listingHtml).toContain(`href="/app?shop=${second}"`);
    expect(listingHtml).toContain("Sign out of all of them");

    // Shopify refuses the person's token: that store's session ends, on both ways of
    // posting, and the other stores' do not.
    const destination = "http-destination.myshopify.com";
    const initiating = `intent=initiate&destinationShop=${destination}&organizationConfirmed=on`;
    for (const path of ["/app/stores", "/app/stores.data"]) {
      const revoked = `revoked-${randomUUID().slice(0, 8)}.myshopify.com`;
      await signInFromShopify(revoked);
      const row = jar.sessionId(revoked);
      const refused = await postForm(path, revoked, initiating);
      expect(refused.status, path).toBe(401);
      expect(jar.has(`syncpilot_session.${revoked}`), path).toBe(false);
      expect(await database.session.count({ where: { id: row } }), path).toBe(
        0,
      );
      expect([jar.sessionId(first), jar.sessionId(second)], path).toEqual(held);
      expect(
        await database.storePairingRequest.count({
          where: { initiatingShop: revoked },
        }),
        path,
      ).toBe(0);
      if (path === "/app/stores")
        expect(await refused.text()).toContain("Your session has ended");
    }

    // Shopify does not answer: nothing applied, still signed in, told to try again.
    const down = `shopify-down-${randomUUID().slice(0, 8)}.myshopify.com`;
    await signInFromShopify(down);
    const row = jar.sessionId(down);
    for (const path of ["/app/stores", "/app/stores.data"]) {
      const unanswered = await postForm(path, down, initiating);
      expect(unanswered.status, path).toBe(503);
      if (path === "/app/stores") {
        expect(unanswered.headers.get("Retry-After")).toBe("10");
        expect(await unanswered.text()).toContain("Shopify could not confirm");
      }
    }
    expect(await database.session.count({ where: { id: row } })).toBe(1);
    expect(jar.sessionId(down)).toBe(row);
    expect((await visit(`/app?shop=${down}`)).status).toBe(200);

    // Logged out of Shopify, and only reading: the next time a page asks, that store's
    // session ends, for a whole page and a menu click alike. A restart forgets what
    // Shopify last said, as three minutes would. Nothing else stops working.
    const readingPage = `revoked-${randomUUID().slice(0, 8)}.myshopify.com`;
    const readingMenu = `revoked-${randomUUID().slice(0, 8)}.myshopify.com`;
    await signInFromShopify(readingPage);
    await signInFromShopify(readingMenu);
    const readingRows = [
      jar.sessionId(readingPage),
      jar.sessionId(readingMenu),
    ];
    expect((await visit(`/app?shop=${readingPage}`)).status).toBe(200);
    expect((await visit(`/app/rules.data?shop=${readingMenu}`)).status).toBe(
      200,
    );
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
    server = startServer();
    await serverAnswers();
    const ended = await visit(`/app/rules?edit=abc&shop=${readingPage}`);
    expect(ended.status).toBe(302);
    const signInAgain = new URL(ended.headers.get("Location")!, base);
    expect(signInAgain.pathname).toBe("/auth/login");
    expect(signInAgain.searchParams.get("shop")).toBe(readingPage);
    expect(signInAgain.searchParams.get("return_to")).toBe(
      "/app/rules?edit=abc",
    );
    expect(ended.headers.get("X-Remix-Reload-Document")).toBe("true");
    const endedMenu = await visit(
      `/app/rules.data?edit=abc&shop=${readingMenu}&_routes=routes/app`,
    );
    // How React Router writes a redirect down: each field names where its value is.
    const written = (await endedMenu.json()) as unknown[];
    const fields = written[1] as Record<string, number>;
    const field = (name: string) =>
      written[fields[`_${written.indexOf(name)}`]];
    expect(field("redirect")).toBe(
      `/auth/login?${new URLSearchParams({
        return_to: "/app/rules?edit=abc",
        shop: readingMenu,
      })}`,
    );
    expect(field("reload")).toBe(true);
    for (const store of [readingPage, readingMenu])
      expect(jar.has(`syncpilot_session.${store}`), store).toBe(false);
    expect(
      await database.session.count({ where: { id: { in: readingRows } } }),
    ).toBe(0);
    for (const store of [first, second, down]) {
      const kept = await visit(`/app?shop=${store}`);
      expect(kept.status, store).toBe(200);
      expect(await kept.text(), store).toContain(store);
    }

    // Staff with no access on a paired store get the reason and a way out, not a
    // bare 500. A production build hides an error's text, so this needs one.
    const staffShop = `staff-${randomUUID().slice(0, 8)}.myshopify.com`;
    const partner = `partner-${randomUUID().slice(0, 8)}.myshopify.com`;
    await signInFromShopify(staffShop);
    const workspace = await database.workspace.create({
      data: { name: "Synthetic paired workspace" },
    });
    await database.shopConnection.update({
      where: { shopDomain: staffShop },
      data: { workspaceId: workspace.id },
    });
    await database.shopConnection.create({
      data: { shopDomain: partner, workspaceId: workspace.id },
    });
    await database.storePair.create({
      data: {
        workspaceId: workspace.id,
        sourceShop: staffShop,
        targetShop: partner,
        requestId: `http-pair-${randomUUID()}`,
      },
    });
    const noAccess = await visit(`/app?shop=${staffShop}`);
    expect(noAccess.status).toBe(403);
    expect(noAccess.headers.get("Cache-Control")).toBe("no-store");
    const noAccessHtml = await noAccess.text();
    expect(noAccessHtml).toContain("A workspace owner must grant access");
    expect(noAccessHtml).toContain(`action="/auth/logout?shop=${staffShop}"`);
    expect(noAccessHtml).not.toContain("Something went wrong");

    // Nothing above put a token anywhere a person or a log can see it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const token of [
      "shpat_stub_offline_token",
      "shpua_stub_online_token",
      "shprt_stub_refresh_token",
    ]) {
      expect(output).not.toContain(token);
      expect(pages.join("\n")).not.toContain(token);
      expect(jar.values().join()).not.toContain(token);
    }
    expect(output).not.toContain("offline-code");
    expect(output).not.toContain("online-code");
    expect(output).not.toContain(authorize.searchParams.get("state"));
    expect(output).not.toContain("hmac=");
  } finally {
    await database.$disconnect();
    server.kill("SIGTERM");
  }
});

test("signed lifecycle deliveries prove their store from the body", async ({
  request,
}) => {
  const shop = `lifecycle-${randomUUID().slice(0, 8)}.myshopify.com`;
  const other = "someone-else.myshopify.com";
  const post = (path: string, topic: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    return request.post(path, {
      headers: shopifyHeaders(shop, topic, body),
      data: body,
    });
  };
  const uninstall = "/webhooks/app/uninstalled";
  const privacy = "/webhooks/privacy";
  expect(
    (
      await post(uninstall, "app/uninstalled", { myshopify_domain: other })
    ).status(),
  ).toBe(400);
  expect(
    (await post(privacy, "shop/redact", { shop_domain: other })).status(),
  ).toBe(400);
  // One signed body cannot be pointed at a route its topic does not belong to.
  expect(
    (await post(uninstall, "shop/redact", { myshopify_domain: shop })).status(),
  ).toBe(400);
  expect(
    (
      await post(uninstall, "app/uninstalled", { myshopify_domain: shop })
    ).status(),
  ).toBe(200);
  expect(
    (await post(privacy, "shop/redact", { shop_domain: shop })).status(),
  ).toBe(200);
});

test("anonymous bodies over the limit get 413 before the server buffers them", async () => {
  const forged = FORGED_DELIVERY;
  for (const route of [
    "/webhooks/products/update",
    "/webhooks/inventory/levels/update",
    "/webhooks/app/uninstalled",
    "/webhooks/app/scopes_update",
    "/webhooks/privacy",
  ]) {
    // A declared 300 MB: answered at once, with none of it sent.
    const declared = await rawRequest(route, {
      ...forged,
      "Content-Length": String(300 * 1024 * 1024),
    });
    expect(declared.status).toBe(413);
  }
  // No declared length: the server stops reading at the limit and says so.
  const streamed = await rawRequest(
    "/webhooks/products/update",
    { ...forged, "Transfer-Encoding": "chunked" },
    { chunks: 400, chunkBytes: 64 * 1024 },
  );
  expect(streamed.status).toBe(413);
  expect(streamed.sentBytes).toBeLessThan(25 * 1024 * 1024);

  const login = LOGIN_POST;
  const declaredLogin = await rawRequest("/auth/login", {
    ...login,
    "Content-Length": String(1024 * 1024),
  });
  expect(declaredLogin.status).toBe(413);
  // The page that reports it still sends the header that ends the upload.
  expect(declaredLogin.head).toMatch(/connection: close/i);
  expect(
    (
      await rawRequest(
        "/auth/login",
        { ...login, "Transfer-Encoding": "chunked" },
        { chunks: 200, chunkBytes: 1024 },
      )
    ).status,
  ).toBe(413);
});

test("a signed delivery above Shopify's largest documented payload size is still received", async ({
  request,
}) => {
  const shop = `large-${randomUUID().slice(0, 8)}.myshopify.com`;
  const body = JSON.stringify({ id: 1, filler: "x".repeat(6 * 1024 * 1024) });
  const response = await request.post("/webhooks/products/update", {
    headers: shopifyHeaders(shop, "products/update", body),
    data: body,
  });
  expect(response.status()).toBe(200);
});

test("stalled uploads are dropped at the deadline and never shut out small deliveries", async ({
  request,
}) => {
  test.setTimeout(60_000);
  // 64 MiB in all, in seconds and with no secret, which is the size of the budget.
  const uploads = [];
  for (const chunks of [151, 151, 151, 151, 151, 151, 118])
    uploads.push(await stalledUpload(chunks));
  const stalledLogin = heldConnection();
  stalledLogin.socket.write(
    requestHead("/auth/login", { ...LOGIN_POST, "Content-Length": "4000" }) +
      "shop=stalled",
  );
  // The share large bodies may use is gone: one more is told to come back.
  await expect
    .poll(
      async () =>
        (
          await rawRequest(
            "/webhooks/products/update",
            { ...FORGED_DELIVERY, "Transfer-Encoding": "chunked" },
            { chunks: 156, chunkBytes: 64 * KiB, complete: true },
          )
        ).head,
      { timeout: 6_000 },
    )
    .toMatch(/^HTTP\/1\.1 503[\s\S]*retry-after: 5/i);

  const shop = `stalled-${randomUUID().slice(0, 8)}.myshopify.com`;
  const signed = async (path: string, topic: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const response = await request.post(path, {
      headers: shopifyHeaders(shop, topic, body),
      data: body,
    });
    return response.status();
  };
  expect(
    await signed("/webhooks/app/uninstalled", "app/uninstalled", {
      id: 1,
      myshopify_domain: shop,
    }),
  ).toBe(200);
  expect(
    await signed("/webhooks/privacy", "shop/redact", {
      shop_id: 1,
      shop_domain: shop,
    }),
  ).toBe(200);
  expect(
    await signed("/webhooks/products/update", "products/update", { id: 1 }),
  ).toBe(200);
  const login = await request.post("/auth/login", {
    headers: LOGIN_POST,
    data: "shop=not%20a%20shop",
    maxRedirects: 0,
  });
  expect(login.status()).toBe(200);
  // All of that happened with the uploads still connected and holding their share.
  expect(
    uploads.filter((upload) => !upload.socket.destroyed).length,
  ).toBeGreaterThanOrEqual(4);

  // Every stalled socket is answered and closed at the read deadline.
  const closedAfterMs = await Promise.all(
    [...uploads, stalledLogin].map((held) => held.closedAfterMs),
  );
  expect(Math.max(...closedAfterMs)).toBeLessThan(12_000);
  expect(stalledLogin.status()).toBe(408);
  expect(
    uploads.filter((upload) => upload.status() === 408).length,
  ).toBeGreaterThanOrEqual(4);
  for (const upload of uploads)
    if (upload.status()) expect([408, 503]).toContain(upload.status());

  // All of it was given back: a large delivery fits again.
  const large = JSON.stringify({ id: 2, filler: "x".repeat(6 * 1024 * 1024) });
  const received = await request.post("/webhooks/products/update", {
    headers: shopifyHeaders(shop, "products/update", large),
    data: large,
  });
  expect(received.status()).toBe(200);
});

test("a body cut into tiny chunks ends the connection with any method on any route, read or not", async () => {
  // One byte a chunk: under every byte limit, and an object the server must hold.
  const tiny = "1\r\nx\r\n".repeat(20_000);
  for (const [method, route] of [
    ["POST", "/webhooks/products/update"],
    ["POST", "/auth/login"],
    ["POST", "/health"],
    ["POST", "/app"],
    // A GET or HEAD can declare a body too, and nothing here reads one.
    ["GET", "/health"],
    ["GET", "/app"],
    ["HEAD", "/health"],
    ["OPTIONS", "/health"],
    ["DELETE", "/health"],
    // A static file is answered before any route runs.
    ["GET", "/favicon.ico"],
    ["HEAD", "/favicon.ico"],
  ]) {
    const held = heldConnection();
    held.socket.write(
      requestHead(
        route,
        { ...FORGED_DELIVERY, "Transfer-Encoding": "chunked" },
        method,
      ) + tiny,
    );
    expect(await held.closedAfterMs, `${method} ${route}`).toBeLessThan(3_000);
  }
});

test("ordinary reads are unaffected by the chunk rule, on one kept-alive connection", async () => {
  const answers = (received: string) =>
    received.match(/HTTP\/1\.1 \d{3}/g)?.map((line) => line.slice(9)) ?? [];
  const socket = connect(3210, "127.0.0.1");
  let received = "";
  socket.on("data", (data) => (received += data.toString("latin1")));
  const send = async (head: string, expected: string[]) => {
    socket.write(head);
    await expect.poll(() => answers(received)).toEqual(expected);
  };
  try {
    const plain = (method: string, path: string) =>
      requestHead(path, {}, method);
    await send(plain("GET", "/health"), ["200"]);
    await send(plain("HEAD", "/health"), ["200", "200"]);
    await send(plain("GET", "/favicon.ico"), ["200", "200", "200"]);
    // A small declared body is read and discarded, and the connection goes on.
    await send(
      requestHead("/health", { "Transfer-Encoding": "chunked" }, "GET") +
        "5\r\nhello\r\n0\r\n\r\n",
      ["200", "200", "200", "200"],
    );
    await send(plain("GET", "/health"), ["200", "200", "200", "200", "200"]);
    expect(socket.destroyed).toBe(false);
  } finally {
    socket.destroy();
  }
});

test("a signed delivery in ordinary small chunks is received", async () => {
  const shop = `chunks-${randomUUID().slice(0, 8)}.myshopify.com`;
  const body = JSON.stringify({ id: 3, filler: "x".repeat(100 * KiB) });
  const pieces = body.match(/[\s\S]{1,500}/g) ?? [];
  const held = heldConnection();
  held.socket.write(
    requestHead("/webhooks/products/update", {
      ...shopifyHeaders(shop, "products/update", body),
      "Transfer-Encoding": "chunked",
    }) +
      pieces
        .map((piece) => `${piece.length.toString(16)}\r\n${piece}\r\n`)
        .join("") +
      "0\r\n\r\n",
  );
  await expect.poll(() => held.status()).toBe(200);
  held.socket.destroy();
});

test("the server drops clients that stall in their headers or never finish a request", async () => {
  test.setTimeout(60_000);
  const partialHeaders = () => {
    const held = heldConnection();
    held.socket.write("POST /health HTTP/1.1\r\nHost: 127.0.0.1:3210\r\n");
    return held;
  };
  // Answered at once, and then kept open by a body that never ends. Nothing reads
  // it, so only the limit on the whole request can end this one.
  const dripping = heldConnection();
  dripping.socket.write(
    requestHead("/health", { "Transfer-Encoding": "chunked" }),
  );
  const drip = setInterval(() => dripping.socket.write("1\r\nx\r\n"), 1_000);
  const held = [dripping, partialHeaders()];
  try {
    // Fifteen seconds apart: no single pass of a 30 second check serves both, so
    // this fails if the server goes back to Node's default checking interval.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    held.push(partialHeaders());
    const [drippingMs, firstMs, secondMs] = await Promise.all(
      held.map((connection) => connection.closedAfterMs),
    );
    for (const ms of [firstMs, secondMs]) {
      expect(ms).toBeGreaterThan(14_000);
      expect(ms).toBeLessThan(22_000);
    }
    expect(drippingMs).toBeGreaterThan(29_000);
    expect(drippingMs).toBeLessThan(37_000);
  } finally {
    clearInterval(drip);
    for (const connection of held) connection.socket.destroy();
  }
});

test("the request log carries paths, never the tokens Shopify puts in the URL", async ({
  request,
}) => {
  const port = 3211;
  const server = spawn(
    process.execPath,
    ["scripts/serve.mjs", "./build/server/index.js"],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        SHOPIFY_API_KEY: "synthetic-contract-test-key",
        SHOPIFY_API_SECRET: SECRET,
        SHOPIFY_APP_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  server.stdout.on("data", (data) => (output += data));
  server.stderr.on("data", (data) => (output += data));
  try {
    await expect
      .poll(
        async () =>
          request
            .get(`http://127.0.0.1:${port}/health`)
            .then((response) => response.status())
            .catch(() => 0),
        { timeout: 20_000 },
      )
      .toBe(200);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const hmac = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const response = await request.get(
      `http://127.0.0.1:${port}/health?embedded=1&hmac=${hmac}&id_token=${jwt}&shop=x.myshopify.com`,
    );
    expect(response.status()).toBe(200);
    await expect
      .poll(
        () =>
          output.split("\n").filter((line) => /"path":"\/health"/.test(line))
            .length,
      )
      .toBeGreaterThan(1);
    expect(output).not.toContain(jwt);
    expect(output).not.toContain(hmac);
    expect(output).not.toContain("id_token");
    // A refused request is not printed past the logger by an error boundary.
    const refused = await request.post(`http://127.0.0.1:${port}/auth/login`, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: `http://127.0.0.1:${port}`,
      },
      data: `shop=${"x".repeat(8 * 1024)}`,
    });
    expect(refused.status()).toBe(413);
    await expect.poll(() => output.includes('"path":"/auth/login"')).toBe(true);
    expect(output).not.toContain("ErrorResponse");
  } finally {
    server.kill("SIGTERM");
  }
});

test("forged product and inventory webhooks are rejected before persistence", async ({
  request,
}) => {
  for (const route of [
    "/webhooks/products/update",
    "/webhooks/inventory/levels/update",
    "/webhooks/app/uninstalled",
    "/webhooks/privacy",
  ]) {
    const result = await request.post(route, {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Shop-Domain": "forged.myshopify.com",
        "X-Shopify-Topic": "PRODUCTS_UPDATE",
        "X-Shopify-Webhook-Id": "forged-local-verification",
        "X-Shopify-Hmac-Sha256": "invalid-hmac",
      },
      data: { id: 1 },
      maxRedirects: 0,
    });
    expect([400, 401]).toContain(result.status());
  }
});
