// Production web entry. react-router-serve always logs each request's full URL,
// and Shopify puts hmac, state and one-time codes on sign-in URLs, so they would
// reach stdout and any log shipper. This serves the same build the same way
// and logs paths only. Usage: node scripts/serve.mjs ./build/server/index.js
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import pino from "pino";

process.env.NODE_ENV = process.env.NODE_ENV ?? "production";

const buildPath = process.argv[2];
if (!buildPath) {
  console.error("Usage: node scripts/serve.mjs <server-build-path>");
  process.exit(1);
}
const build = await import(pathToFileURL(path.resolve(buildPath)).href);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const port = Number(process.env.PORT) || 3000;

const app = express();
app.disable("x-powered-by");
// Chunked framing lets a sender turn six bytes into an object the server has to
// hold, with any method, on any route, and whether or not it reads the body: 14 MiB
// of one-byte chunks took a route that reads nothing to 1 GiB, and 30 MiB took one
// that reads to 2 GiB and stopped it answering. No real client sends that, so a body
// gets 64 chunks and then one for every 256 bytes, and a request past that is
// dropped. This comes first because the static files answer a GET without reading
// it. It bounds one body, not memory: HTTP/1.1 pipelining of many small requests on
// one connection still grows the process, and floods are left to the proxy.
const FREE_BODY_CHUNKS = 64;
const MIN_BODY_CHUNK_BYTES = 256;
app.use((req, _res, next) => {
  let chunks = 0,
    bytes = 0;
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (++chunks > FREE_BODY_CHUNKS + bytes / MIN_BODY_CHUNK_BYTES)
      req.destroy();
  });
  next();
});
app.use(compression());
app.use(
  path.posix.join(build.publicPath, "assets"),
  express.static(path.join(build.assetsBuildDirectory, "assets"), {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(build.publicPath, express.static(build.assetsBuildDirectory));
app.use(express.static("public", { maxAge: "1h" }));
app.use((req, res, next) => {
  const started = performance.now();
  res.once("close", () =>
    logger.info(
      {
        method: req.method,
        // req.path has no query string; the URL's secrets are all in the query.
        path: req.path.slice(0, 200),
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
        ...(res.writableFinished ? {} : { aborted: true }),
      },
      "request",
    ),
  );
  next();
});
app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));

// Shopify gives a delivery five seconds and forms are small, so nothing here needs
// Node's default five minutes. Node looks for expired clients only as often as the
// checking interval, and its default of 30 seconds would add up to that to each
// limit. It is read when the server starts, so it has to be set here.
const server = createServer(
  {
    connectionsCheckingInterval: 5_000,
    headersTimeout: 15_000,
    requestTimeout: 30_000,
  },
  app,
);
const onListen = () => logger.info({ port }, "SyncPilot web listening");
if (process.env.HOST) server.listen(port, process.env.HOST, onListen);
else server.listen(port, onListen);

for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  });
