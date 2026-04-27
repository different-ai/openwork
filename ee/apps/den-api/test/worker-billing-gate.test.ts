import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.POLAR_ACCESS_TOKEN = process.env.POLAR_ACCESS_TOKEN ?? "polar_test_token"
  process.env.POLAR_PRODUCT_ID = process.env.POLAR_PRODUCT_ID ?? "product_test"
  process.env.POLAR_BENEFIT_ID = process.env.POLAR_BENEFIT_ID ?? "benefit_test"
  process.env.POLAR_SUCCESS_URL = process.env.POLAR_SUCCESS_URL ?? "https://app.openworklabs.test/success"
  process.env.POLAR_RETURN_URL = process.env.POLAR_RETURN_URL ?? "https://app.openworklabs.test/checkout"
}

const activeOrgId = createDenTypeId("organization")
const activeUserId = createDenTypeId("user")
const activeSessionId = createDenTypeId("session")

type AccessResult =
  | { allowed: true }
  | { allowed: false; checkoutUrl: string }

const workerRows: Array<Record<string, unknown>> = []
const tokenRows: Array<Record<string, unknown>> = []

let billingAccess: AccessResult = { allowed: true }
let workerLimitExceeded = false
let workerLimitCalls = 0

const requireCloudWorkerAccess = mock(async () => billingAccess)
const provisionWorker = mock(async (input: { workerId: string }) => ({
  provider: "daytona",
  region: "us",
  url: `https://workers.test/${input.workerId}`,
  status: "healthy",
}))

function resetFakes() {
  workerRows.length = 0
  tokenRows.length = 0
  billingAccess = { allowed: true }
  workerLimitExceeded = false
  workerLimitCalls = 0
  requireCloudWorkerAccess.mockClear()
  provisionWorker.mockClear()
}

function classifyInsertedValues(values: unknown) {
  const rows = Array.isArray(values) ? values : [values]
  const first = rows[0] as Record<string, unknown> | undefined

  if (first?.scope) {
    tokenRows.push(...rows as Array<Record<string, unknown>>)
    return
  }

  if (first?.provider && first?.worker_id) {
    return
  }

  if (first?.org_id && first?.destination) {
    workerRows.push(...rows as Array<Record<string, unknown>>)
  }
}

const fakeDb = {
  insert() {
    return {
      values: async (values: unknown) => {
        classifyInsertedValues(values)
        return []
      },
    }
  },
  update() {
    return {
      set: () => ({
        where: async () => {
          return []
        },
      }),
    }
  },
  select() {
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
          }),
          limit: async () => [],
        }),
        orderBy: () => ({
          limit: async () => [],
        }),
        limit: async () => [],
      }),
    }
  },
}

mock.module("../src/db.js", () => ({
  db: fakeDb,
}))

mock.module("../src/orgs.js", () => ({
  getOrganizationContextForUser: mock(async () => null),
  listTeamsForMember: mock(async () => []),
  resolveUserOrganizations: mock(async () => ({
    activeOrgId,
    activeOrgSlug: "test-org",
    orgs: [{ id: activeOrgId, slug: "test-org", name: "Test Org" }],
  })),
  setSessionActiveOrganization: mock(async () => undefined),
}))

mock.module("../src/organization-limits.js", () => ({
  getOrganizationLimitStatus: mock(async () => {
    workerLimitCalls += 1
    return {
      currentCount: workerLimitExceeded ? 1 : 0,
      exceeded: workerLimitExceeded,
      limit: 1,
      limitType: "workers",
    }
  }),
}))

mock.module("../src/billing/polar.js", () => ({
  getCloudWorkerBillingStatus: mock(async () => ({})),
  requireCloudWorkerAccess,
  setCloudWorkerSubscriptionCancellation: mock(async () => null),
}))

mock.module("../src/workers/provisioner.js", () => ({
  deprovisionWorker: mock(async () => undefined),
  provisionWorker,
}))

let workerCoreModule: typeof import("../src/routes/workers/core.js")
let envModule: typeof import("../src/env.js")

beforeAll(async () => {
  seedRequiredEnv()
  envModule = await import("../src/env.js")
  envModule.env.polar.productId = "product_test"
  envModule.env.polar.benefitId = "benefit_test"
  workerCoreModule = await import("../src/routes/workers/core.js")
})

afterEach(() => {
  resetFakes()
})

