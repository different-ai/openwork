import "./load-env.js"
import { Daytona } from "@daytonaio/sdk"
import { Hono } from "hono"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { createDenDb, DaytonaSandboxTable, RateLimitTable, WorkerTokenTable } from "@openwork-ee/den-db"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "./env.js"

const { db } = createDenDb({
  databaseUrl: env.databaseUrl,
  mode: env.dbMode,
  planetscale: env.planetscale,
})
const app = new Hono()
const maxSignedPreviewExpirySeconds = 60 * 60 * 24
const signedPreviewRefreshLeadMs = 5 * 60 * 1000
const anonymousReadRateLimit = { windowMs: 60_000, max: 60 }
const authenticatedReadRateLimit = { windowMs: 60_000, max: 240 }
const authenticatedWriteRateLimit = { windowMs: 60_000, max: 60 }
const publicCorsAllowMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
const publicCorsAllowHeaders = [
  "Authorization",
  "Content-Type",
  "X-OpenWork-Host-Token",
  "X-OpenWork-Client-Id",
  "X-OpenCode-Directory",
  "X-Opencode-Directory",
  "x-opencode-directory",
]
type WorkerId = typeof DaytonaSandboxTable.$inferSelect.worker_id
type WorkerTokenScope = typeof WorkerTokenTable.$inferSelect.scope

const refreshPromises = new Map<WorkerId, Promise<string | null>>()

function assertDaytonaConfig() {
  if (!env.daytona.apiKey) {
    throw new Error("DAYTONA_API_KEY is required for worker proxy")
  }
}

function createDaytonaClient() {
  assertDaytonaConfig()
  return new Daytona({
    apiKey: env.daytona.apiKey,
    apiUrl: env.daytona.apiUrl,
    ...(env.daytona.target ? { target: env.daytona.target } : {}),
  })
}

function normalizedSignedPreviewExpirySeconds() {
  return Math.max(1, Math.min(env.daytona.signedPreviewExpiresSeconds, maxSignedPreviewExpirySeconds))
}

function signedPreviewRefreshAt(expiresInSeconds: number) {
  return new Date(Date.now() + Math.max(0, expiresInSeconds * 1000 - signedPreviewRefreshLeadMs))
}

function noCacheHeaders(headers: Headers) {
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
  headers.set("Pragma", "no-cache")
  headers.set("Expires", "0")
  headers.set("Surrogate-Control", "no-store")
}

function applyPublicCorsHeaders(headers: Headers, request: Request) {
  const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  const allowHeaders = Array.from(new Set([...publicCorsAllowHeaders, ...requestedHeaders]))

  headers.delete("Access-Control-Allow-Credentials")
  headers.set("Access-Control-Allow-Origin", "*")
  headers.set("Access-Control-Allow-Headers", allowHeaders.join(", "))
  headers.set("Access-Control-Allow-Methods", publicCorsAllowMethods.join(","))
  headers.set("Access-Control-Max-Age", "86400")
}

function stripProxyHeaders(input: Headers) {
  const headers = new Headers(input)
  headers.delete("host")
  headers.delete("content-length")
  headers.delete("connection")
  return headers
}

function readClientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  const realIp = request.headers.get("x-real-ip")?.trim()
  return forwarded || realIp || "unknown"
}

function readBearerToken(request: Request) {
  const header = request.headers.get("authorization")?.trim() ?? ""
  if (!header.toLowerCase().startsWith("bearer ")) {
    return null
  }
  const token = header.slice(7).trim()
  return token || null
}

async function consumeRateLimit(input: {
  key: string
  max: number
  windowMs: number
}) {
  const now = Date.now()
  const rows = await db
    .select({ count: RateLimitTable.count, lastRequest: RateLimitTable.lastRequest })
    .from(RateLimitTable)
    .where(eq(RateLimitTable.key, input.key))
    .limit(1)

  const current = rows[0] ?? null
  if (!current) {
    await db.insert(RateLimitTable).values({
      id: createDenTypeId("rateLimit"),
      key: input.key,
      count: 1,
      lastRequest: now,
    })
    return { allowed: true as const, retryAfterSeconds: 0 }
  }

  const elapsedMs = Math.max(0, now - current.lastRequest)
  if (elapsedMs >= input.windowMs) {
    await db
      .update(RateLimitTable)
      .set({ count: 1, lastRequest: now })
      .where(eq(RateLimitTable.key, input.key))
    return { allowed: true as const, retryAfterSeconds: 0 }
  }

  if (current.count >= input.max) {
    return {
      allowed: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((input.windowMs - elapsedMs) / 1000)),
    }
  }

  await db
    .update(RateLimitTable)
    .set({ count: current.count + 1, lastRequest: now })
    .where(eq(RateLimitTable.key, input.key))

  return { allowed: true as const, retryAfterSeconds: 0 }
}

