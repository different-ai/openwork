import {
  CONNECT_DEBUG_PROXY_KEY_HEADER,
  accessKeyMatches,
  allowedUpstreamOverride,
  connectDebugProxyConfig,
} from "./connect-debug-proxy-config"
import {
  connectDebugProxyBrowserRouteCookie,
  readConnectDebugProxyBrowserRoute,
} from "./connect-debug-proxy-browser-route"
import { connectDebugProxyFault } from "./connect-debug-proxy-faults"
import { recordConnectDebugProxyRequest } from "./connect-debug-proxy-log"
import { buildConnectDebugProxyResponse, forwardRequestHeaders } from "./connect-debug-proxy-rewrite"
import { parseConnectDebugProxyScenario } from "./connect-debug-proxy-scenarios"
import { requestUsesMcpMethod } from "./connect-debug-proxy-tamper"

export type ConnectDebugProxyDependencies = {
  fetchImpl?: typeof fetch
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}

function errorResponse(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { headers: { "cache-control": "no-store" }, status })
}

function encodedSegment(value: string): string {
  return encodeURIComponent(value)
}

function targetPath(segments: readonly string[]): string {
  return segments.length > 0 ? `/${segments.map(encodedSegment).join("/")}` : "/"
}

async function requestBody(request: Request): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined
  const body = new Uint8Array(await request.arrayBuffer())
  return body.byteLength > 0 ? body : undefined
}

function logResult(input: {
  appliedFault: string
  method: string
  now: () => number
  pathname: string
  scenario: string
  startedAt: number
  status: number | null
}): void {
  recordConnectDebugProxyRequest({
    appliedFault: input.appliedFault,
    latencyMs: input.now() - input.startedAt,
    method: input.method,
    path: input.pathname,
    receivedAt: new Date(input.startedAt).toISOString(),
    scenario: input.scenario,
    status: input.status,
  })
}

export async function proxyConnectDebugRequest(input: {
  pathSegments: readonly string[]
  request: Request
  scenarioSlug: string
}, dependencies: ConnectDebugProxyDependencies = {}): Promise<Response> {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const now = dependencies.now ?? Date.now
  const wait = dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const startedAt = now()
  const config = connectDebugProxyConfig()
  if (config.errors.length > 0) return errorResponse(503, "connect_debug_proxy_not_configured", config.errors.join(", "))
  const scenario = parseConnectDebugProxyScenario(input.scenarioSlug)
  if (!scenario) return errorResponse(404, "unknown_debug_proxy_scenario", "The requested Connect debug proxy scenario does not exist.")

  const segments = [...input.pathSegments]
  const pathKey = accessKeyMatches(segments[0], config.accessKey) ? segments.shift() ?? null : null
  const headerKey = input.request.headers.get(CONNECT_DEBUG_PROXY_KEY_HEADER)
  if (!pathKey && !accessKeyMatches(headerKey, config.accessKey)) {
    return errorResponse(401, "connect_debug_proxy_access_required", `Supply the access key as the first path segment or ${CONNECT_DEBUG_PROXY_KEY_HEADER} header.`)
  }

  const overrideParameter = segments[0]?.startsWith("~") ? segments.shift() ?? null : null
  const upstreamOrigin = overrideParameter ? allowedUpstreamOverride(overrideParameter, config) : config.defaultUpstream
  if (!upstreamOrigin) return errorResponse(403, "debug_proxy_upstream_not_allowed", "The encoded upstream is not on DEBUG_PROXY_ALLOWED_UPSTREAMS.")

  const requestUrl = new URL(input.request.url)
  const pathname = targetPath(segments)
  const upstreamUrl = new URL(pathname, upstreamOrigin)
  upstreamUrl.search = requestUrl.search
  const baseSegments = ["via", scenario.slug]
  if (pathKey) baseSegments.push(pathKey)
  if (overrideParameter) baseSegments.push(overrideParameter)
  const proxyBase = `${requestUrl.origin}/${baseSegments.map(encodedSegment).join("/")}`
  const browserRoute = Boolean(pathKey) && (
    input.request.headers.get("accept")?.toLowerCase().includes("text/html")
    || readConnectDebugProxyBrowserRoute(input.request.headers.get("cookie")) === new URL(proxyBase).pathname
  )
  const body = await requestBody(input.request)
  let fault = connectDebugProxyFault({
    flakyKey: `${scenario.slug}:${upstreamOrigin}:${pathname}`,
    flakyWindowMs: config.flakyWindowMs,
    now: startedAt,
    pathname,
    requestBody: body,
    scenario,
    slowMs: config.slowMs,
  })
  if (fault?.kind === "tamper"
    && ((fault.mode === "missing-tools" && !requestUsesMcpMethod(body, "tools/list"))
      || (fault.mode === "bad-protocol" && !requestUsesMcpMethod(body, "initialize")))) {
    fault = null
  }
  if (fault?.kind === "response") {
    logResult({ appliedFault: fault.label, method: input.request.method, now, pathname, scenario: scenario.slug, startedAt, status: fault.response.status })
    return fault.response
  }
  if (fault?.kind === "hang") {
    logResult({ appliedFault: fault.label, method: input.request.method, now, pathname, scenario: scenario.slug, startedAt, status: null })
    return new Promise<Response>(() => undefined)
  }
  if (fault?.kind === "delay") await wait(fault.milliseconds)

  let upstream: Response
  try {
    upstream = await fetchImpl(upstreamUrl, {
      body,
      headers: forwardRequestHeaders(input.request.headers, { proxyBase, upstreamOrigin }),
      method: input.request.method,
      redirect: "manual",
    })
  } catch {
    const response = errorResponse(502, "debug_proxy_upstream_fetch_failed", "The Connect debug proxy could not reach its configured upstream.")
    logResult({ appliedFault: fault?.label ?? "upstream-fetch-failed", method: input.request.method, now, pathname, scenario: scenario.slug, startedAt, status: response.status })
    return response
  }

  const response = await buildConnectDebugProxyResponse({
    browserRoute,
    proxyBase,
    tamperMode: fault?.kind === "tamper" ? fault.mode : null,
    upstream,
    upstreamRequestUrl: upstreamUrl,
  })
  if (browserRoute) response.headers.append("set-cookie", connectDebugProxyBrowserRouteCookie(proxyBase))
  logResult({ appliedFault: fault?.label ?? "none", method: input.request.method, now, pathname, scenario: scenario.slug, startedAt, status: response.status })
  return response
}
