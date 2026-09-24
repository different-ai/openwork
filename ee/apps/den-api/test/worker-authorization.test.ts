import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { WorkerInstanceTable, WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono, type MiddlewareHandler } from "hono"
import * as validation from "../src/middleware/validation.js"
import type { WorkerRouteVariables } from "../src/routes/workers/shared.js"
import type { CloudRuntimeOwnership } from "../src/workers/worker-access.js"

type Worker = typeof WorkerTable.$inferSelect
const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const creatorId = createDenTypeId("user")
const otherMemberId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const workerId = createDenTypeId("worker")
const now = new Date("2026-09-22T00:00:00Z")
let worker: Worker
let callerId = creatorId
let callerOrganizationId = organizationId
let apiKeyOrganizationId = organizationId
let role = "member"
let apiKey = false
let authenticated = true
let webAccess = true
let tokenReads = 0
let entitlementReads = 0
let deletedTables: unknown[] = []
let deprovisioned: string[] = []
let runtimeResolutions: CloudRuntimeOwnership[] = []
let upstreamRequests: Array<{ url: string; method: string; headers: Headers }> = []

function fixtureWorker(): Worker {
  return {
    id: workerId,
    org_id: organizationId,
    created_by_user_id: creatorId,
    name: "Worker authorization fixture",
    description: null,
    destination: "cloud",
    status: "healthy",
    image_version: null,
    workspace_path: null,
    sandbox_backend: "cloud-instance",
    cloud_failure_code: null,
    cloud_failure_stage: null,
    cloud_failure_reference: null,
    cloud_failure_at: null,
    last_heartbeat_at: null,
    last_active_at: null,
    created_at: now,
    updated_at: now,
  }
}

function sqlLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(sqlLeaves)
  if (typeof value !== "object" || value === null) return []
  if ("queryChunks" in value && Array.isArray(value.queryChunks)) return value.queryChunks.flatMap(sqlLeaves)
  if ("name" in value && typeof value.name === "string") return [value.name]
  if ("value" in value) return sqlLeaves(value.value)
  return []
}

function selectFixtureRows(table: unknown, condition: unknown, joined: boolean): unknown[] {
  const shape = sqlLeaves(condition).join("")
  if (table === WorkerTable) {
    expect(shape).toContain("id = ")
    expect(shape).toContain("org_id = ")
    return shape.includes(worker.id) && shape.includes(worker.org_id) ? [worker] : []
  }
  if (table === WorkerInstanceTable) {
    expect(shape).toContain(worker.id)
    return [{ id: createDenTypeId("workerInstance"), worker_id: worker.id, provider: "render", region: null,
      url: "https://runtime.example.test", status: "healthy", created_at: now, updated_at: now }]
  }
  if (table === WorkerTokenTable) {
    tokenReads++
    expect(shape).toContain(worker.id)
    expect(shape).toContain("revoked_at is null")
    const tokens = [
      { scope: "host", token: "fixture-host-token" },
      { scope: "client", token: "fixture-client-token" },
      { scope: "activity", token: "fixture-activity-token" },
    ]
    return joined
      ? tokens.filter((entry) => shape.includes(entry.token)).map((entry) => ({ organizationId, scope: entry.scope }))
      : tokens
  }
  throw new Error("unexpected_fixture_storage_read")
}

const fixtureDb = {
  select() {
    return {
      from(table: unknown) {
        let condition: unknown
        let joined = false
        const query = {
          innerJoin() { joined = true; return query },
          where(value: unknown) { condition = value; return query },
          orderBy() { return query },
          limit(count: number) { return Promise.resolve(selectFixtureRows(table, condition, joined).slice(0, count)) },
          then(resolve: (rows: unknown[]) => unknown) { return Promise.resolve(selectFixtureRows(table, condition, joined)).then(resolve) },
        }
        return query
      },
    }
  },
  async transaction(run: (tx: { delete: typeof fixtureDelete }) => Promise<void>) { await run({ delete: fixtureDelete }) },
}
function fixtureDelete(table: unknown) {
  return { async where() { deletedTables.push(table) } }
}

