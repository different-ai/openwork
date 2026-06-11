import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { jsonValidator } from "../src/middleware/validation.js"
import { WorkerInstanceTable, WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { ProvisionedInstance, StaticWorkerConfig } from "../src/workers/provisioner.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.PROVISIONER_MODE = "static"
  process.env.STATIC_WORKER_URLS = process.env.STATIC_WORKER_URLS ?? "http://127.0.0.1:8787"
  process.env.STATIC_WORKER_TOKEN_MAP_JSON = process.env.STATIC_WORKER_TOKEN_MAP_JSON ?? '{"http://127.0.0.1:8787":{"clientToken":"static-client-token","hostToken":"static-host-token"}}'
  process.env.STATIC_WORKER_ATTACH_ALLOW_PRIVATE = "true"
}

let provisionerModule: typeof import("../src/workers/provisioner.js")
let envModule: typeof import("../src/env.js")
let workersSharedModule: typeof import("../src/routes/workers/shared.js")
let workersCoreModule: typeof import("../src/routes/workers/core.js")
let server: ReturnType<typeof Bun.serve>
let staticWorkerUrl: string
let tokenQueryRows: Array<Record<string, unknown>> = []
let instanceQueryRows: Array<Record<string, unknown>> = []

function dbQueryFor(table: unknown) {
  const rows = table === WorkerTokenTable ? tokenQueryRows : table === WorkerInstanceTable ? instanceQueryRows : []
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => rows,
    then: (resolve: (value: Array<Record<string, unknown>>) => unknown) => resolve(rows),
  }
  return chain
}

mock.module("../src/db.js", () => ({
  dbClient: { end: () => Promise.resolve() },
  denDb: {},
  db: {
    select: () => ({ from: (table: unknown) => dbQueryFor(table) }),
  },
}))

function staticWorkerConfig(overrides: Partial<StaticWorkerConfig> = {}): StaticWorkerConfig {
  return {
    urls: [staticWorkerUrl],
    healthPath: "/health",
    healthcheckTimeoutMs: 1000,
    healthcheckIntervalMs: 10,
    reservationTtlMs: 0,
    ...overrides,
  }
}

function createFakeStaticAttachStore() {
  const instances: Array<Record<string, unknown>> = []
  const workers: Array<Record<string, unknown>> = []
  const tokens: Array<Record<string, unknown>> = []
  const selectedUrl = { value: "" }

  const data = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                async limit() {
                  if (table !== WorkerInstanceTable) {
                    return []
                  }
                  return instances
                    .filter((entry) => entry.provider === "static"
                      && entry.url === selectedUrl.value
                      && (entry.status === "provisioning" || entry.status === "healthy"))
                    .map((entry) => ({ id: entry.id }))
                },
              }
            },
          }
        },
      }
    },
    insert(table: unknown) {
      return {
        async values(value: unknown) {
          const values = Array.isArray(value) ? value : [value]
          if (table === WorkerInstanceTable) {
            instances.push(...values as Record<string, unknown>[])
            selectedUrl.value = String((values[0] as Record<string, unknown>).url ?? "")
          } else if (table === WorkerTokenTable) {
            tokens.push(...values as Record<string, unknown>[])
          } else if (table === WorkerTable) {
            workers.push(...values as Record<string, unknown>[])
          }
        },
      }
    },
  }

  return { data, instances, workers, tokens, selectedUrl }
}

function createStaticAttachRouteApp(input: {
  role?: string
  isOwner?: boolean
  store?: ReturnType<typeof createFakeStaticAttachStore>
  fetchReachable?: typeof workersCoreModule.assertStaticWorkerReachable
  lookup?: Parameters<typeof workersSharedModule.validateResolvedStaticWorkerAttachUrl>[2]
}) {
  const app = new Hono()
  const store = input.store ?? createFakeStaticAttachStore()
  const userId = createDenTypeId("user")
  const orgId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")

  workersCoreModule.registerStaticWorkerAttachRoute(app as never, {
    data: store.data as never,
    lookup: input.lookup ?? (async () => [{ address: "203.0.113.10", family: 4 }]),
    fetchReachable: input.fetchReachable ?? (async () => undefined),
    getWorkerLimit: async () => ({ exceeded: false, limit: 10, currentCount: 0 }),
    lock: async (run) => run(store.data as never),
    middlewares: [
      async (c, next) => {
        c.set("user", { id: userId, email: "admin@example.com", name: "Admin" })
        c.set("activeOrganizationId", orgId)
        c.set("organizationContext", {
          organization: { id: orgId },
          currentMember: {
            id: memberId,
            userId,
            role: input.role ?? "admin",
            createdAt: new Date(),
            isOwner: input.isOwner ?? false,
          },
        })
        await next()
      },
      jsonValidator(workersSharedModule.attachStaticWorkerSchema),
    ] as never,
  })
  return { app, store }
}

