/*
 * Keep the local frontend and Worker on the same hostname. A browser considers
 * `localhost` and `127.0.0.1` different sites, even though both reach this PC.
 * Mixing them prevents the HTTP development session cookie from being returned.
 * The production deployment workflow replaces this file with the Worker URL.
 */
window.APP_CONFIG = {
  API_BASE_URL: `${window.location.protocol}//${window.location.hostname}:8787`,
};
