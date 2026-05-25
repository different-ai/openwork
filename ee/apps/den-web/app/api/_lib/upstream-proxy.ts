import { NextRequest } from "next/server";

const DEFAULT_API_BASE = "https://api.openworklabs.com";
const DEFAULT_AUTH_ORIGIN = "https://app.openworklabs.com";
const DEFAULT_AUTH_FALLBACK_BASE = "https://den-control-plane-openwork.onrender.com";
const NO_BODY_STATUS = new Set([204, 205, 304]);

const apiBase = normalizeBaseUrl(process.env.DEN_API_BASE ?? DEFAULT_API_BASE);
const authOrigin = normalizeBaseUrl(process.env.DEN_AUTH_ORIGIN ?? DEFAULT_AUTH_ORIGIN);
const authFallbackBase = normalizeBaseUrl(process.env.DEN_AUTH_FALLBACK_BASE ?? DEFAULT_AUTH_FALLBACK_BASE);
const appPort = process.env.OPENWORK_APP_PORT?.trim() || process.env.PORT?.trim() || "5173";
const configuredCorsOrigins = splitCsv(process.env.DEN_CORS_ORIGINS ?? process.env.CORS_ORIGINS);
const localDevCorsOrigins = process.env.OPENWORK_DEV_MODE === "1"
  ? [`http://localhost:${appPort}`, `http://127.0.0.1:${appPort}`]
  : [];
const corsOrigins = Array.from(new Set([...configuredCorsOrigins, ...localDevCorsOrigins]));

type ProxyOptions = {
  routePrefix: string;
  upstreamPathPrefix?: string;
  rewriteAuthLocationsToRequestOrigin?: boolean;
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean);
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

function isLikelyHtmlBody(body: ArrayBuffer): boolean {
  if (body.byteLength === 0) {
    return false;
  }

  const preview = new TextDecoder().decode(body.slice(0, 256)).trim().toLowerCase();
  return preview.startsWith("<!doctype") || preview.startsWith("<html") || preview.includes("<body");
}

function isLikelyCannotGetBody(body: ArrayBuffer): boolean {
  if (body.byteLength === 0) {
    return false;
  }

  const preview = new TextDecoder().decode(body.slice(0, 256)).trim().toLowerCase();
  return preview.includes("cannot get ");
}

function isAdminTargetPath(targetPath: string): boolean {
  return targetPath === "v1/admin" || targetPath.startsWith("v1/admin/");
}

function shouldFallbackToAuthBase(response: Response, body: ArrayBuffer, targetPath: string): boolean {
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return true;
  }

  if (response.status === 404 && isAdminTargetPath(targetPath)) {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html") || isLikelyHtmlBody(body) || isLikelyCannotGetBody(body)) {
      return true;
    }
  }

  if (response.status < 500) {
    return false;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    return true;
  }

  return isLikelyHtmlBody(body);
}

function buildUpstreamErrorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function applyCorsHeaders(request: NextRequest, headers: Headers): void {
  const origin = request.headers.get("origin")?.trim().replace(/\/+$/, "") ?? "";
  if (!origin) {
    return;
  }

  const allowOrigin = corsOrigins.includes("*") || corsOrigins.includes(origin) ? origin : "";
  if (!allowOrigin) {
    return;
  }

  headers.set("access-control-allow-origin", allowOrigin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "Content-Type,Authorization,X-Api-Key,X-Request-Id,X-Requested-With,X-OpenWork-Legacy-Org-Id");
  headers.append("vary", "Origin");
}

export function buildCorsPreflightResponse(request: NextRequest): Response {
  const headers = new Headers();
  applyCorsHeaders(request, headers);
  return new Response(null, { status: 204, headers });
}

function getJsonRedirectUrl(body: ArrayBuffer): string | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (
      payload &&
      typeof payload === "object" &&
      "redirect" in payload &&
      payload.redirect === true &&
      "url" in payload &&
      typeof payload.url === "string" &&
      payload.url.trim()
    ) {
      return payload.url.trim();
    }
  } catch {}
  return null;
}

function copySetCookieHeaders(upstreamHeaders: Headers, responseHeaders: Headers): void {
  const getSetCookie = (upstreamHeaders as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    const cookies = getSetCookie.call(upstreamHeaders);
    for (const cookie of cookies) {
      if (cookie) {
        responseHeaders.append("set-cookie", cookie);
      }
    }
    return;
  }

  const cookie = upstreamHeaders.get("set-cookie");
  if (cookie) {
    responseHeaders.append("set-cookie", cookie);
  }
}

function buildHeaders(request: NextRequest, contentType: string | null): Headers {
  const headers = new Headers();
  const copyHeaders = [
    "accept",
    "authorization",
    "cookie",
    "user-agent",
    "x-requested-with",
    "x-api-key",
    "x-openwork-legacy-org-id",
    "origin",
    "x-forwarded-for",
  ];

  for (const key of copyHeaders) {
    const value = request.headers.get(key);
    if (value) {
      headers.set(key, value);
    }
  }

  if (contentType) {
    headers.set("content-type", contentType);
  }

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  if (!headers.has("origin")) {
    headers.set("origin", authOrigin);
  }

  const incoming = new URL(request.url);
  headers.set("x-forwarded-host", request.headers.get("host") ?? incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(/:$/, ""));

  return headers;
}

