import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  UNSAFE_ErrorResponseImpl as ErrorResponse,
  createRoutesStub,
} from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), otherStores: vi.fn() }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: mocks.auth },
  signIn: { otherStores: mocks.otherStores },
}));
import { Pagination, QueryFields } from "../app/components/list-navigation";
import {
  EmptyState,
  Form,
  InlineAction,
  Link,
  Metric,
  NavLink,
} from "../app/components/ui";
import { SignInScreen } from "../app/components/sign-in-screen";
import App, {
  ErrorBoundary,
  headers,
  loader,
  shouldRevalidate,
} from "../app/routes/app";

const shop = "shell-store.myshopify.com";
const here = `/app?shop=${shop}`;
const PAGES = [
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
];

async function render(
  loaderResult: () => unknown,
  initialEntry = here,
  hydrationError?: unknown,
) {
  const Stub = createRoutesStub([
    {
      id: "routes/app",
      path: "/app",
      Component: App as never,
      ErrorBoundary: ErrorBoundary as never,
      loader: loaderResult as never,
      children: [{ index: true, Component: () => createElement("p") }],
    },
  ]);
  return renderToString(
    createElement(Stub, {
      initialEntries: [initialEntry],
      hydrationData: hydrationError
        ? { errors: { "routes/app": hydrationError } }
        : { loaderData: { "routes/app": loaderResult() } },
    }),
  );
}
const frame = (extra: object = {}) => ({
  shop,
  person: "Ada L.",
  owner: true,
  otherStores: [],
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.otherStores.mockResolvedValue([]);
});

describe("the dashboard's frame", () => {
  it("names the store from the session it opened", async () => {
    mocks.auth.mockResolvedValue({ session: { shop } });
    const request = new Request(`https://app.test${here}`);
    await expect(
      loader({ request, params: {}, context: {} } as never),
    ).resolves.toMatchObject({ shop });
    expect(mocks.auth).toHaveBeenCalledWith(request);
  });

  const signedInAs = (user: object) => {
    mocks.auth.mockResolvedValue({
      session: { shop, onlineAccessInfo: { associated_user: user } },
    });
    return loader({
      request: new Request(`https://app.test${here}`),
      params: {},
      context: {},
    } as never);
  };

  it("says whose session it is with the least that tells two people apart", async () => {
    const page = await signedInAs({
      id: 101,
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.invalid",
      account_owner: true,
    });
    expect(page).toEqual({
      shop,
      person: "Ada L.",
      owner: true,
      otherStores: [],
    });
    const html = await render(() => page);
    expect(html).toContain("Ada L.");
    expect(html).toContain("Store owner");
    expect(html).not.toContain("Lovelace");
    expect(html).not.toContain("ada@example.invalid");

    const staff = await render(() => frame({ owner: false }));
    expect(staff).toContain("Staff");
    expect(staff).not.toContain("Store owner");
  });

  it.each([
    ["only a first name", { id: 7, first_name: "Ada" }, "Ada"],
    ["no name at all", { id: 7, email: "a@example.invalid" }, "Shopify user 7"],
    ["a blank name", { id: 7, first_name: "  " }, "Shopify user 7"],
  ])("with %s it still says who, and never the email", async (_, user, who) => {
    expect(await signedInAs(user)).toMatchObject({ person: who });
  });

  it("offers every page on this store, the store itself and a way to sign out of it, without App Bridge", async () => {
    const html = await render(() => frame());
    for (const page of PAGES)
      expect(html).toContain(`href="${page}?shop=${shop}"`);
    expect(html).toContain(`href="/app?shop=${shop}"`);
    expect(html).toContain(shop);
    expect(html).toContain(`action="/auth/logout?shop=${shop}"`);
    expect(html).toContain('method="post"');
    expect(html).toContain("Sign out");
    expect(html).toContain("shopifycloud/polaris.js");
    expect(html).not.toContain("app-bridge");
    expect(html).not.toContain("ui-nav-menu");
  });

  it("offers the other stores signed in here, by whole-page links, and a way to add one", async () => {
    const other = "other-store.myshopify.com";
    mocks.auth.mockResolvedValue({ session: { shop } });
    mocks.otherStores.mockResolvedValue([other]);
    const request = new Request(`https://app.test${here}`);
    const page = await loader({ request, params: {}, context: {} } as never);
    expect(mocks.otherStores).toHaveBeenCalledWith(request, shop);
    const html = await render(() => page);
    expect(html).toContain(`href="/app?shop=${other}"`);
    expect(html).toContain('href="/auth/login"');
  });

  it("reads the header again on every navigation, but stays put after a refused action", () => {
    const args = (actionStatus?: number) =>
      ({ actionStatus, defaultShouldRevalidate: false }) as never;
    expect(shouldRevalidate(args())).toBe(true);
    expect(shouldRevalidate(args(200))).toBe(true);
    expect(shouldRevalidate(args(400))).toBe(false);
    expect(shouldRevalidate(args(401))).toBe(false);
  });

  it("passes a limit's Retry-After through", () => {
    const errorHeaders = new Headers({ "Retry-After": "60" });
    expect(headers({ errorHeaders } as never)).toBe(errorHeaders);
    expect(headers({} as never)).toEqual({});
  });
});

