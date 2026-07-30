import { NextRequest } from "next/server";
import { joinBaseUrl, readBaseUrlEnv } from "@openwork/types/url";

import { denWebLogger } from "../../../observability/runtime-logger";

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
const SPOOFABLE_FORWARDING_HEADERS = new Set(["forwarded", "x-forwarded-host", "x-forwarded-prefix", "x-forwarded-proto"]);

/**
 * OpenWork Cloud instances are served from Daytona preview origins that are
 * re-signed (and therefore renamed) on every wake, so they can never appear in
 * a static CORS allowlist. The signed-in SPA running there has to reach Den for
 * /v1/me, /v1/me/orgs, MCP tokens and org connections.
 *
 * We reflect those origins, and make that safe by stripping the cookie header
 * from the forwarded request: an instance-origin call is authenticated by its
 * bearer token alone and can never ride the viewer's app.openworklabs.com
 * session. A hostile page on some other origin therefore gains nothing from the
 * reflection - it has no bearer token and its cookies are discarded.
 *
 * Only the Den API proxy opts in; /api/auth keeps cookies and the strict
 * allowlist, because that is where sessions are actually established.
 */
const DEN_API_ROUTE_PREFIX = "/api/den";
const DEFAULT_CLOUD_INSTANCE_ORIGIN_SUFFIXES = [".daytonaproxy01.net"];
const CORS_ALLOW_HEADERS = "authorization,content-type,x-openwork-org-id,x-request-id,accept";
const CORS_ALLOW_METHODS = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";

function cloudInstanceOriginSuffixes(): string[] {
  const configured = process.env.DEN_CLOUD_INSTANCE_ORIGIN_SUFFIXES?.trim();
  if (!configured) return DEFAULT_CLOUD_INSTANCE_ORIGIN_SUFFIXES;
  const parsed = configured
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.startsWith("."));
  return parsed.length > 0 ? parsed : DEFAULT_CLOUD_INSTANCE_ORIGIN_SUFFIXES;
}

function isCloudInstanceOrigin(origin: string | null): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  return cloudInstanceOriginSuffixes().some((suffix) => hostname.endsWith(suffix));
}

function reflectsCloudInstanceOrigin(request: NextRequest, options: ProxyOptions): boolean {
  return options.routePrefix === DEN_API_ROUTE_PREFIX && isCloudInstanceOrigin(request.headers.get("origin"));
}

function applyCloudInstanceCorsHeaders(headers: Headers, origin: string): void {
  // Never emit a second allow-origin: browsers reject duplicates, and den-api
  // already reflects on the grant-exchange route.
  if (!headers.has("access-control-allow-origin")) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
  }
  headers.append("vary", "Origin");
}

type ProxyOptions = {
  routePrefix: string;
  upstreamPathPrefix?: string;
  rewriteAuthLocationsToRequestOrigin?: boolean;
};

function requestPublicOrigin(request: NextRequest): URL {
  const configuredOrigin = readBaseUrlEnv(process.env, "DEN_WEB_PUBLIC_ORIGIN");
  if (configuredOrigin) {
    try {
      return new URL(configuredOrigin);
    } catch {
      return new URL(request.url);
    }
  }

  return new URL(request.url);
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
  const upstream = new URL(prefixedPath ? joinBaseUrl(base, prefixedPath) : base);
  upstream.search = incoming.search;
  return upstream.toString();
}

function shouldSkipRequestHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(normalized) || REQUEST_ONLY_HEADERS.has(normalized) || SPOOFABLE_FORWARDING_HEADERS.has(normalized);
}

function shouldSkipResponseHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(normalized) || RESPONSE_ONLY_HEADERS.has(normalized) || normalized === "set-cookie";
}