async function postStaticAttach(app: Hono, overrides: Record<string, unknown> = {}) {
  return app.request("http://den.local/v1/workers/static-attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Static Attach Route Worker",
      url: "http://worker.example.com",
      clientToken: "valid-client-token",
      hostToken: "valid-host-token",
      ...overrides,
    }),
  })
}

beforeAll(async () => {
  seedRequiredEnv()
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const authorization = request.headers.get("authorization")
      const hostToken = request.headers.get("x-openwork-host-token")
      if (url.pathname === "/health") {
        return Response.json({ ok: true })
      }
      if (url.pathname === "/workspaces") {
        return authorization === "Bearer valid-client-token"
          ? Response.json({ items: [], activeId: null })
          : Response.json({ error: "unauthorized" }, { status: 401 })
      }
      if (url.pathname === "/env/keys") {
        return hostToken === "valid-host-token"
          ? Response.json({ keys: [] })
          : Response.json({ error: "forbidden" }, { status: 403 })
      }
      if (url.pathname === "/redirect-workspaces") {
        return new Response(null, { status: 302, headers: { location: "/workspaces" } })
      }
      if (url.pathname === "/hang-health") {
        return new Promise<Response>(() => {})
      }
      return new Response("not found", { status: 404 })
    },
  })
  staticWorkerUrl = `http://127.0.0.1:${server.port}`
  process.env.STATIC_WORKER_URLS = staticWorkerUrl
  process.env.STATIC_WORKER_TOKEN_MAP_JSON = JSON.stringify({
    [staticWorkerUrl]: { clientToken: "valid-client-token", hostToken: "valid-host-token" },
  })
  envModule = await import("../src/env.js")
  provisionerModule = await import("../src/workers/provisioner.js")
  workersSharedModule = await import("../src/routes/workers/shared.js")
  workersCoreModule = await import("../src/routes/workers/core.js")
})

afterAll(() => {
  server.stop(true)
})

test("static provisioner assigns a configured healthy worker URL", async () => {
  const provisioned = await provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_health_123",
      name: "Static Health",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    },
    staticWorkerConfig(),
  )

  expect(provisioned).toEqual({
    provider: "static",
    region: "on-prem",
    status: "healthy",
    url: staticWorkerUrl,
  })
})

test("static provisioner verifies configured token-map tokens against worker runtime", async () => {
  const provisioned = await provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_token_map_auth_123",
      name: "Static Token Map Auth",
      hostToken: "generated-host-token-not-used",
      clientToken: "generated-client-token-not-used",
      activityToken: "activity-token",
    },
    staticWorkerConfig({
      tokenMap: {
        [staticWorkerUrl]: { clientToken: "valid-client-token", hostToken: "valid-host-token" },
      },
    }),
  )

  expect(provisioned.url).toBe(staticWorkerUrl)
  expect(provisioned.status).toBe("healthy")

  await expect(provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_token_map_reject_123",
      name: "Static Token Map Reject",
      hostToken: "generated-host-token-not-used",
      clientToken: "generated-client-token-not-used",
      activityToken: "activity-token",
    },
    staticWorkerConfig({
      tokenMap: {
        [staticWorkerUrl]: { clientToken: "invalid-client-token", hostToken: "valid-host-token" },
      },
    }),
  )).rejects.toThrow("Worker rejected configured static client token")
})

test("static provisioner skips URLs already assigned to active workers", async () => {
  const provisioned = await provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_available_url_123",
      name: "Static Available URL",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
      unavailableStaticWorkerUrls: ["http://127.0.0.1:1/"],
    },
    staticWorkerConfig({
      urls: ["http://127.0.0.1:1/", staticWorkerUrl],
    }),
  )

  expect(provisioned.url).toBe(staticWorkerUrl)
  expect(provisioned.status).toBe("healthy")
})

test("static provisioner fails clearly when every configured URL is already active", async () => {
  await expect(provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_exhausted_123",
      name: "Static Exhausted",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
      unavailableStaticWorkerUrls: [staticWorkerUrl],
    },
    staticWorkerConfig({
      urls: [staticWorkerUrl],
    }),
  )).rejects.toThrow("No available static worker URL remains")
})

test("static provisioner combines configured and runtime unavailable URLs", async () => {
  await expect(provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_combined_unavailable_123",
      name: "Static Combined Unavailable",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
      unavailableStaticWorkerUrls: [staticWorkerUrl],
    },
    staticWorkerConfig({
      urls: ["http://127.0.0.1:1", staticWorkerUrl],
      unavailableUrls: ["http://127.0.0.1:1"],
    }),
  )).rejects.toThrow("No available static worker URL remains")
})

