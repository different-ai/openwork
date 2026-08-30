import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import type { OrganizationContext } from "../src/orgs.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

type CloudWorkerStatus = "provisioning" | "healthy" | "failed" | "stopped"
type CloudInstanceStatus = "provisioning" | "waking" | "ready" | "failed"
type CloudRoutesModule = typeof import("../src/routes/cloud/index.js")
type CloudRouteOptions = NonNullable<Parameters<CloudRoutesModule["registerCloudRoutes"]>[1]>
type CloudWorkerStore = NonNullable<CloudRouteOptions["cloudWorkerStore"]>
type StoredCloudWorker = NonNullable<Awaited<ReturnType<CloudWorkerStore["getCloudWorker"]>>> & {
  orgId: Parameters<CloudWorkerStore["getCloudWorker"]>[0]["orgId"]
  userId: Parameters<CloudWorkerStore["getCloudWorker"]>[0]["userId"]
  createdAt: number
}
type StoredToken = Awaited<ReturnType<CloudWorkerStore["getActiveTokens"]>>[number] & {
  workerId: StoredCloudWorker["id"]
}

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.PROVISIONER_MODE = "stub"
  process.env.DAYTONA_SNAPSHOT = "openwork-0.18.8"
}

let routes: typeof import("../src/routes/cloud/index.js")

beforeAll(async () => {
  seedRequiredEnv()
  routes = await import("../src/routes/cloud/index.js")
})

function organizationContext(metadata: string | null, input: {
  orgId?: OrganizationContext["organization"]["id"]
  userId?: OrganizationContext["currentMember"]["userId"]
  userName?: string
  userEmail?: string
  includeMemberUser?: boolean
} = {}): OrganizationContext {
  const now = new Date("2026-07-25T00:00:00Z")
  const orgId = input.orgId ?? createDenTypeId("organization")
  const userId = input.userId ?? createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const userName = input.userName ?? "Cloud Instance Tester"
  const userEmail = input.userEmail ?? "cloud-instance@example.com"
  return {
    organization: {
      id: orgId,
      name: "Cloud Instance Test",
      slug: `cloud-instance-${crypto.randomUUID()}`,
      logo: null,
      allowedEmailDomains: null,
      metadata,
      createdAt: now,
      updatedAt: now,
    },
    currentMember: {
      id: memberId,
      userId,
      role: "member",
      createdAt: now,
      joinedAt: now,
      isOwner: false,
    },
    members: input.includeMemberUser ? [{
      id: memberId,
      userId,
      inviteId: null,
      role: "member",
      createdAt: now,
      joinedAt: now,
      isOwner: false,
      user: {
        id: userId,
        email: userEmail,
        name: userName,
        image: null,
      },
    }] : [],
    invitations: [],
    roles: [],
    teams: [],
  }
}