mock.module("../src/db.js", () => ({ db: fixtureDb }))
mock.module("../src/orgs.js", () => ({
  async resolveUserOrganizations(input: { activeOrganizationId: string | null; userId: string }) {
    expect(input.userId).toBe(callerId)
    const org = { id: callerOrganizationId, slug: "worker-fixture", name: "Worker fixture", role, isOwner: role === "owner" }
    return { orgs: [org], activeOrgId: input.activeOrganizationId ?? org.id, activeOrgSlug: org.slug }
  },
  async setSessionActiveOrganization() { throw new Error("unexpected_fixture_session_write") },
}))
const { resolveUserOrganizationsMiddleware } = await import("../src/middleware/user-organizations.js")
const tokenRoute: MiddlewareHandler = async (_c, next) => { await next() }
mock.module("../src/middleware/index.js", () => ({
  ...validation,
  orgMemberRoute: () => resolveUserOrganizationsMiddleware,
  tokenRoute,
}))
mock.module("../src/billing/polar.js", () => ({
  async requireCloudWorkerAccess() { throw new Error("unexpected_fixture_billing") },
}))
mock.module("../src/organization-limits.js", () => ({
  async getOrganizationLimitStatus() { throw new Error("unexpected_fixture_limits") },
}))
mock.module("../src/llm/cloud-provider-materialization.js", () => ({
  async materializeCloudWorkerProviders() { throw new Error("unexpected_fixture_materialization") },
}))
mock.module("../src/workers/provisioner.js", () => ({
  async provisionWorker() { throw new Error("unexpected_fixture_provisioning") },
  async deprovisionWorker(input: { workerId: string }) { deprovisioned.push(input.workerId) },
}))
mock.module("../src/workers/cloud-runtime.js", () => ({
  cloudRuntimeConfigured: () => false,
  isCloudRuntimeProviderId: (provider: string) => provider === "daytona",
  endpointKindForProvider: (provider: string) => provider === "daytona" ? "signed-expiring" : "stable",
}))
mock.module("../src/workers/worker-access.js", () => ({
  async resolveCloudRuntimeAccess(ownership: CloudRuntimeOwnership) {
    runtimeResolutions.push(ownership)
    return { status: "ready", workerId, url: "https://runtime.example.test", expiresAt: new Date("2099-01-01T00:00:00Z"),
      hostToken: "fixture-host-token", clientToken: "fixture-client-token" }
  },
}))
mock.module("../src/openwork-web-runtime-access.js", () => ({
  async getOpenWorkWebRuntimeAccess() { entitlementReads++; return { hasAccess: webAccess } },
  openWorkWebAccessRequiredPayload: () => ({ error: "openwork_web_access_required", message: "Fixture access required" }),
  async requireOpenWorkWebRuntimeAccess() { throw new Error("unexpected_fixture_provisioning_access") },
}))

process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:3306/not_connected"
process.env.DEN_DB_ENCRYPTION_KEY = "fixture-encryption-key-not-a-secret-32"
process.env.BETTER_AUTH_SECRET = "fixture-auth-key-not-a-secret-32-characters"
process.env.DEN_BASE_URL = "http://localhost:3005"
process.env.PROVISIONER_MODE = "stub"

const { registerWorkerCoreRoutes } = await import("../src/routes/workers/core.js")
const { registerWorkerRuntimeRoutes } = await import("../src/routes/workers/runtime.js")
const { registerCloudWorkerCompatibilityRoutes } = await import("../src/routes/workers/compatibility.js")
const app = new Hono<{ Variables: WorkerRouteVariables }>()
app.onError((error) => { throw error })
app.use("*", async (c, next) => {
  c.set("user", authenticated ? { id: callerId, name: "Worker fixture", email: "worker@example.test", emailVerified: true,
    image: null, createdAt: now, updatedAt: now } : null)
  c.set("session", apiKey ? null : { id: createDenTypeId("session"), token: "fixture-session", userId: callerId,
    activeOrganizationId: callerOrganizationId, activeTeamId: null, createdAt: now, updatedAt: now,
    expiresAt: new Date("2099-01-01T00:00:00Z"), ipAddress: null, userAgent: null })
  c.set("apiKey", apiKey ? { id: "fixture-api-key", configId: "default", referenceId: callerId,
    metadata: { organizationId: apiKeyOrganizationId, orgMembershipId: memberId, issuedByUserId: callerId, issuedByOrgMembershipId: memberId } } : null)
  await next()
})
registerWorkerCoreRoutes(app)
registerWorkerRuntimeRoutes(app)
registerCloudWorkerCompatibilityRoutes(app)

