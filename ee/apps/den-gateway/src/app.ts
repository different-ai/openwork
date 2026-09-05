import "./load-env.js"
import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"
import { createJsonStdoutLogger, type JsonObject, type JsonStdoutLogger } from "@openwork-ee/utils/observability"
import { Hono } from "hono"
import { env } from "./env.js"
import { createInstanceFetch, fetchWithConnectRetry, type FetchLike } from "./instance-fetch.js"

type InstanceStatus = "provisioning" | "waking" | "ready" | "failed"
type NonReadyStatus = "provisioning" | "waking" | "failed"
type StartupFailure = {
  code: string
  stage: "provisioning" | "recovery" | "runtime"
  reference: string
  occurredAt: string
}

type ResolvePayload = {
  status: InstanceStatus
  url: string | null
  clientToken: string | null
  hostToken: string | null
  expiresAt: string | null
  failure?: StartupFailure
}

type InstanceResolution =
  | { kind: "ready"; url: string; clientToken: string; hostToken: string; expiresAtMs: number }
  | { kind: "not_ready"; status: NonReadyStatus; failure?: StartupFailure }
  | { kind: "error"; statusCode: number; error: string }

type ReadyCacheEntry = {
  resolution: Extract<InstanceResolution, { kind: "ready" }>
  expiresAtMs: number
}

export type GatewayAppOptions = {
  webRoot?: string
  denApiBase?: string
  gatewayKey?: string
  buildVersion?: string
  resolveTtlMs?: number
  now?: () => number
  fetchImpl?: typeof fetch
  instanceFetch?: FetchLike
  logger?: JsonStdoutLogger
  logRequests?: boolean
}

type GatewayConfig = {
  webRoot?: string
  denApiBase: string
  gatewayKey?: string
  buildVersion?: string
  resolveTtlMs: number
  now: () => number
  fetchImpl: typeof fetch
  instanceFetch: FetchLike
  logger: JsonStdoutLogger
  logRequests: boolean
}

const ASSET_CACHE = "public, max-age=31536000, immutable"
const INDEX_CACHE = "no-cache"
const gatewayKeyHeader = "X-OpenWork-Gateway-Key"
const resolvePath = "/v1/cloud/gateway/resolve"
const denApiRoutePrefix = "/api/den"
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])
const spoofableForwardingHeaders = new Set(["forwarded", "x-forwarded-host", "x-forwarded-prefix", "x-forwarded-proto"])
const proxyPathNamespaces = [
  "/health",
  "/status",
  "/capabilities",
  "/whoami",
  "/workspaces",
  "/tokens",
  "/env",
  "/approvals",
  "/files",
]
const alwaysProxyPathPrefixes = [
  "/opencode/",
  "/w/",
  "/runtime/",
  "/experimental/",
  "/voice/",
]
const workspacePathPrefix = "/workspace/"
const defaultLogger = createJsonStdoutLogger({ serviceName: "den-gateway" })

function createLazyInstanceFetch(connectTimeoutMs: number): FetchLike {
  let instanceFetch: FetchLike | undefined
  return (url, init) => {
    instanceFetch ??= createInstanceFetch({ connectTimeoutMs })
    return instanceFetch(url, init)
  }
}

class GatewayHttpError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "GatewayHttpError"
    this.status = status
    this.code = code
  }
}

function normalizeHttpBaseUrl(value: string) {
  return value.replace(/\/+$/, "")
}