test("static selector exhausts against DB-recomputed active normalized URLs", () => {
  expect(() => provisionerModule.selectStaticWorkerUrlFromPool(
    "worker_static_db_active_exhausted_123",
    staticWorkerConfig({
      urls: [staticWorkerUrl],
      unavailableUrls: [`${staticWorkerUrl}/`],
    }),
  )).toThrow("No available static worker URL remains")
})

test("static selector allows failed or stopped URLs when DB active set excludes them", () => {
  const selected = provisionerModule.selectStaticWorkerUrlFromPool(
    "worker_static_db_failed_reuse_123",
    staticWorkerConfig({
      urls: [staticWorkerUrl],
      unavailableUrls: [],
    }),
  )

  expect(selected).toBe(staticWorkerUrl)
})

test("static DB assignment lock releases only after reservation transaction completes", async () => {
  const events: string[] = []
  const result = await workersSharedModule.withStaticAssignmentLockUsing({
    pool: {
      async getConnection() {
        return {
          async query(statement: string) {
            if (statement.includes("GET_LOCK")) {
              events.push("lock:acquired")
              return [[{ acquired: 1 }], []]
            }
            if (statement.includes("RELEASE_LOCK")) {
              events.push("lock:released")
              return [[{}], []]
            }
            throw new Error(`unexpected query: ${statement}`)
          },
          release() {
            events.push("connection:released")
          },
        }
      },
    },
    async transaction(run) {
      events.push("transaction:started")
      const value = await run({} as never)
      events.push("transaction:committed")
      return value
    },
    async run() {
      events.push("reservation:inserted")
      return "reserved"
    },
  })

  expect(result).toBe("reserved")
  expect(events).toEqual([
    "lock:acquired",
    "transaction:started",
    "reservation:inserted",
    "transaction:committed",
    "lock:released",
    "connection:released",
  ])
})

test("static attach permission gate allows owners and admins only", () => {
  expect(workersSharedModule.canAttachStaticWorkerForMember({ currentMember: { isOwner: true, role: "member" } })).toBe(true)
  expect(workersSharedModule.canAttachStaticWorkerForMember({ currentMember: { isOwner: false, role: "admin" } })).toBe(true)
  expect(workersSharedModule.canAttachStaticWorkerForMember({ currentMember: { isOwner: false, role: "member" } })).toBe(false)
})

test("static attach route requires authentication", async () => {
  const app = new Hono()
  workersCoreModule.registerWorkerCoreRoutes(app)

  const response = await app.request("http://den.local/v1/workers/static-attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Static", url: staticWorkerUrl, clientToken: "valid-client-token", hostToken: "valid-host-token" }),
  })

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: "unauthorized" })
})

test("static attach route succeeds for organization admin without token echo", async () => {
  const { app, store } = createStaticAttachRouteApp({ role: "admin" })
  const response = await postStaticAttach(app)
  const payload = await response.json() as Record<string, unknown>

  expect(response.status).toBe(201)
  expect(payload.worker).toBeTruthy()
  expect(payload.instance).toBeTruthy()
  expect(JSON.stringify(payload).includes("valid-client-token")).toBe(false)
  expect(JSON.stringify(payload).includes("valid-host-token")).toBe(false)
  expect(store.tokens.map((entry) => entry.scope).sort()).toEqual(["activity", "client", "host"])
})

test("static attach route rejects ordinary organization members", async () => {
  const { app } = createStaticAttachRouteApp({ role: "member", isOwner: false })
  const response = await postStaticAttach(app)

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toMatchObject({ error: "forbidden" })
})

test("static attach route rejects duplicate URLs before verification", async () => {
  const store = createFakeStaticAttachStore()
  store.instances.push({ id: "existing", provider: "static", url: "http://worker.example.com", status: "healthy" })
  store.selectedUrl.value = "http://worker.example.com"
  const { app } = createStaticAttachRouteApp({ store })
  const response = await postStaticAttach(app)

  expect(response.status).toBe(409)
  await expect(response.json()).resolves.toMatchObject({ error: "worker_url_already_attached" })
})

test("static attach route re-checks duplicate URL inside lock before insert", async () => {
  const store = createFakeStaticAttachStore()
  const app = new Hono()
  workersCoreModule.registerStaticWorkerAttachRoute(app as never, {
    data: store.data as never,
    lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchReachable: async () => undefined,
    getWorkerLimit: async () => ({ exceeded: false, limit: 10, currentCount: 0 }),
    lock: async (run) => {
      store.instances.push({ id: "raced", provider: "static", url: "http://worker.example.com", status: "healthy" })
      store.selectedUrl.value = "http://worker.example.com"
      return run(store.data as never)
    },
    middlewares: [
      async (c, next) => {
        const userId = createDenTypeId("user")
        const orgId = createDenTypeId("organization")
        c.set("user", { id: userId, email: "admin@example.com" })
        c.set("activeOrganizationId", orgId)
        c.set("organizationContext", { currentMember: { id: createDenTypeId("member"), userId, role: "admin", createdAt: new Date(), isOwner: false } })
        await next()
      },
      jsonValidator(workersSharedModule.attachStaticWorkerSchema),
    ] as never,
  })

  const response = await postStaticAttach(app)
  expect(response.status).toBe(409)
  expect(store.workers).toHaveLength(0)
})