function contextMiddleware(context: OrganizationContext, input: { userName?: string; userEmail?: string } = {}): MiddlewareHandler<{ Variables: OrgRouteVariables }> {
  return async (c, next) => {
    const now = new Date("2026-07-25T00:00:00Z")
    c.set("organizationContext", context)
    c.set("user", {
      id: context.currentMember.userId,
      name: input.userName ?? "Cloud Instance Tester",
      email: input.userEmail ?? "cloud-instance@example.com",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    c.set("session", null)
    c.set("apiKey", null)
    await next()
  }
}

function fakeSandbox() {
  return {
    signed_preview_url: "https://preview.example.test",
    signed_preview_url_expires_at: new Date(Date.now() + 60_000),
  }
}

function fakeSandboxWithId(sandboxId: string) {
  return {
    ...fakeSandbox(),
    sandbox_id: sandboxId,
  }
}

function expectedCloudInstance(input: {
  status: CloudInstanceStatus
  url: string | null
  imageVersion?: string | null
}) {
  return {
    status: input.status,
    url: input.url,
    imageVersion: input.imageVersion ?? null,
    latestVersion: "openwork-0.18.8",
  }
}

function fakeWorker(status: CloudWorkerStatus) {
  return {
    id: createDenTypeId("worker"),
    name: "Cloud — Tester",
    status,
  }
}

function deferred() {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return {
    promise,
    resolve() {
      resolve?.()
    },
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function makeToken(workerId: StoredCloudWorker["id"], scope: StoredToken["scope"]): StoredToken {
  return { workerId, scope, token: `${scope}-token` }
}

function makeCloudWorkerStore(input: {
  initialWorkers?: StoredCloudWorker[]
  tokens?: StoredToken[]
  injectCanonicalCreateRace?: boolean
  failAtomicCreate?: boolean
} = {}) {
  let sequence = 0
  const workers = [...(input.initialWorkers ?? [])]
  const tokens = [...(input.tokens ?? [])]
  const deletedWorkerIds: StoredCloudWorker["id"][] = []
  const deletedTokenWorkerIds: StoredCloudWorker["id"][] = []
  let claimAttempts = 0
  let recycleClaimAttempts = 0
  let healthyFailures = 0
  let provisioningFailures = 0
  const store: CloudWorkerStore = {
    async getCloudWorker(query) {
      const rows = workers
        .filter((worker) => worker.orgId === query.orgId && worker.userId === query.userId && !deletedWorkerIds.includes(worker.id))
        .sort((left, right) => left.createdAt - right.createdAt)
      return rows[0] ?? null
    },
    async insertCloudWorkerWithTokens(row) {
      if (input.failAtomicCreate) {
        throw new Error("token insert failed")
      }
      if (input.injectCanonicalCreateRace) {
        const canonicalId = createDenTypeId("worker")
        workers.push({
          id: canonicalId,
          name: "Cloud — Canonical",
          status: "provisioning",
          orgId: row.orgId,
          userId: row.userId,
          createdAt: sequence,
        })
        tokens.push(makeToken(canonicalId, "host"), makeToken(canonicalId, "client"), makeToken(canonicalId, "activity"))
      }

      sequence += 1
      workers.push({
        id: row.workerId,
        name: row.name,
        status: "provisioning",
        orgId: row.orgId,
        userId: row.userId,
        createdAt: sequence,
      })
      tokens.push(makeToken(row.workerId, "host"), makeToken(row.workerId, "client"), makeToken(row.workerId, "activity"))
    },
    async deleteCreateRaceLoser(workerId) {
      deletedTokenWorkerIds.push(workerId)
      deletedWorkerIds.push(workerId)
    },
    async claimFailedWorker(workerId) {
      claimAttempts += 1
      const worker = workers.find((entry) => entry.id === workerId)
      if (!worker || worker.status !== "failed") {
        return false
      }

      worker.status = "provisioning"
      return true
    },
    async claimRecycleWorker(workerId) {
      recycleClaimAttempts += 1
      const worker = workers.find((entry) => entry.id === workerId)
      if (!worker || (worker.status !== "healthy" && worker.status !== "stopped")) {
        return false
      }

      worker.status = "provisioning"
      return true
    },
    async getActiveTokens(workerId) {
      return tokens.filter((entry) => entry.workerId === workerId)
    },
    async markProvisioningWorkerFailed(workerId, failure) {
      provisioningFailures += 1
      const worker = workers.find((entry) => entry.id === workerId)
      if (worker?.status === "provisioning") {
        worker.status = "failed"
        if (failure) {
          worker.cloud_failure_code = failure.code
          worker.cloud_failure_stage = failure.stage
          worker.cloud_failure_reference = failure.reference
          worker.cloud_failure_at = failure.occurredAt
        }
      }
    },
    async markHealthyWorkerFailed(workerId, failure) {
      healthyFailures += 1
      const worker = workers.find((entry) => entry.id === workerId)
      if (worker?.status === "healthy") {
        worker.status = "failed"
        if (failure) {
          worker.cloud_failure_code = failure.code
          worker.cloud_failure_stage = failure.stage
          worker.cloud_failure_reference = failure.reference
          worker.cloud_failure_at = failure.occurredAt
        }
      }
    },
  }

  return {
    store,
    workers,
    tokens,
    deletedWorkerIds,
    deletedTokenWorkerIds,
    get claimAttempts() {
      return claimAttempts
    },
    get recycleClaimAttempts() {
      return recycleClaimAttempts
    },
    get healthyFailures() {
      return healthyFailures
    },
    get provisioningFailures() {
      return provisioningFailures
    },
  }
}

function storedWorker(input: {
  orgId?: StoredCloudWorker["orgId"]
  userId?: StoredCloudWorker["userId"]
  status: CloudWorkerStatus
  createdAt?: number
}): StoredCloudWorker {
  return {
    id: createDenTypeId("worker"),
    name: "Cloud — Tester",
    status: input.status,
    orgId: input.orgId ?? createDenTypeId("organization"),
    userId: input.userId ?? createDenTypeId("user"),
    createdAt: input.createdAt ?? 0,
  }
}

describe("Cloud instance route gate", () => {
  test("returns 404 when the Cloud capability is off", async () => {
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(null)),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "cloud_not_found" })
  })

  test("returns 404 in single-org mode even with a literal Cloud opt-in", async () => {
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "single_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "cloud_not_found" })
  })

  test("returns 404 when Daytona provisioning is not configured", async () => {
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "stub",
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "cloud_not_found" })
  })
})