describe("the dashboard's links and forms keep the tab on its store", () => {
  const inPage = (element: () => unknown, entry = here) => {
    const Stub = createRoutesStub([
      {
        id: "routes/app",
        path: "/app",
        Component: () => element() as never,
        loader: () => null,
      },
    ]);
    return renderToString(
      createElement(Stub, {
        initialEntries: [entry],
        hydrationData: { loaderData: { "routes/app": null } },
      }),
    );
  };
  const named = `shop=${shop}`;
  const fieldsNamed = (html: string) =>
    [...html.matchAll(/name="shop"/g)].length;

  it.each<[string, () => unknown, string]>([
    [
      "a link",
      () => createElement(Link, { to: "/app/rules" }, "Go"),
      `href="/app/rules?${named}"`,
    ],
    [
      "a link with its own query",
      () => createElement(Link, { to: "/app/activity?job=7" }, "Go"),
      `href="/app/activity?job=7&amp;${named}"`,
    ],
    [
      "a menu link",
      () => createElement(NavLink, { to: "/app/rules" }, "Go"),
      `href="/app/rules?${named}"`,
    ],
    [
      "a link that only changes the query",
      () => createElement(Link, { to: "?page=2" }, "Go"),
      `href="/app?page=2&amp;${named}"`,
    ],
    [
      "an empty state's way on",
      () => createElement(EmptyState, { title: "x", href: "/app/stores" }),
      `href="/app/stores?${named}"`,
    ],
    [
      "a metric's way on",
      () =>
        createElement(Metric, { label: "x", value: 1, href: "/app/stores" }),
      `href="/app/stores?${named}"`,
    ],
    [
      "pagination",
      () =>
        createElement(Pagination, {
          info: { page: 1, pageSize: 1, total: 3 },
          param: "page",
          label: "rows",
        }),
      `href="/app?${named}&amp;page=2"`,
    ],
  ])("%s names the store", (_, element, expected) => {
    expect(inPage(element)).toContain(expected);
  });

  it("a link out of the dashboard stays as it is", () => {
    expect(
      inPage(() => createElement(Link, { to: "/privacy" }, "Go")),
    ).toContain('href="/privacy"');
  });

  it("a form that changes something posts to its own address, store included", () => {
    for (const method of ["post", "POST"] as const) {
      const html = inPage(
        () => createElement(Form, { method }, createElement("button")),
        `/app?${named}&page=2`,
      );
      expect(html).toContain(`action="/app?${named}&amp;page=2"`);
      expect(fieldsNamed(html)).toBe(0);
    }
  });

  it("a one-button form does too", () => {
    expect(
      inPage(() =>
        createElement(InlineAction, { intent: "x", id: "1", label: "Go" }),
      ),
    ).toContain(`action="/app?${named}"`);
  });

  it("a form with an action of its own has the store put on it", () => {
    expect(
      inPage(() =>
        createElement(Form, { method: "post", action: "/app/rules" }),
      ),
    ).toContain(`action="/app/rules?${named}"`);
  });

  it("a search form carries the store as a field, once, since it replaces the query", () => {
    for (const form of [
      () =>
        createElement(
          Form,
          { method: "get" },
          createElement(QueryFields, { exclude: ["page"] }),
        ),
      () => createElement(Form, null, createElement(QueryFields)),
    ]) {
      const html = inPage(form, `/app?${named}&page=2&kind=x`);
      expect(fieldsNamed(html)).toBe(1);
      expect(html).toContain(`value="${shop}"`);
    }
  });

  it("what a page shows comes from its own address", () => {
    const other = "other-store.myshopify.com";
    expect(
      inPage(
        () => createElement(Link, { to: "/app/rules" }, "Go"),
        `/app?shop=${other}`,
      ),
    ).toContain(`href="/app/rules?shop=${other}"`);
  });
});

