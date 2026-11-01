import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Outlet,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import "../styles/app.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  return (
    <AppProvider apiKey={apiKey}>
      <NavMenu>
        <a href="/app" rel="home">
          Overview
        </a>
        <a href="/app/stores">Stores</a>
        <a href="/app/products">Products</a>
        <a href="/app/inventory">Inventory</a>
        <a href="/app/mappings">Mappings</a>
        <a href="/app/rules">Sync Rules</a>
        <a href="/app/activity">Activity</a>
        <a href="/app/conflicts">Conflicts & approvals</a>
        <a href="/app/reconciliation">Reconciliation</a>
        <a href="/app/settings">Settings & audit</a>
        <a href="/app/help">Help</a>
      </NavMenu>
      {navigation.state !== "idle" && (
        <div
          className="sp-loading"
          role="progressbar"
          aria-label="Loading page"
        />
      )}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
