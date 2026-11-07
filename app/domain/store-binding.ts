/**
 * Every address in the dashboard names its store with ?shop=. That is how one browser
 * works in two stores at once, and how an action can only reach the store its tab was
 * showing: the store comes from the tab's own address, never from what the browser
 * did last. The links and forms in components/ui.tsx keep it on, and authenticate in
 * admin-auth.server.ts refuses a state-changing request that does not have it.
 */
const DASHBOARD_PATH = /^\/app(?:[/?#]|$)/;
const BASE = "https://store-path.invalid/app";

/** Names the store on a dashboard path or a query of the current page, and only those. */
export function storePath(to: string, shop?: string | null) {
  if (!shop || !(DASHBOARD_PATH.test(to) || to.startsWith("?"))) return to;
  const url = new URL(to, BASE);
  url.searchParams.set("shop", shop);
  return to.startsWith("?")
    ? `${url.search}${url.hash}`
    : `${url.pathname}${url.search}${url.hash}`;
}
