import { afterAll, beforeAll, expect, test } from "bun:test"
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
let server: ReturnType<typeof Bun.serve>
let staticWorkerUrl: string

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
  envModule = await import("../src/env.js")
  provisionerModule = await import("../src/workers/provisioner.js")
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
})

test("static env validation normalizes URLs and rejects duplicate normalized URLs", () => {
  const parsed = envModule.parseStaticWorkersEnv({
    STATIC_WORKER_URLS: "https://Worker.Example.com/, https://worker.example.com",
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
  })

  expect(parsed.issues.some((issue) => issue.message === "STATIC_WORKER_URLS entries must be valid URLs")).toBe(true)
  expect(parsed.issues.some((issue) => issue.message === "STATIC_WORKER_URLS entries must use http or https URLs")).toBe(true)
  expect(parsed.issues.some((issue) => issue.path === "STATIC_WORKER_HEALTH_PATH")).toBe(true)
  expect(parsed.issues.some((issue) => issue.path === "STATIC_WORKER_HEALTHCHECK_TIMEOUT_MS")).toBe(true)
  expect(parsed.issues.some((issue) => issue.path === "STATIC_WORKER_HEALTHCHECK_INTERVAL_MS")).toBe(true)
  expect(parsed.issues.some((issue) => issue.path === "STATIC_WORKER_RESERVATION_TTL_MS")).toBe(true)
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