function createConfig(options: GatewayAppOptions): GatewayConfig {
  return {
    webRoot: options.webRoot ?? env.webRoot,
    denApiBase: normalizeHttpBaseUrl(options.denApiBase ?? env.denApiBase),
    gatewayKey: options.gatewayKey ?? env.gatewayKey,
    buildVersion: options.buildVersion ?? env.buildVersion,
    resolveTtlMs: options.resolveTtlMs ?? env.resolveTtlMs,
    now: options.now ?? Date.now,
    fetchImpl: options.fetchImpl ?? fetch,
    instanceFetch: options.instanceFetch ?? options.fetchImpl ?? createLazyInstanceFetch(env.upstreamConnectTimeoutMs),
    logger: options.logger ?? defaultLogger,
    logRequests: options.logRequests ?? env.logRequests,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readStatus(value: unknown): InstanceStatus | null {
  if (value === "provisioning" || value === "waking" || value === "ready" || value === "failed") {
    return value
  }
  return null
}

function readStartupFailure(value: unknown): StartupFailure | null {
  if (!isRecord(value)) return null
  const code = typeof value.code === "string" ? value.code.trim() : ""
  const stage = value.stage
  const reference = typeof value.reference === "string" ? value.reference.trim() : ""
  const occurredAt = typeof value.occurredAt === "string" ? value.occurredAt : ""
  if (!code || !reference || !Number.isFinite(Date.parse(occurredAt))) return null
  if (stage !== "provisioning" && stage !== "recovery" && stage !== "runtime") return null
  return { code, stage, reference, occurredAt }
}

function readResolvePayload(value: unknown): ResolvePayload | null {
  if (!isRecord(value)) {
    return null
  }

  const status = readStatus(value.status)
  const url = typeof value.url === "string" ? value.url : value.url === null ? null : undefined
  const clientToken = typeof value.clientToken === "string" ? value.clientToken : value.clientToken === null ? null : undefined
  const hostToken = typeof value.hostToken === "string" ? value.hostToken : value.hostToken === null ? null : undefined
  const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : value.expiresAt === null ? null : undefined
  if (!status || url === undefined || clientToken === undefined || hostToken === undefined || expiresAt === undefined) {
    return null
  }

  const failure = readStartupFailure(value.failure)
  return { status, url, clientToken, hostToken, expiresAt, ...(failure ? { failure } : {}) }
}

function isUsableUpstreamUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function parseResolvedInstance(payload: ResolvePayload, now: number): InstanceResolution {
  if (payload.status !== "ready") {
    return { kind: "not_ready", status: payload.status, ...(payload.failure ? { failure: payload.failure } : {}) }
  }

  const expiresAtMs = payload.expiresAt ? Date.parse(payload.expiresAt) : Number.NaN
  if (!payload.url || !payload.clientToken || !payload.hostToken || !isUsableUpstreamUrl(payload.url) || !Number.isFinite(expiresAtMs)) {
    return { kind: "error", statusCode: 502, error: "gateway_resolve_invalid_ready_instance" }
  }
  if (expiresAtMs <= now) return { kind: "error", statusCode: 503, error: "gateway_resolve_expired_ready_instance" }

  return { kind: "ready", url: payload.url, clientToken: payload.clientToken, hostToken: payload.hostToken, expiresAtMs }
}

function readBearerAuthorization(headers: Headers) {
  const authorization = headers.get("authorization")?.trim()
  if (!authorization) {
    return null
  }

  const separator = authorization.indexOf(" ")
  if (separator < 0) {
    return null
  }

  const scheme = authorization.slice(0, separator).toLowerCase()
  const token = authorization.slice(separator + 1).trim()
  if (scheme !== "bearer" || !token) {
    return null
  }

  return `Bearer ${token}`
}

function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12)
}

function matchesPathNamespace(pathname: string, namespace: string) {
  return pathname === namespace || pathname.startsWith(`${namespace}/`)
}

function isDocumentNavigation(request: Request) {
  if (request.headers.get("sec-fetch-mode")?.toLowerCase() === "navigate") {
    return true
  }

  const method = request.method.toUpperCase()
  if (method !== "GET" && method !== "HEAD") {
    return false
  }

  const accept = request.headers.get("accept")?.toLowerCase()
  return Boolean(accept?.includes("text/html") && !accept.includes("application/json") && !accept.includes("text/event-stream"))
}

export function shouldProxyToInstance(request: Request) {
  const pathname = new URL(request.url).pathname
  if (proxyPathNamespaces.some((namespace) => matchesPathNamespace(pathname, namespace))) {
    return true
  }
  if (alwaysProxyPathPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return true
  }

  // /workspace/ is ambiguous: openwork-server owns API routes here, while the
  // BrowserRouter SPA owns reloadable session/settings deep links under it.
  return pathname.startsWith(workspacePathPrefix) && !isDocumentNavigation(request)
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

function notFoundResponse() {
  return jsonResponse({ error: "not_found" }, 404)
}

function gatewayErrorResponse(error: GatewayHttpError) {
  return jsonResponse({ error: error.code, message: error.message }, error.status)
}

function requestPathToRelativePath(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname)
    return decoded.replace(/^\/+/, "") || "index.html"
  } catch {
    return null
  }
}

