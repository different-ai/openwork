import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
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

const accessSource = readFileSync(
  fileURLToPath(new URL("../src/routes/org/plugin-system/access.ts", import.meta.url)),
  "utf8",
)
const storeSource = readFileSync(
  fileURLToPath(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url)),
  "utf8",
)

test("access-list reads keep manager authorization without requiring a fresh session", () => {
  const listAccess = storeSource.slice(
    storeSource.indexOf("export async function listResourceAccess"),
    storeSource.indexOf("type TeamPluginAccessEdge"),
  )

  expect(listAccess).toContain('requireFreshSession: false')
  expect(listAccess).toContain('role: "manager"')
  expect(accessSource).toContain('input.role !== "viewer" && input.requireFreshSession !== false')
})

test("access mutations retain the default fresh-session requirement", () => {
  const mutations = storeSource.slice(
    storeSource.indexOf("export async function createResourceAccessGrant"),
    storeSource.indexOf("async function collectPluginMarketplaces"),
  )

  expect(mutations).toContain("export async function createResourceAccessGrant")
  expect(mutations).toContain("export async function deleteResourceAccessGrant")
  expect(mutations).not.toContain("requireFreshSession: false")
})

test("routine plugin and config-object mutations derive freshness from audience exposure", () => {
  for (const functionName of [
    "createConfigObject",
    "createConfigObjectVersion",
    "setConfigObjectLifecycle",
    "updatePlugin",
    "setPluginLifecycle",
  ]) {
    const start = storeSource.indexOf(`export async function ${functionName}`)
    expect(start).toBeGreaterThan(-1)
    const nextExport = storeSource.indexOf("export async function ", start + 1)
    const source = storeSource.slice(start, nextExport === -1 ? undefined : nextExport)
    expect(source).toContain("pluginArchResourceHasExpandedAudience")
  }
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function responseItem(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.item)) throw new Error(`Expected response item: ${JSON.stringify(value)}`)
  return value.item
}

