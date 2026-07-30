import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_team_lifecycle"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const ownerUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const ownerSessionId = createDenTypeId("session")
const renameTeamId = createDenTypeId("team")
const deleteTeamId = createDenTypeId("team")
const invitationId = createDenTypeId("invitation")
const historicalGrantId = createDenTypeId("marketplaceAccessGrant")
const historicalRemovedAt = new Date(Date.now() - 60_000)
const ownerSessionToken = `team-lifecycle-owner-${ownerSessionId}`
let ownerCookie = ""

async function cleanup() {
  await db.delete(schema.DesktopPolicyMemberTable).where(drizzle.eq(schema.DesktopPolicyMemberTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.LlmProviderAccessTable).where(drizzle.inArray(schema.LlmProviderAccessTable.teamId, [renameTeamId, deleteTeamId]))
  await db.delete(schema.MarketplaceAccessGrantTable).where(drizzle.eq(schema.MarketplaceAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.ConfigObjectAccessGrantTable).where(drizzle.eq(schema.ConfigObjectAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.PluginAccessGrantTable).where(drizzle.eq(schema.PluginAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.ConnectorInstanceAccessGrantTable).where(drizzle.eq(schema.ConnectorInstanceAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.TeamMemberTable).where(drizzle.inArray(schema.TeamMemberTable.teamId, [renameTeamId, deleteTeamId]))
  await db.delete(schema.InvitationTable).where(drizzle.eq(schema.InvitationTable.organizationId, organizationId))
  await db.delete(schema.TeamTable).where(drizzle.eq(schema.TeamTable.organizationId, organizationId))
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, ownerSessionId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, memberUserId]))
}

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

  await cleanup()
  await db.insert(schema.AuthUserTable).values([
    {
      id: ownerUserId,
      name: "Team Lifecycle Owner",
      email: `team-lifecycle-owner+${ownerUserId}@test.local`,
      emailVerified: true,
    },
    {
      id: memberUserId,
      name: "Team Lifecycle Member",
      email: `team-lifecycle-member+${memberUserId}@test.local`,
      emailVerified: true,
    },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Team Lifecycle",
    slug: `team-lifecycle-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values([
    {
      id: ownerMemberId,
      organizationId,
      userId: ownerUserId,
      role: "owner",
    },
    {
      id: memberId,
      organizationId,
      userId: memberUserId,
      role: "member",
    },
  ])
  await db.insert(schema.AuthSessionTable).values({
    id: ownerSessionId,
    userId: ownerUserId,
    activeOrganizationId: organizationId,
    token: ownerSessionToken,
    expiresAt: new Date(Date.now() + 60_000),
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
  if (db && schema && drizzle) {
    await cleanup()
  }
  mock.restore()
})

test("name-only team updates preserve member IDs in the response and database", async () => {
  await db.insert(schema.TeamTable).values({
    id: renameTeamId,
    organizationId,
    name: "Engineering",
  })
  await db.insert(schema.TeamMemberTable).values({
    id: createDenTypeId("teamMember"),
    teamId: renameTeamId,
    orgMembershipId: memberId,
  })

  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/teams/${renameTeamId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
      origin: API_ORIGIN,
    },
    body: JSON.stringify({ name: "Product Engineering" }),
  }))
  const payload: unknown = await response.json()

  expect(response.status).toBe(200)
  expect(isRecord(payload) && isRecord(payload.team) ? payload.team.memberIds : null).toEqual([memberId])

  const memberships = await db
    .select()
    .from(schema.TeamMemberTable)
    .where(drizzle.eq(schema.TeamMemberTable.teamId, renameTeamId))
  expect(memberships.map((row) => row.orgMembershipId)).toEqual([memberId])
})

test("team deletion revokes active team access and clears pending invite references", async () => {
  await db.insert(schema.TeamTable).values({
    id: deleteTeamId,
    organizationId,
    name: "Temporary Team",
  })
  await db.insert(schema.TeamMemberTable).values({
    id: createDenTypeId("teamMember"),
    teamId: deleteTeamId,
    orgMembershipId: memberId,
  })
  await db.insert(schema.InvitationTable).values({
    id: invitationId,
    organizationId,
    email: `future-team-member+${invitationId}@test.local`,
    role: "member",
    status: "pending",
    teamId: deleteTeamId,
    inviterId: ownerUserId,
    orgMemberId: ownerMemberId,
    inviteToken: `team-lifecycle-${invitationId}`,
    expiresAt: new Date(Date.now() + 60_000),
  })
  await db.insert(schema.DesktopPolicyMemberTable).values({
    id: createDenTypeId("desktopPolicyMember"),
    organizationId,
    desktopPolicyId: createDenTypeId("desktopPolicy"),
    teamId: deleteTeamId,
  })
  await db.insert(schema.ExternalMcpConnectionAccessGrantTable).values({
    id: createDenTypeId("externalMcpConnectionAccessGrant"),
    organizationId,
    externalMcpConnectionId: createDenTypeId("externalMcpConnection"),
    teamId: deleteTeamId,
    createdByOrgMembershipId: ownerMemberId,
  })
  await db.insert(schema.LlmProviderAccessTable).values({
    id: createDenTypeId("llmProviderAccess"),
    llmProviderId: createDenTypeId("llmProvider"),
    teamId: deleteTeamId,
  })
  await db.insert(schema.MarketplaceAccessGrantTable).values({
    id: createDenTypeId("marketplaceAccessGrant"),
    organizationId,
    marketplaceId: createDenTypeId("marketplace"),
    teamId: deleteTeamId,
    role: "viewer",
    createdByOrgMembershipId: ownerMemberId,
  })
  await db.insert(schema.MarketplaceAccessGrantTable).values({
    id: historicalGrantId,
    organizationId,
    marketplaceId: createDenTypeId("marketplace"),
    teamId: deleteTeamId,
    role: "viewer",
    createdByOrgMembershipId: ownerMemberId,
    removedAt: historicalRemovedAt,
  })
  await db.insert(schema.ConfigObjectAccessGrantTable).values({
    id: createDenTypeId("configObjectAccessGrant"),
    organizationId,
    configObjectId: createDenTypeId("configObject"),
    teamId: deleteTeamId,
    role: "viewer",
    createdByOrgMembershipId: ownerMemberId,
  })
  await db.insert(schema.PluginAccessGrantTable).values({
    id: createDenTypeId("pluginAccessGrant"),
    organizationId,
    pluginId: createDenTypeId("plugin"),
    teamId: deleteTeamId,
    role: "viewer",
    createdByOrgMembershipId: ownerMemberId,
  })
  await db.insert(schema.ConnectorInstanceAccessGrantTable).values({
    id: createDenTypeId("connectorInstanceAccessGrant"),
    organizationId,
    connectorInstanceId: createDenTypeId("connectorInstance"),
    teamId: deleteTeamId,
    role: "viewer",
    createdByOrgMembershipId: ownerMemberId,
  })

  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/teams/${deleteTeamId}`, {
    method: "DELETE",
    headers: {
      cookie: ownerCookie,
      origin: API_ORIGIN,
    },
  }))
  expect(response.status).toBe(204)

  const [teams, memberships, desktopAssignments, mcpGrants, modelGrants, invitations] = await Promise.all([
    db.select().from(schema.TeamTable).where(drizzle.eq(schema.TeamTable.id, deleteTeamId)),
    db.select().from(schema.TeamMemberTable).where(drizzle.eq(schema.TeamMemberTable.teamId, deleteTeamId)),
    db.select().from(schema.DesktopPolicyMemberTable).where(drizzle.eq(schema.DesktopPolicyMemberTable.teamId, deleteTeamId)),
    db.select().from(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.teamId, deleteTeamId)),
    db.select().from(schema.LlmProviderAccessTable).where(drizzle.eq(schema.LlmProviderAccessTable.teamId, deleteTeamId)),
    db.select().from(schema.InvitationTable).where(drizzle.eq(schema.InvitationTable.id, invitationId)),
  ])
  expect(teams).toHaveLength(0)
  expect(memberships).toHaveLength(0)
  expect(desktopAssignments).toHaveLength(0)
  expect(mcpGrants).toHaveLength(0)
  expect(modelGrants).toHaveLength(0)
  expect(invitations[0]?.status).toBe("pending")
  expect(invitations[0]?.teamId).toBeNull()

  const [marketplaceGrants, configObjectGrants, pluginGrants, connectorGrants] = await Promise.all([
    db.select().from(schema.MarketplaceAccessGrantTable).where(drizzle.eq(schema.MarketplaceAccessGrantTable.teamId, deleteTeamId)),
    db.select().from(schema.ConfigObjectAccessGrantTable).where(drizzle.eq(schema.ConfigObjectAccessGrantTable.teamId, deleteTeamId)),
    db.select().from(schema.PluginAccessGrantTable).where(drizzle.eq(schema.PluginAccessGrantTable.teamId, deleteTeamId)),
    db.select().from(schema.ConnectorInstanceAccessGrantTable).where(drizzle.eq(schema.ConnectorInstanceAccessGrantTable.teamId, deleteTeamId)),
  ])
  const revokedGrants = [
    ...marketplaceGrants,
    ...configObjectGrants,
    ...pluginGrants,
    ...connectorGrants,
  ]
  expect(revokedGrants).toHaveLength(5)
  expect(revokedGrants.every((grant) => grant.removedAt instanceof Date)).toBe(true)
  expect(
    marketplaceGrants.find((grant) => grant.id === historicalGrantId)?.removedAt?.getTime(),
  ).toBe(historicalRemovedAt.getTime())
})
