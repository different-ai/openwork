import { NextRequest } from "next/server";
import { joinBaseUrl, readBaseUrlEnv } from "@openwork/types/url";

import { denWebLogger } from "../../../observability/runtime-logger";
import { readPublicWebOrigin } from "../../_lib/public-web-origin";

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
const LOCATION_BASED_HEADERS = new Set(["content-location", "link", "location", "refresh"]);
const INTERNAL_RESPONSE_HEADERS = new Set([
  "alt-svc",
  "cf-cache-status",
  "cf-ray",
  "rndr-id",
  "server",
  "via",
  "x-amzn-trace-id",
  "x-envoy-upstream-service-time",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-prefix",
  "x-forwarded-proto",
  "x-real-ip",
  "x-render-origin-server",
  "x-request-id",
  "x-vercel-id",
]);
const SAFE_X_RESPONSE_HEADERS = new Set(["x-content-type-options"]);
const AUTH_COOKIE_PREFIXES = [
  "openwork-den.",
  "__Secure-openwork-den.",
  "openwork-den-",
  "better-auth.",
  "__Secure-better-auth.",
  "better-auth-",
];

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
const CORS_ALLOW_HEADERS = "authorization,content-type,x-openwork-org-id,x-openwork-legacy-org-id,x-request-id,accept";
const CORS_ALLOW_METHODS = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const UPSTREAM_DEADLINE_MS = 55_000;

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
  upstreamDeadlineMs?: number;
};

type UpstreamAbortCause = "client" | "deadline" | "downstream";

type UpstreamAbort = {
  signal: AbortSignal;
  cause: () => UpstreamAbortCause | null;
  abort: (cause: UpstreamAbortCause) => void;
  cleanup: () => void;
};

function requestPublicOrigin(request: NextRequest): URL {
  const configuredOrigin = readPublicWebOrigin();
  if (configuredOrigin) {
    try {
      return new URL(configuredOrigin);
    } catch {
      return new URL(request.url);
    }
  }

  const requestUrl = new URL(request.url);
  const requestHost = requestUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (requestHost !== "localhost" && requestHost !== "127.0.0.1" && requestHost !== "0.0.0.0" && requestHost !== "::1") {
    return requestUrl;
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  if (forwardedHost && (forwardedProto === "http" || forwardedProto === "https")) {
    try {
      const forwarded = new URL(`${forwardedProto}://${forwardedHost}`);
      if (!forwarded.username && !forwarded.password && forwarded.pathname === "/" && !forwarded.search && !forwarded.hash) {
        return forwarded;
      }
    } catch {
      // Fall through to the request URL when the ingress headers are malformed.
    }
  }

  return requestUrl;
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
  return HOP_BY_HOP_HEADERS.has(normalized)
    || RESPONSE_ONLY_HEADERS.has(normalized)
    || INTERNAL_RESPONSE_HEADERS.has(normalized)
    || (!SAFE_X_RESPONSE_HEADERS.has(normalized) && normalized.startsWith("x-"))
    || normalized === "set-cookie";
}

function shouldSkipExposedResponseHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(normalized)
    || INTERNAL_RESPONSE_HEADERS.has(normalized)
    || (!SAFE_X_RESPONSE_HEADERS.has(normalized) && normalized.startsWith("x-"));
}

function sanitizeExposeHeaders(headers: Headers): void {
  const exposedHeaders = headers.get("access-control-expose-headers");
  if (!exposedHeaders) return;

  const safeHeaders = exposedHeaders
    .split(",")
    .map((header) => header.trim())
    .filter((header) => header && !shouldSkipExposedResponseHeader(header));
  if (safeHeaders.length > 0) {
    headers.set("access-control-expose-headers", safeHeaders.join(", "));
  } else {
    headers.delete("access-control-expose-headers");
  }
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
  referenceId: string,
  stripCookies = false,
): Promise<Headers> {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (shouldSkipRequestHeader(name)) return;
    // Bearer-only for reflected instance origins - see the note above
    // isCloudInstanceOrigin. This is what makes reflection safe.
    if (stripCookies && name.toLowerCase() === "cookie") return;
    if (routePrefix === "/api/auth" && name.toLowerCase() === "cookie") {
      const authCookies = value
        .split(";")
        .map((cookie) => cookie.trim())
        .filter((cookie) => AUTH_COOKIE_PREFIXES.some((prefix) => cookie.startsWith(prefix)));
      if (authCookies.length > 0) {
        headers.append(name, authCookies.join("; "));
      }
      return;
    }
    headers.append(name, value);
  });
  const publicOrigin = requestPublicOrigin(request);
  headers.set("x-forwarded-host", publicOrigin.host);
  headers.set("x-forwarded-proto", publicOrigin.protocol.replace(/:$/, ""));
  headers.set("x-forwarded-prefix", routePrefix);
  headers.set("x-request-id", referenceId);
  await injectActiveTraceContext(headers);
  return headers;
}

