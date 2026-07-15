import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_MCP_CONNECTIONS_GATING_ENABLED = "true"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")
let env: typeof import("../src/env.js").env
let memberFacingMcpConnectionsEnabled: typeof import("../src/capability-sources/external-mcp-rollout.js")["memberFacingMcpConnectionsEnabled"]

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const capabilityOrganizationId = createDenTypeId("organization")
const capabilityMemberId = createDenTypeId("member")
const onboardingOrganizationId = createDenTypeId("organization")
const onboardingMemberId = createDenTypeId("member")
const onboardingTeamId = createDenTypeId("team")
const onboardingTeamMemberId = createDenTypeId("teamMember")
const defaultPolicyId = createDenTypeId("desktopPolicy")
const lowPriorityPolicyId = createDenTypeId("desktopPolicy")
const highPriorityPolicyId = createDenTypeId("desktopPolicy")
const lowPriorityAssignmentId = createDenTypeId("desktopPolicyMember")
const highPriorityMemberAssignmentId = createDenTypeId("desktopPolicyMember")
const highPriorityTeamAssignmentId = createDenTypeId("desktopPolicyMember")
const flatConnectMetadata = {
  connectEnabled: true,
  brandAppName: "Acme Work",
  brandLogoUrl: "https://den.example-corp.internal/assets/wordmark.svg",
  brandIconUrl: "https://den.example-corp.internal/assets/icon.png",
}
const capabilityMetadata = { capabilities: { mcpConnections: true } }
const defaultOnboardingPrompts = ["Default onboarding task", "Default onboarding follow-up"]
const highPriorityOnboardingPrompts = ["High priority task", "High priority follow-up", "High priority optional"]
const defaultOnboardingPromptDescriptions = ["Default onboarding", "Default follow-up"]
const highPriorityOnboardingPromptDescriptions = ["High priority onboarding", "High priority follow-up", "High priority optional"]
let crudDesktopPolicyId: string | null = null

