import "@shopify/shopify-api/adapters/web-api";
import { ApiVersion, LogSeverity, shopifyApi } from "@shopify/shopify-api";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createCookie } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../app/services/logger.server", () => ({
  logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
  safeError: (error: unknown) => error,
  scrubSecrets: (text: string) => text,
}));
vi.mock("../app/db.server", () => ({ default: {} }));
import {
  addDocumentResponseHeaders,
  assertSameOrigin,
  createAdminAuth,
  logSignInLibraryMessage,
  safeReturnPath,
} from "../app/services/admin-auth.server";
import { storePath } from "../app/domain/store-binding";
import { cookieSigningKey } from "../app/services/token-crypto.server";

const ORIGIN = "https://sync.example.invalid";
const STORE = "x.myshopify.com";
afterEach(() => vi.unstubAllEnvs());
const api = (apiSecretKey: string, scopes?: string[]) =>
  shopifyApi({
    apiKey: "synthetic-key",
    apiSecretKey,
    apiVersion: ApiVersion.October26,
    ...(scopes ? { scopes } : {}),
    hostName: "sync.example.invalid",
    isEmbeddedApp: false,
    logger: { level: LogSeverity.Error, log: () => undefined },
    _logDisabledFutureFlags: false,
  });
/** A session cookie for a store, under whatever key a test says this server has. */
const sessionCookie = async (key: string, shop = STORE) =>
  (
    await createCookie(`syncpilot_session.${shop}`, {
      secrets: [key],
    }).serialize("some-session")
  ).split(";")[0];

describe("store paths", () => {
  it.each([
    ["/app", `/app?shop=${STORE}`],
    ["/app/rules", `/app/rules?shop=${STORE}`],
    ["/app/rules?edit=abc", `/app/rules?edit=abc&shop=${STORE}`],
    ["/app?page=2#top", `/app?page=2&shop=${STORE}#top`],
    ["?page=2", `?page=2&shop=${STORE}`],
    ["/app/rules?shop=other.myshopify.com", `/app/rules?shop=${STORE}`],
  ])("names the store on %s", (path, expected) => {
    expect(storePath(path, STORE)).toBe(expected);
  });

  it.each([
    "/privacy",
    "/auth/login",
    "/application",
    "https://evil.example/app",
  ])("leaves %s alone, which is not the dashboard", (path) => {
    expect(storePath(path, STORE)).toBe(path);
  });

  it("leaves a path alone when there is no store to name", () => {
    expect(storePath("/app/rules", null)).toBe("/app/rules");
    expect(storePath("/app/rules", undefined)).toBe("/app/rules");
  });
});

describe("return paths", () => {
  it.each([
    ["/app", "/app"],
    ["/app/", "/app/"],
    ["/app/rules", "/app/rules"],
    ["/app/rules?edit=abc&page=2", "/app/rules?edit=abc&page=2"],
    ["/app/products?q=a%20b", "/app/products?q=a+b"],
  ])("keeps %s", (value, expected) => {
    expect(safeReturnPath(value)).toBe(expected);
  });

  it.each([
    ["an absolute URL", "https://evil.example/app"],
    ["a protocol-relative URL", "//evil.example/app"],
    ["backslashes a browser reads as slashes", "/\\evil.example/app"],
    ["only backslashes", "\\\\evil.example\\app"],
    ["a tab a browser drops", "/\t/evil.example/app"],
    ["a newline a browser drops", "/\n/evil.example/app"],
    ["a scheme", "javascript:alert(1)"],
    ["a path out of the dashboard", "/app/../auth/logout"],
    ["an encoded path out of it", "/app/%2e%2e/auth/logout"],
    ["a backslash path out of it", "/app\\..\\auth\\logout"],
    ["another page of the app", "/auth/login"],
    ["the landing page", "/"],
    ["a longer name that starts the same", "/application"],
    ["an encoded slash that starts the same", "/app%2f..%2f..%2fevil"],
    ["nothing", ""],
    ["a relative path", "app/rules"],
    ["too much for a cookie", `/app/${"x".repeat(2048)}`],
    [
      "what only becomes too much for a cookie once encoded",
      `/app/${"€".repeat(1000)}`,
    ],
    ["a query that does", `/app/rules?q=${"€".repeat(1000)}`],
    ["something that is not text", 42],
    ["a missing value", null],
    ["a form's repeated value", ["/app", "//evil.example"]],
  ])("sends %s to the dashboard", (_, value) => {
    expect(safeReturnPath(value)).toBe("/app");
  });

  it("never keeps what Shopify signs or what an embedded load carried", () => {
    expect(
      safeReturnPath(
        "/app/rules?edit=1&id_token=jwt&hmac=abc&host=def&shop=x.myshopify.com&timestamp=1&embedded=1&session=s&locale=en&code=c&state=t&signature=g&_routes=r",
      ),
    ).toBe("/app/rules?edit=1");
  });
});