describe("Cloud gateway resolve route", () => {
  const grantedOpenWorkWebAccess = async () => ({ hasAccess: true })

  test("returns 404 when the gateway key is not configured", async () => {
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "",
    })

    const response = await app.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "gateway-secret" },
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "cloud_not_found" })
  })

  test("returns 404 when the gateway key is wrong", async () => {
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
    })

    const response = await app.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "bad-secret" },
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "cloud_not_found" })
  })

  test("returns 404 when the gateway key header is missing", async () => {
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
    })

    const response = await app.request("http://den.local/v1/cloud/gateway/resolve")

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "cloud_not_found" })
  })

  test("returns 404 when the Cloud capability is off", async () => {
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(null)),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
    })

    const response = await app.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "gateway-secret" },
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: "cloud_not_found" })
  })

  test("denies Web gateway resolution before provisioning when Den has not granted access", async () => {
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let ensureCalls = 0
    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
      getOpenWorkWebAccess: async () => ({ hasAccess: false }),
      ensureCloudWorker: async () => {
        ensureCalls += 1
        return fakeWorker("provisioning")
      },
    })

    const response = await app.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "gateway-secret" },
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: "openwork_web_access_required",
      message: "OpenWork Web access is not active for this organization.",
    })
    expect(ensureCalls).toBe(0)
  })

  test("returns the gateway tokens only when the instance is ready", async () => {
    const provisioningWorker = fakeWorker("provisioning")
    const provisioningApp = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(provisioningApp, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
      getOpenWorkWebAccess: grantedOpenWorkWebAccess,
      ensureCloudWorker: async () => provisioningWorker,
      getSandboxRecord: async () => null,
    })

    const provisioning = await provisioningApp.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "gateway-secret" },
    })

    expect(provisioning.status).toBe(200)
    await expect(provisioning.json()).resolves.toEqual({ status: "provisioning", url: null, clientToken: null, hostToken: null, expiresAt: null })

    const readyWorker = fakeWorker("healthy")
    const store = makeCloudWorkerStore({ tokens: [makeToken(readyWorker.id, "host"), makeToken(readyWorker.id, "client")] })
    const readyApp = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(readyApp, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
      getOpenWorkWebAccess: grantedOpenWorkWebAccess,
      ensureCloudWorker: async () => readyWorker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      probeSignedPreview: async () => true,
      materializeProviders: async () => ({ ok: true, status: "noop", fingerprint: "owp:v1:test", providers: 0 }),
    })

    const ready = await readyApp.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "gateway-secret" },
    })

    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toEqual({
      status: "ready",
      url: "https://preview.example.test",
      clientToken: "client-token",
      hostToken: "host-token",
      expiresAt: expect.any(String),
    })
  })

  test("does not expose the host token on the member instance response", async () => {
    const readyWorker = fakeWorker("healthy")
    const store = makeCloudWorkerStore({ tokens: [makeToken(readyWorker.id, "host"), makeToken(readyWorker.id, "client")] })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => readyWorker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      probeSignedPreview: async () => true,
    })

    const response = await app.request("http://den.local/v1/cloud/instance")
    const payload = await response.json()

    expect(response.status).toBe(200)
    // The member payload may gain additive fields (imageVersion, latestVersion);
    // this test's contract is only that tokens never serialize here.
    expect(payload).toMatchObject({ status: "ready", url: "https://preview.example.test" })
    expect(payload).not.toHaveProperty("hostToken")
    expect(payload).not.toHaveProperty("clientToken")
  })

  test("does not add instanceName to the gateway resolve response", async () => {
    const readyWorker = fakeWorker("healthy")
    const store = makeCloudWorkerStore({ tokens: [makeToken(readyWorker.id, "host"), makeToken(readyWorker.id, "client")] })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
      getOpenWorkWebAccess: grantedOpenWorkWebAccess,
      ensureCloudWorker: async () => readyWorker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandboxWithId("den-daytona-worker-cloud-test"),
      probeSignedPreview: async () => true,
      materializeProviders: async () => ({ ok: true, status: "noop", fingerprint: "owp:v1:test", providers: 0 }),
    })

    const response = await app.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "gateway-secret" },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      url: "https://preview.example.test",
      clientToken: "client-token",
      hostToken: "host-token",
      expiresAt: expect.any(String),
    })
  })

  test("surfaces degraded provider materialization failures without leaking provider keys", async () => {
    const readyWorker = fakeWorker("healthy")
    const store = makeCloudWorkerStore({ tokens: [makeToken(readyWorker.id, "host"), makeToken(readyWorker.id, "client")] })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    const secret = "sk-secret-never"

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
      getOpenWorkWebAccess: grantedOpenWorkWebAccess,
      ensureCloudWorker: async () => readyWorker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      probeSignedPreview: async () => true,
      materializeProviders: async () => ({
        ok: false,
        status: "failed",
        error: "provider_materialization_failed",
        reason: "runtime_config_patch_failed_500",
        message: `runtime_config_patch_failed_500 ${secret}`,
        fingerprint: "owp:v1:redacted",
        providers: 1,
      }),
    })

    const response = await app.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "gateway-secret" },
    })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(JSON.parse(body)).toEqual({
      status: "ready",
      url: "https://preview.example.test",
      clientToken: "client-token",
      hostToken: "host-token",
      expiresAt: expect.any(String),
      providerSync: { status: "degraded" },
    })
    expect(body).not.toContain(secret)
  })

  test("surfaces unsupported provider materialization as degraded provider sync", async () => {
    const readyWorker = fakeWorker("healthy")
    const store = makeCloudWorkerStore({ tokens: [makeToken(readyWorker.id, "host"), makeToken(readyWorker.id, "client")] })
    const app = new Hono<{ Variables: OrgRouteVariables }>()

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
      getOpenWorkWebAccess: grantedOpenWorkWebAccess,
      ensureCloudWorker: async () => readyWorker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      probeSignedPreview: async () => true,
      materializeProviders: async () => ({
        ok: false,
        status: "unsupported",
        error: "provider_materialization_unsupported",
        reason: "runtime_provider_patch_failed_404",
        message: "runtime_provider_patch_failed_404",
        fingerprint: "owp:v1:redacted",
        providers: 1,
      }),
    })

    const response = await app.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "gateway-secret" },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      url: "https://preview.example.test",
      clientToken: "client-token",
      hostToken: "host-token",
      expiresAt: expect.any(String),
      providerSync: { status: "degraded", reason: "unsupported" },
    })
  })
})

