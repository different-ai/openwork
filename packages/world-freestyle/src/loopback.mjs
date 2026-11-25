// Inside a preview VM every service keeps the snapshot's template origins, which resolve to this VM where nothing
// listens on 443 (see templateHostsEntries). A server that calls another in-VM service at its advertised origin
// (Workbot fetching Den's OAuth metadata and token endpoint from Den's issuer URL) is started with this preload:
// requests to a mapped template host go to that service's loopback address instead, split between Den web and the
// Den API by path, as the preview gateway routes browsers.
//
//   OPENWORK_PREVIEW_LOOPBACK='{"den-0000….preview.openwork.software":{"web":"http://127.0.0.1:3005","api":"http://127.0.0.1:8788"}}'
const API_PATH = /^(?:\/v1(?:\/|$)|\/mcp(?!\/(?:consent|select-organization)(?:\/|$))(?:\/|$)|\/health$|\/oauth\/client-metadata\.json$)/;

function readRoutes(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** The loopback URL for a request to a mapped template origin, or null to send it unchanged. */
export function loopbackUrl(input, routes) {
  if ((typeof input !== "string" && !(input instanceof URL)) || !URL.canParse(input)) return null;
  const url = new URL(input);
  const route = routes[url.hostname];
  if (!route || url.protocol !== "https:") return null;
  const base = API_PATH.test(url.pathname) && typeof route.api === "string" ? route.api : route.web;
  if (typeof base !== "string") return null;
  const target = new URL(base);
  if (target.protocol !== "http:" || !target.hostname.startsWith("127.")) return null;
  return new URL(`${url.pathname}${url.search}`, target);
}

const routes = readRoutes(process.env.OPENWORK_PREVIEW_LOOPBACK);
const installed = Symbol.for("openwork.preview.loopback");
if (typeof globalThis.fetch === "function" && !globalThis.fetch[installed] && Object.keys(routes).length > 0) {
  const send = globalThis.fetch;
  const fetch = (input, init) => send(loopbackUrl(input, routes) ?? input, init);
  fetch[installed] = true;
  globalThis.fetch = fetch;
}
