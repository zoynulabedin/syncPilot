// Loaded with --import into a production server for the sign-in test, before the
// app can capture fetch. Nothing leaves this machine: it answers as Shopify
// documents for the token endpoint and the Admin API, and refuses anything else.
// A store's name picks how it behaves: a person on revoked-* has lost their token,
// shopify-down-* does not answer a person's token, and staff-* signs in staff.
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const SCOPE =
  "read_products,write_products,read_inventory,write_inventory,read_locations";

globalThis.fetch = async (url, init) => {
  const target = new URL(String(url));
  const staff = target.hostname.startsWith("staff-");
  if (target.pathname === "/admin/oauth/access_token") {
    const { code } = JSON.parse(String(init?.body));
    if (String(code).startsWith("offline"))
      return json({
        access_token: "shpat_stub_offline_token",
        scope: SCOPE,
        expires_in: 3600,
        refresh_token: "shprt_stub_refresh_token",
        refresh_token_expires_in: 7_776_000,
      });
    return json({
      access_token: "shpua_stub_online_token",
      scope: SCOPE,
      expires_in: 86_399,
      associated_user_scope: SCOPE,
      associated_user: {
        id: staff ? 909 : 101,
        first_name: "Synthetic",
        last_name: staff ? "Staff" : "Owner",
        email: "fixture@example.invalid",
        email_verified: true,
        account_owner: !staff,
        locale: "en",
        collaborator: false,
      },
    });
  }
  if (target.pathname.endsWith("/graphql.json")) {
    const person =
      new Headers(init?.headers).get("X-Shopify-Access-Token") ===
      "shpua_stub_online_token";
    if (person && target.hostname.startsWith("revoked-"))
      return json({ errors: "[API] Invalid API key or access token" }, 401);
    if (person && target.hostname.startsWith("shopify-down-"))
      return json({ errors: "Service unavailable" }, 503);
    return json({
      data: {
        shop: {
          id: "gid://shopify/Shop/1",
          myshopifyDomain: target.hostname,
          currencyCode: "USD",
        },
        currentAppInstallation: {
          accessScopes: SCOPE.split(",").map((handle) => ({ handle })),
        },
      },
    });
  }
  throw new Error(`Unexpected outbound request to ${target.origin}`);
};
