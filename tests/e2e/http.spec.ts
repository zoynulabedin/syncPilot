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

test("landing page serves the real product and protects embedded routes", async ({
  request,
}) => {
  const home = await request.get("/");
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain("Verified store connections");
  const app = await request.get("/app/activity?shop=untrusted.myshopify.com", {
    maxRedirects: 0,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
      Authorization: "Bearer invalid-local-fixture",
    },
  });
  expect([400, 401]).toContain(app.status());
  expect(await app.text()).not.toContain("synthetic-contract-test-secret");
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

  const login = LOGIN_FORM;
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
    requestHead("/auth/login", { ...LOGIN_FORM, "Content-Length": "4000" }) +
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
    headers: LOGIN_FORM,
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
    received.match(/^HTTP\/1\.1 \d{3}/gm)?.map((line) => line.slice(9)) ?? [];
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
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