describe("Cloud instance route lifecycle states", () => {
  test("returns the Daytona sandbox identifier on the member instance response", async () => {
    const worker = { ...fakeWorker("healthy"), image_version: "openwork-0.18.7" }
    const app = new Hono<{ Variables: OrgRouteVariables }>()

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      getSandboxRecord: async () => fakeSandboxWithId("den-daytona-worker-cloud-test"),
      probeSignedPreview: async () => true,
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ...expectedCloudInstance({
        status: "ready",
        url: "https://preview.example.test",
        imageVersion: "openwork-0.18.7",
      }),
      instanceName: "den-daytona-worker-cloud-test",
    })
  })

  test("omits instanceName on the member instance response without a sandbox record", async () => {
    const worker = fakeWorker("provisioning")
    const app = new Hono<{ Variables: OrgRouteVariables }>()

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      getSandboxRecord: async () => null,
    })

    const response = await app.request("http://den.local/v1/cloud/instance")
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toEqual(expectedCloudInstance({ status: "provisioning", url: null }))
    expect(payload).not.toHaveProperty("instanceName")
  })

  test("returns worker and latest image versions on the member instance response", async () => {
    const worker = { ...fakeWorker("healthy"), image_version: "openwork-0.18.7" }
    const app = new Hono<{ Variables: OrgRouteVariables }>()

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      getSandboxRecord: async () => fakeSandbox(),
      probeSignedPreview: async () => true,
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expectedCloudInstance({
      status: "ready",
      url: "https://preview.example.test",
      imageVersion: "openwork-0.18.7",
    }))
  })

  test("returns waking and starts one wake for concurrent stopped-worker requests", async () => {
    const worker = fakeWorker("stopped")
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    const wakeHold = deferred()
    let wakeExecutions = 0
    let wakePromise: Promise<void> | null = null

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      getSandboxRecord: async () => fakeSandbox(),
      wakeCloudWorker: async () => {
        if (!wakePromise) {
          wakeExecutions += 1
          wakePromise = wakeHold.promise
        }
        return wakePromise
      },
    })

    const [first, second] = await Promise.all([
      app.request("http://den.local/v1/cloud/instance"),
      app.request("http://den.local/v1/cloud/instance"),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await expect(first.json()).resolves.toEqual(expectedCloudInstance({ status: "waking", url: null }))
    await expect(second.json()).resolves.toEqual(expectedCloudInstance({ status: "waking", url: null }))
    expect(wakeExecutions).toBe(1)

    wakeHold.resolve()
    await wakePromise
  })

  test("maps provisioning with a sandbox row to waking", async () => {
    const worker = fakeWorker("provisioning")
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let wakeExecutions = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      getSandboxRecord: async () => fakeSandbox(),
      wakeCloudWorker: async () => {
        wakeExecutions += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expectedCloudInstance({ status: "waking", url: null }))
    expect(wakeExecutions).toBe(0)
  })

  test("claims and wakes a stale stopped sandbox without checkpoint probing on resolve", async () => {
    const worker = { ...storedWorker({ status: "healthy" }), image_version: "openwork-0.18.7" }
    const store = makeCloudWorkerStore({ initialWorkers: [worker] })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let wakeCalls = 0
    let probes = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      inspectSandbox: async () => ({ state: "stopped" }),
      probeSignedPreview: async () => {
        probes += 1
        return true
      },
      wakeCloudWorker: async () => {
        wakeCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expectedCloudInstance({ status: "waking", url: null, imageVersion: "openwork-0.18.7" }))
    expect(store.recycleClaimAttempts).toBe(1)
    expect(worker.status).toBe("provisioning")
    expect(wakeCalls).toBe(1)
    expect(probes).toBe(0)
  })

  test("does not inspect the sandbox for an up-to-date stopped worker wake", async () => {
    const worker = { ...fakeWorker("stopped"), image_version: "openwork-0.18.8" }
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let wakeCalls = 0
    let inspectCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      getSandboxRecord: async () => fakeSandbox(),
      inspectSandbox: async () => {
        inspectCalls += 1
        return { state: "stopped" }
      },
      wakeCloudWorker: async () => {
        wakeCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expectedCloudInstance({ status: "waking", url: null, imageVersion: "openwork-0.18.8" }))
    expect(inspectCalls).toBe(0)
    expect(wakeCalls).toBe(1)
  })

  test("keeps first provisioning without a sandbox row as provisioning", async () => {
    const worker = fakeWorker("provisioning")
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let wakeExecutions = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      getSandboxRecord: async () => null,
      wakeCloudWorker: async () => {
        wakeExecutions += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expectedCloudInstance({ status: "provisioning", url: null }))
    expect(wakeExecutions).toBe(0)
  })
})