async function resolveWorkerTokenScope(workerId: WorkerId, request: Request): Promise<WorkerTokenScope | "invalid" | null> {
  const hostToken = request.headers.get("x-openwork-host-token")?.trim() || null
  const bearerToken = readBearerToken(request)
  const candidateTokens: Array<{ token: string; requiredScope: WorkerTokenScope | null }> = []
  if (hostToken) {
    candidateTokens.push({ token: hostToken, requiredScope: "host" })
  }
  if (bearerToken) {
    candidateTokens.push({ token: bearerToken, requiredScope: null })
  }

  if (candidateTokens.length === 0) {
    return null
  }

  for (const candidate of candidateTokens) {
    const filters = [
      eq(WorkerTokenTable.worker_id, workerId),
      eq(WorkerTokenTable.token, candidate.token),
      isNull(WorkerTokenTable.revoked_at),
    ]
    if (candidate.requiredScope) {
      filters.push(eq(WorkerTokenTable.scope, candidate.requiredScope))
    }

    const rows = await db
      .select({ scope: WorkerTokenTable.scope })
      .from(WorkerTokenTable)
      .where(and(...filters))
      .limit(1)

    if (rows[0]?.scope) {
      return rows[0].scope
    }
  }

  return "invalid"
}

async function enforceProxyRateLimit(input: {
  workerId: WorkerId
  request: Request
  tokenScope: WorkerTokenScope | null
}) {
  const method = input.request.method.toUpperCase()
  const ip = readClientIp(input.request)
  const authState = input.tokenScope ?? "anonymous"
  const limit = method === "GET" || method === "HEAD"
    ? input.tokenScope
      ? authenticatedReadRateLimit
      : anonymousReadRateLimit
    : authenticatedWriteRateLimit

  return consumeRateLimit({
    key: `worker-proxy:${input.workerId}:${authState}:${method}:${ip}`,
    max: limit.max,
    windowMs: limit.windowMs,
  })
}

function targetUrl(baseUrl: string, requestUrl: string, workerId: WorkerId) {
  const current = new URL(requestUrl)
  const suffix = current.pathname.slice(`/${encodeURIComponent(workerId)}`.length) || "/"
  return `${baseUrl.replace(/\/+$/, "")}${suffix}${current.search}`
}

async function getSignedPreviewUrl(workerId: WorkerId) {
  const rows = await db
    .select()
    .from(DaytonaSandboxTable)
    .where(eq(DaytonaSandboxTable.worker_id, workerId))
    .limit(1)

  const record = rows[0] ?? null
  if (!record) {
    return null
  }

  if (record.signed_preview_url_expires_at.getTime() > Date.now()) {
    return record.signed_preview_url
  }

  const existingRefresh = refreshPromises.get(workerId)
  if (existingRefresh) {
    return existingRefresh
  }

  const refreshPromise = (async () => {
    const daytona = createDaytonaClient()
    const sandbox = await daytona.get(record.sandbox_id)
    await sandbox.refreshData()

    const expiresInSeconds = normalizedSignedPreviewExpirySeconds()
    const preview = await sandbox.getSignedPreviewUrl(env.daytona.openworkPort, expiresInSeconds)

    await db
      .update(DaytonaSandboxTable)
      .set({
        signed_preview_url: preview.url,
        signed_preview_url_expires_at: signedPreviewRefreshAt(expiresInSeconds),
        region: sandbox.target,
      })
      .where(eq(DaytonaSandboxTable.worker_id, workerId))

    return preview.url
  })()

  refreshPromises.set(workerId, refreshPromise)

  try {
    return await refreshPromise
  } finally {
    refreshPromises.delete(workerId)
  }
}