function isDomainCookieHostEligible(origin: URL): boolean {
  const hostname = origin.hostname.toLowerCase();
  return origin.protocol === "https:" && hostname.includes(".") && hostname !== "localhost";
}

function normalizeCookieDomainAttribute(value: string): string | null {
  const domain = value.trim().replace(/^\.+/u, "").toLowerCase();
  if (!domain || domain.includes(":")) return null;
  return domain;
}

function cookieDomainAppliesToHost(domain: string, hostname: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function rewriteAuthSetCookieHeader(cookie: string, request: NextRequest, apiBase: string, options: ProxyOptions): string {
  if (options.routePrefix !== "/api/auth") return cookie;

  let apiOrigin: URL;
  try {
    apiOrigin = new URL(apiBase);
  } catch {
    return cookie;
  }

  const publicOrigin = requestPublicOrigin(request);
  if (!isDomainCookieHostEligible(publicOrigin)) return cookie;
  const publicHostname = publicOrigin.hostname.toLowerCase();
  const apiHostname = apiOrigin.hostname.toLowerCase();
  const canShareWithApiSubdomain = apiHostname.endsWith(`.${publicHostname}`);
  let hasDomain = false;

  const rewritten = cookie
    .split(";")
    .map((part, index) => {
      const trimmed = part.trim();
      if (!/^domain=/iu.test(trimmed)) return index === 0 ? trimmed : ` ${trimmed}`;
      hasDomain = true;
      const upstreamDomain = normalizeCookieDomainAttribute(trimmed.slice("domain=".length));
      return upstreamDomain && cookieDomainAppliesToHost(upstreamDomain, publicHostname)
        ? ` Domain=${upstreamDomain}`
        : ` Domain=${publicHostname}`;
    })
    .join(";");

  if (hasDomain || !canShareWithApiSubdomain || /^__Host-/u.test(cookie)) return rewritten;
  return `${rewritten}; Domain=${publicHostname}`;
}

function splitCombinedSetCookieHeader(value: string): string[] {
  const cookies: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === ";") {
      inExpires = false;
      continue;
    }
    if (!inExpires && value.slice(index, index + 8).toLowerCase() === "expires=") {
      inExpires = true;
      index += 7;
      continue;
    }
    if (char === "," && !inExpires) {
      const candidate = value.slice(start, index).trim();
      if (candidate) cookies.push(candidate);
      start = index + 1;
    }
  }

  const finalCookie = value.slice(start).trim();
  if (finalCookie) cookies.push(finalCookie);
  return cookies;
}

function readSetCookieHeaders(upstreamHeaders: Headers): string[] {
  const cookies = upstreamHeaders.getSetCookie();
  if (cookies.length > 0) return cookies;
  const combined = upstreamHeaders.get("set-cookie");
  return combined ? splitCombinedSetCookieHeader(combined) : [];
}

function copySetCookieHeaders(upstreamHeaders: Headers, responseHeaders: Headers, request: NextRequest, apiBase: string, options: ProxyOptions): void {
  for (const cookie of readSetCookieHeaders(upstreamHeaders)) {
    if (cookie) responseHeaders.append("set-cookie", rewriteAuthSetCookieHeader(cookie, request, apiBase, options));
  }
}