async function fetchUpstream(
  request: NextRequest,
  targetUrl: string,
  contentType: string | null,
  body: Uint8Array | null,
): Promise<Response> {
  const init: RequestInit = {
    method: request.method,
    headers: buildHeaders(request, contentType),
    redirect: "manual",
  };

  if (body && request.method !== "GET" && request.method !== "HEAD") {
    init.body = body;
  }

  return fetch(targetUrl, init);
}

async function readUpstreamBody(response: Response): Promise<ArrayBuffer> {
  return response.arrayBuffer();
}

function isEventStreamRequest(request: NextRequest): boolean {
  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  return accept.includes("text/event-stream");
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream");
}

function shouldFallbackToAuthBaseForStream(response: Response, targetPath: string): boolean {
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return true;
  }

  if (response.status === 404 && isAdminTargetPath(targetPath)) {
    return true;
  }

  return false;
}

function rewriteLocationHeader(location: string, request: NextRequest): string {
  let parsedLocation: URL;
  try {
    parsedLocation = new URL(location);
  } catch {
    return location;
  }

  const requestOrigin = new URL(request.url).origin;
  const rewriteableOrigins = [apiBase, authFallbackBase]
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));

  if (!rewriteableOrigins.includes(parsedLocation.origin) || !parsedLocation.pathname.startsWith("/api/auth/")) {
    return location;
  }

  return `${requestOrigin}${parsedLocation.pathname}${parsedLocation.search}${parsedLocation.hash}`;
}

function buildProxyResponse(
  request: NextRequest,
  upstream: Response,
  options: ProxyOptions,
  body?: BodyInit | null,
): Response {
  const responseHeaders = new Headers();
  const passThroughHeaders = ["content-type", "location", "cache-control"];

  for (const key of passThroughHeaders) {
    const value = upstream.headers.get(key);
    if (!value) {
      continue;
    }

    if (key === "location" && options.rewriteAuthLocationsToRequestOrigin) {
      responseHeaders.set(key, rewriteLocationHeader(value, request));
      continue;
    }

    responseHeaders.set(key, value);
  }

  copySetCookieHeaders(upstream.headers, responseHeaders);
  applyCorsHeaders(request, responseHeaders);

  const shouldDropBody = request.method === "HEAD" || NO_BODY_STATUS.has(upstream.status);

  return new Response(shouldDropBody ? null : (body ?? upstream.body), {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function proxyUpstream(
  request: NextRequest,
  segments: string[] = [],
  options: ProxyOptions,
): Promise<Response> {
  const targetPath = getTargetPath(request, segments, options.routePrefix);
  const primaryTargetUrl = buildTargetUrl(apiBase, request, targetPath, options.upstreamPathPrefix);
  const fallbackTargetUrl = buildTargetUrl(authFallbackBase, request, targetPath, options.upstreamPathPrefix);
  const contentType = request.headers.get("content-type");
  const requestBody = request.method !== "GET" && request.method !== "HEAD"
    ? new Uint8Array(await request.arrayBuffer())
    : null;

  let upstream: Response | null = null;

  try {
    upstream = await fetchUpstream(request, primaryTargetUrl, contentType, requestBody);
  } catch {
    if (apiBase !== authFallbackBase) {
      try {
        upstream = await fetchUpstream(request, fallbackTargetUrl, contentType, requestBody);
      } catch {}
    }
  }

  if (!upstream) {
    const response = buildUpstreamErrorResponse(502, "Upstream request failed.");
    applyCorsHeaders(request, response.headers);
    return response;
  }

  if (isEventStreamRequest(request) || isEventStreamResponse(upstream)) {
    if (apiBase !== authFallbackBase && shouldFallbackToAuthBaseForStream(upstream, targetPath)) {
      try {
        upstream = await fetchUpstream(request, fallbackTargetUrl, contentType, requestBody);
      } catch {}
    }
    return buildProxyResponse(request, upstream, options);
  }

  let body = await readUpstreamBody(upstream);

  if (apiBase !== authFallbackBase && shouldFallbackToAuthBase(upstream, body, targetPath)) {
    try {
      upstream = await fetchUpstream(request, fallbackTargetUrl, contentType, requestBody);
      body = await readUpstreamBody(upstream);
    } catch {}
  }

  const responseContentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  if (upstream.status >= 500 && (responseContentType.includes("text/html") || isLikelyHtmlBody(body))) {
    const response = buildUpstreamErrorResponse(upstream.status, "Upstream service unavailable.");
    applyCorsHeaders(request, response.headers);
    return response;
  }

  if (request.method === "GET" && targetPath === "oauth2/authorize") {
    const redirectUrl = getJsonRedirectUrl(body);
    if (redirectUrl) {
      const incoming = new URL(request.url);
      const host = request.headers.get("host") ?? incoming.host;
      const origin = `${incoming.protocol}//${host}`;
      return Response.redirect(new URL(redirectUrl, origin), 302);
    }
  }

  return buildProxyResponse(request, upstream, options, body);
}