beforeAll(async () => {
  seedRequiredEnv()
  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod, envMod, rolloutMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/session.js"),
    import("../src/env.js"),
    import("../src/capability-sources/external-mcp-rollout.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod
  env = envMod.env
  memberFacingMcpConnectionsEnabled = rolloutMod.memberFacingMcpConnectionsEnabled

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "Desktop Config User",
    email: `desktop-config+${userId}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Desktop Config Org",
    slug: `desktop-config-${organizationId}`,
    metadata: flatConnectMetadata,
  })
  await db.insert(schema.OrganizationTable).values({
    id: capabilityOrganizationId,
    name: "Desktop Config Capability Org",
    slug: `desktop-config-capability-${capabilityOrganizationId}`,
    metadata: capabilityMetadata,
  })
  await db.insert(schema.OrganizationTable).values({
    id: onboardingOrganizationId,
    name: "Desktop Config Onboarding Org",
    slug: `desktop-config-onboarding-${onboardingOrganizationId}`,
  })
  await db.insert(schema.MemberTable).values([
    {
      id: memberId,
      organizationId,
      userId,
      role: "owner",
    },
    {
      id: capabilityMemberId,
      organizationId: capabilityOrganizationId,
      userId,
      role: "owner",
    },
    {
      id: onboardingMemberId,
      organizationId: onboardingOrganizationId,
      userId,
      role: "owner",
    },
  ])
  await db.insert(schema.TeamTable).values({
    id: onboardingTeamId,
    organizationId: onboardingOrganizationId,
    name: "Onboarding Team",
  })
  await db.insert(schema.TeamMemberTable).values({
    id: onboardingTeamMemberId,
    teamId: onboardingTeamId,
    orgMembershipId: onboardingMemberId,
  })
  await db.insert(schema.DesktopPolicyTable).values([
    {
      id: defaultPolicyId,
      organizationId: onboardingOrganizationId,
      policyName: "Default desktop policy",
      isDefault: true,
      isEnabled: true,
      policy: {
        onboardingPrompts: defaultOnboardingPrompts,
        onboardingPromptDescriptions: defaultOnboardingPromptDescriptions,
      },
      createdByOrgMemberId: onboardingMemberId,
    },
    {
      id: lowPriorityPolicyId,
      organizationId: onboardingOrganizationId,
      policyName: "Low priority onboarding policy",
      isDefault: null,
      isEnabled: true,
      priority: 1,
      policy: { onboardingPrompts: ["Low priority task", "Low priority follow-up"] },
      createdByOrgMemberId: onboardingMemberId,
    },
    {
      id: highPriorityPolicyId,
      organizationId: onboardingOrganizationId,
      policyName: "High priority onboarding policy",
      isDefault: null,
      isEnabled: true,
      priority: 10,
      policy: {
        onboardingPrompts: highPriorityOnboardingPrompts,
        onboardingPromptDescriptions: highPriorityOnboardingPromptDescriptions,
      },
      createdByOrgMemberId: onboardingMemberId,
    },
  ])
  await db.insert(schema.DesktopPolicyMemberTable).values([
    {
      id: lowPriorityAssignmentId,
      organizationId: onboardingOrganizationId,
      desktopPolicyId: lowPriorityPolicyId,
      orgMemberId: onboardingMemberId,
      teamId: null,
    },
    {
      id: highPriorityMemberAssignmentId,
      organizationId: onboardingOrganizationId,
      desktopPolicyId: highPriorityPolicyId,
      orgMemberId: onboardingMemberId,
      teamId: null,
    },
    {
      id: highPriorityTeamAssignmentId,
      organizationId: onboardingOrganizationId,
      desktopPolicyId: highPriorityPolicyId,
      orgMemberId: null,
      teamId: onboardingTeamId,
    },
  ])
})

afterAll(async () => {
  const memberIds = [memberId, capabilityMemberId, onboardingMemberId]
  const organizationIds = [organizationId, capabilityOrganizationId, onboardingOrganizationId]
  if (crudDesktopPolicyId) {
    await db.delete(schema.DesktopPolicyMemberTable).where(drizzle.eq(schema.DesktopPolicyMemberTable.desktopPolicyId, crudDesktopPolicyId))
    await db.delete(schema.DesktopPolicyTable).where(drizzle.eq(schema.DesktopPolicyTable.id, crudDesktopPolicyId))
  }
  await db.delete(schema.DesktopPolicyMemberTable).where(drizzle.inArray(schema.DesktopPolicyMemberTable.id, [
    lowPriorityAssignmentId,
    highPriorityMemberAssignmentId,
    highPriorityTeamAssignmentId,
  ]))
  await db.delete(schema.DesktopPolicyTable).where(drizzle.inArray(schema.DesktopPolicyTable.id, [
    defaultPolicyId,
    lowPriorityPolicyId,
    highPriorityPolicyId,
  ]))
  await db.delete(schema.TeamMemberTable).where(drizzle.eq(schema.TeamMemberTable.id, onboardingTeamMemberId))
  await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, onboardingTeamId))
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.id, memberIds))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.inArray(schema.OrganizationRoleTable.organizationId, organizationIds))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, organizationIds))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
})

async function requestDesktopConfig(activeOrganizationId: string) {
  const response = await app.fetch(new Request("http://den-api.local/v1/me/desktop-config", {
    headers: {
      "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId: activeOrganizationId }),
    },
  }))

  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(isRecord(body)).toBe(true)
  if (!isRecord(body)) {
    throw new Error("Desktop config response was not an object")
  }
  return body
}

async function requestDesktopPolicyAdmin(input: {
  method: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  body?: unknown
  expectedStatus: number
}) {
  const headers = new Headers({
    "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId: onboardingOrganizationId }),
  })
  const init: RequestInit = { method: input.method, headers }
  if (input.body !== undefined) {
    headers.set("content-type", "application/json")
    init.body = JSON.stringify(input.body)
  }

  const response = await app.fetch(new Request(`http://den-api.local${input.path}`, init))
  expect(response.status).toBe(input.expectedStatus)
  if (input.expectedStatus === 204) return null
  const payload: unknown = await response.json()
  expect(isRecord(payload)).toBe(true)
  if (!isRecord(payload)) {
    throw new Error("Desktop policy response was not an object")
  }
  return payload
}

function expectRecord(value: unknown, message: string): Record<string, unknown> {
  expect(isRecord(value)).toBe(true)
  if (!isRecord(value)) throw new Error(message)
  return value
}

function expectString(value: unknown, message: string) {
  expect(typeof value).toBe("string")
  if (typeof value !== "string") throw new Error(message)
  return value
}

function expectDesktopPolicy(payload: Record<string, unknown>) {
  return expectRecord(payload.desktopPolicy, "Desktop policy payload was missing desktopPolicy")
}

function findListedDesktopPolicy(payload: Record<string, unknown>, id: string) {
  expect(Array.isArray(payload.desktopPolicies)).toBe(true)
  const rows = Array.isArray(payload.desktopPolicies) ? payload.desktopPolicies : []
  for (const row of rows) {
    if (isRecord(row) && row.id === id) return row
  }
  throw new Error("Created desktop policy was not present in list response")
}

function expectConnectEnabled(body: Record<string, unknown>, metadata: Record<string, unknown>) {
  const expected = memberFacingMcpConnectionsEnabled(metadata, {
    gatingEnabled: env.mcpConnectionsGatingEnabled,
  })
  expect(typeof body.connectEnabled).toBe("boolean")
  expect(body.connectEnabled).toBe(expected)
}

test("GET /v1/me/desktop-config exposes the effective connectEnabled org flag", async () => {
  const flatBody = await requestDesktopConfig(organizationId)
  expectConnectEnabled(flatBody, flatConnectMetadata)
  expect(flatBody.brandAppName).toBe(flatConnectMetadata.brandAppName)
  expect(flatBody.brandLogoUrl).toBe(flatConnectMetadata.brandLogoUrl)
  expect(flatBody.brandIconUrl).toBe(flatConnectMetadata.brandIconUrl)
  expect(flatBody.onboardingPrompts).toBeUndefined()

  const capabilityBody = await requestDesktopConfig(capabilityOrganizationId)
  expectConnectEnabled(capabilityBody, capabilityMetadata)
  expect(capabilityBody.connectEnabled).toBe(true)
  expect(capabilityBody.onboardingPrompts).toBeUndefined()
})

test("GET /v1/me/desktop-config returns the effective onboarding prompts", async () => {
  const body = await requestDesktopConfig(onboardingOrganizationId)
  expect(body.onboardingPrompts).toEqual(highPriorityOnboardingPrompts)
  expect(body.onboardingPromptDescriptions).toEqual(highPriorityOnboardingPromptDescriptions)
})

test("desktop policy CRUD preserves, replaces, and clears onboarding prompts and descriptions", async () => {
  const createPayload = await requestDesktopPolicyAdmin({
    method: "POST",
    path: "/v1/desktop-policies",
    expectedStatus: 201,
    body: {
      policyName: "CRUD onboarding policy",
      priority: 3,
      policy: {
        allowZenModel: true,
        onboardingPrompts: ["CRUD prompt one", "CRUD prompt two"],
        onboardingPromptDescriptions: ["CRUD card one", "CRUD card two"],
      },
      memberIds: [],
      teamIds: [],
    },
  })
  if (!createPayload) throw new Error("Create response was empty")
  const created = expectDesktopPolicy(createPayload)
  crudDesktopPolicyId = expectString(created.id, "Created desktop policy was missing id")
  expect(created.priority).toBe(3)
  expect(expectRecord(created.policy, "Created desktop policy was missing policy").onboardingPrompts).toEqual(["CRUD prompt one", "CRUD prompt two"])
  expect(expectRecord(created.policy, "Created desktop policy was missing policy").onboardingPromptDescriptions).toEqual(["CRUD card one", "CRUD card two"])

  const listPayload = await requestDesktopPolicyAdmin({
    method: "GET",
    path: "/v1/desktop-policies",
    expectedStatus: 200,
  })
  if (!listPayload) throw new Error("List response was empty")
  const listed = findListedDesktopPolicy(listPayload, crudDesktopPolicyId)
  expect(listed.priority).toBe(3)
  expect(expectRecord(listed.policy, "Listed desktop policy was missing policy").onboardingPrompts).toEqual(["CRUD prompt one", "CRUD prompt two"])
  expect(expectRecord(listed.policy, "Listed desktop policy was missing policy").onboardingPromptDescriptions).toEqual(["CRUD card one", "CRUD card two"])

  const preservedPayload = await requestDesktopPolicyAdmin({
    method: "PATCH",
    path: `/v1/desktop-policies/${encodeURIComponent(crudDesktopPolicyId)}`,
    expectedStatus: 200,
    body: {
      policyName: "CRUD onboarding policy preserved",
      priority: 4,
      policy: { allowZenModel: false },
      memberIds: [],
      teamIds: [],
    },
  })
  if (!preservedPayload) throw new Error("Preserve response was empty")
  const preserved = expectDesktopPolicy(preservedPayload)
  expect(preserved.priority).toBe(4)
  expect(expectRecord(preserved.policy, "Preserved desktop policy was missing policy").onboardingPrompts).toEqual(["CRUD prompt one", "CRUD prompt two"])
  expect(expectRecord(preserved.policy, "Preserved desktop policy was missing policy").onboardingPromptDescriptions).toEqual(["CRUD card one", "CRUD card two"])

  const replacedPayload = await requestDesktopPolicyAdmin({
    method: "PATCH",
    path: `/v1/desktop-policies/${encodeURIComponent(crudDesktopPolicyId)}`,
    expectedStatus: 200,
    body: {
      policyName: "CRUD onboarding policy replaced",
      priority: 5,
      policy: {
        allowZenModel: false,
        onboardingPrompts: ["Replacement prompt one", "Replacement prompt two"],
        onboardingPromptDescriptions: ["Replacement card one", "Replacement card two"],
      },
      memberIds: [],
      teamIds: [],
    },
  })
  if (!replacedPayload) throw new Error("Replace response was empty")
  const replaced = expectDesktopPolicy(replacedPayload)
  expect(replaced.priority).toBe(5)
  expect(expectRecord(replaced.policy, "Replaced desktop policy was missing policy").onboardingPrompts).toEqual(["Replacement prompt one", "Replacement prompt two"])
  expect(expectRecord(replaced.policy, "Replaced desktop policy was missing policy").onboardingPromptDescriptions).toEqual(["Replacement card one", "Replacement card two"])

  const clearedPayload = await requestDesktopPolicyAdmin({
    method: "PATCH",
    path: `/v1/desktop-policies/${encodeURIComponent(crudDesktopPolicyId)}`,
    expectedStatus: 200,
    body: {
      policyName: "CRUD onboarding policy cleared",
      priority: 6,
      policy: { allowZenModel: false, onboardingPrompts: null },
      memberIds: [],
      teamIds: [],
    },
  })
  if (!clearedPayload) throw new Error("Clear response was empty")
  const cleared = expectDesktopPolicy(clearedPayload)
  expect(cleared.priority).toBe(6)
  expect(expectRecord(cleared.policy, "Cleared desktop policy was missing policy").onboardingPrompts).toBeUndefined()
  expect(expectRecord(cleared.policy, "Cleared desktop policy was missing policy").onboardingPromptDescriptions).toBeUndefined()

  await requestDesktopPolicyAdmin({
    method: "DELETE",
    path: `/v1/desktop-policies/${encodeURIComponent(crudDesktopPolicyId)}`,
    expectedStatus: 204,
  })
  crudDesktopPolicyId = null
})
