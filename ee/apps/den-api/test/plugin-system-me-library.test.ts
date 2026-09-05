import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigObjectTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  MemberTable,
  OrganizationTable,
  OrgOAuthClientTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
  RemoteMcpAppTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono, type MiddlewareHandler } from "hono"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

const API_ORIGIN = "http://127.0.0.1:8790"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_melibrary"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "me-library-test-encryption-key-1234567890"
process.env.BETTER_AUTH_SECRET ??= "me-library-test-secret-123456789012"
process.env.BETTER_AUTH_URL ??= API_ORIGIN
process.env.CORS_ORIGINS ??= API_ORIGIN

let app: Hono<{ Variables: OrgRouteVariables }>
let meLibraryListResponseSchema: typeof import("../src/routes/org/plugin-system/schemas.js").meLibraryListResponseSchema
let db: typeof import("../src/db.js").db

const organizationId = createDenTypeId("organization")
const adminUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const adminMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const pluginId = createDenTypeId("plugin")
const remoteAppPluginId = createDenTypeId("plugin")
const skillConfigObjectId = createDenTypeId("configObject")
const mcpConfigObjectId = createDenTypeId("configObject")
const remoteAppConfigObjectId = createDenTypeId("configObject")
const mcpConnectionId = createDenTypeId("externalMcpConnection")
const nativeConnectionId = createDenTypeId("externalMcpConnection")
const pluginGrantedAt = new Date("2026-06-01T10:00:00.000Z")

const context: PluginArchActorContext = {
  memberTeams: [],
  organizationContext: {
    organization: {
      id: organizationId,
      name: "Member Library Test",
      slug: `member-library-${organizationId}`,
      logo: null,
      allowedEmailDomains: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    currentMember: {
      id: memberId,
      userId: memberUserId,
      role: "member",
      createdAt: new Date(),
      joinedAt: new Date(),
      isOwner: false,
    },
    invitations: [],
    members: [],
    roles: [],
    teams: [],
  },
  session: undefined,
}

async function cleanup() {
  await db.delete(RemoteMcpAppTable).where(eq(RemoteMcpAppTable.organizationId, organizationId))
  await db.delete(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.organizationId, organizationId))
  await db.delete(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, organizationId))
  await db.delete(ConfigObjectTable).where(eq(ConfigObjectTable.organizationId, organizationId))
  await db.delete(PluginTable).where(eq(PluginTable.organizationId, organizationId))
  await db.delete(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.organizationId, organizationId))
  await db.delete(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.organizationId, organizationId))
  await db.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
  await db.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
  await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, [adminUserId, memberUserId]))
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
  meLibraryListResponseSchema = (await import("../src/routes/org/plugin-system/schemas.js")).meLibraryListResponseSchema
  app = new Hono<{ Variables: OrgRouteVariables }>()
  app.use("*", async (c, next) => {
    c.set("organizationContext", context.organizationContext)
    c.set("memberTeams", context.memberTeams)
    await next()
  })
  registerPluginArchRoutes(app)

  await cleanup()
  await db.insert(AuthUserTable).values([
    { id: adminUserId, name: "Avery Admin", email: `${adminUserId}@me-library.test`, emailVerified: true },
    { id: memberUserId, name: "Casey Member", email: `${memberUserId}@me-library.test`, emailVerified: true },
  ])
  await db.insert(OrganizationTable).values({
    id: organizationId,
    name: "Member Library Test",
    slug: `member-library-${organizationId}`,
  })
  await db.insert(MemberTable).values([
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
    { id: memberId, organizationId, userId: memberUserId, role: "member" },
  ])
  await db.insert(PluginTable).values([
    {
      id: pluginId,
      organizationId,
      name: "Bravo Bundle",
      description: "A mixed component bundle",
      status: "active",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: remoteAppPluginId,
      organizationId,
      name: "Delta Dashboard",
      description: "A portable remote MCP App",
      status: "active",
      createdByOrgMembershipId: adminMemberId,
    },
  ])
  await db.insert(ConfigObjectTable).values([
    {
      id: skillConfigObjectId,
      organizationId,
      objectType: "skill",
      sourceMode: "cloud",
      title: "Library Skill",
      status: "active",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: mcpConfigObjectId,
      organizationId,
      objectType: "mcp",
      sourceMode: "cloud",
      title: "Library MCP",
      status: "active",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: remoteAppConfigObjectId,
      organizationId,
      objectType: "app",
      sourceMode: "cloud",
      title: "Delta Dashboard",
      status: "active",
      createdByOrgMembershipId: adminMemberId,
    },
  ])
  await db.insert(PluginConfigObjectTable).values([
    {
      id: createDenTypeId("pluginConfigObject"),
      organizationId,
      pluginId,
      configObjectId: skillConfigObjectId,
      membershipSource: "manual",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("pluginConfigObject"),
      organizationId,
      pluginId,
      configObjectId: mcpConfigObjectId,
      membershipSource: "manual",
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("pluginConfigObject"),
      organizationId,
      pluginId: remoteAppPluginId,
      configObjectId: remoteAppConfigObjectId,
      membershipSource: "manual",
      createdByOrgMembershipId: adminMemberId,
    },
  ])
  await db.insert(PluginAccessGrantTable).values([
    {
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId,
      orgMembershipId: memberId,
      teamId: null,
      orgWide: false,
      role: "editor",
      createdByOrgMembershipId: adminMemberId,
      createdAt: pluginGrantedAt,
    },
    {
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId: remoteAppPluginId,
      orgWide: true,
      role: "viewer",
      createdByOrgMembershipId: adminMemberId,
    },
  ])
  await db.insert(RemoteMcpAppTable).values({
    configObjectId: remoteAppConfigObjectId,
    organizationId,
    pluginId: remoteAppPluginId,
    sourceUrl: "https://example.test/apps/delta.html",
    resolvedSourceUrl: "https://cdn.example.test/apps/delta-v1.html",
    status: "active",
  })
  await db.insert(ExternalMcpConnectionTable).values([
    {
      id: nativeConnectionId,
      organizationId,
      kind: "native_provider",
      nativeProviderKey: "google-workspace",
      name: "Alpha Google",
      url: "https://workspace.google.com",
      authType: "oauth",
      credentialMode: "per_member",
      connectedAt: null,
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: mcpConnectionId,
      organizationId,
      kind: "external_mcp",
      name: "Charlie MCP",
      url: "https://library-mcp.example.test/mcp",
      authType: "oauth",
      credentialMode: "per_member",
      connectedAt: null,
      createdByOrgMembershipId: adminMemberId,
    },
  ])
  await db.insert(ExternalMcpConnectionAccessGrantTable).values([
    {
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId,
      externalMcpConnectionId: nativeConnectionId,
      orgWide: true,
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId,
      externalMcpConnectionId: mcpConnectionId,
      orgWide: true,
      createdByOrgMembershipId: adminMemberId,
    },
  ])
  await db.insert(OrgOAuthClientTable).values({
    id: createDenTypeId("orgOAuthClient"),
    organizationId,
    providerId: nativeConnectionId,
    clientId: "native-google-client",
    createdByOrgMembershipId: adminMemberId,
  })
})

