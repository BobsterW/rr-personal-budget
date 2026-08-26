/*
 * Keep the local frontend and Worker on the same hostname. A browser considers
 * `localhost` and `127.0.0.1` different sites, even though both reach this PC.
 * Mixing them prevents the HTTP development session cookie from being returned.
 * Production uses the Worker deployed in Bobby's Cloudflare account. Keeping
 * both choices here makes the built site deterministic instead of relying on a
 * GitHub environment variable to rewrite this file during every deployment.
 */
const isLocalDevelopment = ["localhost", "127.0.0.1"].includes(
  window.location.hostname,
);

window.APP_CONFIG = {
  API_BASE_URL: isLocalDevelopment
    ? `${window.location.protocol}//${window.location.hostname}:8787`
    : "https://rr-personal-budget-api.bobbyw.workers.dev",
};
