import { data } from "react-router";
import { DomainError } from "../domain/errors";
import {
  ACTION_FORM_LIMIT,
  withBoundedBody,
} from "../services/request-body.server";

/**
 * For a page's loader. A service refuses with a DomainError written for the person
 * refused, and React Router shows an error's text only if it is a response: left as
 * it is, staff with no access on a paired store would get a bare 500, logged as a
 * server fault. A 5xx stays an error, so its details stay out of the page.
 */
export function pageLoader<Args extends unknown[], Result>(
  load: (...args: Args) => Promise<Result>,
) {
  return async (...args: Args) => {
    try {
      return await load(...args);
    } catch (error) {
      if (error instanceof DomainError && error.status < 500)
        throw new Response(error.message, {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        });
      throw error;
    }
  };
}

export async function readActionForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("Content-Type") || "";
  if (
    !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
  )
    throw new Response("Unsupported form encoding", { status: 415 });
  const origin = request.headers.get("Origin");
  const allowed = [new URL(request.url).origin];
  if (process.env.SHOPIFY_APP_URL)
    allowed.push(new URL(process.env.SHOPIFY_APP_URL).origin);
  if (origin && !allowed.includes(origin))
    throw new Response("Invalid request origin", { status: 403 });
  const body = await withBoundedBody(
    request,
    ACTION_FORM_LIMIT,
    (text) => text,
  );
  return new Request(request.url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  }).formData();
}

export function textField(form: FormData, key: string) {
  return String(form.get(key) || "").trim();
}
export function numberField(form: FormData, key: string, fallback = 0) {
  const raw = textField(form, key);
  return raw ? Number(raw) : fallback;
}
export function checked(form: FormData, key: string) {
  return form.get(key) === "on" || form.get(key) === "true";
}
export function actionFailure(error: unknown) {
  if (error instanceof Response) throw error;
  const known = error as { status?: number; message?: string; name?: string };
  if (known.name === "ZodError")
    return data(
      { error: "Some values are invalid. Check the form and try again." },
      { status: 400 },
    );
  const status =
    Number.isInteger(known.status) &&
    Number(known.status) >= 400 &&
    Number(known.status) < 500
      ? Number(known.status)
      : 500;
  return data(
    {
      error:
        status < 500 && known.message
          ? known.message
          : "This operation could not be completed. Refresh the page and try again; contact support if it continues.",
    },
    { status },
  );
}