test("static attach route checks worker quota inside lock before insert", async () => {
  const store = createFakeStaticAttachStore()
  let lockActive = false
  let quotaCheckedInsideLock = false
  const app = new Hono()
  workersCoreModule.registerStaticWorkerAttachRoute(app as never, {
    data: store.data as never,
    lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchReachable: async () => undefined,
    getWorkerLimit: async () => {
      quotaCheckedInsideLock = lockActive
      return { exceeded: true, limit: 1, currentCount: 1 }
    },
    lock: async (run) => {
      lockActive = true
      try {
        return await run(store.data as never)
      } finally {
        lockActive = false
      }
    },
    middlewares: [
      async (c, next) => {
        const userId = createDenTypeId("user")
        const orgId = createDenTypeId("organization")
        c.set("user", { id: userId, email: "admin@example.com" })
        c.set("activeOrganizationId", orgId)
        c.set("organizationContext", { currentMember: { id: createDenTypeId("member"), userId, role: "admin", createdAt: new Date(), isOwner: false } })
        await next()
      },
      jsonValidator(workersSharedModule.attachStaticWorkerSchema),
    ] as never,
  })

  const response = await postStaticAttach(app)
  expect(response.status).toBe(409)
  await expect(response.json()).resolves.toMatchObject({ error: "org_limit_reached" })
  expect(quotaCheckedInsideLock).toBe(true)
  expect(store.workers).toHaveLength(0)
})

test("static attach route rejects invalid URL", async () => {
  const { app } = createStaticAttachRouteApp({})
  const response = await postStaticAttach(app, { url: "ftp://worker.example.com" })

  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" })
})

test("static attach route rejects invalid client and host tokens", async () => {
  const clientFailure = createStaticAttachRouteApp({
    fetchReachable: async () => { throw new Error("arbitrary upstream text valid-client-token") },
  })
  const clientResponse = await postStaticAttach(clientFailure.app)
  const clientPayload = await clientResponse.json() as Record<string, unknown>
  expect(clientResponse.status).toBe(400)
  expect(clientPayload.message).toBe("Static worker verification failed with the provided URL and tokens.")
  expect(JSON.stringify(clientPayload).includes("valid-client-token")).toBe(false)

  const hostFailure = createStaticAttachRouteApp({
    fetchReachable: async () => { throw new Error("arbitrary upstream text valid-host-token") },
  })
  const hostResponse = await postStaticAttach(hostFailure.app)
  const hostPayload = await hostResponse.json() as Record<string, unknown>
  expect(hostResponse.status).toBe(400)
  expect(hostPayload.message).toBe("Static worker verification failed with the provided URL and tokens.")
  expect(JSON.stringify(hostPayload).includes("valid-host-token")).toBe(false)
})

test("static attach URL policy rejects unsafe URLs and allows explicit on-prem hosts", () => {
  const defaultPolicy = { allowPrivate: false, allowedHosts: [], allowedCidrs: [] }

  expect(workersSharedModule.validateStaticWorkerAttachUrl("ftp://worker.example.com", defaultPolicy)).toMatchObject({ ok: false })
  expect(workersSharedModule.validateStaticWorkerAttachUrl("http://user:pass@worker.example.com", defaultPolicy)).toMatchObject({ ok: false })
  expect(workersSharedModule.validateStaticWorkerAttachUrl("http://worker.example.com/?token=abc", defaultPolicy)).toMatchObject({ ok: false })
  expect(workersSharedModule.validateStaticWorkerAttachUrl("http://127.0.0.1:8787", defaultPolicy)).toMatchObject({ ok: false })
  expect(workersSharedModule.validateStaticWorkerAttachUrl("http://127.0.0.1:8787", { ...defaultPolicy, allowedCidrs: ["127.0.0.0/8"] })).toMatchObject({
    ok: true,
    url: "http://127.0.0.1:8787",
  })
  expect(workersSharedModule.validateStaticWorkerAttachUrl("http://lan-worker.local:8787", { ...defaultPolicy, allowedHosts: ["lan-worker.local"] })).toMatchObject({ ok: true })
  expect(workersSharedModule.validateStaticWorkerAttachUrl("http://lan-worker.local:8787", { ...defaultPolicy, allowedCidrs: ["192.168.0.0/16"] })).toMatchObject({ ok: true })
  expect(workersSharedModule.validateStaticWorkerAttachUrl("http://[fd00::10]:8787", { ...defaultPolicy, allowedCidrs: ["fd00::/8"] })).toMatchObject({
    ok: true,
    url: "http://[fd00::10]:8787",
  })
})

