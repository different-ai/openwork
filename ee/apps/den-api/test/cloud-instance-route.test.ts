import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import type { OrganizationContext } from "../src/orgs.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

type CloudWorkerStatus = "provisioning" | "healthy" | "failed" | "stopped"
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
} = {}) {
  let sequence = 0
  const workers = [...(input.initialWorkers ?? [])]
  const tokens = [...(input.tokens ?? [])]
  const deletedWorkerIds: StoredCloudWorker["id"][] = []
  const deletedTokenWorkerIds: StoredCloudWorker["id"][] = []
  let claimAttempts = 0
  let healthyFailures = 0
  let provisioningFailures = 0
  const store: CloudWorkerStore = {
    async getCloudWorker(query) {
      const rows = workers
        .filter((worker) => worker.orgId === query.orgId && worker.userId === query.userId && !deletedWorkerIds.includes(worker.id))
        .sort((left, right) => left.createdAt - right.createdAt)
      return rows[0] ?? null
    },
    async insertCloudWorker(row) {
      if (input.injectCanonicalCreateRace) {
        workers.push({
          id: createDenTypeId("worker"),
          name: "Cloud — Canonical",
          status: "provisioning",
          orgId: row.orgId,
          userId: row.userId,
          createdAt: sequence,
        })
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
    },
    async insertWorkerTokens(row) {
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
    async getActiveTokens(workerId) {
      return tokens.filter((entry) => entry.workerId === workerId)
    },
    async markProvisioningWorkerFailed(workerId) {
      provisioningFailures += 1
      const worker = workers.find((entry) => entry.id === workerId)
      if (worker?.status === "provisioning") {
        worker.status = "failed"
      }
    },
    async markHealthyWorkerFailed(workerId) {
      healthyFailures += 1
      const worker = workers.find((entry) => entry.id === workerId)
      if (worker?.status === "healthy") {
        worker.status = "failed"
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

  test("returns the client token only when the instance is ready", async () => {
    const provisioningWorker = fakeWorker("provisioning")
    const provisioningApp = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(provisioningApp, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
      ensureCloudWorker: async () => provisioningWorker,
      getSandboxRecord: async () => null,
    })

    const provisioning = await provisioningApp.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "gateway-secret" },
    })

    expect(provisioning.status).toBe(200)
    await expect(provisioning.json()).resolves.toEqual({ status: "provisioning", url: null, clientToken: null })

    const readyWorker = fakeWorker("healthy")
    const store = makeCloudWorkerStore({ tokens: [makeToken(readyWorker.id, "client")] })
    const readyApp = new Hono<{ Variables: OrgRouteVariables }>()
    routes.registerCloudRoutes(readyApp, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      gatewayKey: "gateway-secret",
      ensureCloudWorker: async () => readyWorker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      probeSignedPreview: async () => true,
    })

    const ready = await readyApp.request("http://den.local/v1/cloud/gateway/resolve", {
      headers: { "X-OpenWork-Gateway-Key": "gateway-secret" },
    })

    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toEqual({
      status: "ready",
      url: "https://preview.example.test",
      clientToken: "client-token",
    })
  })
})

