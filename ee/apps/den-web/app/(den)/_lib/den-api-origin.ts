let denApiOriginOverride: string | null = null;

function normalizeOrigin(input: string | null | undefined): string | null {
  const trimmed = input?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function setDenApiOriginOverride(input: string | null | undefined) {
  denApiOriginOverride = normalizeOrigin(input);
}

// Browser-facing API origin. DEN_API_PUBLIC_URL is the origin the browser can
// reach (runtime-config hands it to clients); DEN_API_BASE is the server-side
// upstream, which in containers is an in-network URL the browser cannot reach.
// Prefer the public one and keep DEN_API_BASE as the documented fallback.
// Mirrored in next-config-den-api-redirects.cjs (keep in sync).
function configuredDenApiOrigin(): string | null {
  for (const value of [process.env.DEN_API_PUBLIC_URL, process.env.DEN_API_BASE]) {
    const configuredOrigin = value?.trim();
    if (!configuredOrigin) continue;
    try {
      const url = new URL(configuredOrigin);
      // Scheme-less values like `localhost:18788` parse with a `localhost:`
      // scheme and an opaque "null" origin; skip them like the build-time rule.
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {}
  }
  return null;
}

export function denApiOriginForWebOrigin(webOrigin: string): string | null {
  const configuredOrigin = configuredDenApiOrigin();
  if (configuredOrigin) {
    return configuredOrigin;
  }

  let url: URL;
  try {
    url = new URL(webOrigin);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const apiHostname = hostname === "api" || hostname.startsWith("api.")
    ? hostname
    : `api.${hostname}`;

  url.hostname = apiHostname;
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function currentDenApiOriginForWebOrigin(webOrigin: string): string | null {
  return denApiOriginOverride ?? denApiOriginForWebOrigin(webOrigin);
}

export function currentDenApiOrigin(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return currentDenApiOriginForWebOrigin(window.location.origin);
}

export function denApiEndpointForWebOrigin(path: string, webOrigin: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const origin = currentDenApiOriginForWebOrigin(webOrigin);
  if (!origin) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${normalizedPath}`;
}

const PUBLIC_DEN_API_PATH_PREFIXES = ["/v1/orgs/sso/resolve"];

function isPublicDenApiPath(path: string): boolean {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return PUBLIC_DEN_API_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
}

export function denApiCredentialsForEndpoint(endpoint: string, webOrigin: string, path = endpoint): RequestCredentials {
  try {
    const endpointOrigin = new URL(endpoint).origin;
    const currentOrigin = new URL(webOrigin).origin;
    const apiOrigin = currentDenApiOriginForWebOrigin(webOrigin);
    if (endpointOrigin === apiOrigin && isPublicDenApiPath(path)) {
      return "omit";
    }
    return endpointOrigin === currentOrigin || endpointOrigin === apiOrigin ? "include" : "omit";
  } catch {
    return "include";
  }
}

export function denApiCredentials(endpoint: string, path = endpoint): RequestCredentials {
  if (typeof window === "undefined") {
    return "include";
  }

  return denApiCredentialsForEndpoint(endpoint, window.location.origin, path);
}

export function denApiEndpoint(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  if (typeof window === "undefined") {
    return path;
  }

  return denApiEndpointForWebOrigin(path, window.location.origin);
}