describe("Cloud instance update route", () => {
  test("flushes and stops a running stale sandbox", async () => {
    const orgId = createDenTypeId("organization")
    const userId = createDenTypeId("user")
    const worker = { ...storedWorker({ orgId, userId, status: "healthy" }), image_version: "openwork-0.18.7" }
    const store = makeCloudWorkerStore({ initialWorkers: [worker] })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    const flushCalls: StoredCloudWorker["id"][] = []
    const stopCalls: StoredCloudWorker["id"][] = []

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }), { orgId, userId })),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      inspectSandbox: async () => ({ state: "running" }),
      flushWorkerCheckpoint: async (workerId) => {
        flushCalls.push(workerId)
        return true
      },
      stopCloudWorker: async (workerId) => {
        stopCalls.push(workerId)
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance/update", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, status: "update_requested" })
    expect(flushCalls).toEqual([worker.id])
    expect(stopCalls).toEqual([worker.id])
  })

  test("no-ops for a stopped stale sandbox", async () => {
    const orgId = createDenTypeId("organization")
    const userId = createDenTypeId("user")
    const worker = { ...storedWorker({ orgId, userId, status: "healthy" }), image_version: "openwork-0.18.7" }
    const store = makeCloudWorkerStore({ initialWorkers: [worker] })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let flushCalls = 0
    let stopCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }), { orgId, userId })),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      inspectSandbox: async () => ({ state: "stopped" }),
      flushWorkerCheckpoint: async () => {
        flushCalls += 1
        return true
      },
      stopCloudWorker: async () => {
        stopCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance/update", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, status: "update_requested" })
    expect(flushCalls).toBe(0)
    expect(stopCalls).toBe(0)
  })

  test("refuses to stop an already-current worker", async () => {
    const orgId = createDenTypeId("organization")
    const userId = createDenTypeId("user")
    const worker = { ...storedWorker({ orgId, userId, status: "healthy" }), image_version: "openwork-0.18.8" }
    const store = makeCloudWorkerStore({ initialWorkers: [worker] })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let inspectCalls = 0
    let stopCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }), { orgId, userId })),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      inspectSandbox: async () => {
        inspectCalls += 1
        return { state: "running" }
      },
      flushWorkerCheckpoint: async () => true,
      stopCloudWorker: async () => {
        stopCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance/update", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: false, error: "already_current" })
    expect(inspectCalls).toBe(0)
    expect(stopCalls).toBe(0)
  })

  test("leaves a running sandbox up when checkpoint flush fails", async () => {
    const orgId = createDenTypeId("organization")
    const userId = createDenTypeId("user")
    const worker = { ...storedWorker({ orgId, userId, status: "healthy" }), image_version: "openwork-0.18.7" }
    const store = makeCloudWorkerStore({ initialWorkers: [worker] })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let stopCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }), { orgId, userId })),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      inspectSandbox: async () => ({ state: "running" }),
      flushWorkerCheckpoint: async () => false,
      stopCloudWorker: async () => {
        stopCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance/update", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: false, error: "flush_failed" })
    expect(stopCalls).toBe(0)
  })
})

