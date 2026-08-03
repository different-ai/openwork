import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigObjectTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
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

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_meaccess"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "me-access-test-encryption-key-1234567890"
process.env.BETTER_AUTH_SECRET ??= "me-access-test-secret-123456789012"
process.env.BETTER_AUTH_URL ??= API_ORIGIN
process.env.CORS_ORIGINS ??= API_ORIGIN

let app: Hono<{ Variables: OrgRouteVariables }>
let mePluginAccessListResponseSchema: typeof import("../src/routes/org/plugin-system/schemas.js").mePluginAccessListResponseSchema
let db: typeof import("../src/db.js").db

const organizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const adminUserId = createDenTypeId("user")
const caseyUserId = createDenTypeId("user")
const novaUserId = createDenTypeId("user")
const adminMemberId = createDenTypeId("member")
const caseyMemberId = createDenTypeId("member")
const novaMemberId = createDenTypeId("member")
const catalogPluginId = createDenTypeId("plugin")
const creatorPluginId = createDenTypeId("plugin")
const multiEdgePluginId = createDenTypeId("plugin")
const otherPluginId = createDenTypeId("plugin")
const archivedPluginId = createDenTypeId("plugin")
const removedGrantPluginId = createDenTypeId("plugin")
const marketplaceId = createDenTypeId("marketplace")
const configObjectId = createDenTypeId("configObject")
const directGrantedAt = new Date("2026-02-01T10:00:00.000Z")
const sourceRepositoryUrl = "https://github.com/openworklabs/member-library"

async function cleanup() {
  await db.delete(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.organizationId, organizationId))
  await db.delete(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, organizationId))
  await db.delete(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, organizationId))
  await db.delete(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, organizationId))
  await db.delete(ConfigObjectTable).where(eq(ConfigObjectTable.organizationId, organizationId))
  await db.delete(PluginTable).where(eq(PluginTable.organizationId, organizationId))
  await db.delete(MarketplaceTable).where(eq(MarketplaceTable.organizationId, organizationId))
  await db.delete(TeamMemberTable).where(eq(TeamMemberTable.teamId, teamId))
  await db.delete(TeamTable).where(eq(TeamTable.organizationId, organizationId))
  await db.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
  await db.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
  await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, [adminUserId, caseyUserId, novaUserId]))
}

