import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigObjectTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrganizationRoleTable,
  OrganizationTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono, type MiddlewareHandler } from "hono"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

const API_ORIGIN = "http://127.0.0.1:8790"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_teamaccess"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "team-access-test-encryption-key-1234567890"
process.env.BETTER_AUTH_SECRET ??= "team-access-test-secret-123456789"
process.env.BETTER_AUTH_URL ??= API_ORIGIN
process.env.CORS_ORIGINS ??= API_ORIGIN

let app: Hono<{ Variables: OrgRouteVariables }>
let teamPluginAccessListResponseSchema: typeof import("../src/routes/org/plugin-system/schemas.js").teamPluginAccessListResponseSchema
let db: typeof import("../src/db.js").db

const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const otherOrganizationTeamId = createDenTypeId("team")
const unknownTeamId = createDenTypeId("team")

const adminUserId = createDenTypeId("user")
const caseyUserId = createDenTypeId("user")
const novaUserId = createDenTypeId("user")
const adminMemberId = createDenTypeId("member")
const caseyMemberId = createDenTypeId("member")
const novaMemberId = createDenTypeId("member")

const pluginAId = createDenTypeId("plugin")
const pluginBId = createDenTypeId("plugin")
const pluginCId = createDenTypeId("plugin")
const pluginDId = createDenTypeId("plugin")
const pluginEId = createDenTypeId("plugin")
const marketplaceId = createDenTypeId("marketplace")
const configObjectId = createDenTypeId("configObject")

const directGrantId = createDenTypeId("pluginAccessGrant")
const marketplaceGrantId = createDenTypeId("marketplaceAccessGrant")
const orgWideGrantId = createDenTypeId("pluginAccessGrant")
const directGrantedAt = new Date("2026-01-01T10:00:00.000Z")
const marketplaceGrantedAt = new Date("2026-01-02T10:00:00.000Z")
const orgWideGrantedAt = new Date("2026-01-03T10:00:00.000Z")

async function cleanup() {
  await db.delete(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.organizationId, organizationId))
  await db.delete(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, organizationId))
  await db.delete(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, organizationId))
  await db.delete(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, organizationId))
  await db.delete(ConfigObjectTable).where(eq(ConfigObjectTable.organizationId, organizationId))
  await db.delete(PluginTable).where(eq(PluginTable.organizationId, organizationId))
  await db.delete(MarketplaceTable).where(eq(MarketplaceTable.organizationId, organizationId))
  await db.delete(TeamMemberTable).where(inArray(TeamMemberTable.teamId, [teamId, otherOrganizationTeamId]))
  await db.delete(TeamTable).where(inArray(TeamTable.organizationId, [organizationId, otherOrganizationId]))
  await db.delete(OrganizationRoleTable).where(inArray(OrganizationRoleTable.organizationId, [organizationId, otherOrganizationId]))
  await db.delete(MemberTable).where(inArray(MemberTable.organizationId, [organizationId, otherOrganizationId]))
  await db.delete(OrganizationTable).where(inArray(OrganizationTable.id, [organizationId, otherOrganizationId]))
  await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, [adminUserId, caseyUserId, novaUserId]))
}

function actorContext(input: {
  memberId: typeof adminMemberId
  role: string
  teamMember: boolean
  userId: typeof adminUserId
}): PluginArchActorContext {
  const now = new Date()
  return {
    memberTeams: input.teamMember
      ? [{ id: teamId, organizationId, name: "Product", createdAt: now, updatedAt: now }]
      : [],
    organizationContext: {
      organization: {
        id: organizationId,
        name: "Team Access Test",
        slug: `team-access-${organizationId}`,
        logo: null,
        allowedEmailDomains: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: input.memberId,
        userId: input.userId,
        role: input.role,
        createdAt: now,
        joinedAt: now,
        isOwner: false,
      },
      invitations: [],
      members: [],
      roles: [],
      teams: [],
    },
    session: undefined,
  }
}

