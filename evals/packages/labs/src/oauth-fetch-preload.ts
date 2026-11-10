/** Test-process-only transport for providers whose SDK hardcodes production URLs.
 * Never imported by Den: the world opts in with NODE_OPTIONS=--import <this file>.
 * Keep the real provider implementation, issuer checks and JWT verification intact.
 */
export {};
const origin = process.env.OPENWORK_TEST_OAUTH_ORIGIN;
if (origin) {
  const destination = new URL(origin);
  if (destination.protocol !== "http:" || destination.hostname !== "127.0.0.1") {
    throw new Error("OAuth fixture transport requires a loopback HTTP origin");
  }
  const routes = new Map([
    ["https://oauth2.googleapis.com/token", "/token"],
    ["https://www.googleapis.com/oauth2/v3/certs", "/oauth2/v3/certs"],
    ["https://openidconnect.googleapis.com/v1/userinfo", "/v1/userinfo"],
    ["https://www.googleapis.com/oauth2/v3/userinfo", "/oauth2/v3/userinfo"],
    ["https://accounts.google.com/.well-known/openid-configuration", "/.well-known/openid-configuration"],
  ]);
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = routes.get(`${url.origin}${url.pathname}`);
    if (path) {
      const local = new URL(path, destination);
      local.search = url.search;
      return original(new Request(local, request));
    }
    // Fail closed for all other Google traffic, including accidental SDK endpoint changes.
    if (url.hostname === "google.com" || url.hostname.endsWith(".google.com") || url.hostname.endsWith(".googleapis.com")) {
      throw new Error(`Unmapped Google request in OAuth fixture: ${url.origin}${url.pathname}`);
    }
    return original(request);
  }, original);
}
