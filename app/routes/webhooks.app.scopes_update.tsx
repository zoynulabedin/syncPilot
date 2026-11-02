import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { z } from "zod";
import { updateInstallationScopes } from "../services/installation.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);
  const { current } = z
    .object({ current: z.array(z.string().regex(/^[a-z_]+$/)).max(200) })
    .parse(payload);
  await updateInstallationScopes(shop, current);
  return new Response();
};