test("static attach URL policy blocks DNS names resolving to unsafe IPv4 and IPv6 addresses", async () => {
  await expect(workersSharedModule.validateResolvedStaticWorkerAttachUrl(
    "http://public-name.example.com",
    { allowPrivate: false, allowedHosts: [], allowedCidrs: [] },
    async () => [{ address: "127.0.0.1", family: 4 }],
  )).resolves.toMatchObject({ ok: false })

  await expect(workersSharedModule.validateResolvedStaticWorkerAttachUrl(
    "http://public-name.example.com",
    { allowPrivate: false, allowedHosts: [], allowedCidrs: [] },
    async () => [{ address: "fe80::1", family: 6 }],
  )).resolves.toMatchObject({ ok: false })

  await expect(workersSharedModule.validateResolvedStaticWorkerAttachUrl(
    "http://public-name.example.com",
    { allowPrivate: false, allowedHosts: [], allowedCidrs: ["127.0.0.0/8"] },
    async () => [{ address: "127.0.0.1", family: 4 }],
  )).resolves.toMatchObject({ ok: true })

  await expect(workersSharedModule.validateResolvedStaticWorkerAttachUrl(
    "http://allowed-host.example.com",
    { allowPrivate: false, allowedHosts: ["allowed-host.example.com"], allowedCidrs: [] },
    async () => [{ address: "::1", family: 6 }],
  )).resolves.toMatchObject({ ok: false })
})

test("static attach URL policy allows explicitly allow-listed HTTPS hostnames", async () => {
  await expect(workersSharedModule.validateResolvedStaticWorkerAttachUrl(
    "https://worker.example.com",
    { allowPrivate: false, allowedHosts: ["worker.example.com"], allowedCidrs: [] },
    async () => [{ address: "203.0.113.10", family: 4 }],
  )).resolves.toMatchObject({ ok: true })
})

test("static attach URL policy rejects public HTTP hosts unless explicitly allowed", async () => {
  await expect(workersSharedModule.validateResolvedStaticWorkerAttachUrl(
    "http://worker.example.com:8787",
    { allowPrivate: false, allowedHosts: [], allowedCidrs: [] },
    async () => [{ address: "203.0.113.10", family: 4 }],
  )).resolves.toMatchObject({ ok: false })

  await expect(workersSharedModule.validateResolvedStaticWorkerAttachUrl(
    "http://worker.example.com:8787",
    { allowPrivate: false, allowedHosts: ["worker.example.com"], allowedCidrs: [] },
    async () => [{ address: "203.0.113.10", family: 4 }],
  )).resolves.toMatchObject({ ok: true })

  await expect(workersSharedModule.validateResolvedStaticWorkerAttachUrl(
    "http://worker.example.com:8787",
    { allowPrivate: false, allowedHosts: [], allowedCidrs: ["10.0.0.0/8"] },
    async () => [{ address: "203.0.113.10", family: 4 }, { address: "10.1.2.3", family: 4 }],
  )).resolves.toMatchObject({ ok: false })
})

test("static attach URL policy rejects non-allow-listed HTTPS hostnames", async () => {
  await expect(workersSharedModule.validateResolvedStaticWorkerAttachUrl(
    "https://worker.example.com",
    { allowPrivate: false, allowedHosts: [], allowedCidrs: [] },
    async () => [{ address: "203.0.113.10", family: 4 }],
  )).resolves.toMatchObject({ ok: false })
})

test("static attach URL policy still rejects allow-listed HTTPS hostnames resolving to unsafe addresses", async () => {
  await expect(workersSharedModule.validateResolvedStaticWorkerAttachUrl(
    "https://worker.example.com",
    { allowPrivate: false, allowedHosts: ["worker.example.com"], allowedCidrs: [] },
    async () => [{ address: "127.0.0.1", family: 4 }],
  )).resolves.toMatchObject({ ok: false })
})

test("static attach verification fetch uses the validated IP address instead of re-resolving hostname", async () => {
  const seenHosts: string[] = []
  const pinServer = Bun.serve({
    port: 0,
    fetch(request) {
      seenHosts.push(request.headers.get("host") ?? "")
      const url = new URL(request.url)
      if (url.pathname === "/workspaces") {
        return Response.json({ items: [] })
      }
      if (url.pathname === "/env/keys") {
        return Response.json({ keys: [] })
      }
      return new Response("not found", { status: 404 })
    },
  })
  try {
    const target = await workersSharedModule.validateResolvedStaticWorkerAttachUrl(
      `http://rebinding-worker.test:${pinServer.port}`,
      { allowPrivate: false, allowedHosts: [], allowedCidrs: ["127.0.0.0/8"] },
      async () => [{ address: "127.0.0.1", family: 4 }],
    )
    expect(target.ok).toBe(true)
    if (target.ok) {
      await workersCoreModule.assertStaticWorkerReachable(target, "valid-client-token", "valid-host-token")
    }
    expect(seenHosts).toEqual([`rebinding-worker.test:${pinServer.port}`, `rebinding-worker.test:${pinServer.port}`])
  } finally {
    pinServer.stop(true)
  }
})