async function injectActiveTraceContext(headers: Headers): Promise<void> {
  try {
    const { context, isSpanContextValid, trace, TraceFlags } = await import("@opentelemetry/api");
    const spanContext = trace.getSpanContext(context.active());
    if (spanContext === undefined || !isSpanContextValid(spanContext)) return;

    const flags = (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? "01" : "00";
    headers.set("traceparent", `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`);
    if (spanContext.traceState !== undefined) {
      headers.set("tracestate", spanContext.traceState.serialize());
    }
  } catch {
    return;
  }
}

async function cloneRequestHeaders(
  request: NextRequest,
  routePrefix: string,
  stripCookies = false,
): Promise<Headers> {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (shouldSkipRequestHeader(name)) return;
    // Bearer-only for reflected instance origins - see the note above
    // isCloudInstanceOrigin. This is what makes reflection safe.
    if (stripCookies && name.toLowerCase() === "cookie") return;
    headers.append(name, value);
  });
  const publicOrigin = requestPublicOrigin(request);
  headers.set("x-forwarded-host", publicOrigin.host);
  headers.set("x-forwarded-proto", publicOrigin.protocol.replace(/:$/, ""));
  headers.set("x-forwarded-prefix", routePrefix);
  await injectActiveTraceContext(headers);
  return headers;
}

function copySetCookieHeaders(upstreamHeaders: Headers, responseHeaders: Headers): void {
  for (const cookie of upstreamHeaders.getSetCookie()) {
    if (cookie) responseHeaders.append("set-cookie", cookie);
  }
}

function rewriteLocationHeader(location: string, request: NextRequest, apiBase: string): string {
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

function cloneResponseHeaders(request: NextRequest, upstream: Response, options: ProxyOptions, apiBase: string): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (shouldSkipResponseHeader(name)) return;
    if (name.toLowerCase() === "location" && options.rewriteAuthLocationsToRequestOrigin) {
      headers.append(name, rewriteLocationHeader(value, request, apiBase));
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

function elapsedMs(startMs: number): number {
  return Date.now() - startMs;
}

function upstreamOrigin(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return "invalid";
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
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
  const startedAtMs = Date.now();
  const apiBase = readBaseUrlEnv(process.env, "DEN_API_BASE");
  if (!apiBase) {
    denWebLogger.error("den-web upstream proxy misconfigured", {
      route_prefix: options.routePrefix,
      method: request.method,
      duration_ms: elapsedMs(startedAtMs),
      missing: "DEN_API_BASE",
    });
    return buildUpstreamErrorResponse(503, "DEN_API_BASE must be configured.");
  }

  const instanceOrigin = reflectsCloudInstanceOrigin(request, options)
    ? request.headers.get("origin")
    : null;

  // Answer the preflight here: den-api's allowlist cannot know this origin, and
  // the browser will not send the real request without it.
  if (instanceOrigin && request.method === "OPTIONS") {
    const preflight = new Headers({
      "access-control-allow-origin": instanceOrigin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers":
        request.headers.get("access-control-request-headers") ?? CORS_ALLOW_HEADERS,
      "access-control-allow-methods": CORS_ALLOW_METHODS,
      "access-control-max-age": "600",
    });
    preflight.append("vary", "Origin");
    return new Response(null, { status: 204, headers: preflight });
  }

  const targetPath = getTargetPath(request, segments, options.routePrefix);
  const targetUrl = buildTargetUrl(apiBase, request, targetPath, options.upstreamPathPrefix);
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers: await cloneRequestHeaders(request, options.routePrefix, instanceOrigin !== null),
      body: await readRequestBody(request),
      redirect: "manual",
    });
  } catch (error) {
    denWebLogger.error("den-web upstream proxy failed", {
      route_prefix: options.routePrefix,
      method: request.method,
      upstream_origin: upstreamOrigin(apiBase),
      upstream_path: `/${[normalizePathPrefix(options.upstreamPathPrefix ?? ""), targetPath].filter(Boolean).join("/")}`,
      duration_ms: elapsedMs(startedAtMs),
      error_name: errorName(error),
    });
    throw error;
  }

  denWebLogger.log(upstream.ok ? "info" : "warn", "den-web upstream proxy completed", {
    route_prefix: options.routePrefix,
    method: request.method,
    upstream_origin: upstreamOrigin(apiBase),
    upstream_path: `/${[normalizePathPrefix(options.upstreamPathPrefix ?? ""), targetPath].filter(Boolean).join("/")}`,
    status: upstream.status,
    duration_ms: elapsedMs(startedAtMs),
  });

  const shouldDropBody = request.method === "HEAD" || NO_BODY_STATUS.has(upstream.status);
  const responseHeaders = cloneResponseHeaders(request, upstream, options, apiBase);
  if (instanceOrigin) {
    applyCloudInstanceCorsHeaders(responseHeaders, instanceOrigin);
  }

  return new Response(shouldDropBody ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
