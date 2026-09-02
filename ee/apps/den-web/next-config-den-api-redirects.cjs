// Build-time counterpart of app/api/_lib/den-api-redirect.ts.
//
// `/api/den/*` only exists so older desktop builds that still call the web
// origin reach the Den API. When the API origin is already known at build
// time, emitting the 307 as a Next.js redirect lets the hosting routing layer
// answer without invoking a function for every poll. Deployments that learn
// the origin per request (prebuilt images, no DEN_* env at build time) get no
// rule here and keep the route handler.

const DEN_API_ROUTE_PREFIX = "/api/den";

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function originFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Mirrors denUrls(env).web: DEN_BASE_URL is an http(s) origin, scheme optional.
function webOriginFromDenBaseUrl(env) {
  const value = trimmed(env.DEN_BASE_URL);
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Mirrors readPublicWebOrigin(): denUrls(env).web, else DEN_WEB_PUBLIC_ORIGIN.
function publicWebOrigin(env) {
  return webOriginFromDenBaseUrl(env) ?? (trimmed(env.DEN_WEB_PUBLIC_ORIGIN).replace(/\/+$/, "") || null);
}

// Mirrors denApiOriginForWebOrigin(): DEN_API_BASE wins, else `api.` on the web host.
function denApiRedirectOrigin(env = process.env) {
  const configured = trimmed(env.DEN_API_BASE);
  if (configured) {
    const origin = originFromUrl(configured);
    if (origin) return origin;
  }

  const webOrigin = publicWebOrigin(env);
  if (!webOrigin) return null;

  let url;
  try {
    url = new URL(webOrigin);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  url.hostname = hostname === "api" || hostname.startsWith("api.") ? hostname : `api.${hostname}`;
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function denApiRedirects(env = process.env) {
  const apiOrigin = denApiRedirectOrigin(env);
  if (!apiOrigin) return [];

  return [
    {
      source: `${DEN_API_ROUTE_PREFIX}/:path*`,
      destination: `${apiOrigin}/:path*`,
      permanent: false,
    },
  ];
}

module.exports = {
  denApiRedirectOrigin,
  denApiRedirects,
};
