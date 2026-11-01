export function resolveShopifyAppUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.SHOPIFY_APP_URL?.trim();
  const legacy = env.NODE_ENV !== "production" ? env.HOST?.trim() : undefined;
  const value = configured || legacy;
  if (!value)
    throw new Error("Configure SHOPIFY_APP_URL for this Shopify runtime");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SHOPIFY_APP_URL must be an absolute HTTP or HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "SHOPIFY_APP_URL must be an HTTP or HTTPS URL without credentials",
    );
  if (
    env.NODE_ENV === "production" &&
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Production SHOPIFY_APP_URL must use HTTPS");
  return value.replace(/\/$/, "");
}