const adminContext = actorContext({ memberId: adminMemberId, role: "admin", teamMember: false, userId: adminUserId })
const caseyContext = actorContext({ memberId: caseyMemberId, role: "member", teamMember: true, userId: caseyUserId })
const novaContext = actorContext({ memberId: novaMemberId, role: "member", teamMember: false, userId: novaUserId })

function requestContext(actor: string | undefined) {
  if (actor === "casey") return caseyContext
  if (actor === "nova") return novaContext
  return adminContext
}

beforeAll(async () => {
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  db = realDb
  mock.module("../src/db.js", () => ({ db: realDb }))
  const middleware = await import("../src/middleware/index.js")
  const passThroughMiddleware: MiddlewareHandler = async (_c, next) => {
    await next()
  }
  mock.module("../src/middleware/index.js", () => ({
    ...middleware,
    orgMemberRoute: () => passThroughMiddleware,
    resolveMemberTeamsMiddleware: passThroughMiddleware,
  }))
  const { registerPluginArchRoutes } = await import("../src/routes/org/plugin-system/routes.js")
  teamPluginAccessListResponseSchema = (await import("../src/routes/org/plugin-system/schemas.js")).teamPluginAccessListResponseSchema
  app = new Hono<{ Variables: OrgRouteVariables }>()
  app.use("*", async (c, next) => {
    const context = requestContext(c.req.header("x-test-actor"))
    c.set("organizationContext", context.organizationContext)
    c.set("memberTeams", context.memberTeams)
    await next()
  })
  registerPluginArchRoutes(app)

  await cleanup()
  await db.insert(AuthUserTable).values([
    { id: adminUserId, name: "Avery Admin", email: `${adminUserId}@team-access.test`, emailVerified: true },
    { id: caseyUserId, name: "Casey Collaborator", email: `${caseyUserId}@team-access.test`, emailVerified: true },
    { id: novaUserId, name: "Nova Nonmember", email: `${novaUserId}@team-access.test`, emailVerified: true },
  ])
  await db.insert(OrganizationTable).values([
    { id: organizationId, name: "Team Access Test", slug: `team-access-${organizationId}` },
    { id: otherOrganizationId, name: "Other Team Access Test", slug: `other-team-access-${otherOrganizationId}` },
  ])
  await db.insert(MemberTable).values([
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
    { id: caseyMemberId, organizationId, userId: caseyUserId, role: "member" },
    { id: novaMemberId, organizationId, userId: novaUserId, role: "member" },
  ])
  await db.insert(TeamTable).values([
    { id: teamId, organizationId, name: "Product" },
    { id: otherOrganizationTeamId, organizationId: otherOrganizationId, name: "Other Product" },
  ])
  await db.insert(TeamMemberTable).values({
    id: createDenTypeId("teamMember"),
    teamId,
    orgMembershipId: caseyMemberId,
  })
  await db.insert(MarketplaceTable).values({
    id: marketplaceId,
    organizationId,
    name: "Curated Catalog",
    description: "Team catalog",
    status: "active",
    createdByOrgMembershipId: adminMemberId,
  })
  await db.insert(PluginTable).values([
    { id: pluginAId, organizationId, name: "Alpha", status: "active", createdByOrgMembershipId: caseyMemberId },
    { id: pluginBId, organizationId, name: "Beta", status: "active", createdByOrgMembershipId: adminMemberId },
    { id: pluginCId, organizationId, name: "Charlie", status: "active", createdByOrgMembershipId: adminMemberId },
    { id: pluginDId, organizationId, name: "Delta", status: "archived", createdByOrgMembershipId: adminMemberId },
    { id: pluginEId, organizationId, name: "Echo", status: "active", createdByOrgMembershipId: adminMemberId },
  ])
  await db.insert(ConfigObjectTable).values({
    id: configObjectId,
    organizationId,
    objectType: "skill",
    sourceMode: "cloud",
    title: "Alpha Skill",
    status: "active",
    createdByOrgMembershipId: caseyMemberId,
  })
  await db.insert(PluginConfigObjectTable).values({
    id: createDenTypeId("pluginConfigObject"),
    organizationId,
    pluginId: pluginAId,
    configObjectId,
    membershipSource: "manual",
    createdByOrgMembershipId: caseyMemberId,
  })
  await db.insert(MarketplacePluginTable).values({
    id: createDenTypeId("marketplacePlugin"),
    organizationId,
    marketplaceId,
    pluginId: pluginBId,
    membershipSource: "manual",
    createdByOrgMembershipId: adminMemberId,
  })
  await db.insert(MarketplaceAccessGrantTable).values({
    id: marketplaceGrantId,
    organizationId,
    marketplaceId,
    orgMembershipId: null,
    teamId,
    orgWide: false,
    role: "editor",
    createdByOrgMembershipId: adminMemberId,
    createdAt: marketplaceGrantedAt,
  })
  await db.insert(PluginAccessGrantTable).values([
    {
      id: directGrantId,
      organizationId,
      pluginId: pluginAId,
      orgMembershipId: null,
      teamId,
      orgWide: false,
      role: "viewer",
      createdByOrgMembershipId: caseyMemberId,
      createdAt: directGrantedAt,
    },
    {
      id: orgWideGrantId,
      organizationId,
      pluginId: pluginCId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      role: "viewer",
      createdByOrgMembershipId: adminMemberId,
      createdAt: orgWideGrantedAt,
    },
    {
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId: pluginDId,
      orgMembershipId: null,
      teamId,
      orgWide: false,
      role: "viewer",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId: pluginEId,
      orgMembershipId: null,
      teamId,
      orgWide: false,
      role: "viewer",
      createdByOrgMembershipId: adminMemberId,
      removedAt: new Date("2026-01-04T10:00:00.000Z"),
    },
  ])
})

