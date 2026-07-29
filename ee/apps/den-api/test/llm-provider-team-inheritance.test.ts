import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_model_team_inheritance"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function providerNames(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.llmProviders)) {
    throw new Error("LLM provider response did not include llmProviders")
  }

  return payload.llmProviders.flatMap((provider) =>
    isRecord(provider) && typeof provider.name === "string" ? [provider.name] : [],
  )
}

function providerId(payload: unknown) {
  if (
    !isRecord(payload)
    || !isRecord(payload.llmProvider)
    || typeof payload.llmProvider.id !== "string"
  ) {
    throw new Error("LLM provider response did not include an id")
  }

  return payload.llmProvider.id
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const ownerUserId = createDenTypeId("user")
const futureUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const futureMemberId = createDenTypeId("member")
const ownerSessionId = createDenTypeId("session")
const futureSessionId = createDenTypeId("session")
const rejoinSessionId = createDenTypeId("session")
const rejoinInvitationId = createDenTypeId("invitation")
const rejoinMemberId = createDenTypeId("member")
const ownerSessionToken = `model-team-owner-${ownerSessionId}`
const futureSessionToken = `model-team-future-${futureSessionId}`
const rejoinSessionToken = `model-team-rejoin-${rejoinSessionId}`
const teamId = createDenTypeId("team")
let ownerCookie = ""
let futureMemberCookie = ""

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appModule, dbModule, schemaModule, drizzleModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
  ])
  app = appModule.default
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule

  await db.insert(schema.AuthUserTable).values({
    id: ownerUserId,
    name: "Model Team Owner",
    email: `model-team-owner+${ownerUserId}@test.local`,
    emailVerified: true,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Model Team Inheritance",
    slug: `model-team-inheritance-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: ownerMemberId,
    organizationId,
    userId: ownerUserId,
    role: "owner",
  })
  await db.insert(schema.AuthSessionTable).values({
    id: ownerSessionId,
    userId: ownerUserId,
    activeOrganizationId: organizationId,
    token: ownerSessionToken,
    expiresAt: new Date(Date.now() + 60_000),
  })
  await db.insert(schema.TeamTable).values({
    id: teamId,
    organizationId,
    name: "Engineering",
  })

  const betterAuthSecret = process.env.BETTER_AUTH_SECRET
  if (!betterAuthSecret) {
    throw new Error("BETTER_AUTH_SECRET is required")
  }
  ownerCookie = await serializeSignedCookie(
    "better-auth.session_token",
    ownerSessionToken,
    betterAuthSecret,
  )
})

afterAll(async () => {
  if (!db || !schema || !drizzle) {
    mock.restore()
    return
  }

  await db.delete(schema.TeamMemberTable).where(drizzle.eq(schema.TeamMemberTable.teamId, teamId))
  await db.delete(schema.LlmProviderAccessTable).where(
    drizzle.inArray(
      schema.LlmProviderAccessTable.llmProviderId,
      db
        .select({ id: schema.LlmProviderTable.id })
        .from(schema.LlmProviderTable)
        .where(drizzle.eq(schema.LlmProviderTable.organizationId, organizationId)),
    ),
  )
  await db.delete(schema.LlmProviderModelTable).where(
    drizzle.inArray(
      schema.LlmProviderModelTable.llmProviderId,
      db
        .select({ id: schema.LlmProviderTable.id })
        .from(schema.LlmProviderTable)
        .where(drizzle.eq(schema.LlmProviderTable.organizationId, organizationId)),
    ),
  )
  await db.delete(schema.LlmProviderTable).where(drizzle.eq(schema.LlmProviderTable.organizationId, organizationId))
  await db.delete(schema.AuthSessionTable).where(
    drizzle.inArray(schema.AuthSessionTable.id, [ownerSessionId, futureSessionId, rejoinSessionId]),
  )
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.InvitationTable).where(drizzle.eq(schema.InvitationTable.organizationId, organizationId))
  await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, teamId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(
    drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, futureUserId]),
  )
  mock.restore()
})

async function createProvider(input: {
  name: string
  providerId: string
  allMembers?: boolean
  cookie?: string
  memberIds?: string[]
  teamIds?: string[]
}) {
  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/llm-providers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: input.cookie ?? ownerCookie,
      origin: API_ORIGIN,
    },
    body: JSON.stringify({
      name: input.name,
      source: "custom",
      customConfig: {
        id: input.providerId,
        name: input.name,
        npm: "@ai-sdk/openai-compatible",
        env: ["MODEL_TEAM_TEST_API_KEY"],
        models: [{ id: `${input.providerId}-model`, name: `${input.name} Model` }],
      },
      allMembers: input.allMembers,
      memberIds: input.memberIds ?? [],
      teamIds: input.teamIds ?? [],
    }),
  }))
  const payload: unknown = await response.json()
  expect(response.status).toBe(201)
  return providerId(payload)
}

async function listProvidersForFutureMember(scope: "usable" | "manageable" = "usable") {
  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/llm-providers?scope=${scope}`, {
    headers: {
      cookie: futureMemberCookie,
      origin: API_ORIGIN,
    },
  }))
  expect(response.status).toBe(200)
  return response.json()
}

async function setEngineeringTeamMembers(memberIds: string[]) {
  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/teams/${teamId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
      origin: API_ORIGIN,
    },
    body: JSON.stringify({ memberIds }),
  }))
  expect(response.status).toBe(200)
}