function createWorkerApp(input: { email?: string | null } = {}) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", {
      id: activeUserId,
      name: "Test User",
      email: input.email === undefined ? "test@example.com" : input.email,
    })
    c.set("session", {
      id: activeSessionId,
      activeOrganizationId: activeOrgId,
    })
    await next()
  })
  workerCoreModule.registerWorkerCoreRoutes(app)
  return app
}

function postWorker(app: Hono, body: Record<string, unknown>) {
  return app.request("http://den.local/v1/workers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

test("cloud worker creation returns payment_required before writing rows when billing is missing", async () => {
  billingAccess = { allowed: false, checkoutUrl: "https://polar.test/checkout/session" }
  const app = createWorkerApp()

  const response = await postWorker(app, {
    name: "Cloud Worker",
    destination: "cloud",
  })

  expect(response.status).toBe(402)
  await expect(response.json()).resolves.toEqual({
    error: "payment_required",
    message: "Creating a cloud worker requires an active OpenWork Cloud plan.",
    polar: {
      checkoutUrl: "https://polar.test/checkout/session",
      productId: "product_test",
      benefitId: "benefit_test",
    },
  })
  expect(workerLimitCalls).toBe(1)
  expect(requireCloudWorkerAccess).toHaveBeenCalledTimes(1)
  expect(provisionWorker).not.toHaveBeenCalled()
  expect(workerRows).toHaveLength(0)
  expect(tokenRows).toHaveLength(0)
})

test("cloud worker creation stops at the organization worker limit before billing", async () => {
  workerLimitExceeded = true
  billingAccess = { allowed: false, checkoutUrl: "https://polar.test/checkout/session" }
  const app = createWorkerApp()

  const response = await postWorker(app, {
    name: "Cloud Worker",
    destination: "cloud",
  })

  expect(response.status).toBe(409)
  await expect(response.json()).resolves.toEqual({
    currentCount: 1,
    error: "org_limit_reached",
    limit: 1,
    limitType: "workers",
    message: "This workspace currently supports up to 1 workers. Contact support to increase the limit.",
  })
  expect(workerLimitCalls).toBe(1)
  expect(requireCloudWorkerAccess).not.toHaveBeenCalled()
  expect(provisionWorker).not.toHaveBeenCalled()
  expect(workerRows).toHaveLength(0)
  expect(tokenRows).toHaveLength(0)
})

test("paid cloud worker creation still provisions and returns launch details", async () => {
  billingAccess = { allowed: true }
  const app = createWorkerApp()

  const response = await postWorker(app, {
    name: "Cloud Worker",
    destination: "cloud",
  })

  expect(response.status).toBe(202)
  const payload = await response.json() as { launch?: { mode?: string }; worker?: { destination?: string } }
  expect(payload.worker?.destination).toBe("cloud")
  expect(payload.launch?.mode).toBe("async")
  expect(workerLimitCalls).toBe(1)
  expect(requireCloudWorkerAccess).toHaveBeenCalledTimes(1)
  expect(workerRows).toHaveLength(1)
  expect(tokenRows).toHaveLength(3)
  expect(provisionWorker).toHaveBeenCalledTimes(1)
})

test("local worker creation does not require cloud billing", async () => {
  billingAccess = { allowed: false, checkoutUrl: "https://polar.test/checkout/session" }
  const app = createWorkerApp()

  const response = await postWorker(app, {
    name: "Local Worker",
    destination: "local",
    workspacePath: "/tmp/openwork",
  })

  expect(response.status).toBe(201)
  const payload = await response.json() as { launch?: { mode?: string }; worker?: { destination?: string } }
  expect(payload.worker?.destination).toBe("local")
  expect(payload.launch?.mode).toBe("instant")
  expect(workerLimitCalls).toBe(0)
  expect(requireCloudWorkerAccess).not.toHaveBeenCalled()
  expect(workerRows).toHaveLength(1)
  expect(tokenRows).toHaveLength(3)
  expect(provisionWorker).not.toHaveBeenCalled()
})

test("cloud worker creation requires a user email before contacting billing", async () => {
  const app = createWorkerApp({ email: null })

  const response = await postWorker(app, {
    name: "Cloud Worker",
    destination: "cloud",
  })

  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toEqual({ error: "user_email_required" })
  expect(workerLimitCalls).toBe(0)
  expect(requireCloudWorkerAccess).not.toHaveBeenCalled()
  expect(workerRows).toHaveLength(0)
  expect(tokenRows).toHaveLength(0)
})
