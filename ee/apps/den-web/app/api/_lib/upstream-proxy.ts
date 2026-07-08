import { NextRequest } from "next/server";

const NO_BODY_STATUS = new Set([204, 205, 304]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_ONLY_HEADERS = new Set(["host", "content-length"]);
const RESPONSE_ONLY_HEADERS = new Set(["content-length", "content-encoding"]);

const apiBase = readBaseUrlEnv("DEN_API_BASE");

type ProxyOptions = {
  routePrefix: string;
  upstreamPathPrefix?: string;
  rewriteAuthLocationsToRequestOrigin?: boolean;
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function readBaseUrlEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? normalizeBaseUrl(value) : null;
}

function normalizePathPrefix(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function getTargetPath(request: NextRequest, segments: string[], routePrefix: string): string {
  const incoming = new URL(request.url);
  let targetPath = segments.join("/");

  if (!targetPath) {
    const normalizedPrefix = routePrefix.endsWith("/") ? routePrefix : `${routePrefix}/`;
    if (incoming.pathname.startsWith(normalizedPrefix)) {
      targetPath = incoming.pathname.slice(normalizedPrefix.length);
    } else if (incoming.pathname === routePrefix) {
      targetPath = "";
    }
  }

  return targetPath;
}

function buildTargetUrl(
  base: string,
  request: NextRequest,
  targetPath: string,
  upstreamPathPrefix = "",
): string {
  const incoming = new URL(request.url);
  const prefixedPath = [normalizePathPrefix(upstreamPathPrefix), targetPath].filter(Boolean).join("/");
  const upstream = new URL(prefixedPath ? `${base}/${prefixedPath}` : base);
  upstream.search = incoming.search;
  return upstream.toString();
}

function shouldSkipRequestHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(normalized) || REQUEST_ONLY_HEADERS.has(normalized);
}

function shouldSkipResponseHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(normalized) || RESPONSE_ONLY_HEADERS.has(normalized) || normalized === "set-cookie";
}

function cloneRequestHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!shouldSkipRequestHeader(name)) {
      headers.append(name, value);
    }
  });
  return headers;
}

function copySetCookieHeaders(upstreamHeaders: Headers, responseHeaders: Headers): void {
  for (const cookie of upstreamHeaders.getSetCookie()) {
    if (cookie) responseHeaders.append("set-cookie", cookie);
  }
}

function rewriteLocationHeader(location: string, request: NextRequest): string {
  if (!apiBase) return location;

  let parsedLocation: URL;
  try {
    parsedLocation = new URL(location);
  } catch {
    return location;
  }

  let apiOrigin: string;
  try {
    apiOrigin = new URL(apiBase).origin;
  } catch {
    return location;
  }

  if (parsedLocation.origin !== apiOrigin || !parsedLocation.pathname.startsWith("/api/auth/")) {
    return location;
  }

  const requestOrigin = new URL(request.url).origin;
  return `${requestOrigin}${parsedLocation.pathname}${parsedLocation.search}${parsedLocation.hash}`;
}

function cloneResponseHeaders(request: NextRequest, upstream: Response, options: ProxyOptions): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (shouldSkipResponseHeader(name)) return;
    if (name.toLowerCase() === "location" && options.rewriteAuthLocationsToRequestOrigin) {
      headers.append(name, rewriteLocationHeader(value, request));
      return;
    }
    headers.append(name, value);
  });
  copySetCookieHeaders(upstream.headers, headers);
  return headers;
}

function buildUpstreamErrorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function readRequestBody(request: NextRequest): Promise<Uint8Array | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  return new Uint8Array(await request.arrayBuffer());
}

export async function proxyUpstream(
  request: NextRequest,
  segments: string[] = [],
  options: ProxyOptions,
): Promise<Response> {
  if (!apiBase) {
    return buildUpstreamErrorResponse(503, "DEN_API_BASE must be configured.");
  }

  const targetPath = getTargetPath(request, segments, options.routePrefix);
  const targetUrl = buildTargetUrl(apiBase, request, targetPath, options.upstreamPathPrefix);
  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers: cloneRequestHeaders(request),
    body: await readRequestBody(request),
    redirect: "manual",
  });
  const shouldDropBody = request.method === "HEAD" || NO_BODY_STATUS.has(upstream.status);

  return new Response(shouldDropBody ? null : upstream.body, {
    status: upstream.status,
    headers: cloneResponseHeaders(request, upstream, options),
  });
}
