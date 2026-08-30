import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGatewayApp } from "../src/app.ts"
import { resolveGatewayBuildVersion } from "../src/env.ts"

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
  const app = createGatewayApp({ fetchImpl: fetch, ...options, logger: silentLogger, logRequests: false })
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

function readyResolvePayload(url, input = {}) {
  return {
    status: "ready",
    url,
    clientToken: input.clientToken ?? "client-token",
    hostToken: input.hostToken ?? "host-token",
    expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  }
}

function injectedInstanceFetch(instanceHandler) {
  const observed = { upstreamCalls: 0 }
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === "/v1/cloud/gateway/resolve") {
      return Response.json(readyResolvePayload("https://instance.example"))
    }
    observed.upstreamCalls += 1
    return instanceHandler(url, init, observed.upstreamCalls)
  }
  return { fetchImpl, observed }
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
      hostToken: request.headers.get("x-openwork-host-token"),
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
      hostToken: request.headers.get("x-openwork-host-token"),
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

describe("gateway build version", () => {
  test("prefers the explicit version and falls back to Render's commit", () => {
    expect(resolveGatewayBuildVersion({ denGatewayVersion: " openwork-0.19.0 ", renderGitCommit: " render-sha " })).toBe("openwork-0.19.0")
    expect(resolveGatewayBuildVersion({ renderGitCommit: " render-sha " })).toBe("render-sha")
    expect(resolveGatewayBuildVersion({ denGatewayVersion: "  ", renderGitCommit: " render-sha " })).toBe("render-sha")
    expect(resolveGatewayBuildVersion({ denGatewayVersion: "  ", renderGitCommit: "\t" })).toBeUndefined()
    expect(resolveGatewayBuildVersion({})).toBeUndefined()
  })
})

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
    expect(html).not.toContain("host-token")
  })

  test("identifies the configured gateway build in the runtime marker and status", async () => {
    const root = await makeWebRoot()
    const gateway = startGateway({ webRoot: root, buildVersion: "openwork-0.19.0" })
    const base = serverBase(gateway)

    const index = await fetch(`${base}/`)
    const health = await fetch(`${base}/__gw/health`)
    const ready = await fetch(`${base}/__gw/ready`)

    expect(await index.text()).toContain("window.__OPENWORK_GATEWAY__ = {\"version\":1,\"build\":\"openwork-0.19.0\"}")
    await expect(health.json()).resolves.toEqual({ ok: true, service: "den-gateway", build: "openwork-0.19.0" })
    await expect(ready.json()).resolves.toEqual({ ok: true, service: "den-gateway", build: "openwork-0.19.0" })
  })
})

