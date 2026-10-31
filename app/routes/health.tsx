// Liveness only; it does not assert database or Shopify connectivity.
export const loader = () => new Response("ok", {
  status: 200,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
});
