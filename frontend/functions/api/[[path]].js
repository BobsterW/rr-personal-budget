/*
 * SAME-ORIGIN API GATEWAY
 * -----------------------
 * Mobile Safari can block cookies set by workers.dev while the user is
 * browsing pages.dev. This narrowly scoped Pages Function makes the browser
 * call /api on the Pages origin, then forwards that request to the dedicated
 * API Worker. HttpOnly cookies remain inaccessible to frontend JavaScript.
 */

const API_ORIGIN = "https://rr-personal-budget-api.bobbyw.workers.dev";

export async function onRequest({ request, params }) {
  const incomingUrl = new URL(request.url);
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path;
  const upstreamUrl = new URL(`/api/${path ?? ""}`, API_ORIGIN);
  upstreamUrl.search = incomingUrl.search;

  // Forward the browser headers and cookie, but remove headers that describe
  // the browser-to-Pages hop. The Worker then treats the proxy as same-site and
  // issues a Strict cookie that Safari stores on the Pages response.
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");

  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });
  const upstreamResponse = await fetch(upstreamRequest);
  const responseHeaders = new Headers(upstreamResponse.headers);

  // CORS headers describe direct browser-to-Worker requests and are unnecessary
  // on this same-origin response. Removing them avoids contradictory policies.
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-allow-credentials",
  ]) {
    responseHeaders.delete(name);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
