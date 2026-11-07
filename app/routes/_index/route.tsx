import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { SignInScreen } from "../../components/sign-in-screen";
import { signIn } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) =>
  (await signIn.entry(request)) ?? { problem: undefined };

export default function App() {
  const { problem } = useLoaderData<typeof loader>() as { problem?: string };

  return <SignInScreen action="/auth/login" error={problem} />;
}