test("team model inheritance survives re-invites without restoring stale member access", async () => {
  const teamProviderId = await createProvider({
    name: "Engineering Models",
    providerId: "engineering-models",
    teamIds: [teamId],
  })
  await createProvider({
    name: "Everyone Models",
    providerId: "everyone-models",
    allMembers: true,
  })

  await db.insert(schema.AuthUserTable).values({
    id: futureUserId,
    name: "Future Model Team Member",
    email: `model-team-future+${futureUserId}@test.local`,
    emailVerified: true,
  })
  await db.insert(schema.MemberTable).values({
    id: futureMemberId,
    organizationId,
    userId: futureUserId,
    role: "member",
  })
  await db.insert(schema.AuthSessionTable).values({
    id: futureSessionId,
    userId: futureUserId,
    activeOrganizationId: organizationId,
    token: futureSessionToken,
    expiresAt: new Date(Date.now() + 60_000),
  })

  const betterAuthSecret = process.env.BETTER_AUTH_SECRET
  if (!betterAuthSecret) {
    throw new Error("BETTER_AUTH_SECRET is required")
  }
  futureMemberCookie = await serializeSignedCookie(
    "better-auth.session_token",
    futureSessionToken,
    betterAuthSecret,
  )

  expect(providerNames(await listProvidersForFutureMember())).toEqual(["Everyone Models"])

  await setEngineeringTeamMembers([futureMemberId])

  expect(providerNames(await listProvidersForFutureMember()).sort()).toEqual([
    "Engineering Models",
    "Everyone Models",
  ])

  const connectResponse = await app.fetch(new Request(
    `${API_ORIGIN}/v1/llm-providers/${teamProviderId}/connect`,
    {
      headers: {
        cookie: futureMemberCookie,
        origin: API_ORIGIN,
      },
    },
  ))
  expect(connectResponse.status).toBe(200)
  await expect(connectResponse.json()).resolves.toMatchObject({
    llmProvider: {
      id: teamProviderId,
      models: [{ id: "engineering-models-model" }],
    },
  })

  await setEngineeringTeamMembers([])

  expect(providerNames(await listProvidersForFutureMember())).toEqual(["Everyone Models"])

  const formerMemberProviderId = await createProvider({
    name: "Former Member Models",
    providerId: "former-member-models",
    cookie: futureMemberCookie,
  })
  expect(providerNames(await listProvidersForFutureMember()).sort()).toEqual([
    "Everyone Models",
    "Former Member Models",
  ])

  const removeResponse = await app.fetch(new Request(
    `${API_ORIGIN}/v1/members/${futureMemberId}`,
    {
      method: "DELETE",
      headers: {
        cookie: ownerCookie,
        origin: API_ORIGIN,
      },
    },
  ))
  expect(removeResponse.status).toBe(204)

  const staleAccess = await db
    .select()
    .from(schema.LlmProviderAccessTable)
    .where(drizzle.eq(schema.LlmProviderAccessTable.orgMembershipId, futureMemberId))
  expect(staleAccess).toHaveLength(0)

  await db.insert(schema.InvitationTable).values({
    id: rejoinInvitationId,
    organizationId,
    email: `model-team-future+${futureUserId}@test.local`,
    role: "member",
    status: "pending",
    inviterId: ownerUserId,
    orgMemberId: ownerMemberId,
    inviteToken: `model-team-rejoin-${rejoinInvitationId}`,
    expiresAt: new Date(Date.now() + 60_000),
  })
  await db.insert(schema.MemberTable).values({
    id: rejoinMemberId,
    organizationId,
    userId: null,
    inviteId: rejoinInvitationId,
    invitedByOrgMember: ownerMemberId,
    role: "member",
    joinedAt: null,
  })

  await setEngineeringTeamMembers([rejoinMemberId])
  await createProvider({
    name: "Rejoin Direct Models",
    providerId: "rejoin-direct-models",
    memberIds: [rejoinMemberId],
  })

  await db.insert(schema.AuthSessionTable).values({
    id: rejoinSessionId,
    userId: futureUserId,
    activeOrganizationId: null,
    token: rejoinSessionToken,
    expiresAt: new Date(Date.now() + 60_000),
  })
  const betterAuthSecretForRejoin = process.env.BETTER_AUTH_SECRET
  if (!betterAuthSecretForRejoin) {
    throw new Error("BETTER_AUTH_SECRET is required")
  }
  futureMemberCookie = await serializeSignedCookie(
    "better-auth.session_token",
    rejoinSessionToken,
    betterAuthSecretForRejoin,
  )

  const acceptResponse = await app.fetch(new Request(
    `${API_ORIGIN}/v1/orgs/invitations/accept`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: futureMemberCookie,
        origin: API_ORIGIN,
      },
      body: JSON.stringify({ id: rejoinInvitationId }),
    },
  ))
  expect(acceptResponse.status).toBe(200)

  const lifecycleRows = await db
    .select()
    .from(schema.MemberTable)
    .where(drizzle.inArray(schema.MemberTable.id, [futureMemberId, rejoinMemberId]))
  const removedMember = lifecycleRows.find((member) => member.id === futureMemberId)
  const rejoinedMember = lifecycleRows.find((member) => member.id === rejoinMemberId)
  expect(removedMember?.userId).toBeNull()
  expect(removedMember?.removedAt).toBeInstanceOf(Date)
  expect(rejoinedMember?.userId).toBe(futureUserId)
  expect(rejoinedMember?.removedAt).toBeNull()

  expect(providerNames(await listProvidersForFutureMember()).sort()).toEqual([
    "Engineering Models",
    "Everyone Models",
    "Rejoin Direct Models",
  ])
  expect(providerNames(await listProvidersForFutureMember("manageable"))).not.toContain(
    "Former Member Models",
  )

  const formerProviderResponse = await app.fetch(new Request(
    `${API_ORIGIN}/v1/llm-providers/${formerMemberProviderId}/connect`,
    {
      headers: {
        cookie: futureMemberCookie,
        origin: API_ORIGIN,
      },
    },
  ))
  expect(formerProviderResponse.status).toBe(403)
})