function publicProxyUrlForUpstreamUrl(value: string, request: NextRequest, apiBase: string, options: ProxyOptions): string {
  let parsedValue: URL;
  try {
    parsedValue = new URL(value);
  } catch {
    return value;
  }

  let apiOrigin: string;
  try {
    apiOrigin = new URL(apiBase).origin;
  } catch {
    return value;
  }

  if (parsedValue.origin !== apiOrigin) {
    return value;
  }

  const requestOrigin = new URL(request.url).origin;
  const routePrefix = options.routePrefix.startsWith("/") ? options.routePrefix : `/${options.routePrefix}`;
  const upstreamPrefix = normalizePathPrefix(options.upstreamPathPrefix ?? "");
  let publicPath: string;

  if (upstreamPrefix) {
    const normalizedUpstreamPrefix = `/${upstreamPrefix}`;
    if (!parsedValue.pathname.startsWith(normalizedUpstreamPrefix)) return value;
    const suffix = parsedValue.pathname.slice(normalizedUpstreamPrefix.length);
    publicPath = `${routePrefix}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  } else {
    publicPath = `${routePrefix}${parsedValue.pathname.startsWith("/") ? parsedValue.pathname : `/${parsedValue.pathname}`}`;
  }

  return `${requestOrigin}${publicPath}${parsedValue.search}${parsedValue.hash}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteEmbeddedUpstreamUrls(value: string, request: NextRequest, apiBase: string, options: ProxyOptions): string {
  let apiOrigin: string;
  try {
    apiOrigin = new URL(apiBase).origin;
  } catch {
    return value;
  }

  const absoluteUpstreamUrl = new RegExp(`${escapeRegExp(apiOrigin)}[^\\s,;<>\"]*`, "g");
  return value.replace(absoluteUpstreamUrl, (match) => publicProxyUrlForUpstreamUrl(match, request, apiBase, options));
}

function rewriteLocationBasedHeader(value: string, request: NextRequest, apiBase: string, options: ProxyOptions): string {
  const rewrittenSingleUrl = publicProxyUrlForUpstreamUrl(value, request, apiBase, options);
  return rewrittenSingleUrl === value
    ? rewriteEmbeddedUpstreamUrls(value, request, apiBase, options)
    : rewrittenSingleUrl;
}

function cloneResponseHeaders(request: NextRequest, upstream: Response, options: ProxyOptions, apiBase: string): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (shouldSkipResponseHeader(name)) return;
    if (LOCATION_BASED_HEADERS.has(name.toLowerCase())) {
      headers.append(name, rewriteLocationBasedHeader(value, request, apiBase, options));
      return;
    }
    headers.append(name, value);
  });
  copySetCookieHeaders(upstream.headers, headers, request, apiBase, options);
  sanitizeExposeHeaders(headers);
  return headers;
}

function buildUpstreamErrorResponse(
  status: number,
  error: string,
  message: string,
  referenceId: string,
): Response {
  return new Response(JSON.stringify({ error, message, referenceId }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": referenceId,
    },
  });
}

function requestReference(request: NextRequest): string {
  const incoming = request.headers.get("x-request-id")?.trim();
  return incoming ? incoming.slice(0, 128) : crypto.randomUUID();
}

function createUpstreamAbort(clientSignal: AbortSignal, deadlineMs: number): UpstreamAbort {
  const controller = new AbortController();
  let abortCause: UpstreamAbortCause | null = null;
  let cleanedUp = false;
  let deadline: ReturnType<typeof setTimeout> | null = null;

  const abortForClient = () => abort("client");
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (deadline !== null) {
      clearTimeout(deadline);
    }
    clientSignal.removeEventListener("abort", abortForClient);
  };

  function abort(cause: UpstreamAbortCause) {
    if (controller.signal.aborted) return;
    abortCause = cause;
    controller.abort(cause === "client" ? clientSignal.reason : undefined);
    cleanup();
  }

  if (clientSignal.aborted) {
    abortForClient();
  } else {
    clientSignal.addEventListener("abort", abortForClient, { once: true });
    deadline = setTimeout(() => abort("deadline"), deadlineMs);
  }

  return {
    signal: controller.signal,
    cause: () => abortCause,
    abort,
    cleanup,
  };
}