test("static worker token discovery pins the validated address before sending client token", async () => {
  const seenHosts: string[] = []
  const pinServer = Bun.serve({
    port: 0,
    fetch(request) {
      seenHosts.push(request.headers.get("host") ?? "")
      const authorization = request.headers.get("authorization")
      const url = new URL(request.url)
      if (url.pathname === "/workspaces" && authorization === "Bearer valid-client-token") {
        return Response.json({ items: [{ id: "workspace_static_pin", active: true }] })
      }
      return new Response("not found", { status: 404 })
    },
  })
  try {
    tokenQueryRows = [
      { scope: "host", token: "valid-host-token" },
      { scope: "client", token: "valid-client-token" },
    ]
    instanceQueryRows = [{ provider: "static", url: `http://localhost:${pinServer.port}` }]

    const resolved = await workersSharedModule.getWorkerTokensAndConnect({ id: "worker_static_token_pin_123" } as never)

    expect("tokens" in resolved).toBe(true)
    expect("connect" in resolved ? resolved.connect?.workspaceId : null).toBe("workspace_static_pin")
    expect("connect" in resolved ? resolved.connect?.openworkUrl : null).toBe(`http://localhost:${pinServer.port}/w/workspace_static_pin`)
    expect(seenHosts).toEqual([`localhost:${pinServer.port}`])
  } finally {
    tokenQueryRows = []
    instanceQueryRows = []
    pinServer.stop(true)
  }
})

test("static runtime fetch does not forward host token across redirects", async () => {
  const redirectedRequests: string[] = []
  const redirectTarget = Bun.serve({
    port: 0,
    fetch(request) {
      redirectedRequests.push(request.headers.get("x-openwork-host-token") ?? "")
      return Response.json({ ok: true })
    },
  })
  const redirectSource = Bun.serve({
    port: 0,
    fetch() {
      return new Response(null, {
        status: 307,
        headers: { location: `http://127.0.0.1:${redirectTarget.port}/sink` },
      })
    },
  })
  try {
    tokenQueryRows = [
      { scope: "host", token: "valid-host-token" },
      { scope: "client", token: "valid-client-token" },
    ]
    instanceQueryRows = [{ provider: "static", url: `http://localhost:${redirectSource.port}` }]

    const response = await workersSharedModule.fetchWorkerRuntimeJson({
      workerId: "worker_static_runtime_redirect_123" as never,
      path: "/runtime/upgrade",
      method: "POST",
      body: { providerToken: "secret" },
    })

    expect(response.ok).toBe(false)
    expect(response.status).toBe(307)
    expect(redirectedRequests).toEqual([])
  } finally {
    tokenQueryRows = []
    instanceQueryRows = []
    redirectSource.stop(true)
    redirectTarget.stop(true)
  }
})

test("static runtime versions uses the client bearer token", async () => {
  const seenAuthorization: string[] = []
  const runtimeServer = Bun.serve({
    port: 0,
    fetch(request) {
      seenAuthorization.push(request.headers.get("authorization") ?? "")
      return Response.json({ versions: [] })
    },
  })
  try {
    tokenQueryRows = [
      { scope: "host", token: "valid-host-token" },
      { scope: "client", token: "valid-client-token" },
    ]
    instanceQueryRows = [{ provider: "static", url: `http://localhost:${runtimeServer.port}` }]

    const response = await workersSharedModule.fetchWorkerRuntimeJson({
      workerId: "worker_static_runtime_versions_123" as never,
      path: "/runtime/versions",
      auth: "client",
    })

    expect(response.ok).toBe(true)
    expect(seenAuthorization).toEqual(["Bearer valid-client-token"])
  } finally {
    tokenQueryRows = []
    instanceQueryRows = []
    runtimeServer.stop(true)
  }
})

test("static token reads are limited to creator, owners, and admins", () => {
  const creatorId = createDenTypeId("user")
  const otherUserId = createDenTypeId("user")
  const worker = { created_by_user_id: creatorId }

  expect(workersSharedModule.canReadStaticWorkerTokensForMember({ worker, userId: creatorId, currentMember: { isOwner: false, role: "member" } })).toBe(true)
  expect(workersSharedModule.canReadStaticWorkerTokensForMember({ worker, userId: otherUserId, currentMember: { isOwner: true, role: "member" } })).toBe(true)
  expect(workersSharedModule.canReadStaticWorkerTokensForMember({ worker, userId: otherUserId, currentMember: { isOwner: false, role: "admin" } })).toBe(true)
  expect(workersSharedModule.canReadStaticWorkerTokensForMember({ worker, userId: otherUserId, currentMember: { isOwner: false, role: "member" } })).toBe(false)
})

