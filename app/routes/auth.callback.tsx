import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { SignInScreen } from "../components/sign-in-screen";
import { signIn } from "../shopify.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  signIn.callback(request);

// Only a refusal renders: a sign-in that worked has already redirected. The form
// posts away from here, or it would resend Shopify's spent code and signature.
export default function SignInRefused() {
  const { problem } = useLoaderData<typeof loader>() as { problem?: string };
  return <SignInScreen action="/auth/login" error={problem} />;
}