beforeEach(() => {
  worker = fixtureWorker()
  callerId = creatorId
  callerOrganizationId = organizationId
  apiKeyOrganizationId = organizationId
  role = "member"
  apiKey = false
  authenticated = true
  webAccess = true
  tokenReads = 0
  entitlementReads = 0
  deletedTables = []
  deprovisioned = []
  runtimeResolutions = []
  upstreamRequests = []
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith("https://runtime.example.test/")) throw new Error("unexpected_fixture_network_request")
    upstreamRequests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) })
    return Response.json(url.endsWith("/workspaces") ? { activeId: "fixture-workspace", items: [] } : { version: "fixture-runtime" })
  })
})
afterAll(() => mock.restore())

const controlRoutes = [
  { method: "POST", suffix: "/tokens", body: {}, status: 200 },
  { method: "POST", suffix: "/tokens", body: { includeExpiringOpenworkUrl: true }, status: 200 },
  { method: "GET", suffix: "/runtime", status: 200 },
  { method: "POST", suffix: "/runtime/upgrade", body: {}, status: 200 },
  { method: "DELETE", suffix: "", status: 204 },
]
function request(route: typeof controlRoutes[number], headers: HeadersInit = {}) {
  return app.request(`/v1/workers/${workerId}${route.suffix}`, { method: route.method,
    headers: { ...Object.fromEntries(new Headers(headers)), "Content-Type": "application/json" },
    body: route.body === undefined ? undefined : JSON.stringify(route.body) })
}
function expectNoRuntimeAuthority() {
  expect(tokenReads).toBe(0)
  expect(entitlementReads).toBe(0)
  expect(runtimeResolutions).toEqual([])
  expect(upstreamRequests).toEqual([])
  expect(deprovisioned).toEqual([])
  expect(deletedTables).toEqual([])
}