afterAll(async () => {
  await cleanup()
  mock.restore()
})

test("the member library omits stored standalone URL Apps without deleting them", async () => {
  const response = await app.fetch(new Request(`${API_ORIGIN}/v1/me/library`))
  expect(response.status).toBe(200)
  const body = meLibraryListResponseSchema.parse(await response.json())
  expect(body.items.filter((item) => item.type === "connection").every((item) => typeof item.url === "string")).toBe(true)

  expect(body).toEqual({
    items: [
      {
        type: "connection",
        id: nativeConnectionId,
        name: "Alpha Google",
        url: "https://workspace.google.com",
        description: null,
        transport: "native",
        provider: "google-workspace",
        state: "needs_signin",
        connectedAt: null,
        edges: [{ kind: "org_wide" }],
      },
      {
        type: "plugin",
        id: pluginId,
        name: "Bravo Bundle",
        description: "A mixed component bundle",
        componentCount: 2,
        componentKinds: ["mcp", "skill"],
        sourceRepositoryUrl: null,
        edges: [{
          kind: "person",
          sharedBy: { orgMembershipId: adminMemberId, name: "Avery Admin" },
          grantedAt: pluginGrantedAt.toISOString(),
        }],
        role: "editor",
      },
      {
        type: "connection",
        id: mcpConnectionId,
        name: "Charlie MCP",
        url: "https://library-mcp.example.test/mcp",
        description: null,
        transport: "mcp",
        provider: null,
        state: "needs_signin",
        connectedAt: null,
        edges: [{ kind: "org_wide" }],
      },
      {
        type: "plugin",
        id: remoteAppPluginId,
        name: "Delta Dashboard",
        description: "A portable remote MCP App",
        componentCount: 1,
        componentKinds: ["app"],
        sourceRepositoryUrl: null,
        edges: [{ kind: "org_wide" }],
        role: "viewer",
      },
    ],
  })
  const storedApps = await db.select().from(RemoteMcpAppTable).where(eq(RemoteMcpAppTable.organizationId, organizationId))
  expect(storedApps).toHaveLength(1)
  expect(storedApps[0]?.configObjectId).toBe(remoteAppConfigObjectId)
})
