import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, expect, test } from "bun:test"
import { Hono } from "hono"
import { cors } from "hono/cors"
import type { WorkerRouteVariables } from "../src/routes/workers/shared.js"
import type { CloudRuntimeStore } from "../src/workers/worker-access.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"
  process.env.PROVISIONER_MODE = "daytona"
  process.env.DAYTONA_API_KEY = "daytona-test-key"
  process.env.DAYTONA_SNAPSHOT = "openwork-0.18.8"
}

type SharedModule = typeof import("../src/routes/workers/shared.js")
type AccessModule = typeof import("../src/workers/worker-access.js")
type CompatibilityModule = typeof import("../src/routes/workers/compatibility.js")
let shared: SharedModule
let access: AccessModule
let compatibility: CompatibilityModule

beforeAll(async () => {
  seedRequiredEnv()
  ;[shared, access, compatibility] = await Promise.all([
    import("../src/routes/workers/shared.js"),
    import("../src/workers/worker-access.js"),
    import("../src/routes/workers/compatibility.js"),
  ])
})

function worker() {
  const now = new Date("2026-08-27T10:00:00.000Z")
  return {
    id: createDenTypeId("worker"),
    org_id: createDenTypeId("organization"),
    created_by_user_id: createDenTypeId("user"),
    name: "Daytona Cloud",
    description: null,
    destination: "cloud",
    status: "healthy",
    image_version: "openwork-0.18.8",
    workspace_path: null,
    sandbox_backend: "cloud-instance",
    last_heartbeat_at: null,
    last_active_at: null,
    created_at: now,
    updated_at: now,
  } satisfies Parameters<SharedModule["fetchWorkerRuntimeJson"]>[0]["worker"]
}

function runtimeStore(): CloudRuntimeStore {
  return {
    async claimFailedWorker() { return false },
    async claimRecycleWorker() { return false },
    async getActiveTokens() {
      return [
        { scope: "host", token: "host-token" },
        { scope: "client", token: "client-token" },
        { scope: "activity", token: "activity-token" },
      ]
    },
    async markProvisioningWorkerFailed() {},
    async markHealthyWorkerFailed() {},
  }
}

test("generic Daytona runtime routes refresh expiry and request only the fresh preview", async () => {
  const runtimeWorker = worker()
  const requested: string[] = []
  const result = await shared.fetchWorkerRuntimeJson({
    worker: runtimeWorker,
    path: "/runtime/versions",
  }, {
    resolveCloudAccess: (ownership) => access.resolveCloudRuntimeAccess(ownership, {
      loadWorker: async () => runtimeWorker,
      store: runtimeStore(),
      getSandboxRecord: async () => ({
        signed_preview_url: "https://expired.preview.example.test",
        signed_preview_url_expires_at: new Date("2026-08-27T09:00:00.000Z"),
      }),
      refreshSignedPreview: async () => ({
        signed_preview_url: "https://fresh.preview.example.test",
        signed_preview_url_expires_at: new Date("2026-08-27T12:00:00.000Z"),
      }),
      inspectSandbox: async () => ({ state: "started" }),
      probeSignedPreview: async () => true,
      startWake: () => {},
      startRecovery: () => {},
      now: () => new Date("2026-08-27T10:00:00.000Z").getTime(),
    }),
    fetchImpl: async (input, init) => {
      requested.push(String(input))
      expect(init?.redirect).toBe("error")
      return Response.json({ version: "fresh" })
    },
  })

  expect(result).toEqual({ ok: true, status: 200, payload: { version: "fresh" } })
  expect(requested).toEqual(["https://fresh.preview.example.test/runtime/versions"])
  expect(requested.join(" ")).not.toContain("expired.preview.example.test")
})

test("Daytona instance persistence and API responses never expose an expiring preview as timeless", () => {
  const now = new Date("2026-08-27T10:00:00.000Z")
  const runtimeWorker = worker()
  const daytona = {
    id: createDenTypeId("workerInstance"),
    worker_id: runtimeWorker.id,
    provider: "daytona",
    region: "us",
    url: "https://stale.preview.example.test",
    status: "healthy",
    created_at: now,
    updated_at: now,
  } satisfies Parameters<SharedModule["toInstanceResponse"]>[0]
  const render = { ...daytona, provider: "render", url: "https://durable.render.example.test" }

  expect(shared.persistedWorkerInstanceUrl(daytona)).toEndWith("/v1/cloud/instance")
  expect(shared.persistedWorkerInstanceUrl(daytona)).not.toContain("stale.preview.example.test")
  expect(shared.toInstanceResponse(daytona)?.url).toBeNull()
  expect(shared.persistedWorkerInstanceUrl(render)).toBe("https://durable.render.example.test")
  expect(shared.toInstanceResponse(render)?.url).toBe("https://durable.render.example.test")
})