test("stale-session authoring follows the private versus exposed route matrix", async () => {
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
  const sessionId = createDenTypeId("session")
  const exposedPluginId = createDenTypeId("plugin")
  const exposedConfigObjectId = createDenTypeId("configObject")
  const exposedVersionId = createDenTypeId("configObjectVersion")
  const marketplaceId = createDenTypeId("marketplace")
  const now = new Date()
  const staleCreatedAt = new Date(now.getTime() - 20 * 60_000)
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

    const createdPluginResponse = await request("POST", "/v1/plugins", {
      name: "Stale Private Plugin",
      orgWide: false,
    })
    expect(createdPluginResponse.status).toBe(201)
    const privatePluginId = String(responseItem(await createdPluginResponse.json()).id ?? "")
    expect(privatePluginId).toMatch(/^plg_/)

    const renamedPluginResponse = await request("PATCH", `/v1/plugins/${privatePluginId}`, {
      name: "Renamed Stale Private Plugin",
    })
    expect(renamedPluginResponse.status).toBe(200)
    expect(responseItem(await renamedPluginResponse.json()).name).toBe("Renamed Stale Private Plugin")

    const initialSkillSource = "---\nname: stale-private-skill\ndescription: Private stale-session fixture.\n---\nInitial instructions."
    const createdSkillResponse = await request("POST", "/v1/config-objects", {
      type: "skill",
      pluginIds: [privatePluginId],
      sourceMode: "cloud",
      input: { rawSourceText: initialSkillSource },
    })
    expect(createdSkillResponse.status).toBe(201)
    const privateConfigObjectId = String(responseItem(await createdSkillResponse.json()).id ?? "")
    expect(privateConfigObjectId).toMatch(/^cob_/)

    const updatedSkillSource = `${initialSkillSource}\n\nUpdated instructions.`
    const versionResponse = await request("POST", `/v1/config-objects/${privateConfigObjectId}/versions`, {
      input: { rawSourceText: updatedSkillSource },
      reason: "stale-session private edit",
    })
    expect(versionResponse.status).toBe(201)
    const versions = await database.select().from(ConfigObjectVersionTable)
      .where(eq(ConfigObjectVersionTable.configObjectId, privateConfigObjectId))
    expect(versions).toHaveLength(2)
    expect(versions.some((version) => version.rawSourceText === updatedSkillSource)).toBe(true)

    const expectFreshAuthRequired = async (response: Response) => {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: "reauth",
        reason: "fresh_auth_required",
        message: "For security, confirm it's you before changing workspace settings.",
      })
    }
    const blockedPluginName = `Blocked Org-wide ${organizationId}`
    const blockedSkillName = `blocked-exposed-${organizationId.slice(-8)}`
    const blockedCases = [
      {
        name: "create org-wide plugin",
        request: () => request("POST", "/v1/plugins", { name: blockedPluginName, orgWide: true }),
        verifyNoWrite: async () => {
          const rows = await database.select().from(PluginTable).where(and(
            eq(PluginTable.organizationId, organizationId),
            eq(PluginTable.name, blockedPluginName),
          ))
          expect(rows).toHaveLength(0)
        },
      },
      {
        name: "patch org-wide plugin",
        request: () => request("PATCH", `/v1/plugins/${exposedPluginId}`, { name: "Blocked Exposed Rename" }),
        verifyNoWrite: async () => {
          const rows = await database.select().from(PluginTable).where(eq(PluginTable.id, exposedPluginId))
          expect(rows[0]?.name).toBe("Exposed Plugin")
        },
      },
      {
        name: "create skill in exposed plugin",
        request: () => request("POST", "/v1/config-objects", {
          type: "skill",
          pluginIds: [exposedPluginId],
          sourceMode: "cloud",
          input: {
            rawSourceText: `---\nname: ${blockedSkillName}\ndescription: Must not persist.\n---\nBlocked instructions.`,
          },
        }),
        verifyNoWrite: async () => {
          const rows = await database.select().from(ConfigObjectTable).where(and(
            eq(ConfigObjectTable.organizationId, organizationId),
            eq(ConfigObjectTable.title, blockedSkillName),
          ))
          expect(rows).toHaveLength(0)
        },
      },
      {
        name: "version exposed skill",
        request: () => request("POST", `/v1/config-objects/${exposedConfigObjectId}/versions`, {
          input: {
            rawSourceText: "---\nname: exposed-skill\ndescription: Exposed skill fixture.\n---\nBlocked revision.",
          },
          reason: "must not persist",
        }),
        verifyNoWrite: async () => {
          const rows = await database.select().from(ConfigObjectVersionTable)
            .where(eq(ConfigObjectVersionTable.configObjectId, exposedConfigObjectId))
          expect(rows).toHaveLength(1)
        },
      },
      {
        name: "grant plugin access",
        request: () => request("POST", `/v1/plugins/${privatePluginId}/access`, {
          orgWide: true,
          role: "viewer",
        }),
        verifyNoWrite: async () => {
          const rows = await database.select().from(PluginAccessGrantTable).where(and(
            eq(PluginAccessGrantTable.pluginId, privatePluginId),
            eq(PluginAccessGrantTable.orgWide, true),
          ))
          expect(rows).toHaveLength(0)
        },
      },
      {
        name: "grant skill access",
        request: () => request("POST", `/v1/config-objects/${privateConfigObjectId}/access`, {
          orgWide: true,
          role: "viewer",
        }),
        verifyNoWrite: async () => {
          const rows = await database.select().from(ConfigObjectAccessGrantTable).where(and(
            eq(ConfigObjectAccessGrantTable.configObjectId, privateConfigObjectId),
            eq(ConfigObjectAccessGrantTable.orgWide, true),
          ))
          expect(rows).toHaveLength(0)
        },
      },
      {
        name: "publish plugin",
        request: () => request("POST", `/v1/marketplaces/${marketplaceId}/plugins`, {
          pluginId: privatePluginId,
        }),
        verifyNoWrite: async () => {
          const rows = await database.select().from(MarketplacePluginTable).where(and(
            eq(MarketplacePluginTable.marketplaceId, marketplaceId),
            eq(MarketplacePluginTable.pluginId, privatePluginId),
          ))
          expect(rows).toHaveLength(0)
        },
      },
    ]

    for (const blockedCase of blockedCases) {
      await expectFreshAuthRequired(await blockedCase.request())
      await blockedCase.verifyNoWrite()
    }
  } finally {
    await cleanup()
    mock.restore()
  }
})