describe("Cloud instance route lifecycle states", () => {
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
    await expect(first.json()).resolves.toEqual({ status: "waking", url: null })
    await expect(second.json()).resolves.toEqual({ status: "waking", url: null })
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
    await expect(response.json()).resolves.toEqual({ status: "waking", url: null })
    expect(wakeExecutions).toBe(0)
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
    await expect(response.json()).resolves.toEqual({ status: "provisioning", url: null })
    expect(wakeExecutions).toBe(0)
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
      .resolves.toEqual({ status: "provisioning", url: null })
    await expect(userOneApp.request("http://den.local/v1/cloud/instance").then((response) => response.json()))
      .resolves.toEqual({ status: "provisioning", url: null })
    await expect(userTwoApp.request("http://den.local/v1/cloud/instance").then((response) => response.json()))
      .resolves.toEqual({ status: "provisioning", url: null })

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
    await expect(response.json()).resolves.toEqual({ status: "provisioning", url: null })
    const activeWorkers = store.workers.filter((worker) => !store.deletedWorkerIds.includes(worker.id))
    expect(activeWorkers).toHaveLength(1)
    expect(activeWorkers[0]?.name).toBe("Cloud — Canonical")
    expect(store.deletedWorkerIds).toHaveLength(1)
    expect(store.deletedTokenWorkerIds).toEqual(store.deletedWorkerIds)
    expect(store.tokens.filter((token) => token.workerId === store.deletedWorkerIds[0])).toHaveLength(3)
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
  test("adopts an existing stopped sandbox for a failed worker instead of provisioning a duplicate", async () => {
    const worker = storedWorker({ status: "failed" })
    const store = makeCloudWorkerStore({
      initialWorkers: [worker],
      tokens: [makeToken(worker.id, "host"), makeToken(worker.id, "client"), makeToken(worker.id, "activity")],
    })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let provisionCalls = 0
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
      continueProvisioning: async () => {
        provisionCalls += 1
      },
      wakeCloudWorker: async () => {
        wakeCalls += 1
        worker.status = "healthy"
      },
    })

    const first = await app.request("http://den.local/v1/cloud/instance")
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual({ status: "waking", url: null })
    await flushMicrotasks()

    expect(store.claimAttempts).toBe(1)
    expect(provisionCalls).toBe(0)
    expect(wakeCalls).toBe(1)
    expect(worker.status).not.toBe("failed")

    await expect(app.request("http://den.local/v1/cloud/instance").then((response) => response.json()))
      .resolves.toEqual({ status: "ready", url: "https://preview.example.test" })
  })

  test("claims a failed worker, kicks provisioning, then throttles another failed GET for 60 seconds", async () => {
    const worker = storedWorker({ status: "failed" })
    const store = makeCloudWorkerStore({
      initialWorkers: [worker],
      tokens: [makeToken(worker.id, "host"), makeToken(worker.id, "client"), makeToken(worker.id, "activity")],
    })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let provisionCalls = 0
    let now = 1_000

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => null,
      now: () => now,
      continueProvisioning: async () => {
        provisionCalls += 1
      },
    })

    const first = await app.request("http://den.local/v1/cloud/instance")
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual({ status: "provisioning", url: null })
    await flushMicrotasks()
    expect(store.claimAttempts).toBe(1)
    expect(provisionCalls).toBe(1)

    worker.status = "failed"
    now += 10_000
    const second = await app.request("http://den.local/v1/cloud/instance")
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toEqual({ status: "failed", url: null })
    await flushMicrotasks()
    expect(store.claimAttempts).toBe(1)
    expect(provisionCalls).toBe(1)
  })

  test("two concurrent failed GETs start exactly one heal", async () => {
    const worker = storedWorker({ status: "failed" })
    const store = makeCloudWorkerStore({
      initialWorkers: [worker],
      tokens: [makeToken(worker.id, "host"), makeToken(worker.id, "client"), makeToken(worker.id, "activity")],
    })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let provisionCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => null,
      now: () => 5_000,
      continueProvisioning: async () => {
        provisionCalls += 1
      },
    })

    const [first, second] = await Promise.all([
      app.request("http://den.local/v1/cloud/instance"),
      app.request("http://den.local/v1/cloud/instance"),
    ])
    const payloads = await Promise.all([first.json(), second.json()])

    expect(payloads).toContainEqual({ status: "provisioning", url: null })
    expect(payloads).toContainEqual({ status: "failed", url: null })
    await flushMicrotasks()
    expect(store.claimAttempts).toBe(1)
    expect(provisionCalls).toBe(1)
  })
})

describe("Cloud instance ready liveness", () => {
  test("returns waking and starts wake when the preview is dead and the sandbox is stopped", async () => {
    const worker = fakeWorker("healthy")
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let probes = 0
    let wakeCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
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
    await expect(response.json()).resolves.toEqual({ status: "waking", url: null })
    expect(probes).toBe(1)
    expect(wakeCalls).toBe(1)
  })

  test("marks missing sandboxes failed, kicks heal, and reports waking", async () => {
    const worker = storedWorker({ status: "healthy" })
    const store = makeCloudWorkerStore({
      initialWorkers: [worker],
      tokens: [makeToken(worker.id, "host"), makeToken(worker.id, "client"), makeToken(worker.id, "activity")],
    })
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    let provisionCalls = 0

    routes.registerCloudRoutes(app, {
      memberRoute: contextMiddleware(organizationContext(JSON.stringify({ capabilities: { cloud: true } }))),
      orgMode: "multi_org",
      provisionerMode: "daytona",
      daytonaApiKey: "daytona-test-key",
      ensureCloudWorker: async () => worker,
      cloudWorkerStore: store.store,
      getSandboxRecord: async () => fakeSandbox(),
      refreshSignedPreview: async () => null,
      probeSignedPreview: async () => false,
      inspectSandbox: async () => null,
      continueProvisioning: async () => {
        provisionCalls += 1
      },
    })

    const response = await app.request("http://den.local/v1/cloud/instance")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "waking", url: null })
    await flushMicrotasks()
    expect(store.healthyFailures).toBe(1)
    expect(store.claimAttempts).toBe(1)
    expect(provisionCalls).toBe(1)
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
      .resolves.toEqual({ status: "ready", url: "https://preview.example.test" })
    now += 1_000
    await expect(app.request("http://den.local/v1/cloud/instance").then((response) => response.json()))
      .resolves.toEqual({ status: "ready", url: "https://preview.example.test" })

    expect(probes).toBe(1)
  })
})
