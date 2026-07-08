import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, expect, mock, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

type TestOrg = {
  id: string
  slug: string
}

type TestApiKey = {
  id: string
  configId: string
  referenceId: string
  metadata: {
    organizationId: string
    orgMembershipId: string
    issuedByUserId: string
    issuedByOrgMembershipId: string
  } | null
}

type TestContext = {
  organization: TestOrg
  currentMember: { id: string; role: string; isOwner: boolean }
  currentMemberTeams: unknown[]
  members: unknown[]
  teams: unknown[]
  roles: unknown[]
}

type TestState = {
  userId: string
  visibleOrgs: TestOrg[]
  contextByOrgId: Map<string, TestContext>
  resolveUserOrganizationsCalls: Array<{ activeOrganizationId?: string | null; userId: string }>
  setSessionActiveOrganizationCalls: Array<{ sessionId: string; organizationId: string | null }>
}

const stateByUserId = new Map<string, TestState>()
const stateBySessionId = new Map<string, TestState>()
let organizationContextModule: typeof import("../src/middleware/organization-context.js")

mock.module("../src/orgs.js", () => ({
  getOrganizationContextForUser: (input: { organizationId: string; userId: string }) => {
    const state = stateByUserId.get(input.userId)
    return Promise.resolve(state?.contextByOrgId.get(input.organizationId) ?? null)
  },
  resolveUserOrganizations: (input: { activeOrganizationId?: string | null; userId: string }) => {
    const state = stateByUserId.get(input.userId)
    if (!state) {
      return Promise.resolve({ orgs: [], activeOrgId: null, activeOrgSlug: null })
    }

    state.resolveUserOrganizationsCalls.push(input)
    const requestedOrg = input.activeOrganizationId
      ? state.visibleOrgs.find((org) => org.id === input.activeOrganizationId) ?? null
      : null
    const activeOrg = requestedOrg ?? (state.visibleOrgs.length === 1 ? state.visibleOrgs[0] : null)
    return Promise.resolve({
      orgs: state.visibleOrgs,
      activeOrgId: activeOrg?.id ?? null,
      activeOrgSlug: activeOrg?.slug ?? null,
    })
  },
  setSessionActiveOrganization: (sessionId: string, organizationId: string | null) => {
    stateBySessionId.get(sessionId)?.setSessionActiveOrganizationCalls.push({ sessionId, organizationId })
    return Promise.resolve()
  },
}))

beforeAll(async () => {
  seedRequiredEnv()
  organizationContextModule = await import("../src/middleware/organization-context.js")
})

function createTestState(userId: string): TestState {
  const state: TestState = {
    userId,
    visibleOrgs: [],
    contextByOrgId: new Map(),
    resolveUserOrganizationsCalls: [],
    setSessionActiveOrganizationCalls: [],
  }
  stateByUserId.set(userId, state)
  return state
}

function addVisibleOrg(state: TestState, slug: string) {
  const org = { id: createDenTypeId("organization"), slug }
  const memberId = createDenTypeId("member")
  state.visibleOrgs.push(org)
  state.contextByOrgId.set(org.id, {
    organization: org,
    currentMember: { id: memberId, role: "owner", isOwner: true },
    currentMemberTeams: [],
    members: [],
    teams: [],
    roles: [],
  })
  return { org, memberId }
}

function createApiKey(input: { organizationId: string; memberId: string; userId: string }): TestApiKey {
  return {
    id: createDenTypeId("apiKey"),
    configId: "den-api-key",
    referenceId: input.userId,
    metadata: {
      organizationId: input.organizationId,
      orgMembershipId: input.memberId,
      issuedByUserId: input.userId,
      issuedByOrgMembershipId: input.memberId,
    },
  }
}

function createOrgContextApp(state: TestState, input: {
  apiKey?: TestApiKey | null
  sessionActiveOrganizationId: string | null
}) {
  const app = new Hono()
  const sessionId = createDenTypeId("session")
  stateBySessionId.set(sessionId, state)
  app.use("*", async (c, next) => {
    c.set("user", {
      id: state.userId,
      name: "Org Context User",
      email: "user@example.com",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    c.set("session", {
      id: sessionId,
      activeOrganizationId: input.sessionActiveOrganizationId,
    })
    c.set("apiKey", input.apiKey ?? null)
    if (input.sessionActiveOrganizationId) {
      c.set("activeOrganizationId", input.sessionActiveOrganizationId)
    }
    await next()
  })
  app.get("/v1/org", organizationContextModule.resolveOrganizationContextMiddleware, (c) => {
    const context = c.get("organizationContext")
    const session = c.get("session")
    return c.json({
      organizationId: context.organization.id,
      activeOrganizationId: c.get("activeOrganizationId") ?? null,
      sessionActiveOrganizationId: session?.activeOrganizationId ?? null,
    })
  })
  return app
}

test("canonical organization scope header wins over a different active session org", async () => {
  const userId = createDenTypeId("user")
  const state = createTestState(userId)
  const sessionOrg = addVisibleOrg(state, "session-org").org
  const headerOrg = addVisibleOrg(state, "header-org").org
  const app = createOrgContextApp(state, { sessionActiveOrganizationId: sessionOrg.id })

  const response = await app.request("http://den.local/v1/org", {
    headers: { "x-openwork-org-id": headerOrg.id },
  })

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    organizationId: headerOrg.id,
    activeOrganizationId: headerOrg.id,
    sessionActiveOrganizationId: sessionOrg.id,
  })
  expect(state.resolveUserOrganizationsCalls).toHaveLength(0)
})