afterAll(async () => {
  await cleanup()
  mock.restore()
})

function requestTeamAccess(actor: "admin" | "casey" | "nova", requestedTeamId = teamId) {
  return app.fetch(new Request(`${API_ORIGIN}/v1/teams/${requestedTeamId}/plugin-access`, {
    headers: { "x-test-actor": actor },
  }))
}

const expectedItems = [
  {
    plugin: { id: pluginAId, name: "Alpha", componentCount: 1 },
    edge: "direct_team",
    marketplace: null,
    role: "viewer",
    grantedBy: { orgMembershipId: caseyMemberId, name: "Casey Collaborator" },
    grantedAt: directGrantedAt.toISOString(),
    grantId: directGrantId,
  },
  {
    plugin: { id: pluginBId, name: "Beta", componentCount: 0 },
    edge: "via_catalog",
    marketplace: { id: marketplaceId, name: "Curated Catalog" },
    role: "editor",
    grantedBy: { orgMembershipId: adminMemberId, name: "Avery Admin" },
    grantedAt: marketplaceGrantedAt.toISOString(),
    grantId: null,
  },
  {
    plugin: { id: pluginCId, name: "Charlie", componentCount: 0 },
    edge: "org_wide",
    marketplace: null,
    role: "viewer",
    grantedBy: { orgMembershipId: adminMemberId, name: "Avery Admin" },
    grantedAt: orgWideGrantedAt.toISOString(),
    grantId: null,
  },
]

test("an org admin sees the team's effective plugin access", async () => {
  const response = await requestTeamAccess("admin")
  expect(response.status).toBe(200)
  const payload = teamPluginAccessListResponseSchema.parse(await response.json())
  expect(payload).toEqual({ items: expectedItems })
})

test("a non-admin team member sees the same effective plugin access", async () => {
  const response = await requestTeamAccess("casey")
  expect(response.status).toBe(200)
  const payload = teamPluginAccessListResponseSchema.parse(await response.json())
  expect(payload).toEqual({ items: expectedItems })
})

test("a non-member cannot view the team's plugin access", async () => {
  const response = await requestTeamAccess("nova")
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ error: "forbidden" })
})

test("an unknown team returns not found", async () => {
  const response = await requestTeamAccess("admin", unknownTeamId)
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: "team_not_found" })
})

test("a team from another organization returns not found", async () => {
  const response = await requestTeamAccess("admin", otherOrganizationTeamId)
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: "team_not_found" })
})