async function resolveWithinRoot(root: string, ...segments: string[]) {
  const resolvedRoot = await realpath(root)
  const candidate = resolve(resolvedRoot, ...segments)
  const resolvedCandidate = await realpath(candidate).catch(() => candidate)
  if (resolvedCandidate === resolvedRoot) {
    return candidate
  }
  if (!resolvedCandidate.startsWith(resolvedRoot + sep)) {
    throw new GatewayHttpError(400, "path_escape", "Path escapes web root")
  }
  return candidate
}

function contentType(extension: string) {
  if (extension === ".html") {
    return "text/html; charset=utf-8"
  }
  if (extension === ".js" || extension === ".mjs") {
    return "text/javascript; charset=utf-8"
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8"
  }
  if (extension === ".json" || extension === ".map") {
    return "application/json; charset=utf-8"
  }
  if (extension === ".svg") {
    return "image/svg+xml; charset=utf-8"
  }
  if (extension === ".png") {
    return "image/png"
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg"
  }
  if (extension === ".webp") {
    return "image/webp"
  }
  if (extension === ".ico") {
    return "image/x-icon"
  }
  if (extension === ".woff") {
    return "font/woff"
  }
  if (extension === ".woff2") {
    return "font/woff2"
  }
  if (extension === ".ttf") {
    return "font/ttf"
  }
  return "application/octet-stream"
}

function isTextExtension(extension: string) {
  return extension === ".html" || extension === ".js" || extension === ".mjs" || extension === ".css" ||
    extension === ".json" || extension === ".svg" || extension === ".map"
}

function responseHeaders(extension: string, cacheControl: string) {
  return new Headers({
    "Cache-Control": cacheControl,
    "Content-Type": contentType(extension),
  })
}

function escapeScriptJson(json: string) {
  return json.replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

function injectGatewayMarker(html: string, buildVersion: string | undefined) {
  const gatewayMarker = { version: 1, ...(buildVersion ? { build: buildVersion } : {}) }
  const marker = escapeScriptJson(JSON.stringify(gatewayMarker))
  const script = `<script>window.__OPENWORK_GATEWAY__ = ${marker}</script>`
  const headCloseIndex = html.toLowerCase().indexOf("</head>")
  if (headCloseIndex < 0) {
    return `${script}${html}`
  }
  return `${html.slice(0, headCloseIndex)}${script}${html.slice(headCloseIndex)}`
}

async function serveFile(root: string, relativePath: string, requestPathname: string, method: string, buildVersion: string | undefined) {
  const filePath = await resolveWithinRoot(root, relativePath)
  const fileStat = await stat(filePath).catch(() => null)
  if (!fileStat?.isFile()) {
    return null
  }

  const extension = extname(relativePath).toLowerCase()
  const cacheControl = requestPathname.startsWith("/assets/") ? ASSET_CACHE : INDEX_CACHE
  const headers = responseHeaders(extension, cacheControl)
  if (method === "HEAD") {
    return new Response(null, { status: 200, headers })
  }

  if (isTextExtension(extension)) {
    const body = await readFile(filePath, "utf8")
    const text = relativePath === "index.html" ? injectGatewayMarker(body, buildVersion) : body
    return new Response(text, { status: 200, headers })
  }

  const bytes = await readFile(filePath)
  return new Response(new Uint8Array(bytes), { status: 200, headers })
}

async function serveStatic(request: Request, webRoot: string | undefined, buildVersion: string | undefined) {
  if (!webRoot) {
    return null
  }

  const method = request.method.toUpperCase()
  if (method !== "GET" && method !== "HEAD") {
    return null
  }

  const url = new URL(request.url)
  const relativePath = requestPathToRelativePath(url.pathname)
  if (!relativePath) {
    return jsonResponse({ error: "invalid_path", message: "Invalid URL path" }, 400)
  }

  try {
    const file = await serveFile(webRoot, relativePath, url.pathname, method, buildVersion)
    if (file) {
      return file
    }
    if (url.pathname.startsWith("/assets/")) {
      return notFoundResponse()
    }
    return await serveFile(webRoot, "index.html", "/index.html", method, buildVersion) ?? notFoundResponse()
  } catch (error) {
    if (error instanceof GatewayHttpError) {
      return gatewayErrorResponse(error)
    }
    throw error
  }
}

function buildResolveUrl(denApiBase: string) {
  return `${denApiBase}${resolvePath}`
}

async function resolveFromDenApi(config: GatewayConfig, bearer: string): Promise<InstanceResolution> {
  if (!config.gatewayKey) {
    return { kind: "error", statusCode: 503, error: "gateway_not_configured" }
  }

  let response: Response
  try {
    response = await config.fetchImpl(buildResolveUrl(config.denApiBase), {
      method: "GET",
      headers: {
        Authorization: bearer,
        [gatewayKeyHeader]: config.gatewayKey,
      },
      redirect: "manual",
    })
  } catch {
    return { kind: "error", statusCode: 502, error: "gateway_resolve_failed" }
  }

  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }

  if (!response.ok) {
    return { kind: "error", statusCode: response.status, error: "gateway_resolve_rejected" }
  }

  const payload = readResolvePayload(parsed)
  if (!payload) {
    return { kind: "error", statusCode: 502, error: "gateway_resolve_invalid_response" }
  }

  return parseResolvedInstance(payload, config.now())
}