test("legacy organization scope header remains an alias", async () => {
  const userId = createDenTypeId("user")
  const state = createTestState(userId)
  const sessionOrg = addVisibleOrg(state, "session-org").org
  const headerOrg = addVisibleOrg(state, "legacy-header-org").org
  const app = createOrgContextApp(state, { sessionActiveOrganizationId: sessionOrg.id })

  const response = await app.request("http://den.local/v1/org", {
    headers: { "x-openwork-legacy-org-id": headerOrg.id },
  })

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    organizationId: headerOrg.id,
    activeOrganizationId: headerOrg.id,
    sessionActiveOrganizationId: sessionOrg.id,
  })
  expect(state.resolveUserOrganizationsCalls).toHaveLength(0)
})

test("a valid active session org resolves without re-resolving organizations", async () => {
  const userId = createDenTypeId("user")
  const state = createTestState(userId)
  const sessionOrg = addVisibleOrg(state, "session-org").org
  const app = createOrgContextApp(state, { sessionActiveOrganizationId: sessionOrg.id })

  const response = await app.request("http://den.local/v1/org")

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    organizationId: sessionOrg.id,
    activeOrganizationId: sessionOrg.id,
    sessionActiveOrganizationId: sessionOrg.id,
  })
  expect(state.resolveUserOrganizationsCalls).toHaveLength(0)
})

test("an explicit header for a non-member org hard fails instead of falling back", async () => {
  const userId = createDenTypeId("user")
  const state = createTestState(userId)
  const sessionOrg = addVisibleOrg(state, "session-org").org
  const nonMemberOrgId = createDenTypeId("organization")
  const app = createOrgContextApp(state, { sessionActiveOrganizationId: sessionOrg.id })

  const response = await app.request("http://den.local/v1/org", {
    headers: { "x-openwork-org-id": nonMemberOrgId },
  })

  expect(response.status).toBe(404)
  await expect(response.json()).resolves.toEqual({ error: "organization_not_found" })
  expect(state.resolveUserOrganizationsCalls).toHaveLength(0)
})

test("a stale session self-heals when the user has exactly one org", async () => {
  const userId = createDenTypeId("user")
  const state = createTestState(userId)
  const staleOrgId = createDenTypeId("organization")
  const fallbackOrg = addVisibleOrg(state, "only-org").org
  const app = createOrgContextApp(state, { sessionActiveOrganizationId: staleOrgId })

  const response = await app.request("http://den.local/v1/org")

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    organizationId: fallbackOrg.id,
    activeOrganizationId: fallbackOrg.id,
    sessionActiveOrganizationId: fallbackOrg.id,
  })
  expect(state.resolveUserOrganizationsCalls).toEqual([{ activeOrganizationId: null, userId }])
  expect(state.setSessionActiveOrganizationCalls).toHaveLength(1)
  expect(state.setSessionActiveOrganizationCalls[0]?.organizationId).toBe(fallbackOrg.id)
})

test("a stale session with multiple orgs still requires an explicit org signal", async () => {
  const userId = createDenTypeId("user")
  const state = createTestState(userId)
  const staleOrgId = createDenTypeId("organization")
  addVisibleOrg(state, "first-org")
  addVisibleOrg(state, "second-org")
  const app = createOrgContextApp(state, { sessionActiveOrganizationId: staleOrgId })

  const response = await app.request("http://den.local/v1/org")

  expect(response.status).toBe(404)
  await expect(response.json()).resolves.toEqual({ error: "organization_not_found" })
  expect(state.resolveUserOrganizationsCalls).toEqual([{ activeOrganizationId: null, userId }])
  expect(state.setSessionActiveOrganizationCalls).toHaveLength(0)
})

test("a canonical header fixes a stale session even when the user has multiple orgs", async () => {
  const userId = createDenTypeId("user")
  const state = createTestState(userId)
  const staleOrgId = createDenTypeId("organization")
  const headerOrg = addVisibleOrg(state, "header-org").org
  addVisibleOrg(state, "other-org")
  const app = createOrgContextApp(state, { sessionActiveOrganizationId: staleOrgId })

  const response = await app.request("http://den.local/v1/org", {
    headers: { "x-openwork-org-id": headerOrg.id },
  })

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    organizationId: headerOrg.id,
    activeOrganizationId: headerOrg.id,
    sessionActiveOrganizationId: staleOrgId,
  })
  expect(state.resolveUserOrganizationsCalls).toHaveLength(0)
})

test("an API-key scoped org wins over a conflicting request header", async () => {
  const userId = createDenTypeId("user")
  const state = createTestState(userId)
  const apiOrg = addVisibleOrg(state, "api-key-org")
  const headerOrg = addVisibleOrg(state, "header-org").org
  const apiKey = createApiKey({ organizationId: apiOrg.org.id, memberId: apiOrg.memberId, userId })
  const app = createOrgContextApp(state, { apiKey, sessionActiveOrganizationId: headerOrg.id })

  const response = await app.request("http://den.local/v1/org", {
    headers: { "x-openwork-org-id": headerOrg.id },
  })

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    organizationId: apiOrg.org.id,
    activeOrganizationId: apiOrg.org.id,
    sessionActiveOrganizationId: headerOrg.id,
  })
  expect(state.resolveUserOrganizationsCalls).toHaveLength(0)
})
