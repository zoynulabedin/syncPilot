import type {
  HeadersFunction,
  LinksFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import {
  Outlet,
  isRouteErrorResponse,
  useLoaderData,
  useLocation,
  useNavigation,
  useRouteError,
} from "react-router";

import { Link, NavLink, POLARIS_SCRIPT, useStore } from "../components/ui";
import { storePath } from "../domain/store-binding";
import { requireActor } from "../services/authorization.server";
import { authenticate, signIn } from "../shopify.server";
import "../styles/app.css";

// Here rather than in the root: the sign-in screen loads nothing from elsewhere.
export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com/" },
  {
    rel: "stylesheet",
    href: "https://cdn.shopify.com/static/fonts/inter/v4/styles.css",
  },
];

// Polaris's own navigation component renders only in the Shopify admin's shell.
const PAGES = [
  { to: "/app", label: "Overview", end: true },
  { to: "/app/stores", label: "Stores" },
  { to: "/app/products", label: "Products" },
  { to: "/app/inventory", label: "Inventory" },
  { to: "/app/stock-pools", label: "Stock pools" },
  { to: "/app/mappings", label: "Mappings" },
  { to: "/app/rules", label: "Sync Rules" },
  { to: "/app/automatic-sync", label: "Automatic sync" },
  { to: "/app/activity", label: "Activity" },
  { to: "/app/conflicts", label: "Conflicts & approvals" },
  { to: "/app/reconciliation", label: "Reconciliation" },
  { to: "/app/settings", label: "Settings & audit" },
  { to: "/app/help", label: "Help" },
];

/**
 * One browser can pass between people, so the page says whose session this is. Their
 * first name and an initial tell a shared back office apart without putting anyone's
 * email address or full name on the screen.
 */
function whoIs(user?: {
  id?: number;
  first_name?: string;
  last_name?: string;
}) {
  const first = user?.first_name?.trim();
  const initial = user?.last_name?.trim().charAt(0);
  if (first) return initial ? `${first} ${initial}.` : first;
  return user?.id ? `Shopify user ${user.id}` : undefined;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return {
    shop: session.shop,
    person: whoIs(session.onlineAccessInfo?.associated_user),
    owner: requireActor({ session }).role === "OWNER",
    otherStores: await signIn.otherStores(request, session.shop),
  };
};

// The person behind this store's session can change: opening the app from Shopify in
// another tab asks who is there now. So a navigation reads the header again. A refused
// action stays put, or it would redirect away from the message saying nothing happened.
export const shouldRevalidate: ShouldRevalidateFunction = ({ actionStatus }) =>
  !actionStatus || actionStatus < 400;

/** A whole-page post, so nothing of this session stays in memory. Only this tab's store. */
function SignOut() {
  const store = useStore();
  return (
    <form
      method="post"
      action={
        store
          ? `/auth/logout?${new URLSearchParams({ shop: store })}`
          : "/auth/logout"
      }
    >
      <button className="sp-button sp-button-secondary" type="submit">
        Sign out
      </button>
    </form>
  );
}

export default function App() {
  const { shop, person, owner, otherStores } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  return (
    <>
      <script src={POLARIS_SCRIPT} />
      <div className="sp-shell">
        <header className="sp-topbar">
          <Link className="sp-brand" to="/app">
            SyncPilot
          </Link>
          {/* Whole-page links: nothing of one store's page carries over to the other. */}
          <nav className="sp-other-stores" aria-label="Your other stores">
            {otherStores.map((store) => (
              <a key={store} href={storePath("/app", store)}>
                {store}
              </a>
            ))}
            <a href="/auth/login">Open another store</a>
          </nav>
          <span className="sp-current-shop" title="This page is for this store">
            {shop}
          </span>
          <span className="sp-current-person" title="Signed in as">
            {person && `${person} · `}
            {owner ? "Store owner" : "Staff"}
          </span>
          <SignOut />
        </header>
        <div className="sp-layout">
          <nav className="sp-nav" aria-label="SyncPilot pages">
            {PAGES.map(({ to, label, end }) => (
              <NavLink key={to} to={to} end={end}>
                {label}
              </NavLink>
            ))}
          </nav>
          <main className="sp-main">
            {navigation.state !== "idle" && (
              <div
                className="sp-loading"
                role="progressbar"
                aria-label="Loading page"
              />
            )}
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}

type Refusal = {
  signIn?: boolean;
  shop?: string | null;
  storeMissing?: boolean;
  tryAgain?: boolean;
};

export function ErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();
  const store = useStore();
  // The root boundary reports anything that is not a response, without its details.
  if (!isRouteErrorResponse(error)) throw error;
  const here = `${location.pathname}${location.search}`;
  const refusal = (error.data ?? {}) as Refusal;
  if (error.status === 401) {
    const query = new URLSearchParams({ return_to: here });
    if (refusal.shop) query.set("shop", refusal.shop);
    return (
      <main className="sp-page sp-signed-out">
        <section className="sp-card" role="alert">
          <h2>Your session has ended</h2>
          <p>
            {refusal.shop
              ? `You are no longer signed in to ${refusal.shop}. `
              : ""}
            Nothing was changed. Sign in again, then repeat what you were doing.
          </p>
          <a className="sp-button" href={`/auth/login?${query}`}>
            Sign in again
          </a>
        </section>
      </main>
    );
  }
  if (refusal.storeMissing)
    return (
      <main className="sp-page sp-signed-out">
        <section className="sp-card" role="alert">
          <h2>This page did not say which store it is for</h2>
          <p>
            Nothing was changed. Open the dashboard again, check the store named
            at the top of the page, then repeat what you were doing.
          </p>
          <a className="sp-button" href="/app">
            Open the dashboard
          </a>
        </section>
      </main>
    );
  if (refusal.tryAgain)
    return (
      <main className="sp-page sp-signed-out">
        <section className="sp-card" role="alert">
          <h2>Shopify could not confirm your sign-in</h2>
          <p>
            Nothing was changed. SyncPilot checks with Shopify before it changes
            anything, and did not get an answer. Try again in a moment.
          </p>
          <a className="sp-button" href={here}>
            Back to this page
          </a>
        </section>
      </main>
    );
  return (
    <main className="sp-page sp-signed-out">
      <section className="sp-card" role="alert">
        <h2>This request could not be completed ({error.status})</h2>
        {typeof error.data === "string" && <p>{error.data}</p>}
        <p>
          <a href={storePath("/app", store)}>Back to SyncPilot</a> ·{" "}
          <a href={storePath("/app/help", store)}>Get help</a>
        </p>
        <SignOut />
      </section>
    </main>
  );
}

// A thrown limit carries Retry-After, which only reaches the browser through here.
export const headers: HeadersFunction = ({ errorHeaders }) =>
  errorHeaders ?? {};