test("cloud worker tokens expose expiring URLs only by explicit opt-in", async () => {
  const runtimeWorker = worker()
  const requested: string[] = []
  const resolveCloudAccess = async () => ({
    status: "ready" as const,
    workerId: runtimeWorker.id,
    url: "https://create-token.preview.example.test",
    expiresAt: new Date("2026-08-27T12:00:00.000Z"),
    clientToken: "client-token",
    hostToken: "host-token",
  })
  const loadActiveTokens = async () => [
    { scope: "host" as const, token: "host-token" },
    { scope: "client" as const, token: "client-token" },
  ]
  const legacy = await shared.getWorkerTokensAndConnect(runtimeWorker, {
    apiPublicUrl: "https://den.example.test/api/den",
    resolveCloudAccess,
    loadActiveTokens,
    fetchImpl: async (input, init) => {
      requested.push(String(input))
      expect(init?.redirect).toBe("error")
      return Response.json({ activeId: "created-workspace", items: [] })
    },
  })
  const resolved = await shared.getWorkerTokensAndConnect(runtimeWorker, {
    includeExpiringOpenworkUrl: true,
    apiPublicUrl: "https://den.example.test/api/den",
    loadActiveTokens,
    resolveCloudAccess: async () => ({
      status: "ready",
      workerId: runtimeWorker.id,
      url: "https://create-token.preview.example.test",
      expiresAt: new Date("2026-08-27T12:00:00.000Z"),
      clientToken: "client-token",
      hostToken: "host-token",
    }),
    fetchImpl: async (input, init) => {
      requested.push(String(input))
      expect(init?.redirect).toBe("error")
      return Response.json({ activeId: "created-workspace", items: [] })
    },
  })

  expect(legacy).toEqual({
    tokens: { owner: "host-token", host: "host-token", client: "client-token" },
    connect: {
      openworkUrl: `https://den.example.test/api/den/v1/cloud/workers/${runtimeWorker.id}`,
      workspaceId: null,
    },
  })
  expect(resolved).toEqual({
    tokens: { owner: "host-token", host: "host-token", client: "client-token" },
    connect: {
      openworkUrl: `https://den.example.test/api/den/v1/cloud/workers/${runtimeWorker.id}/w/created-workspace`,
      workspaceId: "created-workspace",
    },
    directPreview: {
      version: 1,
      openworkUrl: "https://create-token.preview.example.test/w/created-workspace",
      workspaceId: "created-workspace",
      expiresAt: "2026-08-27T12:00:00.000Z",
    },
  })
  expect(requested).toEqual([
    "https://create-token.preview.example.test/workspaces",
  ])
  expect("connect" in legacy ? legacy.connect?.openworkUrl : null).not.toContain("preview.example.test")
  expect("directPreview" in legacy).toBe(false)
  expect(requested.join(" ")).not.toContain("workers.example.test")
})

test("cloud worker tokens retain the stable route while provisioning", async () => {
  const runtimeWorker = { ...worker(), status: "provisioning" as const }
  const resolved = await shared.getWorkerTokensAndConnect(runtimeWorker, {
    apiPublicUrl: "https://den.example.test/api/den",
    includeExpiringOpenworkUrl: true,
    loadActiveTokens: async () => [
      { scope: "host", token: "host-token" },
      { scope: "client", token: "client-token" },
    ],
    resolveCloudAccess: async () => ({ status: "waking", workerId: runtimeWorker.id, reason: "reprovisioning" }),
  })

  expect(resolved).toEqual({
    tokens: { owner: "host-token", host: "host-token", client: "client-token" },
    connect: {
      openworkUrl: `https://den.example.test/api/den/v1/cloud/workers/${runtimeWorker.id}`,
      workspaceId: null,
    },
    directPreview: null,
  })
})

