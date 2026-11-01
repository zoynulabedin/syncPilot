import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { revokeInstallation } from "../services/installation.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  await revokeInstallation(shop);

  return new Response();
};
