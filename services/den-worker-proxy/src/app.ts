import "./load-env.js"
import { Daytona } from "@daytonaio/sdk"
import { Hono } from "hono"
import { eq } from "../../../packages/den-db/dist/drizzle.js"
import { createDenDb, DaytonaSandboxTable } from "../../../packages/den-db/dist/index.js"
import { normalizeDenTypeId } from "../../../packages/utils/dist/typeid.js"
import { env } from "./env.js"

const { db } = createDenDb({
  databaseUrl: env.databaseUrl,
  mode: env.dbMode,
  planetscale: env.planetscale,
})
const app = new Hono()
const maxSignedPreviewExpirySeconds = 60 * 60 * 24
const signedPreviewRefreshLeadMs = 5 * 60 * 1000
type WorkerId = typeof DaytonaSandboxTable.$inferSelect.worker_id

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

function stripProxyHeaders(input: Headers) {
  const headers = new Headers(input)
  headers.delete("host")
  headers.delete("content-length")
  headers.delete("connection")
  return headers
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
}

async function proxyRequest(workerId: WorkerId, request: Request) {
  let baseUrl: string | null = null

  try {
    baseUrl = await getSignedPreviewUrl(workerId)
  } catch (error) {
    const headers = new Headers({ "Content-Type": "application/json" })
    noCacheHeaders(headers)
    return new Response(JSON.stringify({
      error: "worker_proxy_refresh_failed",
      message: error instanceof Error ? error.message : "unknown_error",
    }), { status: 502, headers })
  }

  if (!baseUrl) {
    const headers = new Headers({ "Content-Type": "application/json" })
    noCacheHeaders(headers)
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
    return new Response(JSON.stringify({
      error: "worker_proxy_upstream_failed",
      message: error instanceof Error ? error.message : "unknown_error",
    }), { status: 502, headers })
  }

  const headers = new Headers(upstream.headers)
  headers.delete("content-length")
  noCacheHeaders(headers)

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

  const segments = requestUrl.pathname.split("/").filter(Boolean)
  const workerId = segments[0]?.trim()

  if (!workerId) {
    const headers = new Headers({ "Content-Type": "application/json" })
    noCacheHeaders(headers)
    return new Response(JSON.stringify({ error: "worker_id_required" }), {
      status: 400,
      headers,
    })
  }

  try {
    return proxyRequest(normalizeDenTypeId("worker", workerId), c.req.raw)
  } catch {
    const headers = new Headers({ "Content-Type": "application/json" })
    noCacheHeaders(headers)
    return new Response(JSON.stringify({ error: "worker_not_found" }), {
      status: 404,
      headers,
    })
  }
})

export default app