test("static pool health checks preserve pinned host headers", async () => {
  const seenHosts: string[] = []
  const pinServer = Bun.serve({
    port: 0,
    fetch(request) {
      seenHosts.push(request.headers.get("host") ?? "")
      return Response.json({ ok: true })
    },
  })
  try {
    await provisionerModule.checkStaticWorkerHealth({
      url: `http://127.0.0.1:${pinServer.port}`,
      headers: { Host: `worker-static.test:${pinServer.port}` },
    }, staticWorkerConfig())

    expect(seenHosts).toEqual([`worker-static.test:${pinServer.port}`])
  } finally {
    pinServer.stop(true)
  }
})

test("static attach verification keeps HTTPS hostname for certificate validation", async () => {
  const originalFetch = globalThis.fetch
  const requestedUrls: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requestedUrls.push(String(input))
    return Promise.resolve(Response.json({ ok: true }))
  }) as typeof fetch
  try {
    await workersCoreModule.assertStaticWorkerReachable({
      ok: true,
      url: "https://worker.example.com:8787",
      resolvedAddresses: [{ address: "203.0.113.10", family: 4 }],
    }, "valid-client-token", "valid-host-token")
    expect(requestedUrls).toEqual([
      "https://worker.example.com:8787/workspaces",
      "https://worker.example.com:8787/env/keys",
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("static attach worker token verification succeeds without following redirects", async () => {
  await expect(workersCoreModule.assertStaticWorkerReachable(staticWorkerUrl, "valid-client-token", "valid-host-token")).resolves.toBeUndefined()

  const redirectResponse = await workersCoreModule.fetchStaticWorker(staticWorkerUrl, "/redirect-workspaces", {})
  expect(redirectResponse.status).toBe(302)
})

test("static attach worker token verification rejects invalid client and host tokens without echoing tokens", async () => {
  await expect(workersCoreModule.assertStaticWorkerReachable(staticWorkerUrl, "invalid-client-token", "valid-host-token"))
    .rejects.toThrow("Worker rejected the provided client token with HTTP 401")
  await expect(workersCoreModule.assertStaticWorkerReachable(staticWorkerUrl, "valid-client-token", "invalid-host-token"))
    .rejects.toThrow("Worker rejected the provided host token with HTTP 403")

  try {
    await workersCoreModule.assertStaticWorkerReachable(staticWorkerUrl, "invalid-client-token", "valid-host-token")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message.includes("invalid-client-token")).toBe(false)
    expect(message.includes("valid-host-token")).toBe(false)
  }
})

test("static provisioner fails clearly when no worker URLs are configured", async () => {
  await expect(provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_missing_url_123",
      name: "Static Missing URL",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    },
    staticWorkerConfig({
      urls: [],
    }),
  )).rejects.toThrow("STATIC_WORKER_URLS is required when PROVISIONER_MODE=static")
})

test("static provisioner fails clearly when health check does not pass", async () => {
  await expect(provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_unhealthy_123",
      name: "Static Unhealthy",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    },
    staticWorkerConfig({
      urls: [`${staticWorkerUrl}/missing`],
      healthcheckTimeoutMs: 50,
    }),
  )).rejects.toThrow("Timed out waiting for worker health endpoint")
})

test("static provisioner aborts a hanging health check within the configured timeout", async () => {
  const startedAt = performance.now()

  await expect(provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_hanging_health_123",
      name: "Static Hanging Health",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    },
    staticWorkerConfig({
      healthPath: "/hang-health",
      healthcheckTimeoutMs: 75,
    }),
  )).rejects.toThrow("Timed out waiting for worker health endpoint")

  expect(performance.now() - startedAt).toBeLessThan(1000)
})

test("static env validation requires config only when static mode is enabled", () => {
  expect(envModule.parseStaticWorkersEnv({ STATIC_WORKER_URLS: undefined }).issues).toContainEqual({
    path: "STATIC_WORKER_URLS",
    message: "STATIC_WORKER_URLS is required when PROVISIONER_MODE=static",
  })
  expect(envModule.parseStaticWorkersEnv({ STATIC_WORKER_URLS: undefined }).issues).toContainEqual({
    path: "STATIC_WORKER_TOKEN_MAP_JSON",
    message: "STATIC_WORKER_TOKEN_MAP_JSON is required when PROVISIONER_MODE=static",
  })
})

test("static env validation normalizes URLs and rejects duplicate normalized URLs", () => {
  const parsed = envModule.parseStaticWorkersEnv({
    STATIC_WORKER_URLS: "https://Worker.Example.com/, https://worker.example.com",
    STATIC_WORKER_TOKEN_MAP_JSON: JSON.stringify({
      "https://worker.example.com": { clientToken: "client-token", hostToken: "host-token" },
    }),
  })

  expect(parsed.urls).toEqual(["https://worker.example.com"])
  expect(parsed.issues.some((issue) => issue.message.includes("duplicate URL https://worker.example.com"))).toBe(true)
})