describe("the same-origin check", () => {
  const request = (method: string, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/app/rules`, { method, headers });
  const status = (candidate: Request) => {
    try {
      assertSameOrigin(candidate, ORIGIN);
      return "allowed";
    } catch (error) {
      return (error as Response).status;
    }
  };

  it.each(["GET", "HEAD"])("leaves %s alone", (method) => {
    expect(status(request(method, { Origin: "https://evil.example" }))).toBe(
      "allowed",
    );
    expect(status(request(method))).toBe("allowed");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "holds %s to it",
    (method) => {
      expect(status(request(method, { Origin: ORIGIN }))).toBe("allowed");
      expect(status(request(method))).toBe(403);
      expect(status(request(method, { Origin: "https://evil.example" }))).toBe(
        403,
      );
    },
  );

  it("judges by the configured app URL, not what a proxy says this host is", () => {
    const proxied = new Request("http://internal:3000/app/rules", {
      method: "POST",
      headers: { Origin: "http://internal:3000" },
    });
    expect(status(proxied)).toBe(403);
  });

  it("falls back to Sec-Fetch-Site only when Origin is absent", () => {
    expect(status(request("POST", { "Sec-Fetch-Site": "same-origin" }))).toBe(
      "allowed",
    );
    for (const site of ["same-site", "cross-site", "none"])
      expect(status(request("POST", { "Sec-Fetch-Site": site }))).toBe(403);
    expect(
      status(
        request("POST", {
          Origin: "null",
          "Sec-Fetch-Site": "same-origin",
        }),
      ),
    ).toBe(403);
  });
});

describe("document headers", () => {
  const headersFor = () => {
    const headers = new Headers();
    addDocumentResponseHeaders(headers);
    return headers;
  };

  it("no document can be framed", () => {
    const headers = headersFor();
    expect(headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Link")).toBeNull();
  });

  it("no document is kept, so the dashboard cannot be, however its path is spelled", () => {
    expect(headersFor().get("Cache-Control")).toBe("no-store");
  });
});

describe("the library's logging", () => {
  it("loses the context, where the library puts the state it held", () => {
    logSignInLibraryMessage(
      LogSeverity.Error,
      "[shopify-api/ERROR] Invalid OAuth callback | {shop: x.myshopify.com, stateFromCookie: held-state}",
    );
    const logged = JSON.stringify(mocks.warn.mock.calls);
    expect(logged).toContain("Invalid OAuth callback");
    expect(logged).not.toContain("held-state");
  });
});

describe("configuration", () => {
  it("refuses to begin a sign-in that would ask for no permissions", async () => {
    const auth = createAdminAuth({
      api: api("synthetic-secret"),
      sessionStorage: {
        loadSession: async () => undefined,
        storeSession: async () => true,
      },
      appUrl: ORIGIN,
    });
    await expect(
      auth.login(
        new Request(`${ORIGIN}/auth/login`, { method: "POST" }),
        new URLSearchParams({ shop: STORE }),
      ),
    ).rejects.toThrow("SCOPES");
  });
});

describe("a session store that is down", () => {
  // No encryption key in these tests, so the app's secret stands in for one.
  const key = () =>
    createHmac("sha256", "synthetic-secret")
      .update("syncpilot/sign-in-cookies/v1")
      .digest("base64url");
  const down = () =>
    createAdminAuth({
      api: api("synthetic-secret", ["read_products"]),
      sessionStorage: {
        loadSession: async () => {
          throw new Error("The session table is not there");
        },
        storeSession: async () => true,
      },
      appUrl: ORIGIN,
    });

  it("is an error, not a reason to send someone with a session off to Shopify", async () => {
    vi.stubEnv("SESSION_ENCRYPTION_KEY", "");
    await expect(
      down().login(
        new Request(`${ORIGIN}/auth/login?shop=${STORE}`, {
          headers: { Cookie: await sessionCookie(key()) },
        }),
      ),
    ).rejects.toThrow("session table");
  });

  it("does not matter to someone with no session, who it is never read for", async () => {
    await expect(
      down().login(new Request(`${ORIGIN}/auth/login?shop=${STORE}`)),
    ).resolves.toEqual({ confirming: STORE });
    const outcome = await down()
      .login(
        new Request(`${ORIGIN}/auth/login`, { method: "POST" }),
        new URLSearchParams({ shop: STORE }),
      )
      .catch((thrown: unknown) => thrown);
    expect((outcome as Response).status).toBe(302);
  });
});

describe("the key that signs a browser's cookies", () => {
  const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
  const auth = (apiSecretKey: string) =>
    createAdminAuth({
      api: api(apiSecretKey, ["read_products"]),
      sessionStorage: {
        loadSession: async () => undefined,
        storeSession: async () => true,
      },
      appUrl: ORIGIN,
    });
  const accepts = async (apiSecretKey: string, key: string) =>
    (
      await auth(apiSecretKey).otherStores(
        new Request(ORIGIN, { headers: { Cookie: await sessionCookie(key) } }),
        "another.myshopify.com",
      )
    ).includes(STORE);

  it("belongs to the server, so any app on it reads the cookie and the app's secret does not", async () => {
    vi.stubEnv("SESSION_ENCRYPTION_KEY", ENCRYPTION_KEY);
    const key = cookieSigningKey()!;
    expect(key).not.toBe(ENCRYPTION_KEY);
    expect(await accepts("first-app-secret", key)).toBe(true);
    expect(await accepts("second-app-secret", key)).toBe(true);
    expect(await accepts("first-app-secret", "first-app-secret")).toBe(false);
  });

  it("changes with the server's key", async () => {
    vi.stubEnv("SESSION_ENCRYPTION_KEY", OTHER_KEY);
    const other = cookieSigningKey()!;
    vi.stubEnv("SESSION_ENCRYPTION_KEY", ENCRYPTION_KEY);
    expect(cookieSigningKey()).not.toBe(other);
    expect(await accepts("first-app-secret", other)).toBe(false);
  });

  it("is required in production, so the app's secret is never the key there", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_ENCRYPTION_KEY", "");
    expect(() => cookieSigningKey()).toThrow("SESSION_ENCRYPTION_KEY");
  });
});

describe("the links and forms under /app", () => {
  const inDirectory = (directory: string, name: RegExp) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && name.test(entry.name))
      .map((entry) => `${directory}/${entry.name}`);
  // The one component that may import them is ui.tsx, which everything else uses, and
  // the sign-in screen, which is not under /app and posts before there is a session.
  const routes = [
    ...inDirectory("app/routes", /^app.*\.tsx$/),
    ...inDirectory("app/components", /\.tsx$/).filter(
      (file) => !/\/(?:ui|sign-in-screen)\.tsx$/.test(file),
    ),
  ];

  it("are all looked at", () => {
    expect(routes.length).toBeGreaterThanOrEqual(14);
  });

  it.each(routes)("%s has none that could lose the tab's store", (file) => {
    const text = readFileSync(file, "utf8");
    const fromRouter = [
      ...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"react-router"/g),
    ]
      .map(([, names]) => names)
      .join();
    expect(fromRouter).not.toMatch(
      /\b(?:Form|Link|NavLink|useFetcher|useSubmit|useNavigate|redirect)\b/,
    );
    // The one plain form is the sign-out, which is not under /app.
    const plainForms = [...text.matchAll(/<form\b/g)].length;
    expect(plainForms).toBe(file.endsWith("routes/app.tsx") ? 1 : 0);
  });
});

describe("the app's credentials", () => {
  const sources = (directory: string): string[] =>
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
      .map((entry) => `${entry.parentPath}/${entry.name}`);

  it("are read in one place, which one app per store will replace", () => {
    const reads = [...sources("app"), ...sources("scripts")].flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /env\.SHOPIFY_API_(?:KEY|SECRET)/g,
        ),
      ].map(() => file.replaceAll("\\", "/")),
    );
    expect(reads).toEqual(["app/shopify.server.ts", "app/shopify.server.ts"]);
    const server = readFileSync("app/shopify.server.ts", "utf8");
    expect(server).toMatch(/const appCredentials = \(\) => \(\{/);
    expect([...server.matchAll(/\.\.\.appCredentials\(\)/g)].length).toBe(3);
  });
});

describe("App Bridge", () => {
  const sources = (directory: string): string[] =>
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
      .map((entry) => `${entry.parentPath}/${entry.name}`);

  it("is gone from the code and the dependencies", () => {
    for (const file of sources("app")) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/app-bridge|NavMenu|AppProvider/);
    }
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).not.toContain(
      "@shopify/app-bridge-react",
    );
    expect(readFileSync("vite.config.ts", "utf8")).not.toContain("app-bridge");
  });

  it("nothing looks for what an embedded load used to put in the URL", () => {
    for (const file of sources("app/routes"))
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /\b(?:id_token|embedded)\b|get\("host"\)|window\.shopify|\bshopify\.(?:toast|idToken|modal|saveBar)/,
      );
  });
});
