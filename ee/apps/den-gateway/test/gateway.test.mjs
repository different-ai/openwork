import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGatewayApp } from "../src/app.ts"

const silentLogger = {
  log() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger
  },
}

const servers = []
const tempDirs = []

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    server.stop(true)
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    await rm(dir, { recursive: true, force: true })
  }
})

function startServer(fetchHandler) {
  const server = Bun.serve({ port: 0, fetch: fetchHandler })
  servers.push(server)
  return server
}

function serverBase(server) {
  return `http://127.0.0.1:${server.port}`
}

function startGateway(options) {
  const app = createGatewayApp({ ...options, logger: silentLogger, logRequests: false })
  return startServer(app.fetch)
}

async function makeWebRoot() {
  const root = await mkdtemp(join(tmpdir(), "den-gateway-web-"))
  tempDirs.push(root)
  await mkdir(join(root, "assets"), { recursive: true })
  await writeFile(join(root, "index.html"), "<!doctype html><div id=\"root\">OpenWork App</div>")
  await writeFile(join(root, "assets", "app.js"), "globalThis.__openworkTest = true;")
  return root
}

function startDenApi(resolvePayload) {
  const observed = { calls: 0, authorization: null, gatewayKey: null }
  const server = startServer((request) => {
    const url = new URL(request.url)
    if (url.pathname !== "/v1/cloud/gateway/resolve") {
      return Response.json({ error: "not_found" }, { status: 404 })
    }
    observed.calls += 1
    observed.authorization = request.headers.get("authorization")
    observed.gatewayKey = request.headers.get("x-openwork-gateway-key")
    return Response.json(resolvePayload())
  })
  return { server, observed }
}

function startPassthroughDenApi() {
  const observed = { requests: [] }
  const encoder = new TextEncoder()
  const server = startServer(async (request) => {
    const url = new URL(request.url)
    observed.requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
      gatewayKey: request.headers.get("x-openwork-gateway-key"),
      forwardedPrefix: request.headers.get("x-forwarded-prefix"),
      body: await request.text(),
    })

    if (url.pathname === "/v1/events") {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: den-first\n\n"))
          setTimeout(() => {
            controller.enqueue(encoder.encode("data: den-second\n\n"))
            controller.close()
          }, 500)
        },
      })
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
    }

    if (url.pathname === "/v1/compressed") {
      return new Response(Bun.gzipSync("compressed den upstream"), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Encoding": "gzip",
          "Transfer-Encoding": "chunked",
        },
      })
    }

    return Response.json({ ok: true, path: url.pathname }, {
      headers: { "Cache-Control": "private, max-age=10" },
    })
  })
  return { server, observed }
}

function startUpstream() {
  const observed = { requests: [] }
  const encoder = new TextEncoder()
  const server = startServer((request) => {
    const url = new URL(request.url)
    observed.requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
    })

    if (url.pathname.endsWith("/opencode/event")) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"))
          setTimeout(() => {
            controller.enqueue(encoder.encode("data: second\n\n"))
            controller.close()
          }, 500)
        },
      })
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
    }

    if (url.pathname === "/status" && url.searchParams.get("gzip") === "1") {
      return new Response(Bun.gzipSync("compressed upstream"), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Encoding": "gzip",
          "Transfer-Encoding": "chunked",
        },
      })
    }

    return Response.json({ ok: true, path: url.pathname }, {
      headers: { "Cache-Control": "public, max-age=60" },
    })
  })
  return { server, observed }
}