function registerCompatibilityTestApp(input: {
  workerId: ReturnType<typeof createDenTypeId<"worker">>
  runtimeUrls?: string[]
  requests: Array<{ url: string; init: RequestInit }>
  response?: (url: string, init: RequestInit) => Response | Promise<Response>
  maxActiveRequestsPerWorker?: number
}) {
  const app = new Hono<{ Variables: WorkerRouteVariables }>()
  const organizationId = createDenTypeId("organization")
  let resolveIndex = 0
  compatibility.registerCloudWorkerCompatibilityRoutes(app, {
    authenticate: async ({ request, workerId }) => {
      if (workerId !== input.workerId) return null
      const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
      const host = request.headers.get("x-openwork-host-token") ?? ""
      if (host === "host-token" || bearer === "host-token") return { organizationId, scope: "host" }
      if (bearer === "client-token") return { organizationId, scope: "client" }
      return null
    },
    resolveCloudAccess: async () => {
      const urls = input.runtimeUrls ?? ["https://fresh.preview.example.test"]
      const url = urls[Math.min(resolveIndex, urls.length - 1)]
      resolveIndex += 1
      return {
        status: "ready",
        workerId: input.workerId,
        url,
        expiresAt: new Date("2026-08-27T12:00:00.000Z"),
        clientToken: "fresh-client-token",
        hostToken: "fresh-host-token",
      }
    },
    fetchImpl: async (url, init = {}) => {
      const normalized = { url: String(url), init }
      input.requests.push(normalized)
      return await input.response?.(normalized.url, init) ?? Response.json({ ok: true })
    },
    maxActiveRequestsPerWorker: input.maxActiveRequestsPerWorker,
  })
  return app
}

