import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr8"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")

const organizationId = createDenTypeId("organization")
const adminUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const adminMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const visibleMarketplaceId = createDenTypeId("marketplace")
const hiddenMarketplaceId = createDenTypeId("marketplace")
const supportPluginId = createDenTypeId("plugin")
const triagePluginId = createDenTypeId("plugin")
const secretPluginId = createDenTypeId("plugin")
const sharedConnectionId = createDenTypeId("externalMcpConnection")
const legacyConnectionId = createDenTypeId("externalMcpConnection")
const visibleLegacyConfigObjectId = createDenTypeId("configObject")
const hiddenLegacyConfigObjectId = createDenTypeId("configObject")

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/session.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod

  const now = new Date()
  await db.insert(schema.AuthUserTable).values([
    { id: adminUserId, name: "Required By Admin", email: `required-by-admin+${adminUserId}@test.local` },
    { id: memberUserId, name: "Required By Member", email: `required-by-member+${memberUserId}@test.local` },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Required By Org",
    slug: `required-by-${organizationId}`,
    metadata: null,
  })
  await db.insert(schema.MemberTable).values([
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
    { id: memberId, organizationId, userId: memberUserId, role: "member" },
  ])
  await db.insert(schema.MarketplaceTable).values([
    {
      id: visibleMarketplaceId,
      organizationId,
      name: "Visible Marketplace",
      description: null,
      logoUrl: null,
      status: "active",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: hiddenMarketplaceId,
      organizationId,
      name: "Hidden Marketplace",
      description: null,
      logoUrl: null,
      status: "active",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ])
  await db.insert(schema.MarketplaceAccessGrantTable).values({
    id: createDenTypeId("marketplaceAccessGrant"),
    organizationId,
    marketplaceId: visibleMarketplaceId,
    orgMembershipId: null,
    teamId: null,
    orgWide: true,
    role: "viewer",
    createdByOrgMembershipId: adminMemberId,
    createdAt: now,
    removedAt: null,
  })
  await db.insert(schema.PluginTable).values([
    {
      id: supportPluginId,
      organizationId,
      name: "Support Operations",
      description: null,
      status: "active",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: triagePluginId,
      organizationId,
      name: "Support Triage",
      description: null,
      status: "active",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: secretPluginId,
      organizationId,
      name: "Secret Operations",
      description: null,
      status: "active",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ])
  await db.insert(schema.MarketplacePluginTable).values([
    {
      id: createDenTypeId("marketplacePlugin"),
      organizationId,
      marketplaceId: visibleMarketplaceId,
      pluginId: supportPluginId,
      membershipSource: "manual",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      removedAt: null,
    },
    {
      id: createDenTypeId("marketplacePlugin"),
      organizationId,
      marketplaceId: visibleMarketplaceId,
      pluginId: triagePluginId,
      membershipSource: "manual",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      removedAt: null,
    },
    {
      id: createDenTypeId("marketplacePlugin"),
      organizationId,
      marketplaceId: hiddenMarketplaceId,
      pluginId: secretPluginId,
      membershipSource: "manual",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      removedAt: null,
    },
  ])
  await db.insert(schema.ExternalMcpConnectionTable).values([
    {
      id: sharedConnectionId,
      organizationId,
      name: "Support Operations / slack",
      url: "https://mcp.slack.com/mcp",
      authType: "oauth",
      credentialMode: "per_member",
      connectedAt: null,
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: legacyConnectionId,
      organizationId,
      name: "Legacy Direct MCP",
      url: "https://legacy.example.test/mcp",
      authType: "none",
      credentialMode: "shared",
      connectedAt: now,
      createdByOrgMembershipId: adminMemberId,
    },
  ])
  await db.insert(schema.ExternalMcpConnectionAccessGrantTable).values([
    {
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId,
      externalMcpConnectionId: sharedConnectionId,
      requiredAuthType: "oauth",
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      createdByOrgMembershipId: adminMemberId,
    },
    {
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId,
      externalMcpConnectionId: legacyConnectionId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      createdByOrgMembershipId: adminMemberId,
    },
  ])
  await db.insert(schema.PluginMcpRequirementBindingTable).values([
    {
      id: createDenTypeId("pluginMcpRequirementBinding"),
      organizationId,
      pluginId: supportPluginId,
      configObjectId: createDenTypeId("configObject"),
      serverName: "slack",
      externalMcpConnectionId: sharedConnectionId,
      requiredAuthType: "oauth",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: createDenTypeId("pluginMcpRequirementBinding"),
      organizationId,
      pluginId: triagePluginId,
      configObjectId: createDenTypeId("configObject"),
      serverName: "slack",
      externalMcpConnectionId: sharedConnectionId,
      requiredAuthType: "oauth",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: createDenTypeId("pluginMcpRequirementBinding"),
      organizationId,
      pluginId: secretPluginId,
      configObjectId: createDenTypeId("configObject"),
      serverName: "slack",
      externalMcpConnectionId: sharedConnectionId,
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      updatedAt: now,
    },
  ])
  await db.insert(schema.OrgOAuthClientTable).values({
    id: createDenTypeId("orgOAuthClient"),
    organizationId,
    providerId: sharedConnectionId,
    clientId: "configured-slack-client",
    createdByOrgMembershipId: adminMemberId,
  })
  await db.insert(schema.ConfigObjectTable).values([
    {
      id: visibleLegacyConfigObjectId,
      organizationId,
      objectType: "mcp",
      sourceMode: "import",
      title: "Visible Legacy MCP",
      description: null,
      searchText: "Visible Legacy MCP",
      currentFileName: "visible-legacy.json",
      currentFileExtension: ".json",
      currentRelativePath: "mcp/visible-legacy.json",
      status: "active",
      createdByOrgMembershipId: adminMemberId,
      connectorInstanceId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: hiddenLegacyConfigObjectId,
      organizationId,
      objectType: "mcp",
      sourceMode: "import",
      title: "Hidden Legacy MCP",
      description: null,
      searchText: "Hidden Legacy MCP",
      currentFileName: "hidden-legacy.json",
      currentFileExtension: ".json",
      currentRelativePath: "mcp/hidden-legacy.json",
      status: "active",
      createdByOrgMembershipId: adminMemberId,
      connectorInstanceId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ])
  await db.insert(schema.ConfigObjectVersionTable).values([
    {
      id: createDenTypeId("configObjectVersion"),
      organizationId,
      configObjectId: visibleLegacyConfigObjectId,
      normalizedPayloadJson: { mcpServers: { legacy: { openworkManaged: "den_external_mcp", externalMcpConnectionId: legacyConnectionId, url: "https://legacy.example.test/mcp" } } },
      rawSourceText: null,
      schemaVersion: "openwork.den_external_mcp.v1",
      createdVia: "import",
      createdByOrgMembershipId: adminMemberId,
      connectorSyncEventId: null,
      sourceRevisionRef: null,
      isDeletedVersion: false,
      createdAt: now,
    },
    {
      id: createDenTypeId("configObjectVersion"),
      organizationId,
      configObjectId: hiddenLegacyConfigObjectId,
      normalizedPayloadJson: { mcpServers: { legacy: { openworkManaged: "den_external_mcp", externalMcpConnectionId: legacyConnectionId, url: "https://legacy.example.test/mcp" } } },
      rawSourceText: null,
      schemaVersion: "openwork.den_external_mcp.v1",
      createdVia: "import",
      createdByOrgMembershipId: adminMemberId,
      connectorSyncEventId: null,
      sourceRevisionRef: null,
      isDeletedVersion: false,
      createdAt: now,
    },
  ])
  await db.insert(schema.PluginConfigObjectTable).values([
    {
      id: createDenTypeId("pluginConfigObject"),
      organizationId,
      pluginId: supportPluginId,
      configObjectId: visibleLegacyConfigObjectId,
      membershipSource: "api",
      connectorMappingId: null,
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      removedAt: null,
    },
    {
      id: createDenTypeId("pluginConfigObject"),
      organizationId,
      pluginId: secretPluginId,
      configObjectId: hiddenLegacyConfigObjectId,
      membershipSource: "api",
      connectorMappingId: null,
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      removedAt: null,
    },
  ])
})

afterAll(async () => {
  await db.delete(schema.PluginMcpRequirementBindingTable).where(drizzle.eq(schema.PluginMcpRequirementBindingTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
  await db.delete(schema.ConfigObjectVersionTable).where(drizzle.eq(schema.ConfigObjectVersionTable.organizationId, organizationId))
  await db.delete(schema.PluginConfigObjectTable).where(drizzle.eq(schema.PluginConfigObjectTable.organizationId, organizationId))
  await db.delete(schema.ConfigObjectTable).where(drizzle.eq(schema.ConfigObjectTable.organizationId, organizationId))
  await db.delete(schema.MarketplacePluginTable).where(drizzle.eq(schema.MarketplacePluginTable.organizationId, organizationId))
  await db.delete(schema.MarketplaceAccessGrantTable).where(drizzle.eq(schema.MarketplaceAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.PluginTable).where(drizzle.eq(schema.PluginTable.organizationId, organizationId))
  await db.delete(schema.MarketplaceTable).where(drizzle.eq(schema.MarketplaceTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [adminUserId, memberUserId]))
  mock.restore()
})

function requestAs(userId: DenTypeId<"user">, path: string) {
  return app.fetch(new Request(`http://den-api.local${path}`, {
    headers: {
      "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId }),
    },
  }))
}

async function connectionRows(response: Response): Promise<Record<string, unknown>[]> {
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.connections)) {
    throw new Error("MCP connection list response was incomplete")
  }
  return body.connections.filter(isRecord)
}

function requiredByNames(row: Record<string, unknown>): string[] {
  if (!Array.isArray(row.requiredBy)) return []
  return row.requiredBy.flatMap((entry) => isRecord(entry) && typeof entry.name === "string" ? [entry.name] : [])
}

function findConnection(rows: Record<string, unknown>[], connectionId: string): Record<string, unknown> {
  const row = rows.find((entry) => entry.id === connectionId)
  if (!row) throw new Error(`Missing connection ${connectionId}`)
  return row
}

test("usable MCP connections include only visible plugin requirement provenance and preserve direct legacy rows", async () => {
  const response = await requestAs(memberUserId, "/v1/mcp-connections?scope=usable")
  expect(response.status).toBe(200)
  const rows = await connectionRows(response)

  expect(rows.map((row) => row.id)).toContain(sharedConnectionId)
  expect(rows.map((row) => row.id)).toContain(legacyConnectionId)
  expect(requiredByNames(findConnection(rows, sharedConnectionId))).toEqual(["Support Operations", "Support Triage"])
  expect(findConnection(rows, sharedConnectionId)).toMatchObject({
    oauthClientConfigured: true,
    oauthClientRequired: true,
    requiredAuthType: "oauth",
    setupRequired: false,
  })
  expect(requiredByNames(findConnection(rows, legacyConnectionId))).toEqual(["Support Operations"])
})

test("manageable MCP connections include all org plugin requirement provenance", async () => {
  const response = await requestAs(adminUserId, "/v1/mcp-connections?scope=manageable")
  expect(response.status).toBe(200)
  const rows = await connectionRows(response)

  expect(requiredByNames(findConnection(rows, sharedConnectionId))).toEqual(["Secret Operations", "Support Operations", "Support Triage"])
  expect(requiredByNames(findConnection(rows, legacyConnectionId))).toEqual(["Secret Operations", "Support Operations"])
})