for (const route of controlRoutes) {
  const label = `${route.method} ${route.suffix || "/"} ${JSON.stringify(route.body) ?? ""}`
  for (const authMode of ["session", "api-key"]) {
    test(`${label}: creator ${authMode} can control their Cloud worker`, async () => {
      apiKey = authMode === "api-key"
      const response = await request(route)
      expect(response.status).toBe(route.status)
      if (route.suffix === "/tokens") {
        const payload = await response.json()
        expect(payload).toMatchObject({ tokens: {
          owner: "fixture-host-token", host: "fixture-host-token", client: "fixture-client-token",
        } })
        expect(tokenReads).toBe(1)
        if (route.body && "includeExpiringOpenworkUrl" in route.body) {
          expect(runtimeResolutions).toEqual([{ organizationId, workerId }])
          expect(payload).toMatchObject({ directPreview: { version: 1, workspaceId: "fixture-workspace" } })
        } else {
          expect(runtimeResolutions).toEqual([])
          expect(upstreamRequests).toEqual([])
        }
      }
      if (route.suffix.startsWith("/runtime")) {
        expect(runtimeResolutions).toEqual([{ organizationId, workerId }])
        expect(upstreamRequests[0]?.headers.get("X-OpenWork-Host-Token")).toBe("fixture-host-token")
      }
      if (route.method === "DELETE") {
        expect(deprovisioned).toEqual([workerId])
        expect(deletedTables).toContain(WorkerTable)
        expect(deletedTables).toContain(WorkerTokenTable)
      }
    })
    for (const memberRole of ["member", "admin", "owner"]) {
      test(`${label}: another ${memberRole}'s ${authMode} cannot control a Cloud worker`, async () => {
        apiKey = authMode === "api-key"
        callerId = otherMemberId
        role = memberRole
        const response = await request(route)
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ error: "forbidden" })
        expectNoRuntimeAuthority()
      })
    }
    test(`${label}: ${authMode} cannot cross organizations even for the same creator`, async () => {
      apiKey = authMode === "api-key"
      callerOrganizationId = otherOrganizationId
      apiKeyOrganizationId = otherOrganizationId
      const response = await request(route)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: "worker_not_found" })
      expectNoRuntimeAuthority()
    })
  }
  test(`${label}: ownerless Cloud workers fail closed`, async () => {
    worker.created_by_user_id = null
    expect((await request(route)).status).toBe(403)
    expectNoRuntimeAuthority()
  })
  test(`${label}: Cloud ownership is enforced for legacy backends too`, async () => {
    worker.sandbox_backend = "render"
    callerId = otherMemberId
    expect((await request(route)).status).toBe(403)
    expectNoRuntimeAuthority()
  })
  for (const authMode of ["session", "api-key"]) {
    test(`${label}: existing local-worker organization ${authMode} access remains supported`, async () => {
      worker.destination = "local"
      callerId = otherMemberId
      apiKey = authMode === "api-key"
      expect((await request(route)).status).toBe(route.status)
      expect(deprovisioned).toEqual([])
    })
  }
  test(`${label}: API-key organization scope cannot be overridden by a header`, async () => {
    apiKey = true
    apiKeyOrganizationId = otherOrganizationId
    expect((await request(route, { "x-openwork-org-id": organizationId })).status).toBe(404)
    expectNoRuntimeAuthority()
  })
  test(`${label}: unauthenticated callers cannot obtain runtime authority`, async () => {
    authenticated = false
    expect((await request(route)).status).toBe(401)
    expectNoRuntimeAuthority()
  })
}

test("creator token and runtime access still require Cloud entitlement", async () => {
  webAccess = false
  for (const route of controlRoutes.filter((entry) => entry.method !== "DELETE")) {
    const response = await request(route)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: "openwork_web_access_required" })
  }
  expect(tokenReads).toBe(0)
  expect(runtimeResolutions).toEqual([])
  expect(upstreamRequests).toEqual([])
})

test("organization members retain metadata visibility without runtime authority", async () => {
  callerId = otherMemberId
  const response = await app.request(`/v1/workers/${workerId}`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ worker: { id: workerId, isMine: false } })
  expectNoRuntimeAuthority()
})

for (const credential of ["fixture-session", "fixture-api-key", "fixture-activity-token", "another-worker-host-token"]) {
  test(`compatibility proxy rejects ${credential} before resolving a runtime`, async () => {
    callerId = otherMemberId
    apiKey = true
    const response = await app.request(`/v1/cloud/workers/${workerId}/runtime/versions`, {
      headers: { Authorization: `Bearer ${credential}`, "x-api-key": "fixture-api-key" },
    })
    expect(response.status).toBe(401)
    expect(runtimeResolutions).toEqual([])
    expect(upstreamRequests).toEqual([])
    expect(entitlementReads).toBe(0)
  })
}

test("compatibility proxy keeps explicit worker-host bearer authority", async () => {
  authenticated = false
  const response = await app.request(`/v1/cloud/workers/${workerId}/runtime/upgrade`, {
    method: "POST", headers: { "X-OpenWork-Host-Token": "fixture-host-token" },
  })
  expect(response.status).toBe(200)
  await response.text()
  expect(runtimeResolutions).toEqual([{ organizationId, workerId }])
  expect(upstreamRequests[0]?.headers.get("X-OpenWork-Host-Token")).toBe("fixture-host-token")
})

test("compatibility proxy does not promote a worker-client bearer to host authority", async () => {
  const response = await app.request(`/v1/cloud/workers/${workerId}/runtime/upgrade`, {
    method: "POST", headers: { Authorization: "Bearer fixture-client-token" },
  })
  expect(response.status).toBe(401)
  expect(runtimeResolutions).toEqual([])
  expect(upstreamRequests).toEqual([])
})