async function resolveInstance(input: {
  config: GatewayConfig
  cache: Map<string, ReadyCacheEntry>
  bearer: string
}) {
  const cached = input.cache.get(input.bearer)
  const now = input.config.now()
  if (cached && cached.expiresAtMs > now) {
    return cached.resolution
  }

  if (cached) {
    input.cache.delete(input.bearer)
  }

  const resolution = await resolveFromDenApi(input.config, input.bearer)
  if (resolution.kind === "ready") {
    input.cache.set(input.bearer, {
      resolution,
      expiresAtMs: Math.min(now + input.config.resolveTtlMs, resolution.expiresAtMs),
    })
  }
  return resolution
}

function buildProxyUrl(baseUrl: string, requestUrl: string) {
  const current = new URL(requestUrl)
  const target = new URL(baseUrl)
  const basePath = target.pathname.replace(/\/+$/, "")
  target.pathname = `${basePath}${current.pathname}` || "/"
  if (target.search && current.search) {
    target.search = `${target.search}&${current.search.slice(1)}`
  } else if (current.search) {
    target.search = current.search
  }
  return target.toString()
}

function denApiProxyPath(pathname: string) {
  if (pathname === denApiRoutePrefix) {
    return ""
  }
  if (pathname.startsWith(`${denApiRoutePrefix}/`)) {
    return pathname.slice(denApiRoutePrefix.length)
  }
  return pathname
}

function buildDenApiProxyUrl(denApiBase: string, requestUrl: string) {
  const current = new URL(requestUrl)
  const target = new URL(denApiBase)
  const basePath = target.pathname.replace(/\/+$/, "")
  const proxyPath = denApiProxyPath(current.pathname)
  target.pathname = `${basePath}${proxyPath}` || "/"
  target.search = current.search
  return target.toString()
}

async function requestBody(request: Request) {
  const method = request.method.toUpperCase()
  if (method === "GET" || method === "HEAD") {
    return undefined
  }

  const body = await request.arrayBuffer()
  return body.byteLength > 0 ? body : undefined
}

function upstreamRequestHeaders(headers: Headers, clientToken: string, hostToken: string) {
  const upstream = new Headers(headers)
  upstream.delete("authorization")
  upstream.delete("x-openwork-host-token")
  upstream.delete("cookie")
  upstream.delete("host")
  upstream.delete("connection")
  upstream.delete("content-length")
  upstream.delete("transfer-encoding")
  upstream.delete(gatewayKeyHeader)
  upstream.set("Authorization", `Bearer ${clientToken}`)
  upstream.set("x-openwork-host-token", hostToken)
  return upstream
}

function denApiRequestHeaders(request: Request) {
  const upstream = new Headers()
  request.headers.forEach((value, name) => {
    const normalized = name.toLowerCase()
    if (hopByHopHeaders.has(normalized)) return
    if (normalized === "host" || normalized === "content-length" || normalized === "cookie") return
    if (spoofableForwardingHeaders.has(normalized)) return
    if (normalized === gatewayKeyHeader.toLowerCase()) return
    if (normalized === "x-openwork-host-token") return
    upstream.append(name, value)
  })

  const url = new URL(request.url)
  upstream.set("x-forwarded-host", url.host)
  upstream.set("x-forwarded-proto", url.protocol.replace(/:$/, ""))
  upstream.set("x-forwarded-prefix", denApiRoutePrefix)
  return upstream
}

