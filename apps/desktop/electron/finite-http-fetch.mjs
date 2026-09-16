/**
 * Chromium's main and renderer HTTP/1.1 clients can share saturated socket
 * pools. Only plain loopback HTTP may use Node networking; external requests
 * retain Chromium's OS certificate trust and proxy support.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {typeof fetch} externalFetch
 */
export function fetchFiniteDesktopHttp(url, init, externalFetch) {
  const target = new URL(url);
  const loopback = target.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
  if (!loopback) return externalFetch(url, init);
  // loopback-fetch: validated HTTP loopback only; reject redirects so credentials and Node networking cannot escape to an external origin.
  return fetch(url, { ...init, redirect: "error" });
}
