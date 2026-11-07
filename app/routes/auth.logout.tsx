import type { ActionFunctionArgs } from "react-router";
import { signIn } from "../shopify.server";

export const action = ({ request }: ActionFunctionArgs) =>
  signIn.logout(request);