describe("Cloud instance per-user workers", () => {
  test("creates one worker per user and reuses the same user's canonical worker", async () => {
    const orgId = createDenTypeId("organization")
    const userOne = createDenTypeId("user")
    const userTwo = createDenTypeId("user")
    const store = makeCloudWorkerStore()
    let provisionCalls = 0

    function appForUser(userId: typeof userOne, email: string) {
      const app = new Hono<{ Variables: OrgRouteVariables }>()
      routes.registerCloudRoutes(app, {
        memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }), {
          orgId,
          userId,
          userEmail: email,
        }), { userEmail: email }),
        orgMode: "multi_org",
        provisionerMode: "daytona",
        daytonaApiKey: "daytona-test-key",
        cloudWorkerStore: store.store,
        getSandboxRecord: async () => null,
        continueProvisioning: async () => {
          provisionCalls += 1
        },
      })
      return app
    }

    const userOneApp = appForUser(userOne, "ada@example.com")
    const userTwoApp = appForUser(userTwo, "grace@example.com")

    await expect(userOneApp.request("http://den.local/v1/cloud/instance").then((response) => response.json()))
      .resolves.toEqual(expectedCloudInstance({ status: "provisioning", url: null }))
    await expect(userOneApp.request("http://den.local/v1/cloud/instance").then((response) => response.json()))
      .resolves.toEqual(expectedCloudInstance({ status: "provisioning", url: null }))
    await expect(userTwoApp.request("http://den.local/v1/cloud/instance").then((response) => response.json()))
      .resolves.toEqual(expectedCloudInstance({ status: "provisioning", url: null }))

    expect(store.workers.filter((worker) => !store.deletedWorkerIds.includes(worker.id))).toHaveLength(2)
    expect(new Set(store.workers.map((worker) => worker.userId)).size).toBe(2)
    expect(provisionCalls).toBe(2)
  })

  test("converges a simulated double insert to the oldest canonical worker and deletes loser tokens", async () => {
    const orgId = createDenTypeId("organization")
    const userId = createDenTypeId("user")
    const store = makeCloudWorkerStore({ injectCanonicalCreateRace: true })
    let provisionCalls = 0
    const app = new Hono<{ Variables: OrgRouteVariables }>()

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }), {
        orgId,
        userId,
        userName: "Race Winner",
        userEmail: "winner@example.com",
        includeMemberUser: true,
      })),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => null,
      continueProvisioning: async () => {
        provisionCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expectedCloudInstance({ status: "provisioning", url: null }))
    const activeWorkers = store.workers.filter((worker) => !store.deletedWorkerIds.includes(worker.id))
    expect(activeWorkers).toHaveLength(1)
    expect(activeWorkers[0]?.name).toBe("Cloud — Canonical")
    expect(store.deletedWorkerIds).toHaveLength(1)
    expect(store.deletedTokenWorkerIds).toEqual(store.deletedWorkerIds)
    expect(store.tokens.filter((token) => token.workerId === store.deletedWorkerIds[0])).toHaveLength(3)
    expect(provisionCalls).toBe(0)
  })

  test("does not publish or provision a worker when the atomic worker-and-token insert fails", async () => {
    const store = makeCloudWorkerStore({ failAtomicCreate: true })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let provisionCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => null,
      continueProvisioning: async () => {
        provisionCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(500)
    expect(store.workers).toHaveLength(0)
    expect(store.tokens).toHaveLength(0)
    expect(provisionCalls).toBe(0)
  })

  test("uses the org member display name for the human-readable worker name", async () => {
    const orgId = createDenTypeId("organization")
    const userId = createDenTypeId("user")
    const store = makeCloudWorkerStore()
    const app = new Hono<{ Variables: OrgRouteVariables }>()

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }), {
        orgId,
        userId,
        userName: "Ada Lovelace",
        userEmail: "ada@example.com",
        includeMemberUser: true,
      })),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => null,
      continueProvisioning: async () => undefined,
    })

    await app.request("http://den.local/v1/cloud/instance")

    expect(store.workers[0]?.name).toBe("Cloud — Ada Lovelace")
  })
})