test("static env validation rejects invalid URL, protocol, health path, and timeout values", () => {
  const parsed = envModule.parseStaticWorkersEnv({
    STATIC_WORKER_URLS: "not-a-url, ftp://worker.example.com",
    STATIC_WORKER_HEALTH_PATH: "health?ready=1",
    STATIC_WORKER_HEALTHCHECK_TIMEOUT_MS: "0",
    STATIC_WORKER_HEALTHCHECK_INTERVAL_MS: "NaN",
    STATIC_WORKER_RESERVATION_TTL_MS: "-1",
    STATIC_WORKER_TOKEN_MAP_JSON: "not-json",
  })

  expect(parsed.issues.some((issue) => issue.message === "STATIC_WORKER_URLS entries must be valid URLs")).toBe(true)
  expect(parsed.issues.some((issue) => issue.message === "STATIC_WORKER_URLS entries must use http or https URLs")).toBe(true)
  expect(parsed.issues.some((issue) => issue.path === "STATIC_WORKER_HEALTH_PATH")).toBe(true)
  expect(parsed.issues.some((issue) => issue.path === "STATIC_WORKER_HEALTHCHECK_TIMEOUT_MS")).toBe(true)
  expect(parsed.issues.some((issue) => issue.path === "STATIC_WORKER_HEALTHCHECK_INTERVAL_MS")).toBe(true)
  expect(parsed.issues.some((issue) => issue.path === "STATIC_WORKER_RESERVATION_TTL_MS")).toBe(true)
  expect(parsed.issues.some((issue) => issue.message === "STATIC_WORKER_TOKEN_MAP_JSON must be valid JSON")).toBe(true)
})

test("static env validation requires one token-map pair per configured worker URL", () => {
  const parsed = envModule.parseStaticWorkersEnv({
    STATIC_WORKER_URLS: "http://worker-a.example.com,http://worker-b.example.com",
    STATIC_WORKER_TOKEN_MAP_JSON: JSON.stringify({
      "http://worker-a.example.com/": { clientToken: "client-a", hostToken: "host-a" },
      "http://worker-extra.example.com": { clientToken: "client-extra", hostToken: "host-extra" },
    }),
  })

  expect(parsed.tokenMap["http://worker-a.example.com"]).toEqual({ clientToken: "client-a", hostToken: "host-a" })
  expect(parsed.issues.some((issue) => issue.message.includes("missing token pair for http://worker-b.example.com"))).toBe(true)
  expect(parsed.issues.some((issue) => issue.message.includes("unconfigured URL http://worker-extra.example.com"))).toBe(true)
})

test("static provisioner in-process reservations prevent concurrent duplicate assignment", async () => {
  const config = staticWorkerConfig({ reservationTtlMs: 1000 })
  const first = provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_concurrent_a_123",
      name: "Static Concurrent A",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    },
    config,
  )
  const second = provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_concurrent_b_123",
      name: "Static Concurrent B",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    },
    config,
  )

  const results = await Promise.allSettled([first, second])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)

  const fulfilled = results.find((result): result is PromiseFulfilledResult<ProvisionedInstance> => result.status === "fulfilled")
  expect(fulfilled?.value.url).toBe(staticWorkerUrl)
  await provisionerModule.deprovisionWorker({ workerId: "worker_static_concurrent_a_123", instanceUrl: staticWorkerUrl })
  await provisionerModule.deprovisionWorker({ workerId: "worker_static_concurrent_b_123", instanceUrl: staticWorkerUrl })
})

test("static provisioner releases failed health reservations for reuse", async () => {
  await expect(provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_failed_cleanup_123",
      name: "Static Failed Cleanup",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    },
    staticWorkerConfig({ healthPath: "/missing", healthcheckTimeoutMs: 50, reservationTtlMs: 1000 }),
  )).rejects.toThrow("Timed out waiting for worker health endpoint")

  const provisioned = await provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_failed_cleanup_reuse_123",
      name: "Static Failed Cleanup Reuse",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    },
    staticWorkerConfig(),
  )
  expect(provisioned.url).toBe(staticWorkerUrl)
})

test("static provisioner recovers stale reservations for reuse", async () => {
  const first = await provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_stale_a_123",
      name: "Static Stale A",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    },
    staticWorkerConfig({ reservationTtlMs: 1 }),
  )
  expect(first.url).toBe(staticWorkerUrl)

  await new Promise((resolve) => setTimeout(resolve, 5))

  const second = await provisionerModule.provisionStaticWorker(
    {
      workerId: "worker_static_stale_b_123",
      name: "Static Stale B",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    },
    staticWorkerConfig(),
  )
  expect(second.url).toBe(staticWorkerUrl)
})