describe("den-gateway proxy", () => {
  test("passes through Den's Web access denial without resolving an instance", async () => {
    let instanceCalls = 0
    const gateway = startGateway({
      denApiBase: "https://den.example",
      gatewayKey: "gateway-secret",
      fetchImpl: async (url) => {
        if (new URL(url).pathname === "/v1/cloud/gateway/resolve") {
          return Response.json({ error: "openwork_web_access_required" }, { status: 403 })
        }
        instanceCalls += 1
        return new Response("unexpected")
      },
    })

    const response = await fetch(`${serverBase(gateway)}/status`, {
      headers: { Authorization: "Bearer den-token" },
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "gateway_resolve_rejected" })
    expect(instanceCalls).toBe(0)
  })

  test("retries one connect-phase failure and passes through success", async () => {
    const injected = injectedInstanceFetch((_url, _init, call) => {
      if (call === 1) {
        throw new Error("connect failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })
      }
      return new Response("ok")
    })
    const gateway = startGateway({ fetchImpl: injected.fetchImpl, denApiBase: "https://den.example", gatewayKey: "gateway-secret" })

    const response = await fetch(`${serverBase(gateway)}/status`, { headers: { Authorization: "Bearer den-token" } })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
    expect(injected.observed.upstreamCalls).toBe(2)
  })

  test("does not retry an instance request that succeeds first try", async () => {
    const injected = injectedInstanceFetch(() => new Response("ok"))
    const gateway = startGateway({ fetchImpl: injected.fetchImpl, denApiBase: "https://den.example", gatewayKey: "gateway-secret" })

    const response = await fetch(`${serverBase(gateway)}/status`, { headers: { Authorization: "Bearer den-token" } })

    expect(response.status).toBe(200)
    expect(injected.observed.upstreamCalls).toBe(1)
  })

  test("does not retry a non-connect instance failure", async () => {
    const injected = injectedInstanceFetch(() => {
      throw new Error("boom")
    })
    const gateway = startGateway({ fetchImpl: injected.fetchImpl, denApiBase: "https://den.example", gatewayKey: "gateway-secret" })

    const response = await fetch(`${serverBase(gateway)}/status`, { headers: { Authorization: "Bearer den-token" } })

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: "gateway_upstream_failed" })
    expect(injected.observed.upstreamCalls).toBe(1)
  })

  test("caps connect-phase retries at one", async () => {
    const injected = injectedInstanceFetch(() => {
      const error = new Error("connect failed")
      error.code = "ECONNRESET"
      throw error
    })
    const gateway = startGateway({ fetchImpl: injected.fetchImpl, denApiBase: "https://den.example", gatewayKey: "gateway-secret" })

    const response = await fetch(`${serverBase(gateway)}/status`, { headers: { Authorization: "Bearer den-token" } })

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: "gateway_upstream_failed" })
    expect(injected.observed.upstreamCalls).toBe(2)
  })

  test("resends identical buffered POST body bytes and headers after a connect failure", async () => {
    const attempts = []
    const injected = injectedInstanceFetch(async (_url, init, call) => {
      attempts.push({
        body: Array.from(new Uint8Array(init.body)),
        contentType: new Headers(init.headers).get("content-type"),
        testHeader: new Headers(init.headers).get("x-test-header"),
      })
      if (call === 1) {
        throw new Error("connect failed", { cause: { code: "ETIMEDOUT" } })
      }
      return new Response("created", { status: 201 })
    })
    const gateway = startGateway({ fetchImpl: injected.fetchImpl, denApiBase: "https://den.example", gatewayKey: "gateway-secret" })

    const response = await fetch(`${serverBase(gateway)}/workspaces`, {
      method: "POST",
      headers: {
        Authorization: "Bearer den-token",
        "Content-Type": "application/octet-stream",
        "X-Test-Header": "preserved",
      },
      body: new Uint8Array([0, 1, 2, 255]),
    })

    expect(response.status).toBe(201)
    expect(injected.observed.upstreamCalls).toBe(2)
    expect(attempts).toEqual([
      { body: [0, 1, 2, 255], contentType: "application/octet-stream", testHeader: "preserved" },
      { body: [0, 1, 2, 255], contentType: "application/octet-stream", testHeader: "preserved" },
    ])
  })

  test("passes /api/den through to den-api with the caller bearer, no cookies, and the prefix stripped", async () => {
    const denApi = startPassthroughDenApi()
    const upstream = startUpstream()
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })

    const response = await fetch(`${serverBase(gateway)}/api/den/v1/me?expand=org`, {
      method: "POST",
      headers: {
        Authorization: "Bearer den-session",
        "X-OpenWork-Host-Token": "browser-host-token",
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
      hostToken: null,
      cookie: null,
      gatewayKey: null,
      forwardedPrefix: "/api/den",
      body: '{"hello":"world"}',
    })
    expect(denApi.observed.requests[0].authorization).not.toBe("Bearer host-token")
    expect(denApi.observed.requests[0].authorization).not.toBe("Bearer client-token")
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
    const denApi = startDenApi(() => readyResolvePayload(serverBase(upstream.server)))
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

  test("injects client and host tokens upstream while stripping browser-supplied credentials", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => readyResolvePayload(serverBase(upstream.server)))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })

    const response = await fetch(`${serverBase(gateway)}/status`, {
      headers: {
        Authorization: "Bearer den-bearer",
        "X-OpenWork-Host-Token": "browser-host-token",
        Cookie: "ow_session=must_not_leak",
      },
    })

    expect(response.status).toBe(200)
    expect(upstream.observed.requests[0].authorization).toBe("Bearer client-token")
    expect(upstream.observed.requests[0].authorization).not.toBe("Bearer den-bearer")
    expect(upstream.observed.requests[0].hostToken).toBe("host-token")
    expect(upstream.observed.requests[0].hostToken).not.toBe("browser-host-token")
    expect(upstream.observed.requests[0].cookie).toBeNull()
  })

  test("caches ready resolution per Den bearer until the TTL expires", async () => {
    const upstream = startUpstream()
    let now = 1_000
    let resolveResponses = 0
    const denApi = startDenApi(() => {
      resolveResponses += 1
      return readyResolvePayload(serverBase(upstream.server), {
        clientToken: `client-token-${resolveResponses}`,
        hostToken: `host-token-${resolveResponses}`,
      })
    })
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret", resolveTtlMs: 1_000, now: () => now })
    const base = serverBase(gateway)
    const headers = { Authorization: "Bearer den-cache" }

    const first = await fetch(`${base}/status`, { headers })
    const second = await fetch(`${base}/capabilities`, { headers })
    now += 1_001
    const third = await fetch(`${base}/whoami`, { headers })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(200)
    expect(denApi.observed.calls).toBe(2)
    expect(upstream.observed.requests).toHaveLength(3)
    expect(upstream.observed.requests.map((request) => request.authorization)).toEqual([
      "Bearer client-token-1",
      "Bearer client-token-1",
      "Bearer client-token-2",
    ])
    expect(upstream.observed.requests.map((request) => request.hostToken)).toEqual([
      "host-token-1",
      "host-token-1",
      "host-token-2",
    ])
  })

  test("never caches a ready resolution beyond its signed-preview safety time", async () => {
    const upstream = startUpstream()
    let now = 1_000
    let resolveResponses = 0
    const denApi = startDenApi(() => {
      resolveResponses += 1
      return readyResolvePayload(serverBase(upstream.server), {
        clientToken: `client-token-${resolveResponses}`,
        hostToken: `host-token-${resolveResponses}`,
        expiresAt: new Date(resolveResponses === 1 ? 1_500 : 10_000).toISOString(),
      })
    })
    const gateway = startGateway({
      denApiBase: serverBase(denApi.server),
      gatewayKey: "gateway-secret",
      resolveTtlMs: 15_000,
      now: () => now,
    })
    const base = serverBase(gateway)
    const headers = { Authorization: "Bearer den-expiry-bound" }

    expect((await fetch(`${base}/status`, { headers })).status).toBe(200)
    now = 1_400
    expect((await fetch(`${base}/capabilities`, { headers })).status).toBe(200)
    now = 1_501
    expect((await fetch(`${base}/whoami`, { headers })).status).toBe(200)

    expect(denApi.observed.calls).toBe(2)
    expect(upstream.observed.requests.map((request) => request.authorization)).toEqual([
      "Bearer client-token-1",
      "Bearer client-token-1",
      "Bearer client-token-2",
    ])
  })

  test("proxies namespaced allowlist subpaths", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => readyResolvePayload(serverBase(upstream.server)))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })
    const base = serverBase(gateway)
    const headers = { Authorization: "Bearer den-api", Accept: "application/json" }

    const requests = [
      ["POST", "/files/sessions/abc/ops"],
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
      "POST /files/sessions/abc/ops",
      "POST /workspaces/local",
      "POST /workspaces/ws_1/activate",
      "GET /env/keys",
      "POST /approvals/appr_1",
    ])
  })

  test("serves workspace document navigations from the SPA but proxies workspace API calls", async () => {
    const root = await makeWebRoot()
    const upstream = startUpstream()
    const denApi = startDenApi(() => readyResolvePayload(serverBase(upstream.server)))
    const gateway = startGateway({ webRoot: root, denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })
    const base = serverBase(gateway)

    const navigation = await fetch(`${base}/workspace/ws_1/session/sess_1`, {
      headers: { "Sec-Fetch-Mode": "navigate" },
    })
    expect(navigation.status).toBe(200)
    expect(await navigation.text()).toContain("OpenWork App")
    expect(upstream.observed.requests).toHaveLength(0)

    const api = await fetch(`${base}/workspace/ws_1/opencode/session`, {
      headers: { Authorization: "Bearer den-workspace", Accept: "application/json" },
    })
    expect(api.status).toBe(200)
    expect(upstream.observed.requests[0].path).toBe("/workspace/ws_1/opencode/session")
  })

  test("proxies workspace opencode SSE without buffering", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => readyResolvePayload(serverBase(upstream.server)))
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
    const denApi = startDenApi(() => readyResolvePayload(serverBase(upstream.server)))
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

  test("returns a typed retryable error for a non-ready workspace and does not proxy", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({ status: "waking", url: null, clientToken: null, hostToken: null, expiresAt: null }))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })

    const base = serverBase(gateway)
    const response = await fetch(`${base}/status`, { headers: { Authorization: "Bearer den-token" } })
    const second = await fetch(`${base}/status`, { headers: { Authorization: "Bearer den-token" } })

    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("5")
    await expect(response.json()).resolves.toEqual({ error: "workspace_not_ready", status: "waking" })
    expect(second.status).toBe(503)
    await expect(second.json()).resolves.toEqual({ error: "workspace_not_ready", status: "waking" })
    expect(upstream.observed.requests).toHaveLength(0)
    expect(denApi.observed.calls).toBe(2)
  })

  test("forwards safe startup diagnostics without exposing runtime credentials", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => ({
      status: "failed",
      url: null,
      clientToken: null,
      hostToken: null,
      expiresAt: null,
      failure: {
        code: "runtime_health_timeout",
        stage: "recovery",
        reference: "cwf_test-reference",
        occurredAt: "2026-08-28T12:00:00.000Z",
      },
    }))
    const gateway = startGateway({ denApiBase: serverBase(denApi.server), gatewayKey: "gateway-secret" })

    const response = await fetch(`${serverBase(gateway)}/workspaces`, {
      headers: { Authorization: "Bearer browser-session-secret" },
    })
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({
      error: "workspace_not_ready",
      status: "failed",
      failure: {
        code: "runtime_health_timeout",
        stage: "recovery",
        reference: "cwf_test-reference",
        occurredAt: "2026-08-28T12:00:00.000Z",
      },
    })
    expect(JSON.stringify(body)).not.toContain("browser-session-secret")
    expect(JSON.stringify(body)).not.toContain("clientToken")
    expect(upstream.observed.requests).toHaveLength(0)
  })

  test("streams SSE without buffering and strips stale compression headers", async () => {
    const upstream = startUpstream()
    const denApi = startDenApi(() => readyResolvePayload(serverBase(upstream.server)))
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