function actorContext(input: {
  memberId: typeof caseyMemberId
  teamMember: boolean
  userId: typeof caseyUserId
}): PluginArchActorContext {
  const now = new Date()
  return {
    memberTeams: input.teamMember
      ? [{ id: teamId, organizationId, name: "Product", createdAt: now, updatedAt: now }]
      : [],
    organizationContext: {
      organization: {
        id: organizationId,
        name: "Member Library Test",
        slug: `member-library-${organizationId}`,
        logo: null,
        allowedEmailDomains: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: input.memberId,
        userId: input.userId,
        role: "member",
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

const caseyContext = actorContext({ memberId: caseyMemberId, teamMember: true, userId: caseyUserId })
const novaContext = actorContext({ memberId: novaMemberId, teamMember: false, userId: novaUserId })

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
  mePluginAccessListResponseSchema = (await import("../src/routes/org/plugin-system/schemas.js")).mePluginAccessListResponseSchema
  app = new Hono<{ Variables: OrgRouteVariables }>()
  app.use("*", async (c, next) => {
    const context = c.req.header("x-test-actor") === "nova" ? novaContext : caseyContext
    c.set("organizationContext", context.organizationContext)
    c.set("memberTeams", context.memberTeams)
    await next()
  })
  registerPluginArchRoutes(app)

  await cleanup()
  await db.insert(AuthUserTable).values([
    { id: adminUserId, name: "Avery Admin", email: `${adminUserId}@me-access.test`, emailVerified: true },
    { id: caseyUserId, name: "Casey Collaborator", email: `${caseyUserId}@me-access.test`, emailVerified: true },
    { id: novaUserId, name: "Nova Member", email: `${novaUserId}@me-access.test`, emailVerified: true },
  ])
  await db.insert(OrganizationTable).values({
    id: organizationId,
    name: "Member Library Test",
    slug: `member-library-${organizationId}`,
  })
  await db.insert(MemberTable).values([
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
    { id: caseyMemberId, organizationId, userId: caseyUserId, role: "member" },
    { id: novaMemberId, organizationId, userId: novaUserId, role: "member" },
  ])
  await db.insert(TeamTable).values({ id: teamId, organizationId, name: "Product" })
  await db.insert(TeamMemberTable).values({
    id: createDenTypeId("teamMember"),
    teamId,
    orgMembershipId: caseyMemberId,
  })
  await db.insert(MarketplaceTable).values({
    id: marketplaceId,
    organizationId,
    name: "Curated Catalog",
    description: "Organization library",
    status: "active",
    createdByOrgMembershipId: adminMemberId,
  })
  await db.insert(PluginTable).values([
    { id: catalogPluginId, organizationId, name: "Alpha Catalog", description: null, status: "active", createdByOrgMembershipId: adminMemberId },
    { id: creatorPluginId, organizationId, name: "Bravo Creator", description: "Created by Casey", sourceRepositoryUrl, status: "active", createdByOrgMembershipId: caseyMemberId },
    { id: multiEdgePluginId, organizationId, name: "Charlie Multi", description: "Shared through every edge", status: "active", createdByOrgMembershipId: adminMemberId },
    { id: otherPluginId, organizationId, name: "Delta Other", description: null, status: "active", createdByOrgMembershipId: novaMemberId },
    { id: archivedPluginId, organizationId, name: "Echo Archived", description: null, status: "archived", createdByOrgMembershipId: caseyMemberId },
    { id: removedGrantPluginId, organizationId, name: "Foxtrot Removed", description: null, status: "active", createdByOrgMembershipId: adminMemberId },
  ])
  await db.insert(ConfigObjectTable).values({
    id: configObjectId,
    organizationId,
    objectType: "skill",
    sourceMode: "cloud",
    title: "Creator Skill",
    status: "active",
    createdByOrgMembershipId: caseyMemberId,
  })
  await db.insert(PluginConfigObjectTable).values({
    id: createDenTypeId("pluginConfigObject"),
    organizationId,
    pluginId: creatorPluginId,
    configObjectId,
    membershipSource: "manual",
    createdByOrgMembershipId: caseyMemberId,
  })
  await db.insert(MarketplacePluginTable).values([
    {
      id: createDenTypeId("marketplacePlugin"),
      organizationId,
      marketplaceId,
      pluginId: catalogPluginId,
      membershipSource: "manual",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("marketplacePlugin"),
      organizationId,
      marketplaceId,
      pluginId: multiEdgePluginId,
      membershipSource: "manual",
      createdByOrgMembershipId: adminMemberId,
    },
  ])
  await db.insert(MarketplaceAccessGrantTable).values([
    {
      id: createDenTypeId("marketplaceAccessGrant"),
      organizationId,
      marketplaceId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      role: "manager",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("marketplaceAccessGrant"),
      organizationId,
      marketplaceId,
      orgMembershipId: caseyMemberId,
      teamId: null,
      orgWide: false,
      role: "editor",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("marketplaceAccessGrant"),
      organizationId,
      marketplaceId,
      orgMembershipId: null,
      teamId,
      orgWide: false,
      role: "viewer",
      createdByOrgMembershipId: adminMemberId,
    },
  ])
  await db.insert(PluginAccessGrantTable).values([
    {
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId: multiEdgePluginId,
      orgMembershipId: caseyMemberId,
      teamId: null,
      orgWide: false,
      role: "manager",
      createdByOrgMembershipId: adminMemberId,
      createdAt: directGrantedAt,
    },
    {
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId: multiEdgePluginId,
      orgMembershipId: null,
      teamId,
      orgWide: false,
      role: "viewer",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId: multiEdgePluginId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      role: "editor",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId: archivedPluginId,
      orgMembershipId: caseyMemberId,
      teamId: null,
      orgWide: false,
      role: "viewer",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId: removedGrantPluginId,
      orgMembershipId: caseyMemberId,
      teamId: null,
      orgWide: false,
      role: "viewer",
      createdByOrgMembershipId: adminMemberId,
      removedAt: new Date("2026-02-02T10:00:00.000Z"),
    },
  ])
})

afterAll(async () => {
  await cleanup()
  mock.restore()
})

async function requestMeAccess(actor: "casey" | "nova") {
  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/me/plugin-access`, {
    headers: { "x-test-actor": actor },
  }))
  expect(response.status).toBe(200)
  return mePluginAccessListResponseSchema.parse(await response.json())
}

test("a member sees a deduplicated library with every applicable edge and highest role", async () => {
  expect(await requestMeAccess("casey")).toEqual({
    items: [
      {
        plugin: {
          id: catalogPluginId,
          name: "Alpha Catalog",
          description: null,
          componentCount: 0,
          sourceRepositoryUrl: null,
        },
        edges: [{ kind: "catalog", marketplace: { id: marketplaceId, name: "Curated Catalog" } }],
        role: "viewer",
      },
      {
        plugin: {
          id: creatorPluginId,
          name: "Bravo Creator",
          description: "Created by Casey",
          componentCount: 1,
          sourceRepositoryUrl,
        },
        edges: [{ kind: "mine" }],
        role: "manager",
      },
      {
        plugin: {
          id: multiEdgePluginId,
          name: "Charlie Multi",
          description: "Shared through every edge",
          componentCount: 0,
          sourceRepositoryUrl: null,
        },
        edges: [
          {
            kind: "person",
            sharedBy: { orgMembershipId: adminMemberId, name: "Avery Admin" },
            grantedAt: directGrantedAt.toISOString(),
          },
          { kind: "team", team: { id: teamId, name: "Product" } },
          { kind: "org_wide" },
          { kind: "catalog", marketplace: { id: marketplaceId, name: "Curated Catalog" } },
        ],
        role: "manager",
      },
    ],
  })
})

test("another member sees only edges that apply to them", async () => {
  expect(await requestMeAccess("nova")).toEqual({
    items: [
      {
        plugin: {
          id: catalogPluginId,
          name: "Alpha Catalog",
          description: null,
          componentCount: 0,
          sourceRepositoryUrl: null,
        },
        edges: [{ kind: "catalog", marketplace: { id: marketplaceId, name: "Curated Catalog" } }],
        role: "viewer",
      },
      {
        plugin: {
          id: multiEdgePluginId,
          name: "Charlie Multi",
          description: "Shared through every edge",
          componentCount: 0,
          sourceRepositoryUrl: null,
        },
        edges: [
          { kind: "org_wide" },
          { kind: "catalog", marketplace: { id: marketplaceId, name: "Curated Catalog" } },
        ],
        role: "editor",
      },
      {
        plugin: {
          id: otherPluginId,
          name: "Delta Other",
          description: null,
          componentCount: 0,
          sourceRepositoryUrl: null,
        },
        edges: [{ kind: "mine" }],
        role: "manager",
      },
    ],
  })
})
