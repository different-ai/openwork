import { expect, mock, test } from "bun:test"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrganizationTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono, type MiddlewareHandler } from "hono"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function responseItem(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.item)) throw new Error(`Expected response item: ${JSON.stringify(value)}`)
  return value.item
}

test("admins with an old sign-in can do routine plugin work without a step-up", async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DB_MODE ??= "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "freshness-route-test-encryption-key-123456789"
  process.env.BETTER_AUTH_SECRET ??= "freshness-route-test-secret-1234567890123"
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"

  mock.restore()
  const database = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: database }))
  const middleware = await import("../src/middleware/index.js")
  const passThroughMiddleware: MiddlewareHandler = async (_context, next) => {
    await next()
  }
  mock.module("../src/middleware/index.js", () => ({
    ...middleware,
    orgMemberRoute: () => passThroughMiddleware,
    resolveMemberTeamsMiddleware: passThroughMiddleware,
  }))

  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const viewerUserId = createDenTypeId("user")
  const viewerMemberId = createDenTypeId("member")
  const sessionId = createDenTypeId("session")
  const exposedPluginId = createDenTypeId("plugin")
  const exposedConfigObjectId = createDenTypeId("configObject")
  const exposedVersionId = createDenTypeId("configObjectVersion")
  const marketplaceId = createDenTypeId("marketplace")
  const now = new Date()
  // Older than the 2-hour privileged window: routine plugin work must not step up.
  const staleCreatedAt = new Date(now.getTime() - 3 * 60 * 60_000)
  const organizationContext: PluginArchActorContext["organizationContext"] = {
    organization: {
      id: organizationId,
      name: "Freshness Route Matrix",
      slug: `freshness-route-${organizationId}`,
      logo: null,
      allowedEmailDomains: null,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    },
    currentMember: {
      id: memberId,
      userId,
      role: "owner",
      createdAt: now,
      joinedAt: now,
      isOwner: true,
    },
    invitations: [],
    members: [],
    roles: [],
    teams: [],
  }

  const cleanup = async () => {
    await database.delete(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, organizationId))
    await database.delete(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.organizationId, organizationId))
    await database.delete(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.organizationId, organizationId))
    await database.delete(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, organizationId))
    await database.delete(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, organizationId))
    await database.delete(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.organizationId, organizationId))
    await database.delete(ConfigObjectTable).where(eq(ConfigObjectTable.organizationId, organizationId))
    await database.delete(PluginTable).where(eq(PluginTable.organizationId, organizationId))
    await database.delete(MarketplaceTable).where(eq(MarketplaceTable.organizationId, organizationId))
    await database.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
    await database.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
    await database.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
    await database.delete(AuthUserTable).where(eq(AuthUserTable.id, viewerUserId))
  }

  try {
    await database.insert(AuthUserTable).values({
      id: userId,
      name: "Freshness Route Owner",
      email: `${userId}@freshness-route.test`,
      emailVerified: true,
    })
    await database.insert(OrganizationTable).values({
      id: organizationId,
      name: "Freshness Route Matrix",
      slug: `freshness-route-${organizationId}`,
    })
    await database.insert(MemberTable).values({ id: memberId, organizationId, userId, role: "owner" })
    await database.insert(AuthUserTable).values({
      id: viewerUserId,
      name: "Freshness Route Viewer",
      email: `${viewerUserId}@freshness-route.test`,
      emailVerified: true,
    })
    await database.insert(MemberTable).values({ id: viewerMemberId, organizationId, userId: viewerUserId, role: "member" })
    await database.insert(PluginTable).values({
      id: exposedPluginId,
      organizationId,
      name: "Exposed Plugin",
      status: "active",
      createdByOrgMembershipId: memberId,
    })
    await database.insert(ConfigObjectTable).values({
      id: exposedConfigObjectId,
      organizationId,
      objectType: "skill",
      sourceMode: "cloud",
      title: "exposed-skill",
      description: "Exposed skill fixture.",
      status: "active",
      createdByOrgMembershipId: memberId,
    })
    await database.insert(ConfigObjectVersionTable).values({
      id: exposedVersionId,
      organizationId,
      configObjectId: exposedConfigObjectId,
      rawSourceText: "---\nname: exposed-skill\ndescription: Exposed skill fixture.\n---\nExisting instructions.",
      normalizedPayloadJson: null,
      createdVia: "cloud",
      createdByOrgMembershipId: memberId,
    })
    await database.insert(PluginConfigObjectTable).values({
      id: createDenTypeId("pluginConfigObject"),
      organizationId,
      pluginId: exposedPluginId,
      configObjectId: exposedConfigObjectId,
      membershipSource: "manual",
      createdByOrgMembershipId: memberId,
    })
    await database.insert(PluginAccessGrantTable).values([
      {
        id: createDenTypeId("pluginAccessGrant"),
        organizationId,
        pluginId: exposedPluginId,
        orgMembershipId: memberId,
        orgWide: false,
        role: "manager",
        createdByOrgMembershipId: memberId,
      },
      {
        id: createDenTypeId("pluginAccessGrant"),
        organizationId,
        pluginId: exposedPluginId,
        orgWide: true,
        role: "viewer",
        createdByOrgMembershipId: memberId,
      },
    ])
    await database.insert(ConfigObjectAccessGrantTable).values([
      {
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        configObjectId: exposedConfigObjectId,
        orgMembershipId: memberId,
        orgWide: false,
        role: "manager",
        createdByOrgMembershipId: memberId,
      },
      {
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        configObjectId: exposedConfigObjectId,
        orgWide: true,
        role: "viewer",
        createdByOrgMembershipId: memberId,
      },
    ])
    await database.insert(MarketplaceTable).values({
      id: marketplaceId,
      organizationId,
      name: "Freshness Marketplace",
      status: "active",
      createdByOrgMembershipId: memberId,
    })
    await database.insert(MarketplaceAccessGrantTable).values({
      id: createDenTypeId("marketplaceAccessGrant"),
      organizationId,
      marketplaceId,
      orgMembershipId: memberId,
      orgWide: false,
      role: "manager",
      createdByOrgMembershipId: memberId,
    })

    const { registerPluginArchRoutes } = await import("../src/routes/org/plugin-system/routes.js")
    const app = new Hono<{ Variables: OrgRouteVariables }>()
    app.use("*", async (context, next) => {
      context.set("organizationContext", organizationContext)
      context.set("memberTeams", [])
      context.set("apiKey", null)
      context.set("session", {
        id: sessionId,
        userId,
        activeOrganizationId: organizationId,
        activeTeamId: null,
        token: `stale-${sessionId}`,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        ipAddress: null,
        userAgent: null,
        createdAt: staleCreatedAt,
        updatedAt: staleCreatedAt,
      })
      await next()
    })
    registerPluginArchRoutes(app)

    const request = (method: "PATCH" | "POST", path: string, body: Record<string, unknown>) => app.request(
      `http://127.0.0.1:8790${path}`,
      { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    )

    const expectOk = async (response: Response, status: number) => {
      const text = await response.text()
      expect({ status: response.status, text }).toMatchObject({ status })
      expect(text).not.toContain("fresh_auth_required")
      return text ? JSON.parse(text) : null
    }

    const privatePlugin = responseItem(await expectOk(await request("POST", "/v1/plugins", { name: "Private Plugin", orgWide: false }), 201))
    const privatePluginId = String(privatePlugin.id ?? "")
    expect(privatePluginId).toMatch(/^plg_/)
    const privateSkill = responseItem(await expectOk(await request("POST", "/v1/config-objects", {
      type: "skill", pluginIds: [privatePluginId], sourceMode: "cloud",
      input: { rawSourceText: "---\nname: private-skill\ndescription: Private fixture.\n---\nInstructions." },
    }), 201))
    const privateConfigObjectId = String(privateSkill.id ?? "")

    await expectOk(await request("POST", "/v1/plugins", { name: `Org-wide ${organizationId}`, orgWide: true }), 201)
    await expectOk(await request("PATCH", `/v1/plugins/${exposedPluginId}`, { name: "Renamed Exposed Plugin" }), 200)
    await expectOk(await request("POST", "/v1/config-objects", {
      type: "skill", pluginIds: [exposedPluginId], sourceMode: "cloud",
      input: { rawSourceText: "---\nname: shared-skill\ndescription: Shared fixture.\n---\nInstructions." },
    }), 201)
    await expectOk(await request("POST", "/v1/config-objects", {
      type: "mcp", pluginIds: [exposedPluginId], sourceMode: "cloud",
      input: { rawSourceText: '{"mcpServers":{"fixture":{"url":"https://example.test/mcp"}}}' },
    }), 201)
    await expectOk(await request("POST", `/v1/config-objects/${exposedConfigObjectId}/versions`, {
      input: { rawSourceText: "---\nname: exposed-skill\ndescription: Exposed skill fixture.\n---\nRevised." },
      reason: "routine edit",
    }), 201)
    await expectOk(await request("POST", `/v1/plugins/${privatePluginId}/access`, { orgWide: true, role: "viewer" }), 201)
    await expectOk(await request("POST", `/v1/config-objects/${privateConfigObjectId}/access`, { orgWide: true, role: "viewer" }), 201)
    await expectOk(await request("POST", `/v1/marketplaces/${marketplaceId}/plugins`, { pluginId: privatePluginId }), 201)
    await expectOk(await request("POST", `/v1/plugins/${exposedPluginId}/archive`, {}), 200)
    await expectOk(await request("POST", `/v1/plugins/${exposedPluginId}/restore`, {}), 200)

    const exposedRows = await database.select().from(PluginTable).where(eq(PluginTable.id, exposedPluginId))
    expect(exposedRows[0]?.status).toBe("active")
    const orgWideGrants = await database.select().from(PluginAccessGrantTable).where(and(
      eq(PluginAccessGrantTable.pluginId, privatePluginId), eq(PluginAccessGrantTable.orgWide, true),
    ))
    expect(orgWideGrants).toHaveLength(1)

    // Role checks still decide who may write.
    const { createConfigObjectVersion } = await import("../src/routes/org/plugin-system/store.js")
    const viewerContext: PluginArchActorContext = {
      memberTeams: [],
      session: null,
      organizationContext: {
        ...organizationContext,
        currentMember: { ...organizationContext.currentMember, id: viewerMemberId, userId: viewerUserId, role: "member", isOwner: false },
      },
    }
    await expect(createConfigObjectVersion({
      context: viewerContext,
      configObjectId: exposedConfigObjectId,
      value: { rawSourceText: "---\nname: exposed-skill\ndescription: Exposed skill fixture.\n---\nViewer edit." },
    })).rejects.toMatchObject({ error: "forbidden" })
  } finally {
    await cleanup()
    mock.restore()
  }
})
