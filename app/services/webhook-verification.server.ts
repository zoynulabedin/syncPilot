import {
  WebhookType,
  WebhookValidationErrorReason,
  type WebhookValidateParams,
  type WebhookValidation,
} from "@shopify/shopify-api";
import { normalizeShop } from "../domain/guards";
import { logger } from "./logger.server";
import {
  WEBHOOK_BODY_LIMIT,
  anonymousBodies,
  withBoundedBody,
} from "./request-body.server";

type WebhookValidator = {
  validate: (params: WebhookValidateParams) => Promise<WebhookValidation>;
};

/**
 * Everything a route may use from a delivery. There is no session or admin
 * client: verification proves the body, and nothing here touches stored tokens.
 *
 * Only `payload` is signed. `shop`, `topic`, `webhookId`, `eventId` and
 * `triggeredAt` come from headers Shopify's HMAC does not cover.
 */
export type VerifiedWebhook = {
  apiVersion: string;
  shop: string;
  topic: string;
  webhookId: string;
  name?: string;
  eventId?: string;
  triggeredAt?: Date;
  payload: unknown;
};

const RFC_3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** Shopify sends RFC 3339 times, in headers with nanosecond precision. */
export function parseShopifyTime(value: unknown) {
  if (typeof value !== "string" || !RFC_3339.test(value)) return undefined;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? undefined : time;
}

/** For a signed delivery this app will not act on. Leaves no state behind. */
export function rejectWebhook(
  code: string,
  context: { topic?: string; shop?: string } = {},
) {
  logger.warn(
    { code, topic: context.topic, shop: context.shop },
    "Signed webhook delivery rejected",
  );
  return new Response(undefined, { status: 400, statusText: "Bad Request" });
}

/**
 * Verifies the body with the official library and nothing else. Status codes
 * match authenticate.webhook for a wrong method, a bad signature and missing
 * headers; unlike it, a failure to load or refresh the offline session cannot
 * occur, and a signed body that is not JSON is a 400 rather than a 500.
 */
export async function verifyWebhook(
  webhooks: WebhookValidator,
  request: Request,
  topics: readonly string[],
): Promise<VerifiedWebhook> {
  if (request.method !== "POST")
    throw new Response(undefined, {
      status: 405,
      statusText: "Method not allowed",
    });
  return withBoundedBody(
    request,
    WEBHOOK_BODY_LIMIT,
    async (rawBody) => {
      const check = await webhooks.validate({ rawBody, rawRequest: request });
      if (!check.valid) {
        if (check.reason === WebhookValidationErrorReason.InvalidHmac)
          throw new Response(undefined, {
            status: 401,
            statusText: "Unauthorized",
          });
        throw new Response(undefined, {
          status: 400,
          statusText: "Bad Request",
        });
      }
      // Subscriptions are webhook topics only; no Events subscription exists.
      if (check.webhookType !== WebhookType.Webhooks)
        throw rejectWebhook("WEBHOOK_TYPE_UNSUPPORTED", check);
      const { topic } = check;
      // One signed body must not reach a handler its topic does not belong to.
      if (!topics.includes(topic))
        throw rejectWebhook("WEBHOOK_TOPIC_MISMATCH", {
          topic,
          shop: check.domain.slice(0, 100),
        });
      let shop: string;
      try {
        shop = normalizeShop(check.domain);
      } catch {
        throw rejectWebhook("WEBHOOK_SHOP_INVALID", { topic });
      }
      const triggeredAt = parseShopifyTime(check.triggeredAt);
      if (
        (check.triggeredAt && !triggeredAt) ||
        check.webhookId.length > 200 ||
        (check.eventId?.length ?? 0) > 200
      )
        throw rejectWebhook("WEBHOOK_HEADER_INVALID", { topic, shop });
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        throw rejectWebhook("WEBHOOK_BODY_INVALID", { topic, shop });
      }
      return {
        apiVersion: check.apiVersion,
        shop,
        topic,
        webhookId: check.webhookId,
        name: check.name,
        eventId: check.eventId,
        triggeredAt,
        payload,
      };
    },
    anonymousBodies,
  );
}

/**
 * The shop header is unsigned, so a destructive handler needs the store named
 * inside the signed body as well. Otherwise one captured delivery could revoke
 * or erase any other store by changing a header.
 */
export function requireSignedShop(
  webhook: VerifiedWebhook,
  field: "myshopify_domain" | "shop_domain",
) {
  const body = (webhook.payload ?? {}) as Record<string, unknown>;
  let signed: string | undefined;
  try {
    signed = normalizeShop(body[field]);
  } catch {
    // Absent or not a shop domain, which proves nothing.
  }
  if (signed !== webhook.shop)
    throw rejectWebhook("WEBHOOK_SHOP_MISMATCH", webhook);
}

/**
 * app/uninstalled only. Shopify's sample body has a null myshopify_domain, and
 * refusing a real delivery shaped that way would lose every uninstall to retries,
 * which is worse than the risk here: a revocation that pairing again undoes. A
 * body that names a store still has to name this one. Erasure cannot be undone,
 * so shop/redact and customers/* stay with requireSignedShop.
 */
export function requireUninstallShop(webhook: VerifiedWebhook) {
  const body = webhook.payload;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const named = (body as Record<string, unknown>).myshopify_domain;
    if (named === null || named === undefined) {
      logger.warn(
        {
          code: "WEBHOOK_SHOP_NOT_IN_BODY",
          topic: webhook.topic,
          shop: webhook.shop,
        },
        "Signed uninstall names no store; acting on the unsigned shop header",
      );
      return;
    }
  }
  requireSignedShop(webhook, "myshopify_domain");
}