function streamUpstreamBody(
  upstreamBody: ReadableStream<Uint8Array>,
  upstreamAbort: UpstreamAbort,
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          upstreamAbort.cleanup();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        upstreamAbort.cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      upstreamAbort.abort("downstream");
      upstreamAbort.cleanup();
      await reader.cancel(reason);
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

async function readRequestBody(request: NextRequest): Promise<Blob | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  // Forward a Blob, never an ArrayBuffer or a view: Next 16's patched fetch
  // hands buffer-backed bodies to undici with their backing ArrayBuffer
  // detached — even a fresh copy — so every proxied write threw "Cannot
  // perform ArrayBuffer.prototype.slice on a detached ArrayBuffer" while
  // GETs (null body) kept working. A Blob owns its bytes and survives the hop.
  return request.blob();
}

export async function proxyUpstream(
  request: NextRequest,
  segments: string[] = [],
  options: ProxyOptions,
): Promise<Response> {
  const startedAtMs = Date.now();
  const referenceId = requestReference(request);
  const apiBase = readBaseUrlEnv(process.env, "DEN_API_BASE");
  if (!apiBase) {
    denWebLogger.error("den-web upstream proxy misconfigured", {
      route_prefix: options.routePrefix,
      method: request.method,
      duration_ms: elapsedMs(startedAtMs),
      missing: "DEN_API_BASE",
    });
    return new Response(JSON.stringify({ error: "DEN_API_BASE must be configured." }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
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
  const requestHeaders = await cloneRequestHeaders(
    request,
    options.routePrefix,
    referenceId,
    instanceOrigin !== null,
  );
  const requestBody = await readRequestBody(request);
  const upstreamAbort = createUpstreamAbort(
    request.signal,
    options.upstreamDeadlineMs ?? UPSTREAM_DEADLINE_MS,
  );
  let streamsResponse = false;
  let upstream: Response;
  try {
    try {
      upstream = await fetch(targetUrl, {
        method: request.method,
        headers: requestHeaders,
        body: requestBody,
        redirect: "manual",
        signal: upstreamAbort.signal,
      });
    } catch (error) {
      const cause = upstreamAbort.cause();
      if (cause === "client") {
        throw error;
      }

      const timedOut = cause === "deadline";
      denWebLogger.error(timedOut ? "den-web upstream proxy timed out" : "den-web upstream proxy failed", {
        route_prefix: options.routePrefix,
        method: request.method,
        upstream_origin: upstreamOrigin(apiBase),
        upstream_path: `/${[normalizePathPrefix(options.upstreamPathPrefix ?? ""), targetPath].filter(Boolean).join("/")}`,
        duration_ms: elapsedMs(startedAtMs),
        error_name: errorName(error),
        request_id: referenceId,
      });
      return buildUpstreamErrorResponse(
        timedOut ? 504 : 502,
        timedOut ? "upstream_timeout" : "upstream_unreachable",
        timedOut
          ? "The upstream service did not respond before the deadline."
          : "The upstream service could not be reached.",
        referenceId,
      );
    }

    denWebLogger.log(upstream.ok ? "info" : "warn", "den-web upstream proxy completed", {
      route_prefix: options.routePrefix,
      method: request.method,
      upstream_origin: upstreamOrigin(apiBase),
      upstream_path: `/${[normalizePathPrefix(options.upstreamPathPrefix ?? ""), targetPath].filter(Boolean).join("/")}`,
      status: upstream.status,
      duration_ms: elapsedMs(startedAtMs),
      request_id: referenceId,
    });

    const shouldDropBody = request.method === "HEAD" || NO_BODY_STATUS.has(upstream.status);
    const responseHeaders = cloneResponseHeaders(request, upstream, options, apiBase);
    if (instanceOrigin) {
      applyCloudInstanceCorsHeaders(responseHeaders, instanceOrigin);
    }

    const responseBody = shouldDropBody || !upstream.body
      ? null
      : streamUpstreamBody(upstream.body, upstreamAbort);
    streamsResponse = responseBody !== null;
    return new Response(responseBody, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } finally {
    if (!streamsResponse) {
      upstreamAbort.cleanup();
    }
  }
}