describe("Cloud instance failed self-heal", () => {
  test("returns the durable safe diagnostic while recovery starts", async () => {
    const occurredAt = new Date("2026-08-28T12:00:00.000Z")
    const context = organizationContext(JSON.stringify({ capabilities: { cloud: true } }))
    const worker = {
      ...storedWorker({
        orgId: context.organization.id,
        userId: context.currentMember.userId,
        status: "failed",
      }),
      cloud_failure_code: "runtime_health_timeout",
      cloud_failure_stage: "recovery",
      cloud_failure_reference: "cwf_route-test",
      cloud_failure_at: occurredAt,
    } satisfies StoredCloudWorker
    const store = makeCloudWorkerStore({
      initialWorkers: [worker],
      tokens: [makeToken(worker.id, "host"), makeToken(worker.id, "client"), makeToken(worker.id, "activity")],
    })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let recoveryCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(context),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => null,
      now: () => occurredAt.getTime() + 120_000,
      recoverCloudWorker: async () => {
        recoveryCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance")
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      ...expectedCloudInstance({ status: "provisioning", url: null }),
      failure: {
        code: "runtime_health_timeout",
        stage: "recovery",
        reference: "cwf_route-test",
        occurredAt: occurredAt.toISOString(),
      },
    })
    expect(recoveryCalls).toBe(1)
    expect(JSON.stringify(payload)).not.toContain("token")
  })

  test("adopts an existing stopped sandbox for a failed worker instead of provisioning a duplicate", async () => {
    const worker = storedWorker({ status: "failed" })
    const store = makeCloudWorkerStore({
      initialWorkers: [worker],
      tokens: [makeToken(worker.id, "host"), makeToken(worker.id, "client"), makeToken(worker.id, "activity")],
    })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let wakeCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      inspectSandbox: async () => ({ state: "stopped" }),
      probeSignedPreview: async () => true,
      recoverCloudWorker: async () => {
        wakeCalls += 1
        worker.status = "healthy"
      },
    })

    const first = await app.request("http://den.local/v1/cloud/instance")
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual(expectedCloudInstance({ status: "waking", url: null }))
    await flushMicrotasks()

    expect(store.claimAttempts).toBe(1)
    expect(wakeCalls).toBe(1)
    expect(worker.status).not.toBe("failed")

    await expect(app.request("http://den.local/v1/cloud/instance").then((response) => response.json()))
      .resolves.toEqual(expectedCloudInstance({ status: "ready", url: "https://preview.example.test" }))
  })

  test("keeps passive cooldown durable and rate-limits repeated explicit retries", async () => {
    let now = 1_000
    const worker = {
      ...storedWorker({ status: "failed" }),
      cloud_failure_code: "provider_operation_failed",
      cloud_failure_stage: "provisioning",
      cloud_failure_reference: "cwf_initial-provisioning",
      cloud_failure_at: new Date(now),
    } satisfies StoredCloudWorker
    const store = makeCloudWorkerStore({
      initialWorkers: [worker],
      tokens: [makeToken(worker.id, "host"), makeToken(worker.id, "client"), makeToken(worker.id, "activity")],
    })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let recoveryCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => null,
      now: () => now,
      recoverCloudWorker: async () => {
        recoveryCalls += 1
      },
    })

    const publicInitialFailure = {
      code: "provider_operation_failed",
      stage: "provisioning",
      reference: "cwf_initial-provisioning",
      occurredAt: new Date(1_000).toISOString(),
    }
    const first = await app.request("http://den.local/v1/cloud/instance")
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual({
      ...expectedCloudInstance({ status: "provisioning", url: null }),
      failure: publicInitialFailure,
    })
    await flushMicrotasks()
    expect(store.claimAttempts).toBe(1)
    expect(recoveryCalls).toBe(1)

    worker.status = "failed"
    worker.cloud_failure_stage = "recovery"
    worker.cloud_failure_at = new Date(now)
    now += 10_000
    const second = await app.request("http://den.local/v1/cloud/instance")
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toEqual({
      ...expectedCloudInstance({ status: "failed", url: null }),
      failure: { ...publicInitialFailure, stage: "recovery" },
    })
    await flushMicrotasks()
    expect(store.claimAttempts).toBe(1)
    expect(recoveryCalls).toBe(1)

    const retry = await app.request("http://den.local/v1/cloud/instance/retry", { method: "POST" })
    expect(retry.status).toBe(200)
    await expect(retry.json()).resolves.toEqual({
      ...expectedCloudInstance({ status: "provisioning", url: null }),
      failure: { ...publicInitialFailure, stage: "recovery" },
    })
    await flushMicrotasks()
    expect(store.claimAttempts).toBe(2)
    expect(recoveryCalls).toBe(2)

    worker.status = "failed"
    const repeatedRetry = await app.request("http://den.local/v1/cloud/instance/retry", { method: "POST" })
    expect(repeatedRetry.status).toBe(200)
    await expect(repeatedRetry.json()).resolves.toEqual({
      ...expectedCloudInstance({ status: "failed", url: null }),
      failure: { ...publicInitialFailure, stage: "recovery" },
    })
    await flushMicrotasks()
    expect(store.claimAttempts).toBe(2)
    expect(recoveryCalls).toBe(2)

    now += 60_000
    const cooledRetry = await app.request("http://den.local/v1/cloud/instance/retry", { method: "POST" })
    expect(cooledRetry.status).toBe(200)
    await expect(cooledRetry.json()).resolves.toEqual({
      ...expectedCloudInstance({ status: "provisioning", url: null }),
      failure: { ...publicInitialFailure, stage: "recovery" },
    })
    await flushMicrotasks()
    expect(store.claimAttempts).toBe(3)
    expect(recoveryCalls).toBe(3)
  })

  test("two concurrent failed GETs start exactly one heal", async () => {
    const worker = storedWorker({ status: "failed" })
    const store = makeCloudWorkerStore({
      initialWorkers: [worker],
      tokens: [makeToken(worker.id, "host"), makeToken(worker.id, "client"), makeToken(worker.id, "activity")],
    })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let recoveryCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => null,
      now: () => 5_000,
      recoverCloudWorker: async () => {
        recoveryCalls += 1
      },
    })

    const [first, second] = await Promise.all([
      app.request("http://den.local/v1/cloud/instance"),
      app.request("http://den.local/v1/cloud/instance"),
    ])
    const payloads = await Promise.all([first.json(), second.json()])

    expect(payloads).toContainEqual(expectedCloudInstance({ status: "provisioning", url: null }))
    expect(payloads).toContainEqual(expectedCloudInstance({ status: "failed", url: null }))
    await flushMicrotasks()
    expect(store.claimAttempts).toBe(2)
    expect(recoveryCalls).toBe(1)
  })
})

