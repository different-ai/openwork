import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import {
  getOpenWorkWebRuntimeAccess,
  openWorkWebAccessRequiredPayload,
  type OpenWorkWebRuntimeAccessResolver,
} from "../openwork-web-runtime-access.js"
import { resolveCloudRuntimeAccess } from "./worker-access.js"

type WorkerId = typeof WorkerTable.$inferSelect.id
type OrganizationId = typeof WorkerTable.$inferSelect.org_id
type WorkerTokenScope = "client" | "host"
type WorkerAuthorization = {
  organizationId: OrganizationId
  scope: WorkerTokenScope
}

type AuthenticateWorkerRequest = (input: {
  request: Request
  workerId: WorkerId
}) => Promise<WorkerAuthorization | null>

type ResolveCloudAccess = typeof resolveCloudRuntimeAccess

export type CloudWorkerCompatibilityOptions = {
  authenticate?: AuthenticateWorkerRequest
  getOpenWorkWebAccess?: OpenWorkWebRuntimeAccessResolver
  resolveCloudAccess?: ResolveCloudAccess
  fetchImpl?: typeof fetch
  maxActiveRequestsPerWorker?: number
}

const DEFAULT_MAX_ACTIVE_REQUESTS_PER_WORKER = 16
const activeRequestsByWorker = new Map<WorkerId, number>()

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])
const REQUEST_HEADERS_TO_STRIP = new Set([
  "accept-encoding",
  "authorization",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "origin",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-prefix",
  "x-forwarded-proto",
  "x-openwork-host-token",
  "x-real-ip",
])
const RESPONSE_HEADERS_TO_STRIP = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "content-encoding",
  "content-length",
  "content-location",
  "link",
  "location",
  "refresh",
  "set-cookie",
])
const NO_BODY_STATUSES = new Set([204, 205, 304])

function readBearerToken(request: Request) {
  const authorization = request.headers.get("authorization")?.trim() ?? ""
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

function requestTokens(request: Request) {
  return Array.from(new Set([
    readBearerToken(request),
    request.headers.get("x-openwork-host-token")?.trim() || null,
  ].filter((value): value is string => Boolean(value))))
}

async function authenticateWorkerRequest(input: {
  request: Request
  workerId: WorkerId
}): Promise<WorkerAuthorization | null> {
  const tokens = requestTokens(input.request)
  if (tokens.length === 0) return null

  const rows = await db
    .select({
      organizationId: WorkerTable.org_id,
      scope: WorkerTokenTable.scope,
    })
    .from(WorkerTokenTable)
    .innerJoin(WorkerTable, eq(WorkerTable.id, WorkerTokenTable.worker_id))
    .where(and(
      eq(WorkerTokenTable.worker_id, input.workerId),
      inArray(WorkerTokenTable.token, tokens),
      isNull(WorkerTokenTable.revoked_at),
    ))
    .limit(tokens.length)

  const host = rows.find((row) => row.scope === "host")
  if (host) return { organizationId: host.organizationId, scope: "host" }
  const client = rows.find((row) => row.scope === "client")
  return client ? { organizationId: client.organizationId, scope: "client" } : null
}

function connectionNamedHeaders(headers: Headers) {
  return new Set((headers.get("connection") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))
}

function upstreamRequestHeaders(request: Request, authorization: WorkerAuthorization, access: {
  clientToken: string
  hostToken: string
}) {
  const headers = new Headers()
  const connectionHeaders = connectionNamedHeaders(request.headers)
  request.headers.forEach((value, name) => {
    const normalized = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(normalized) || connectionHeaders.has(normalized) || REQUEST_HEADERS_TO_STRIP.has(normalized)) return
    headers.append(name, value)
  })
  headers.set("Authorization", `Bearer ${access.clientToken}`)
  if (authorization.scope === "host") {
    headers.set("X-OpenWork-Host-Token", access.hostToken)
  }
  return headers
}

function downstreamResponseHeaders(upstream: Response) {
  const headers = new Headers()
  const connectionHeaders = connectionNamedHeaders(upstream.headers)
  upstream.headers.forEach((value, name) => {
    const normalized = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(normalized) || connectionHeaders.has(normalized) || RESPONSE_HEADERS_TO_STRIP.has(normalized)) return
    headers.append(name, value)
  })
  headers.set("Cache-Control", "no-store")
  headers.set("Pragma", "no-cache")
  return headers
}

function jsonError(
  status: 401 | 429 | 502 | 503,
  error: "too_many_requests" | "unauthorized" | "worker_runtime_proxy_failed" | "worker_runtime_unavailable",
  headers: HeadersInit = {},
) {
  return Response.json({ error }, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...headers,
    },
  })
}

function openWorkWebAccessRequiredResponse() {
  return Response.json(openWorkWebAccessRequiredPayload(), {
    status: 403,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  })
}

