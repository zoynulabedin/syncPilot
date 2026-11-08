import { PrismaClient } from "@prisma/client";
import type { Browser as Chrome, Page } from "@playwright/test";
import { chromium, expect, test } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

// The one test that runs the client: hydration, the menu, router form posts, two
// stores in two tabs and what a refused action shows. A real browser against the
// production build, and nothing can leave this machine. Every *.myshopify.com name
// goes to a listener here playing Shopify's authorize page, every other name fails to
// resolve, and the server's own fetch is tests/e2e/shopify-stub.mjs. Polaris and the
// font therefore never load, so this says nothing about how polaris.js renders.
const SECRET = "synthetic-browser-test-secret";
const PORT = 3213;
const LISTENER_PORT = 43213;
const BASE = `http://localhost:${PORT}`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

const now = () => String(Math.trunc(Date.now() / 1000));
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
const store = (label: string) =>
  `${label}-${randomUUID().slice(0, 8)}.myshopify.com`;
const dashboard = (shop: string, page = "/app") => `${page}?shop=${shop}`;

/** A throwaway certificate for the listener: the browser is told to accept it. */
function certificate() {
  const directory = mkdtempSync(path.join(tmpdir(), "syncpilot-browser-"));
  const [key, cert] = ["key.pem", "cert.pem"].map((name) =>
    path.join(directory, name),
  );
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=browser-test.invalid",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(key), cert: readFileSync(cert) };
  } catch {
    return null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function launch(): Promise<Chrome | null> {
  try {
    return await chromium.launch({
      channel: "chrome",
      headless: true,
      args: [
        `--host-resolver-rules=MAP *.myshopify.com 127.0.0.1:${LISTENER_PORT}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`,
        "--no-proxy-server",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-features=DnsOverHttps,OptimizationHints,MediaRouter",
        "--no-first-run",
      ],
    });
  } catch {
    return null;
  }
}

test("a real browser signs in to two stores at once, pairs them, and each tab stays on its own store", async () => {
  test.setTimeout(180_000);
  // Only ever on the runner's disposable database: this creates rows and signs in.
  test.skip(!process.env.TEST_DATABASE_URL, "Run through npm run test:e2e.");
  const tls = certificate();
  test.skip(!tls, "Needs openssl for the local listener's certificate.");
  const browser = await launch();
  test.skip(!browser, "Needs Google Chrome installed.");

  const grants: { shop: string; online: boolean }[] = [];
  const listener = createServer(tls!, (request, response) => {
    const target = new URL(
      request.url ?? "/",
      `https://${request.headers.host}`,
    );
    // Another site, for a link from elsewhere: this listener is not the app's origin.
    if (target.pathname === "/link-to") {
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end(`<a id="go" href="${target.searchParams.get("to")}">go</a>`);
      return;
    }
    if (target.pathname !== "/admin/oauth/authorize") {
      response.writeHead(404).end();
      return;
    }
    const shop = target.hostname;
    const online = target.searchParams.get("grant_options[]") === "per-user";
    grants.push({ shop, online });
    const query = signed({
      code: `${online ? "online" : "offline"}-${randomUUID()}`,
      shop,
      state: target.searchParams.get("state") ?? "",
      timestamp: now(),
    });
    response
      .writeHead(302, {
        Location: `${target.searchParams.get("redirect_uri")}?${query}`,
      })
      .end();
  });
  await new Promise<void>((resolve) =>
    listener.listen(LISTENER_PORT, "127.0.0.1", resolve),
  );
  const startServer = () =>
    spawn(
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
          PORT: String(PORT),
          SHOPIFY_API_KEY: "synthetic-browser-test-key",
          SHOPIFY_API_SECRET: SECRET,
          SHOPIFY_APP_URL: BASE,
          SCOPES:
            "read_products,write_products,read_inventory,write_inventory,read_locations",
          SYNC_WRITE_ENABLED: "false",
          INVENTORY_WRITE_ENABLED: "false",
        },
        stdio: "ignore",
      },
    );
  let server = startServer();
  const serverAnswers = () =>
    expect
      .poll(
        () =>
          fetch(`${BASE}/health`)
            .then((response) => response.status)
            .catch(() => 0),
        { timeout: 20_000 },
      )
      .toBe(200);
  const database = new PrismaClient();
  try {
    await serverAnswers();
    const context = await browser!.newContext({
      ignoreHTTPSErrors: true,
      userAgent: USER_AGENT,
    });
    const hosts = new Set<string>();
    context.on("request", (request) =>
      hosts.add(new URL(request.url()).hostname),
    );
    const broken: string[] = [];
    const watch = (page: Page) => {
      page.on("pageerror", (error) => broken.push(String(error)));
      page.on("console", (message) => {
        if (/Minified React error|Hydration/i.test(message.text()))
          broken.push(message.text());
      });
      // "Confirm connection" asks with window.confirm.
      page.on("dialog", (dialog) => void dialog.accept());
      return page;
    };
    const openFromShopify = async (page: Page, shop: string) => {
      await page.goto(`${BASE}/?${signed({ shop, timestamp: now() })}`);
      await page.waitForURL(`${BASE}${dashboard(shop)}`, { timeout: 15_000 });
      await page.waitForSelector(".sp-current-shop");
    };
    const cookieNames = async () =>
      (await context.cookies()).map(({ name }) => name);
    const sessionCookie = async (shop: string) =>
      (await context.cookies()).find(
        ({ name }) => name === `syncpilot_session.${shop}`,
      )?.value;
    const onStoresPage = async (page: Page, shop: string) => {
      await page
        .locator(`nav.sp-nav a[href="${dashboard(shop, "/app/stores")}"]`)
        .click();
      await page.waitForFunction(
        (to) => `${location.pathname}${location.search}` === to,
        dashboard(shop, "/app/stores"),
      );
    };
    const expectOn = async (page: Page, shop: string) => {
      await expect(page.locator(".sp-current-shop")).toHaveText(shop);
      expect(new URL(page.url()).searchParams.get("shop")).toBe(shop);
    };
    const destination = store("browser-destination");
    await database.shopConnection.create({ data: { shopDomain: destination } });
    const fillPairingForm = async (page: Page, to = destination) => {
      await page.fill("#destinationShop", to);
      await page
        .locator(
          'form:has(#destinationShop) input[name="organizationConfirmed"]',
        )
        .check();
    };
    const submitPairingForm = (page: Page) =>
      page.locator('button[name="intent"][value="initiate"]').click();
    const pairingsFrom = (shop: string) =>
      database.storePairingRequest.count({ where: { initiatingShop: shop } });

    // Both grants from the link Shopify opens, and no leftovers from the flow.
    const a = store("browser-a");
    const tabA = watch(await context.newPage());
    await openFromShopify(tabA, a);
    expect(grants).toEqual([
      { shop: a, online: true },
      { shop: a, online: false },
    ]);
    await expectOn(tabA, a);
    const person = await tabA.locator(".sp-current-person").textContent();
    expect(person).toContain("Synthetic O.");
    expect(person).toContain("Store owner");
    expect(person).not.toContain("fixture@example.invalid");
    const names = await cookieNames();
    expect(names).toContain(`syncpilot_session.${a}`);
    expect(names).toContain("syncpilot_stores");
    expect(names.filter((name) => /state|sign_in/.test(name))).toEqual([]);

    // The menu moves in place and keeps the store: the client is running, and App
    // Bridge is not needed.
    await tabA.evaluate(() => {
      (window as unknown as { stayed: boolean }).stayed = true;
    });
    const menu = await tabA
      .locator("nav.sp-nav a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(menu).toHaveLength(13);
    for (const href of [...menu, dashboard(a, "/app/stores")]) {
      expect(new URL(href!, BASE).searchParams.get("shop")).toBe(a);
      await tabA.locator(`nav.sp-nav a[href="${href}"]`).click();
      await tabA.waitForFunction(
        (to) => `${location.pathname}${location.search}` === to,
        href,
      );
      await tabA.waitForFunction(() => !document.querySelector(".sp-loading"));
      expect(
        await tabA.locator("nav.sp-nav a.active").getAttribute("href"),
      ).toBe(href);
    }
    await tabA.waitForSelector("#destinationShop");
    expect(
      await tabA.evaluate(
        () => (window as unknown as { stayed?: boolean }).stayed,
      ),
    ).toBe(true);

    // A search replaces the query, and still keeps the store, once.
    await tabA
      .locator(`nav.sp-nav a[href="${dashboard(a, "/app/activity")}"]`)
      .click();
    await tabA.selectOption("#status", "FAILED");
    await tabA.locator('form.sp-search button[type="submit"]').click();
    await tabA.waitForFunction(() => location.search.includes("status=FAILED"));
    expect(new URL(tabA.url()).searchParams.getAll("shop")).toEqual([a]);
    await tabA
      .locator(`nav.sp-nav a[href="${dashboard(a, "/app/stores")}"]`)
      .click();
    await tabA.waitForSelector("#destinationShop");

    // A real form, posted by the router, runs on the store its tab is on.
    await fillPairingForm(tabA);
    await submitPairingForm(tabA);
    await tabA.waitForSelector(".sp-notice-success");
    await expectOn(tabA, a);
    expect(await pairingsFrom(a)).toBe(1);
    await database.storePairingRequest.deleteMany({
      where: { initiatingShop: a },
    });

    // Opening it from Shopify again asks who is there, and asks only for that.
    grants.length = 0;
    const before = await sessionCookie(a);
    const again = watch(await context.newPage());
    await openFromShopify(again, a);
    expect(grants).toEqual([{ shop: a, online: true }]);
    expect(await sessionCookie(a)).not.toBe(before);
    await again.close();

    // Another tab signs in to another store, and the first is left exactly as it was.
    await tabA.reload();
    await tabA.waitForSelector("#destinationShop");
    const held = await sessionCookie(a);
    const b = store("browser-b");
    const tabB = watch(await context.newPage());
    await openFromShopify(tabB, b);
    await expectOn(tabB, b);
    await expectOn(tabA, a);
    expect(await sessionCookie(a)).toBe(held);
    expect(await sessionCookie(b)).toBeDefined();
    // Each header offers the other store, and following that does not touch this one.
    await expect(
      tabB.locator(`.sp-other-stores a[href="${dashboard(a)}"]`),
    ).toHaveCount(1);
    await tabB.locator(`.sp-other-stores a[href="${dashboard(a)}"]`).click();
    await tabB.waitForURL(`${BASE}${dashboard(a)}`);
    await expectOn(tabB, a);
    await tabB.locator(`.sp-other-stores a[href="${dashboard(b)}"]`).click();
    await tabB.waitForURL(`${BASE}${dashboard(b)}`);
    await expectOn(tabB, b);

    // The whole pairing journey in one browser, a tab per store, and nobody signs in.
    grants.length = 0;
    await onStoresPage(tabB, b);
    await tabB.waitForSelector("#requestId");
    await fillPairingForm(tabA, b);
    await submitPairingForm(tabA);
    await tabA.waitForSelector(".sp-code");
    await expectOn(tabA, a);
    const [requestId, challenge] = await tabA
      .locator(".sp-code")
      .allTextContents();
    expect(await pairingsFrom(a)).toBe(1);
    expect(await pairingsFrom(b)).toBe(0);
    await tabB.fill("#requestId", requestId);
    await tabB.fill("#challenge", challenge);
    await tabB
      .locator('form:has(#requestId) input[name="organizationConfirmed"]')
      .check();
    await tabB.locator('button[name="intent"][value="accept"]').click();
    await tabB.waitForSelector(".sp-notice-success");
    await expectOn(tabB, b);
    // The first tab, still on A, sees that and confirms it as A.
    await tabA.locator('button:has-text("Refresh connection status")').click();
    await tabA.locator('button:has-text("Confirm connection")').click();
    await tabA.waitForSelector(".sp-notice-success");
    await expectOn(tabA, a);
    expect(
      await database.storePairingRequest.findUniqueOrThrow({
        where: { id: requestId },
      }),
    ).toMatchObject({
      initiatingShop: a,
      destinationShop: b,
      state: "VERIFIED",
    });
    expect(grants).toEqual([]);
    await tabA.reload();
    await tabB.reload();
    await expectOn(tabA, a);
    await expectOn(tabB, b);

    // An unsigned link to a third store asks first, and goes nowhere until told.
    grants.length = 0;
    const c = store("browser-c");
    await tabB.goto(`${BASE}${dashboard(c)}`);
    await tabB.waitForSelector("#sign-in-heading");
    expect(await tabB.locator("#sign-in-heading").textContent()).toBe(
      "Sign in to this store?",
    );
    expect(grants).toEqual([]);
    expect((await cookieNames()).filter((name) => name.includes(c))).toEqual(
      [],
    );
    await tabB.locator('a[href="/"]').click();
    await tabB.waitForURL(`${BASE}${dashboard(b)}`);
    await tabB.goto(`${BASE}/auth/login?shop=${c}`);
    await tabB.locator('button[type="submit"]').click();
    await tabB.waitForURL(`${BASE}${dashboard(c)}`, { timeout: 15_000 });
    await expectOn(tabB, c);
    // That left both of the others signed in, and the first tab still acts on A.
    await tabA.locator('button:has-text("Refresh connection status")').click();
    await expectOn(tabA, a);
    expect(await sessionCookie(a)).toBe(held);
    await tabA.close();
    await tabB.close();

    // A lapsed store this browser knows: a link on another site still asks, through
    // the redirect too, which is the browser's own word for where it came from. The
    // same address opened here comes back through Shopify with no question.
    const lapsed = store("lapsed");
    const tabLapsed = watch(await context.newPage());
    await openFromShopify(tabLapsed, lapsed);
    await database.session.updateMany({
      where: { shop: lapsed, isOnline: true },
      data: { expires: new Date(Date.now() - 60_000) },
    });
    grants.length = 0;
    await tabLapsed.goto(
      `https://elsewhere.myshopify.com/link-to?${new URLSearchParams({
        to: `${BASE}${dashboard(lapsed)}`,
      })}`,
    );
    await tabLapsed.locator("#go").click();
    await tabLapsed.waitForSelector("#sign-in-heading");
    expect(await tabLapsed.locator("#sign-in-heading").textContent()).toBe(
      "Sign in to this store?",
    );
    expect(grants).toEqual([]);
    await tabLapsed.goto(`${BASE}${dashboard(lapsed)}`);
    await tabLapsed.waitForSelector(".sp-current-shop");
    await expectOn(tabLapsed, lapsed);
    expect(grants).toEqual([{ shop: lapsed, online: true }]);
    await tabLapsed.close();

    // Shopify refuses the person's token: told so, signed out of that store only, and
    // back to the page.
    const revoked = store("revoked");
    const tabRevoked = watch(await context.newPage());
    await openFromShopify(tabRevoked, revoked);
    await onStoresPage(tabRevoked, revoked);
    await tabRevoked.waitForSelector("#destinationShop");
    await fillPairingForm(tabRevoked);
    await submitPairingForm(tabRevoked);
    await tabRevoked.waitForSelector(".sp-signed-out");
    const ended = await tabRevoked.locator(".sp-signed-out").textContent();
    expect(ended).toContain("Your session has ended");
    expect(ended).toContain(revoked);
    expect(await sessionCookie(revoked)).toBeUndefined();
    expect(await sessionCookie(a)).toBe(held);
    expect(await pairingsFrom(revoked)).toBe(0);
    await tabRevoked.locator(".sp-signed-out a.sp-button").click();
    await tabRevoked.waitForURL(`${BASE}${dashboard(revoked, "/app/stores")}`, {
      timeout: 15_000,
    });
    await tabRevoked.waitForSelector("#destinationShop");
    await tabRevoked.close();

    // Logged out of Shopify and only reading: the next menu click leaves the app as a
    // whole page, signs in again and comes back to that page, and no other store is
    // touched. A restart forgets what Shopify last said, as three minutes would.
    const reading = store("revoked");
    const tabReading = watch(await context.newPage());
    await openFromShopify(tabReading, reading);
    await tabReading.evaluate(() => {
      (window as unknown as { stayed: boolean }).stayed = true;
    });
    const readingCookie = await sessionCookie(reading);
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
    server = startServer();
    await serverAnswers();
    grants.length = 0;
    await tabReading
      .locator(`nav.sp-nav a[href="${dashboard(reading, "/app/stores")}"]`)
      .click();
    await tabReading.waitForURL(`${BASE}${dashboard(reading, "/app/stores")}`, {
      timeout: 15_000,
    });
    await tabReading.waitForSelector("#destinationShop");
    expect(grants).toEqual([{ shop: reading, online: true }]);
    expect(await sessionCookie(reading)).not.toBe(readingCookie);
    expect(await sessionCookie(a)).toBe(held);
    expect(
      await tabReading.evaluate(
        () => (window as unknown as { stayed?: boolean }).stayed,
      ),
    ).toBeUndefined();
    await tabReading.close();

    // Shopify does not answer: told to try again, still signed in, nothing applied.
    const down = store("shopify-down");
    const tabDown = watch(await context.newPage());
    await openFromShopify(tabDown, down);
    await onStoresPage(tabDown, down);
    await tabDown.waitForSelector("#destinationShop");
    await fillPairingForm(tabDown);
    await submitPairingForm(tabDown);
    await tabDown.waitForSelector(".sp-signed-out");
    expect(await tabDown.locator(".sp-signed-out").textContent()).toContain(
      "Shopify could not confirm",
    );
    expect(await sessionCookie(down)).toBeDefined();
    expect(await pairingsFrom(down)).toBe(0);
    await tabDown.locator(".sp-signed-out a.sp-button").click();
    await tabDown.waitForSelector("#destinationShop");
    await tabDown.close();

    // Staff with no access on a paired store: the reason, and the way out still works.
    const staff = store("staff");
    const tabStaff = watch(await context.newPage());
    await openFromShopify(tabStaff, staff);
    const staffPerson = await tabStaff
      .locator(".sp-current-person")
      .textContent();
    expect(staffPerson).toContain("Synthetic S.");
    expect(staffPerson).toContain("Staff");
    const workspace = await database.workspace.create({
      data: { name: "Synthetic browser workspace" },
    });
    await database.shopConnection.update({
      where: { shopDomain: staff },
      data: { workspaceId: workspace.id },
    });
    const partner = store("partner");
    await database.shopConnection.create({
      data: { shopDomain: partner, workspaceId: workspace.id },
    });
    await database.storePair.create({
      data: {
        workspaceId: workspace.id,
        sourceShop: staff,
        targetShop: partner,
        requestId: `browser-pair-${randomUUID()}`,
      },
    });
    await tabStaff.goto(`${BASE}${dashboard(staff)}`);
    await tabStaff.waitForSelector(".sp-signed-out");
    expect(await tabStaff.locator(".sp-signed-out").textContent()).toContain(
      "A workspace owner must grant access",
    );

    // The dashboard fits a phone with who is signed in on it.
    const fits = watch(await context.newPage());
    await fits.setViewportSize({ width: 375, height: 700 });
    await database.shopConnection.update({
      where: { shopDomain: staff },
      data: { workspaceId: null },
    });
    await fits.goto(`${BASE}${dashboard(staff)}`);
    await fits.waitForSelector(".sp-current-person");
    const width = await fits.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.inner);

    // Signing out from the header ends that store and says what else is signed in.
    await fits.locator(".sp-topbar button").click();
    await fits.waitForURL(`${BASE}/auth/login`, { timeout: 10_000 });
    expect(await sessionCookie(staff)).toBeUndefined();
    expect(await sessionCookie(a)).toBe(held);
    const listed = await fits.locator(`a[href="${dashboard(a)}"]`).count();
    expect(listed).toBe(1);
    // Then all of them, on the cookies' real paths.
    await fits.locator('button:has-text("Sign out of all of them")').click();
    await fits.waitForFunction(
      () => !document.body.textContent?.includes("Signed in on this browser"),
    );
    expect(await cookieNames()).toEqual([]);
    // The back button brings no dashboard back.
    await fits.goBack();
    await fits.waitForLoadState("load");
    await fits.goBack();
    await fits.waitForLoadState("load");
    expect(new URL(fits.url()).pathname).toBe("/auth/login");
    expect(await fits.locator(".sp-topbar").count()).toBe(0);

    // And all of that stayed on this machine.
    for (const host of hosts)
      expect(
        host === "localhost" ||
          /\.myshopify\.com$|^cdn\.shopify\.com$/.test(host),
        host,
      ).toBe(true);
    expect(broken).toEqual([]);
  } finally {
    await browser!.close();
    server.kill("SIGTERM");
    listener.close();
    await database.$disconnect();
  }
});