describe("Cloud instance ready liveness", () => {
  test("returns waking and starts wake when the preview is dead and the sandbox is stopped", async () => {
    const context = organizationContext(JSON.stringify({ capabilities: { cloud: true } }))
    const worker = storedWorker({
      orgId: context.organization.id,
      userId: context.currentMember.userId,
      status: "healthy",
    })
    const store = makeCloudWorkerStore({ initialWorkers: [worker] })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let probes = 0
    let wakeCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(context),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      refreshSignedPreview: async () => null,
      probeSignedPreview: async () => {
        probes += 1
        return false
      },
      inspectSandbox: async () => ({ state: "stopped" }),
      wakeCloudWorker: async () => {
        wakeCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expectedCloudInstance({ status: "waking", url: null }))
    expect(probes).toBe(1)
    expect(wakeCalls).toBe(1)
    expect(store.recycleClaimAttempts).toBe(1)
  })

  test("persists a same-poll diagnostic before recovering an unreachable running sandbox", async () => {
    const context = organizationContext(JSON.stringify({ capabilities: { cloud: true } }))
    const worker = storedWorker({
      orgId: context.organization.id,
      userId: context.currentMember.userId,
      status: "healthy",
    })
    const store = makeCloudWorkerStore({
      initialWorkers: [worker],
      tokens: [makeToken(worker.id, "host"), makeToken(worker.id, "client"), makeToken(worker.id, "activity")],
    })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let recoveryCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(context),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      refreshSignedPreview: async () => null,
      probeSignedPreview: async () => false,
      inspectSandbox: async () => null,
      recoverCloudWorker: async () => {
        recoveryCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ...expectedCloudInstance({ status: "waking", url: null }),
      failure: {
        code: "runtime_unreachable",
        stage: "runtime",
        reference: expect.stringMatching(/^cwf_/),
        occurredAt: expect.any(String),
      },
    })
    await flushMicrotasks()
    expect(store.healthyFailures).toBe(1)
    expect(store.claimAttempts).toBe(1)
    expect(recoveryCalls).toBe(1)
  })

  test("caches healthy preview probes for 15 seconds", async () => {
    const worker = fakeWorker("healthy")
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let probes = 0
    let now = 20_000

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      getSandboxRecord: async () => fakeSandbox(),
      now: () => now,
      probeSignedPreview: async () => {
        probes += 1
        return true
      },
    })

    await expect(app.request("http://den.local/v1/cloud/instance").then((response) => response.json()))
      .resolves.toEqual(expectedCloudInstance({ status: "ready", url: "https://preview.example.test" }))
    now += 1_000
    await expect(app.request("http://den.local/v1/cloud/instance").then((response) => response.json()))
      .resolves.toEqual(expectedCloudInstance({ status: "ready", url: "https://preview.example.test" }))

    expect(probes).toBe(1)
  })
})