test("cloud worker OPTIONS bypasses global credentialed CORS for native origins", async () => {
  const app = new Hono<{ Variables: WorkerRouteVariables }>()
  compatibility.registerCloudWorkerCompatibilityPreflightRoute(app)
  app.use("*", cors({
    origin: ["https://browser.example.test"],
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }))
  compatibility.registerCloudWorkerCompatibilityRoutes(app, {
    authenticate: async () => {
      throw new Error("preflight must not authenticate")
    },
  })

  for (const origin of ["null", "openwork://desktop"]) {
    const response = await app.request("https://den.example.test/v1/cloud/workers/worker_native/health", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "content-type,x-openwork-host-token,x-opencode-directory",
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(origin)
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-openwork-host-token")
    expect(response.headers.get("access-control-allow-methods")).toContain("PATCH")
  }

  const unrelated = await app.request("https://den.example.test/v1/other", {
    method: "OPTIONS",
    headers: { Origin: "openwork://desktop", "Access-Control-Request-Method": "POST" },
  })
  expect(unrelated.headers.get("access-control-allow-origin")).toBeNull()
})

test("stable cloud worker route refreshes the preview on every request", async () => {
  const workerId = createDenTypeId("worker")
  const requests: Array<{ url: string; init: RequestInit }> = []
  const app = registerCompatibilityTestApp({
    workerId,
    runtimeUrls: ["https://preview-a.example.test", "https://preview-b.example.test"],
    requests,
  })
  const stableUrl = `https://den.example.test/v1/cloud/workers/${workerId}/health?probe=1`
  const headers = { Authorization: "Bearer client-token" }

  expect((await app.request(stableUrl, { headers })).status).toBe(200)
  expect((await app.request(stableUrl, { headers })).status).toBe(200)
  expect(requests.map((request) => request.url)).toEqual([
    "https://preview-a.example.test/health?probe=1",
    "https://preview-b.example.test/health?probe=1",
  ])
})

test("stable cloud worker route enforces worker token and method scope", async () => {
  const workerId = createDenTypeId("worker")
  const requests: Array<{ url: string; init: RequestInit }> = []
  const app = registerCompatibilityTestApp({ workerId, requests })
  const route = `https://den.example.test/v1/cloud/workers/${workerId}/workspace/demo/config`

  const clientRead = await app.request(route, { headers: { Authorization: "Bearer client-token" } })
  const clientWrite = await app.request(route, {
    method: "PUT",
    headers: { Authorization: "Bearer client-token", "Content-Type": "application/json" },
    body: "{}",
  })
  const wrongWorker = await app.request(
    `https://den.example.test/v1/cloud/workers/${createDenTypeId("worker")}/health`,
    { headers: { Authorization: "Bearer client-token" } },
  )
  const hostWrite = await app.request(route, {
    method: "PUT",
    headers: { "X-OpenWork-Host-Token": "host-token", "Content-Type": "application/json" },
    body: "{}",
  })
  const desktopHandoffWrite = await app.request(route, {
    method: "POST",
    headers: { Authorization: "Bearer host-token", "Content-Type": "application/json" },
    body: JSON.stringify({ from: "desktop-handoff" }),
  })

  expect(clientRead.status).toBe(200)
  expect(clientWrite.status).toBe(401)
  expect(await clientWrite.json()).toEqual({ error: "unauthorized" })
  expect(clientWrite.headers.get("cache-control")).toBe("no-store")
  expect(wrongWorker.status).toBe(401)
  expect(await wrongWorker.json()).toEqual({ error: "unauthorized" })
  expect(hostWrite.status).toBe(200)
  expect(desktopHandoffWrite.status).toBe(200)
  expect(requests).toHaveLength(3)
  const handoffHeaders = new Headers(requests[2]?.init.headers)
  expect(handoffHeaders.get("authorization")).toBe("Bearer fresh-client-token")
  expect(handoffHeaders.get("x-openwork-host-token")).toBe("fresh-host-token")
})

test("stable cloud worker route safely proxies bodies, headers, and streaming responses", async () => {
  const workerId = createDenTypeId("worker")
  const requests: Array<{ url: string; init: RequestInit }> = []
  const encoder = new TextEncoder()
  const app = registerCompatibilityTestApp({
    workerId,
    requests,
    response: (url) => {
      if (url.includes("/event-stream")) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("data: one\n\n"))
            controller.enqueue(encoder.encode("data: two\n\n"))
            controller.close()
          },
        }), {
          headers: {
            "Content-Type": "text/event-stream",
            Connection: "x-runtime-secret",
            "X-Runtime-Secret": "hidden",
            Location: "https://attacker.example.test",
          },
        })
      }
      return Response.json({ saved: true }, {
        headers: { "Content-Encoding": "gzip", "Set-Cookie": "runtime=secret" },
      })
    },
  })
  const route = `https://den.example.test/v1/cloud/workers/${workerId}`
  const write = await app.request(`${route}/workspace/demo/config?mode=replace`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Connection: "x-client-secret",
      "X-Client-Secret": "hidden",
      "X-OpenWork-Host-Token": "host-token",
    },
    body: JSON.stringify({ enabled: true }),
  })
  const stream = await app.request(`${route}/event-stream?cursor=2`, {
    headers: { Authorization: "Bearer client-token", "Last-Event-ID": "one" },
  })

  expect(write.status).toBe(200)
  expect(await write.json()).toEqual({ saved: true })
  expect(requests[0]?.url).toBe("https://fresh.preview.example.test/workspace/demo/config?mode=replace")
  expect(requests[0]?.init.method).toBe("PATCH")
  expect(await new Response(requests[0]?.init.body).text()).toBe(JSON.stringify({ enabled: true }))
  const writeHeaders = new Headers(requests[0]?.init.headers)
  expect(writeHeaders.get("authorization")).toBe("Bearer fresh-client-token")
  expect(writeHeaders.get("x-openwork-host-token")).toBe("fresh-host-token")
  expect(writeHeaders.get("x-client-secret")).toBeNull()
  expect(requests[0]?.init.redirect).toBe("error")
  expect(write.headers.get("content-encoding")).toBeNull()
  expect(write.headers.get("set-cookie")).toBeNull()
  expect(write.headers.get("cache-control")).toBe("no-store")

  expect(stream.status).toBe(200)
  expect(stream.headers.get("content-type")).toBe("text/event-stream")
  expect(stream.headers.get("x-runtime-secret")).toBeNull()
  expect(stream.headers.get("location")).toBeNull()
  expect(stream.headers.get("cache-control")).toBe("no-store")
  expect(await stream.text()).toBe("data: one\n\ndata: two\n\n")
  const streamHeaders = new Headers(requests[1]?.init.headers)
  expect(streamHeaders.get("authorization")).toBe("Bearer fresh-client-token")
  expect(streamHeaders.get("x-openwork-host-token")).toBeNull()
  expect(streamHeaders.get("last-event-id")).toBe("one")
})