describe("the sign-in screen", () => {
  const screen = (props: Parameters<typeof SignInScreen>[0]) => {
    const Stub = createRoutesStub([
      {
        path: "/auth/login",
        Component: () => createElement(SignInScreen, props),
      },
    ]);
    return renderToString(
      createElement(Stub, {
        initialEntries: ["/auth/login?return_to=%2Fapp%2Frules"],
      }),
    );
  };

  it("for a link naming a store, names it, posts the choice, and offers the way out", () => {
    const html = screen({ confirming: "other-store.myshopify.com" });
    expect(html).toContain("Sign in to this store?");
    expect(html).toContain("A link asked to open other-store.myshopify.com");
    expect(html).toContain("stays signed in");
    expect(html).toContain('value="other-store.myshopify.com"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="return_to"');
    expect(html).toContain('href="/"');
  });

  it("is the ordinary screen otherwise", () => {
    const html = screen({});
    expect(html).toContain("Continue with Shopify");
    expect(html).not.toContain("Sign in to this store?");
    expect(html).not.toContain("Signed in on this browser");
  });

  it("says which stores are still signed in, with a way into each and out of all", () => {
    const html = screen({ signedIn: [shop] });
    expect(html).toContain("Signed in on this browser already");
    expect(html).toContain(`href="/app?shop=${shop}"`);
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain("Sign out of all of them");
  });
});

describe("the dashboard's error page", () => {
  it("says a lapsed session changed nothing, names the store, and offers the way back to this page", async () => {
    const html = await render(
      () => null,
      `/app?page=2&shop=${shop}`,
      new ErrorResponse(401, "", { signIn: true, shop }),
    );
    expect(html).toContain("Your session has ended");
    expect(html).toContain(`no longer signed in to ${shop}`);
    expect(html).toContain("Nothing was changed");
    expect(html).toContain(
      `/auth/login?return_to=%2Fapp%3Fpage%3D2%26shop%3D${shop}&amp;shop=${shop}`,
    );
  });

  it("does not name a store it does not know", async () => {
    const html = await render(
      () => null,
      "/app",
      new ErrorResponse(401, "", {
        signIn: true,
        shop: null,
      }),
    );
    expect(html).toContain("/auth/login?return_to=%2Fapp");
    expect(html).not.toContain("shop=");
    expect(html).not.toContain("no longer signed in to");
  });

  it("says when an action named no store, that nothing changed, and offers a way back", async () => {
    const html = await render(
      () => null,
      "/app/settings",
      new ErrorResponse(400, "", { storeMissing: true }),
    );
    expect(html).toContain("did not say which store");
    expect(html).toContain("Nothing was changed");
    expect(html).toContain('href="/app"');
  });

  it("says Shopify did not answer, nothing changed, and to try again", async () => {
    const page = `/app/stores?shop=${shop}`;
    const html = await render(
      () => null,
      page,
      new ErrorResponse(503, "", { tryAgain: true }),
    );
    expect(html).toContain("Shopify could not confirm");
    expect(html).toContain("Nothing was changed");
    expect(html).toContain("Try again");
    expect(html).toContain(`href="${page}"`);
  });

  it("gives a person refused access the reason, and a way out of this store", async () => {
    const html = await render(
      () => null,
      here,
      new ErrorResponse(
        403,
        "",
        "A workspace owner must grant access to this staff account.",
      ),
    );
    expect(html).toContain("A workspace owner must grant access");
    expect(html).toContain(`action="/auth/logout?shop=${shop}"`);
    expect(html).toContain("Sign out");
    expect(html).toContain(`href="/app/help?shop=${shop}"`);
    expect(html).toContain(`href="/app?shop=${shop}"`);
  });

  it("shows other refusals as text, never as markup", async () => {
    const html = await render(
      () => null,
      here,
      new ErrorResponse(403, "", "<img src=x onerror=alert(1)>"),
    );
    expect(html).toContain("(<!-- -->403<!-- -->)");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
