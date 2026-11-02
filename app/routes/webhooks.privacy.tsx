import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { receivePrivacyRequest } from "../services/privacy.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, topic } = await authenticate.webhook(request);
  await receivePrivacyRequest(
    shop,
    topic,
    request.headers.get("x-shopify-webhook-id") || "",
  );
  return new Response(null, { status: 200 });
}
