import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  isRouteErrorResponse,
  useActionData,
  useLoaderData,
  useRouteError,
} from "react-router";

import { SignInScreen } from "../../components/sign-in-screen";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

// A refused form is answered through the boundary below, which sends only the
// headers returned here. `Connection: close` is what ends the upload.
export const headers: HeadersFunction = ({ errorHeaders }) =>
  errorHeaders ?? {};

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <SignInScreen
      error={`This request could not be completed (${status}). Please try again.`}
    />
  );
}

type Answer = {
  errors: { shop?: string };
  typed?: string;
  confirming?: string;
  signedIn?: string[];
};

async function answer(request: Request): Promise<Answer> {
  const result = await login(request);
  if ("confirming" in result)
    return { errors: {}, confirming: result.confirming };
  if ("signedIn" in result) return { errors: {}, signedIn: result.signedIn };
  return {
    errors: loginErrorMessage(result),
    ...("typed" in result ? { typed: result.typed } : {}),
  };
}

export const loader = ({ request }: LoaderFunctionArgs) => answer(request);

export const action = ({ request }: ActionFunctionArgs) => answer(request);

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { errors, typed, confirming, signedIn } = actionData || loaderData;

  return (
    <SignInScreen
      error={errors.shop}
      typed={typed}
      confirming={confirming}
      signedIn={signedIn}
    />
  );
}