describe("den-gateway static UI", () => {
  test("serves index, falls back for deep routes, hard-404s asset misses, rejects traversal, and caches assets immutably", async () => {
    const root = await makeWebRoot()
    const gateway = startGateway({ webRoot: root })
    const base = serverBase(gateway)

    const index = await fetch(`${base}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get("cache-control")).toBe("no-cache")
    expect(await index.text()).toContain("OpenWork App")

    const deep = await fetch(`${base}/sessions/deep/link`)
    expect(deep.status).toBe(200)
    expect(await deep.text()).toContain("OpenWork App")

    const asset = await fetch(`${base}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

    const missingAsset = await fetch(`${base}/assets/missing.js`)
    expect(missingAsset.status).toBe(404)
    expect(missingAsset.headers.get("content-type")).not.toContain("text/html")
    expect(await missingAsset.text()).not.toContain("OpenWork App")

    const traversal = await fetch(`${base}/%2e%2e%2fsecret.txt`)
    expect(traversal.status).toBe(400)
  })

  test("injects the gateway runtime marker into index.html without a bootstrap token", async () => {
    const root = await makeWebRoot()
    const gateway = startGateway({ webRoot: root })

    const response = await fetch(`${serverBase(gateway)}/`)
    const html = await response.text()

    expect(html).toContain("window.__OPENWORK_GATEWAY__ = {\"version\":1}")
    expect(html).not.toContain("__OPENWORK_BOOTSTRAP__")
    expect(html).not.toContain("client-token")
  })
})

describe("den-gateway proxy", () => {
  test("passes /api/den through to den-api with the caller bearer, no cookies, and the prefix stripped", async () => {
    const denApi = startPassthroughDenApi()
    const upstream = startUpstream()
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })

    const response = await fetch(`${serverBase(gateway)}/api/den/v1/me?expand=org`, {
      method: "POST",
      headers: {
        Authorization: "Bearer den-session",
        Cookie: "ow_session=must_not_leak",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, max-age=10")
    expect(denApi.observed.requests).toHaveLength(1)
    expect(denApi.observed.requests[0]).toEqual({
      method: "POST",
      path: "/v1/me?expand=org",
      authorization: "Bearer den-session",
      cookie: null,
      gatewayKey: null,
      forwardedPrefix: "/api/den",
      body: '{"hello":"world"}',
    })
    expect(upstream.observed.requests).toHaveLength(0)
  })

  test("streams /api/den responses without buffering and strips stale compression headers", async () => {
    const denApi = startPassthroughDenApi()
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })
    const base = serverBase(gateway)

    const startedAt = Date.now()
    const streamResponse = await fetch(`${base}/api/den/v1/events`, {
      headers: { Authorization: "Bearer den-stream", Accept: "text/event-stream" },
    })
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream")
    const reader = streamResponse.body.getReader()
    const first = await reader.read()
    const elapsed = Date.now() - startedAt
    expect(new TextDecoder().decode(first.value)).toBe("data: den-first\n\n")
    expect(elapsed).toBeLessThan(300)
    await reader.read()

    const compressed = await fetch(`${base}/api/den/v1/compressed`, {
      headers: { Authorization: "Bearer den-stream" },
    })
    expect(compressed.headers.get("content-encoding")).toBeNull()
    expect(compressed.headers.get("transfer-encoding")).toBeNull()
    expect(await compressed.text()).toBe("compressed den upstream")
  })

  test("answers gateway health while /health proxies to the instance", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({ status: "ready", url: serverBase(upstream.server), clientToken: "client-token" }))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })
    const base = serverBase(gateway)

    const ownHealth = await fetch(`${base}/__gw/health`)
    expect(ownHealth.status).toBe(200)
    await expect(ownHealth.json()).resolves.toEqual({ ok: true, service: "den-gateway" })

    const proxiedHealth = await fetch(`${base}/health`, { headers: { Authorization: "Bearer den-token" } })
    expect(proxiedHealth.status).toBe(200)
    expect(proxiedHealth.headers.get("cache-control")).toBe("public, max-age=60")
    expect(upstream.observed.requests[0].path).toBe("/health")
    expect(denApi.observed.authorization).toBe("Bearer den-token")
    expect(denApi.observed.gatewayKey).toBe("gateway-secret")
  })

  test("injects the client token upstream and strips the Den bearer and cookies", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({ status: "ready", url: serverBase(upstream.server), clientToken: "client-token" }))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })

    const response = await fetch(`${serverBase(gateway)}/status`, {
      headers: {
        Authorization: "Bearer den-bearer",
        Cookie: "ow_session=must_not_leak",
      },
    })

    expect(response.status).toBe(200)
    expect(upstream.observed.requests[0].authorization).toBe("Bearer client-token")
    expect(upstream.observed.requests[0].authorization).not.toBe("Bearer den-bearer")
    expect(upstream.observed.requests[0].cookie).toBeNull()
  })

  test("caches ready resolution per Den bearer for rapid proxied requests", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({ status: "ready", url: serverBase(upstream.server), clientToken: "client-token" }))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })
    const base = serverBase(gateway)
    const headers = { Authorization: "Bearer den-cache" }

    const first = await fetch(`${base}/status`, { headers })
    const second = await fetch(`${base}/capabilities`, { headers })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(denApi.observed.calls).toBe(1)
    expect(upstream.observed.requests).toHaveLength(2)
  })

  test("proxies namespaced allowlist subpaths", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({ status: "ready", url: serverBase(upstream.server), clientToken: "client-token" }))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })
    const base = serverBase(gateway)
    const headers = { Authorization: "Bearer den-api", Accept: "application/json" }

    const requests = [
      ["POST", "/files/sessions/abc/read-batch"],
      ["POST", "/workspaces/local"],
      ["POST", "/workspaces/ws_1/activate"],
      ["GET", "/env/keys"],
      ["POST", "/approvals/appr_1"],
    ]

    for (const [method, path] of requests) {
      const response = await fetch(`${base}${path}`, { method, headers })
      expect(response.status).toBe(200)
    }

    expect(upstream.observed.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /files/sessions/abc/read-batch",
      "POST /workspaces/local",
      "POST /workspaces/ws_1/activate",
      "GET /env/keys",
      "POST /approvals/appr_1",
    ])
  })

  test("serves workspace document navigations from the SPA but proxies workspace API calls", async () => {
    const root = await makeWebRoot()
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({ status: "ready", url: serverBase(upstream.server), clientToken: "client-token" }))
    const gateway = startGateway({ webRoot: root, denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })
    const base = serverBase(gateway)

    const navigation = await fetch(`${base}/workspace/ws_1/session/sess_1`, {
      headers: { "Sec-Fetch-Mode": "navigate" },
    })
    expect(navigation.status).toBe(200)
    expect(await navigation.text()).toContain("OpenWork App")
    expect(upstream.observed.requests).toHaveLength(0)

    const api = await fetch(`${base}/workspace/ws_1/sessions`, {
      headers: { Authorization: "Bearer den-workspace", Accept: "application/json" },
    })
    expect(api.status).toBe(200)
    expect(upstream.observed.requests[0].path).toBe("/workspace/ws_1/sessions")
  })

  test("proxies workspace opencode SSE without buffering", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({ status: "ready", url: serverBase(upstream.server), clientToken: "client-token" }))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })
    const base = serverBase(gateway)

    const startedAt = Date.now()
    const streamResponse = await fetch(`${base}/workspace/ws_1/opencode/event`, {
      headers: { Authorization: "Bearer den-stream", Accept: "text/event-stream" },
    })
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream")
    const reader = streamResponse.body.getReader()
    const first = await reader.read()
    const elapsed = Date.now() - startedAt
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n")
    expect(elapsed).toBeLessThan(300)
    expect(upstream.observed.requests[0].path).toBe("/workspace/ws_1/opencode/event")
    await reader.read()
  })

  test("keeps /w navigations proxied and non-api navigations on the SPA", async () => {
    const root = await makeWebRoot()
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({ status: "ready", url: serverBase(upstream.server), clientToken: "client-token" }))
    const gateway = startGateway({ webRoot: root, denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })
    const base = serverBase(gateway)

    const workspaceMount = await fetch(`${base}/w/ws_1/anything`, {
      headers: { Authorization: "Bearer den-w", "Sec-Fetch-Mode": "navigate" },
    })
    expect(workspaceMount.status).toBe(200)
    await expect(workspaceMount.json()).resolves.toEqual({ ok: true, path: "/w/ws_1/anything" })
    expect(upstream.observed.requests[0].path).toBe("/w/ws_1/anything")

    const settings = await fetch(`${base}/settings/general`, {
      headers: { "Sec-Fetch-Mode": "navigate" },
    })
    expect(settings.status).toBe(200)
    expect(await settings.text()).toContain("OpenWork App")
    expect(upstream.observed.requests).toHaveLength(1)
  })

  test("returns non-ready JSON status and does not proxy", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({ status: "waking", url: null, clientToken: null }))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })

    const base = serverBase(gateway)
    const response = await fetch(`${base}/status`, { headers: { Authorization: "Bearer den-token" } })
    const second = await fetch(`${base}/status`, { headers: { Authorization: "Bearer den-token" } })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "waking" })
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toEqual({ status: "waking" })
    expect(upstream.observed.requests).toHaveLength(0)
    expect(denApi.observed.calls).toBe(2)
  })

  test("streams SSE without buffering and strips stale compression headers", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({ status: "ready", url: serverBase(upstream.server), clientToken: "client-token" }))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })
    const base = serverBase(gateway)

    const startedAt = Date.now()
    const streamResponse = await fetch(`${base}/opencode/event`, { headers: { Authorization: "Bearer den-stream" } })
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream")
    const reader = streamResponse.body.getReader()
    const first = await reader.read()
    const elapsed = Date.now() - startedAt
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n")
    expect(elapsed).toBeLessThan(300)
    await reader.read()

    const compressed = await fetch(`${base}/status?gzip=1`, { headers: { Authorization: "Bearer den-stream" } })
    expect(compressed.headers.get("content-encoding")).toBeNull()
    expect(compressed.headers.get("transfer-encoding")).toBeNull()
    expect(await compressed.text()).toBe("compressed upstream")
  })
})
