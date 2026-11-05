const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Shopify documents a 5 MB HTTPS limit for Events deliveries and none for
 * webhook topics, whose full product payloads can run to megabytes. Twice the
 * documented figure leaves room without trusting the sender.
 */
export const WEBHOOK_BODY_LIMIT = 10 * MiB;
/** The login form carries one shop domain. */
export const LOGIN_BODY_LIMIT = 4 * KiB;
export const ACTION_FORM_LIMIT = 64 * KiB;
/** Lifecycle and compliance deliveries and the login form all fit in this. */
export const SMALL_BODY_LIMIT = 256 * KiB;

export type BodyBudget = {
  used: number;
  max: number;
  /** The part of `max` that only a body still within SMALL_BODY_LIMIT may use. */
  smallReserve: number;
  /** How long one whole body may take to arrive. */
  readDeadlineMs: number;
};
/**
 * Unverified bytes this process may hold at once. Every body can be under its
 * own cap and many of them together still exhaust memory in the process that
 * receives webhooks, so concurrent senders share this. Shopify retries a 503.
 *
 * Anyone can post here, so the budget must not become a way to stop deliveries.
 * Shopify allows five seconds for a whole request, so a body still arriving after
 * eight is not Shopify's and gives up its share. The reserve keeps a few large
 * uploads from shutting out uninstall and compliance deliveries. Telling senders
 * apart is left to the proxy's per-IP limits.
 */
export const anonymousBodies: BodyBudget = {
  used: 0,
  max: 64 * MiB,
  smallReserve: 16 * MiB,
  readDeadlineMs: 8_000,
};

function refused(
  status: number,
  message: string,
  headers: Record<string, string> = {},
) {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store", Connection: "close", ...headers },
  });
}

/**
 * Runs `consume` with the decoded body, or throws a Response before the body can
 * exceed `limit`. An over-limit declared length is refused without reading.
 * `request.text()` would buffer everything first, so the bytes are counted here.
 * With a budget, the body must also fit it and arrive before its deadline.
 *
 * The stream is abandoned rather than cancelled: on Node, cancelling destroys
 * the socket and the client never sees the status. `Connection: close` ends the
 * upload once the response has been written.
 */
export async function withBoundedBody<T>(
  request: Request,
  limit: number,
  consume: (body: string) => Promise<T> | T,
  budget?: BodyBudget,
): Promise<T> {
  const tooLarge = () => refused(413, "Request body is too large");
  if (Number(request.headers.get("Content-Length")) > limit) throw tooLarge();
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0,
    held = 0,
    expired = false;
  // Releasing the lock is what ends a read that is still waiting for bytes.
  const deadline =
    budget &&
    setTimeout(() => {
      expired = true;
      reader?.releaseLock();
    }, budget.readDeadlineMs);
  try {
    while (reader) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch {
        if (expired) throw refused(408, "Request body did not arrive in time");
        // The client went away mid-upload; nobody is waiting for a server error.
        throw refused(400, "Request body could not be read");
      }
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw tooLarge();
      if (budget) {
        const ceiling =
          length > SMALL_BODY_LIMIT
            ? budget.max - budget.smallReserve
            : budget.max;
        if (budget.used + next.value.byteLength > ceiling)
          throw refused(503, "Retry shortly.", { "Retry-After": "5" });
        budget.used += next.value.byteLength;
        held += next.value.byteLength;
      }
      chunks.push(next.value);
    }
    // Decoded only once it fits, so a refused flood leaves no strings to collect.
    const decoder = new TextDecoder();
    let body = "";
    for (const chunk of chunks) body += decoder.decode(chunk, { stream: true });
    body += decoder.decode();
    return await consume(body);
  } finally {
    clearTimeout(deadline);
    if (budget) budget.used -= held;
    reader?.releaseLock();
  }
}