function sanitizeProxyResponse(response: Response) {
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("transfer-encoding")
  headers.delete("content-length")
  headers.delete("location")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function sanitizeDenApiResponse(response: Response) {
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("transfer-encoding")
  headers.delete("content-length")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function proxyToDenApi(input: {
  config: GatewayConfig
  request: Request
}) {
  let response: Response
  try {
    response = await input.config.fetchImpl(buildDenApiProxyUrl(input.config.denApiBase, input.request.url), {
      method: input.request.method,
      headers: denApiRequestHeaders(input.request),
      body: await requestBody(input.request),
      redirect: "manual",
    })
  } catch {
    return jsonResponse({ error: "gateway_den_api_failed" }, 502)
  }

  return sanitizeDenApiResponse(response)
}

async function proxyToInstance(input: {
  config: GatewayConfig
  request: Request
  resolution: Extract<InstanceResolution, { kind: "ready" }>
}) {
  let response: Response
  try {
    response = await fetchWithConnectRetry({
      fetchImpl: input.config.instanceFetch,
      url: buildProxyUrl(input.resolution.url, input.request.url),
      init: {
        method: input.request.method,
        headers: upstreamRequestHeaders(input.request.headers, input.resolution.clientToken, input.resolution.hostToken),
        body: await requestBody(input.request),
        redirect: "manual",
      },
    })
  } catch {
    return jsonResponse({ error: "gateway_upstream_failed" }, 502)
  }

  return sanitizeProxyResponse(response)
}

async function handleProxy(input: {
  config: GatewayConfig
  cache: Map<string, ReadyCacheEntry>
  request: Request
}) {
  const bearer = readBearerAuthorization(input.request.headers)
  if (!bearer) {
    return jsonResponse({ error: "unauthorized" }, 401)
  }

  const resolution = await resolveInstance({ config: input.config, cache: input.cache, bearer })
  if (resolution.kind === "not_ready") {
    const response = jsonResponse({
      error: "workspace_not_ready",
      status: resolution.status,
      ...(resolution.failure ? { failure: resolution.failure } : {}),
    }, 503)
    response.headers.set("Retry-After", "5")
    return response
  }
  if (resolution.kind === "error") {
    return jsonResponse({ error: resolution.error }, resolution.statusCode)
  }

  return proxyToInstance({ config: input.config, request: input.request, resolution })
}

function requestLogFields(request: Request, response: Response, startedAtMs: number): JsonObject {
  const url = new URL(request.url)
  const bearer = readBearerAuthorization(request.headers)
  return {
    method: request.method.toUpperCase(),
    path: url.pathname,
    status: response.status,
    duration_ms: Date.now() - startedAtMs,
    bearer_hash: bearer ? hashSecret(bearer) : undefined,
  }
}

function logResponse(config: GatewayConfig, request: Request, response: Response, startedAtMs: number) {
  if (!config.logRequests) {
    return
  }

  const fields = requestLogFields(request, response, startedAtMs)
  if (response.status >= 500) {
    config.logger.error("den-gateway request completed", fields)
    return
  }
  if (response.status >= 400) {
    config.logger.warn("den-gateway request completed", fields)
    return
  }
  config.logger.info("den-gateway request completed", fields)
}

export function createGatewayApp(options: GatewayAppOptions = {}) {
  const config = createConfig(options)
  const cache = new Map<string, ReadyCacheEntry>()
  const app = new Hono()

  app.use("*", async (c, next) => {
    const startedAtMs = Date.now()
    await next()
    if (c.req.path !== "/__gw/health" && c.req.path !== "/__gw/ready") {
      logResponse(config, c.req.raw, c.res, startedAtMs)
    }
  })

  app.get("/__gw/health", (c) => c.json({ ok: true, service: "den-gateway", ...(config.buildVersion ? { build: config.buildVersion } : {}) }))
  app.get("/__gw/ready", (c) => c.json({ ok: true, service: "den-gateway", ...(config.buildVersion ? { build: config.buildVersion } : {}) }))

  app.all(denApiRoutePrefix, (c) => proxyToDenApi({ config, request: c.req.raw }))
  app.all(`${denApiRoutePrefix}/*`, (c) => proxyToDenApi({ config, request: c.req.raw }))

  app.all("*", async (c) => {
    if (shouldProxyToInstance(c.req.raw)) {
      return handleProxy({ config, cache, request: c.req.raw })
    }

    return await serveStatic(c.req.raw, config.webRoot, config.buildVersion) ?? notFoundResponse()
  })

  return app
}

export default createGatewayApp()
