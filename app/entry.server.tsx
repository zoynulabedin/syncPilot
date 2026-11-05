import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, isRouteErrorResponse } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext, type HandleErrorFunction } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { logger, safeError } from "./services/logger.server";

export const streamTimeout = 5000;

// React Router's default prints errors with console.error, past the redaction
// that logs get, and a request URL or token can be part of the message.
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) return;
  logger.error(
    {
      err: safeError(
        isRouteErrorResponse(error)
          ? ((error as { error?: unknown }).error ??
              `${error.status} ${error.statusText}`)
          : error,
      ),
      method: request.method,
      path: new URL(request.url).pathname,
    },
    "Request failed",
  );
};

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          logger.error({ err: safeError(error) }, "Page failed to render");
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