test("stable cloud worker route never relays a runtime redirect", async () => {
  const workerId = createDenTypeId("worker")
  const requests: Array<{ url: string; init: RequestInit }> = []
  const app = registerCompatibilityTestApp({
    workerId,
    requests,
    response: () => new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.example.test/redirected" },
    }),
  })
  const response = await app.request(`https://den.example.test/v1/cloud/workers/${workerId}/health`, {
    headers: { Authorization: "Bearer client-token" },
  })

  expect(response.status).toBe(502)
  expect(response.headers.get("location")).toBeNull()
  expect(await response.json()).toEqual({ error: "worker_runtime_proxy_failed" })
  expect(requests[0]?.init.redirect).toBe("error")
})

test("stable cloud worker route streams a multi-chunk large request without buffering", async () => {
  const workerId = createDenTypeId("worker")
  const requests: Array<{ url: string; init: RequestInit }> = []
  const observedChunks: Array<{ length: number; firstByte: number }> = []
  const app = registerCompatibilityTestApp({
    workerId,
    requests,
    response: async (_url, init) => {
      expect("duplex" in init && init.duplex).toBe("half")
      const body = new Response(init.body).body
      if (!body) throw new Error("upstream request body was not streamed")
      const reader = body.getReader()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        observedChunks.push({ length: chunk.value.byteLength, firstByte: chunk.value[0] ?? -1 })
      }
      return Response.json({ streamed: true })
    },
  })
  const route = `https://den.example.test/v1/cloud/workers/${workerId}/workspace/demo/files/raw`
  const chunkSize = 3 * 1024 * 1024
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of [1, 2, 3]) controller.enqueue(new Uint8Array(chunkSize).fill(value))
      controller.close()
    },
  })
  const requestInit: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "X-OpenWork-Host-Token": "host-token" },
    body,
    duplex: "half",
  }
  const response = await app.request(new Request(route, requestInit))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ streamed: true })
  expect(observedChunks).toEqual([
    { length: chunkSize, firstByte: 1 },
    { length: chunkSize, firstByte: 2 },
    { length: chunkSize, firstByte: 3 },
  ])
  expect(requests).toHaveLength(1)
})

test("stable cloud worker route releases its slot after an upstream request error", async () => {
  const workerId = createDenTypeId("worker")
  const requests: Array<{ url: string; init: RequestInit }> = []
  let calls = 0
  const app = registerCompatibilityTestApp({
    workerId,
    requests,
    maxActiveRequestsPerWorker: 1,
    response: () => {
      calls += 1
      if (calls === 1) throw new Error("upstream failed")
      return Response.json({ recovered: true })
    },
  })
  const route = `https://den.example.test/v1/cloud/workers/${workerId}/health`
  const failed = await app.request(route, { headers: { Authorization: "Bearer client-token" } })
  const recovered = await app.request(route, { headers: { Authorization: "Bearer client-token" } })

  expect(failed.status).toBe(502)
  expect(recovered.status).toBe(200)
  expect(await recovered.json()).toEqual({ recovered: true })
})

test("stable cloud worker route limits active streams and releases on cancel", async () => {
  const workerId = createDenTypeId("worker")
  const requests: Array<{ url: string; init: RequestInit }> = []
  let upstreamCalls = 0
  const app = registerCompatibilityTestApp({
    workerId,
    requests,
    maxActiveRequestsPerWorker: 1,
    response: () => {
      upstreamCalls += 1
      if (upstreamCalls > 1) return Response.json({ ok: true })
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: held\n\n")) } }), {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  const route = `https://den.example.test/v1/cloud/workers/${workerId}/event-stream`
  const first = await app.request(route, { headers: { Authorization: "Bearer client-token" } })
  const limited = await app.request(route, { headers: { Authorization: "Bearer client-token" } })

  expect(first.status).toBe(200)
  expect(limited.status).toBe(429)
  expect(limited.headers.get("retry-after")).toBe("1")
  await first.body?.cancel()

  const afterCancel = await app.request(route, { headers: { Authorization: "Bearer client-token" } })
  expect(afterCancel.status).toBe(200)
  expect(await afterCancel.json()).toEqual({ ok: true })
  const afterClose = await app.request(route, { headers: { Authorization: "Bearer client-token" } })
  expect(afterClose.status).toBe(200)
  await afterClose.body?.cancel()
})