function acquireWorkerRequest(workerId: WorkerId, maximum: number) {
  const active = activeRequestsByWorker.get(workerId) ?? 0
  if (active >= maximum) return null
  activeRequestsByWorker.set(workerId, active + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (activeRequestsByWorker.get(workerId) ?? 1) - 1
    if (remaining > 0) activeRequestsByWorker.set(workerId, remaining)
    else activeRequestsByWorker.delete(workerId)
  }
}

function releaseOnStreamCompletion(body: ReadableStream<Uint8Array>, release: () => void) {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(chunk.value)
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        release()
      }
    },
  })
}

function proxiedPath(request: Request, workerId: WorkerId) {
  const pathname = new URL(request.url).pathname
  const marker = `/v1/cloud/workers/${encodeURIComponent(workerId)}`
  const markerIndex = pathname.lastIndexOf(marker)
  if (markerIndex < 0) return null
  const path = pathname.slice(markerIndex + marker.length)
  if (path && !path.startsWith("/")) return null
  return path || "/"
}

function upstreamUrl(previewUrl: string, request: Request, workerId: WorkerId) {
  const path = proxiedPath(request, workerId)
  if (!path) return null

  let target: URL
  try {
    target = new URL(previewUrl)
  } catch {
    return null
  }
  if ((target.protocol !== "https:" && target.protocol !== "http:") || target.username || target.password) return null

  target.pathname = `${target.pathname.replace(/\/+$/, "")}${path}`
  target.search = new URL(request.url).search
  target.hash = ""
  return target
}

function isReadMethod(method: string) {
  return method === "GET" || method === "HEAD"
}

export async function proxyCloudWorkerCompatibilityRequest(input: {
  request: Request
  workerId: WorkerId
}, options: CloudWorkerCompatibilityOptions = {}) {
  const authenticate = options.authenticate ?? authenticateWorkerRequest
  const authorization = await authenticate(input)
  if (!authorization || (!isReadMethod(input.request.method.toUpperCase()) && authorization.scope !== "host")) {
    return jsonError(401, "unauthorized")
  }

  // The stable /v1/cloud/workers/:id URL, token handling, and response shape are
  // unchanged. Published desktops connect here only after OpenWorkWebAccessGate
  // (v0.18.42+) granted Web access; the recheck terminates a worker token into a
  // live VM, so it enforces the same entitlement as provisioning and tokens.
  let webAccess
  try {
    webAccess = await (options.getOpenWorkWebAccess ?? getOpenWorkWebRuntimeAccess)(authorization.organizationId)
  } catch {
    return jsonError(503, "worker_runtime_unavailable")
  }
  if (!webAccess.hasAccess) return openWorkWebAccessRequiredResponse()

  const maximum = Math.max(1, options.maxActiveRequestsPerWorker ?? DEFAULT_MAX_ACTIVE_REQUESTS_PER_WORKER)
  const release = acquireWorkerRequest(input.workerId, maximum)
  if (!release) return jsonError(429, "too_many_requests", { "Retry-After": "1" })

  let releaseWithResponseBody = false
  try {
    const method = input.request.method.toUpperCase()

    let access: Awaited<ReturnType<ResolveCloudAccess>>
    try {
      access = await (options.resolveCloudAccess ?? resolveCloudRuntimeAccess)({
        organizationId: authorization.organizationId,
        workerId: input.workerId,
      })
    } catch {
      return jsonError(503, "worker_runtime_unavailable")
    }
    if (access.status !== "ready") return jsonError(503, "worker_runtime_unavailable")

    const target = upstreamUrl(access.url, input.request, input.workerId)
    if (!target) return jsonError(502, "worker_runtime_proxy_failed")

    let upstream: Response
    try {
      const requestBody = isReadMethod(method) ? null : input.request.body
      const baseInit: RequestInit = {
        method,
        headers: upstreamRequestHeaders(input.request, authorization, access),
        cache: "no-store",
        redirect: "error",
        signal: input.request.signal,
      }
      const requestInit: RequestInit | (RequestInit & { duplex: "half" }) = requestBody
        ? { ...baseInit, body: requestBody, duplex: "half" }
        : baseInit
      upstream = await (options.fetchImpl ?? fetch)(target, requestInit)
    } catch {
      return jsonError(502, "worker_runtime_proxy_failed")
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => undefined)
      return jsonError(502, "worker_runtime_proxy_failed")
    }

    const responseBody = method === "HEAD" || NO_BODY_STATUSES.has(upstream.status) ? null : upstream.body
    if (!responseBody) await upstream.body?.cancel().catch(() => undefined)
    const downstreamBody = responseBody ? releaseOnStreamCompletion(responseBody, release) : null
    releaseWithResponseBody = downstreamBody !== null
    return new Response(downstreamBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: downstreamResponseHeaders(upstream),
    })
  } finally {
    if (!releaseWithResponseBody) release()
  }
}
