import { beforeAll, expect, test } from "bun:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { paramValidator } from "../src/middleware/validation.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let managedProviderModule: typeof import("../src/routes/workers/managed-providers.js")
let workersSharedModule: typeof import("../src/routes/workers/shared.js")

beforeAll(async () => {
  seedRequiredEnv()
  managedProviderModule = await import("../src/routes/workers/managed-providers.js")
  workersSharedModule = await import("../src/routes/workers/shared.js")
})

function createApp(input: {
  role?: string
  isOwner?: boolean
  listProviders?: Parameters<typeof managedProviderModule.registerManagedProviderSyncRoutes>[1]["listProviders"]
  pushRuntime?: Parameters<typeof managedProviderModule.registerManagedProviderSyncRoutes>[1]["pushRuntime"]
}) {
  const app = new Hono()
  const orgId = createDenTypeId("organization")
  const workerId = createDenTypeId("worker")
  const provider = {
    id: createDenTypeId("llmProvider"),
    providerId: "anthropic",
    name: "Anthropic",
    source: "models_dev" as const,
    credentialKind: "api_key" as const,
    providerConfig: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], npm: "@ai-sdk/anthropic" },
    models: [{ id: "claude", name: "Claude", config: { id: "claude" } }],
    apiKey: "plain-provider-secret-den-test",
    revision: "rev-1",
  }
  managedProviderModule.registerManagedProviderSyncRoutes(app as never, {
    middlewares: [
      async (c, next) => {
        c.set("activeOrganizationId", orgId)
        c.set("organizationContext", {
          organization: { id: orgId },
          currentMember: { id: createDenTypeId("member"), userId: createDenTypeId("user"), role: input.role ?? "admin", isOwner: input.isOwner ?? false },
        })
        await next()
      },
      paramValidator(workersSharedModule.workerIdParamSchema),
    ] as never,
    getWorker: async (id, activeOrgId) => id === workerId && activeOrgId === orgId ? { id } : null,
    listProviders: input.listProviders ?? (async () => [provider]),
    pushRuntime: input.pushRuntime ?? (async () => ({ ok: true, status: 200, payload: { status: "applied" } })),
  })
  return { app, workerId, provider }
}

test("managed provider sync rejects non-admin members", async () => {
  const { app, workerId } = createApp({ role: "member" })
  const response = await app.request(`http://den.local/v1/workers/${workerId}/managed-providers/sync`, { method: "POST" })
  expect(response.status).toBe(403)
})

test("managed provider sync sends credentials only to worker runtime and redacts response", async () => {
  const calls: unknown[] = []
  const { app, workerId, provider } = createApp({
    pushRuntime: async (_workerId, payload) => {
      calls.push(payload)
      return { ok: true, status: 200, payload: { status: "applied", apiKey: provider.apiKey } }
    },
  })

  const response = await app.request(`http://den.local/v1/workers/${workerId}/managed-providers/sync`, { method: "POST" })
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(JSON.stringify(body)).not.toContain("plain-provider-secret")
  expect(JSON.stringify(calls[0])).toContain("plain-provider-secret-den-test")
  expect(body).toMatchObject({ status: "applied", providerCount: 1 })
})

test("managed provider sync sanitizes worker failures", async () => {
  const { app, workerId } = createApp({
    pushRuntime: async () => ({ ok: false, status: 500, payload: { message: "failed with plain-provider-secret-den-test access-token-den refresh-token-den" } }),
  })
  const response = await app.request(`http://den.local/v1/workers/${workerId}/managed-providers/sync`, { method: "POST" })
  expect(response.status).toBe(502)
  const body = await response.json()
  expect(body.status).toBe("failed")
  expect(JSON.stringify(body)).not.toContain("plain-provider-secret")
  expect(JSON.stringify(body)).not.toContain("access-token-den")
  expect(JSON.stringify(body)).not.toContain("refresh-token-den")
  expect(body.reason).toBe("Worker provider sync failed.")
})

test("managed provider sync pushes an empty provider set so workers remove revoked providers", async () => {
  let called = false
  const { app, workerId } = createApp({
    listProviders: async () => [],
    pushRuntime: async (_workerId, payload) => {
      called = true
      expect(payload).toEqual({ providers: [], revision: "empty" })
      return { ok: true, status: 200, payload: { status: "applied" } }
    },
  })

  const response = await app.request(`http://den.local/v1/workers/${workerId}/managed-providers/sync`, { method: "POST" })
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ status: "applied", providerCount: 0, providerIds: [], revision: "empty" })
  expect(called).toBe(true)
})

test("managed provider sync reports missing worker as not found", async () => {
  const { app } = createApp({ role: "admin" })
  const missingWorker = createDenTypeId("worker")
  const response = await app.request(`http://den.local/v1/workers/${missingWorker}/managed-providers/sync`, { method: "POST" })
  expect(response.status).toBe(404)
})

test("managed provider revision is stable and redaction helper removes token-shaped secrets", () => {
  expect(managedProviderModule.computeManagedProviderRevision([{ id: "b", revision: "2" }, { id: "a", revision: "1" }])).toBe("a:1|b:2")
  expect(managedProviderModule.sanitizeManagedProviderSyncFailure({ message: "bad plain-secret access-token refresh-token" })).toBe("Worker provider sync failed.")
})

test("managed provider runtime sync targets only current healthy worker instances", () => {
  expect(workersSharedModule.isWorkerRuntimeSyncTarget({
    workerStatus: "healthy",
    instanceStatus: "healthy",
    instanceUrl: "https://worker.example.com",
    hostToken: "host-token",
  })).toBe(true)
  expect(workersSharedModule.isWorkerRuntimeSyncTarget({
    workerStatus: "failed",
    instanceStatus: "healthy",
    instanceUrl: "https://worker.example.com",
    hostToken: "host-token",
  })).toBe(false)
  expect(workersSharedModule.isWorkerRuntimeSyncTarget({
    workerStatus: "healthy",
    instanceStatus: "failed",
    instanceUrl: "https://stale-reservation.example.com",
    hostToken: "host-token",
  })).toBe(false)
  expect(workersSharedModule.isWorkerRuntimeSyncTarget({
    workerStatus: "healthy",
    instanceStatus: "healthy",
    instanceUrl: "",
    hostToken: "host-token",
  })).toBe(false)
})