async function proxyRequest(workerId: WorkerId, request: Request) {
  let baseUrl: string | null = null

  try {
    baseUrl = await getSignedPreviewUrl(workerId)
  } catch (error) {
    const headers = new Headers({ "Content-Type": "application/json" })
    noCacheHeaders(headers)
    applyPublicCorsHeaders(headers, request)
    return new Response(JSON.stringify({
      error: "worker_proxy_refresh_failed",
      message: error instanceof Error ? error.message : "unknown_error",
    }), { status: 502, headers })
  }

  if (!baseUrl) {
    const headers = new Headers({ "Content-Type": "application/json" })
    noCacheHeaders(headers)
    applyPublicCorsHeaders(headers, request)
    return new Response(JSON.stringify({ error: "worker_proxy_unavailable" }), {
      status: 404,
      headers,
    })
  }

  let upstream: Response
  try {
    upstream = await fetch(targetUrl(baseUrl, request.url, workerId), {
      method: request.method,
      headers: stripProxyHeaders(request.headers),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual",
    })
  } catch (error) {
    const headers = new Headers({ "Content-Type": "application/json" })
    noCacheHeaders(headers)
    applyPublicCorsHeaders(headers, request)
    return new Response(JSON.stringify({
      error: "worker_proxy_upstream_failed",
      message: error instanceof Error ? error.message : "unknown_error",
    }), { status: 502, headers })
  }

  const headers = new Headers(upstream.headers)
  headers.delete("access-control-allow-origin")
  headers.delete("access-control-allow-credentials")
  headers.delete("access-control-allow-headers")
  headers.delete("access-control-allow-methods")
  headers.delete("access-control-max-age")
  headers.delete("content-length")
  headers.delete("set-cookie")
  headers.delete("vary")
  noCacheHeaders(headers)
  applyPublicCorsHeaders(headers, request)

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  })
}

app.all("*", async (c) => {
  const requestUrl = new URL(c.req.url)
  if (requestUrl.pathname === "/") {
    return Response.redirect("https://openworklabs.com", 302)
  }

  if (c.req.method === "OPTIONS") {
    const headers = new Headers()
    noCacheHeaders(headers)
    applyPublicCorsHeaders(headers, c.req.raw)
    return new Response(null, { status: 204, headers })
  }

  const segments = requestUrl.pathname.split("/").filter(Boolean)
  const workerId = segments[0]?.trim()

  if (!workerId) {
    const headers = new Headers({ "Content-Type": "application/json" })
    noCacheHeaders(headers)
    applyPublicCorsHeaders(headers, c.req.raw)
    return new Response(JSON.stringify({ error: "worker_id_required" }), {
      status: 400,
      headers,
    })
  }

  try {
    const normalizedWorkerId = normalizeDenTypeId("worker", workerId)
    const tokenScope = await resolveWorkerTokenScope(normalizedWorkerId, c.req.raw)
    const isWriteMethod = !["GET", "HEAD", "OPTIONS"].includes(c.req.method.toUpperCase())

    if (tokenScope === "invalid" || (isWriteMethod && !tokenScope)) {
      const headers = new Headers({ "Content-Type": "application/json" })
      noCacheHeaders(headers)
      applyPublicCorsHeaders(headers, c.req.raw)
      return new Response(JSON.stringify({ error: "worker_proxy_unauthorized" }), {
        status: 401,
        headers,
      })
    }

    const rateLimit = await enforceProxyRateLimit({
      workerId: normalizedWorkerId,
      request: c.req.raw,
      tokenScope,
    })
    if (!rateLimit.allowed) {
      const headers = new Headers({ "Content-Type": "application/json" })
      headers.set("X-Retry-After", String(rateLimit.retryAfterSeconds))
      noCacheHeaders(headers)
      applyPublicCorsHeaders(headers, c.req.raw)
      return new Response(JSON.stringify({ error: "worker_proxy_rate_limited" }), {
        status: 429,
        headers,
      })
    }

    return proxyRequest(normalizedWorkerId, c.req.raw)
  } catch {
    const headers = new Headers({ "Content-Type": "application/json" })
    noCacheHeaders(headers)
    applyPublicCorsHeaders(headers, c.req.raw)
    return new Response(JSON.stringify({ error: "worker_not_found" }), {
      status: 404,
      headers,
    })
  }
})

export default app
