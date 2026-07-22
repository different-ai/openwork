import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { and, eq, inArray, sql } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ConnectedAccountTable,
  ConnectorAccountTable,
  ConnectorInstanceAccessGrantTable,
  ConnectorInstanceTable,
  ConnectorMappingTable,
  ConnectorTargetTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrgOAuthClientTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginMcpRequirementBindingTable,
  PluginTable,
  OrganizationTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr6"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type Db = typeof import("../src/db.js").db
type Store = typeof import("../src/routes/org/plugin-system/store.js")
type ConfigObjectType = typeof ConfigObjectTable.$inferSelect.objectType

type SeededOrg = {
  context: PluginArchActorContext
  marketplaceId: DenTypeId<"marketplace">
  memberId: DenTypeId<"member">
  organizationId: DenTypeId<"organization">
  userId: DenTypeId<"user">
}

type SeededPlugin = {
  configObjectIds: DenTypeId<"configObject">[]
  pluginId: DenTypeId<"plugin">
}

type SeededTeam = {
  teamId: DenTypeId<"team">
}

let db: Db
let store: Store

async function connectedMcpResult(): Promise<{ status: "connected" }> {
  return { status: "connected" }
}

async function unsupportedExternalMcpRuntimeCall(): Promise<never> {
  throw new Error("Unexpected external MCP runtime call in marketplace cloud readiness tests")
}

const connectExternalMcpMock = mock(connectedMcpResult)
const unsupportedExternalMcpRuntimeMock = mock(unsupportedExternalMcpRuntimeCall)

const createdOrganizationIds: DenTypeId<"organization">[] = []
const createdUserIds: DenTypeId<"user">[] = []

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  db = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db }))
  const { env } = await import("../src/env.js")
  mock.module("../src/env.js", () => ({
    env: {
      ...env,
      allowPrivateMcpUrls: true,
      betterAuthUrl: "http://127.0.0.1:3005",
      betterAuthSecret: "test-secret",
      githubConnectorApp: {},
      mcpConnectionsGatingEnabled: true, // Deprecated gate remains inert.
    },
  }))
  mock.module("../src/capability-sources/external-mcp-client-runtime.js", () => ({
    abandonExternalMcpAuth: unsupportedExternalMcpRuntimeMock,
    abandonLegacyExternalMcpAuth: unsupportedExternalMcpRuntimeMock,
    callExternalMcpTool: unsupportedExternalMcpRuntimeMock,
    connectExternalMcp: connectExternalMcpMock,
    completeExternalMcpAuth: unsupportedExternalMcpRuntimeMock,
    completeLegacyExternalMcpAuth: unsupportedExternalMcpRuntimeMock,
    externalMcpClientRuntimeName: "test external MCP runtime",
    inspectExternalMcpToolCall: unsupportedExternalMcpRuntimeMock,
    listExternalMcpTools: unsupportedExternalMcpRuntimeMock,
  }))
  store = await import("../src/routes/org/plugin-system/store.js")
})

afterAll(() => {
  mock.restore()
})

afterEach(async () => {
  if (createdOrganizationIds.length > 0) {
    await db.delete(ConnectedAccountTable).where(inArray(ConnectedAccountTable.organizationId, createdOrganizationIds))
    await db.delete(OrgOAuthClientTable).where(inArray(OrgOAuthClientTable.organizationId, createdOrganizationIds))
    await db.delete(PluginMcpRequirementBindingTable).where(inArray(PluginMcpRequirementBindingTable.organizationId, createdOrganizationIds))
    await db.delete(ExternalMcpConnectionAccessGrantTable).where(inArray(ExternalMcpConnectionAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(ExternalMcpConnectionTable).where(inArray(ExternalMcpConnectionTable.organizationId, createdOrganizationIds))
    await db.delete(ConfigObjectVersionTable).where(inArray(ConfigObjectVersionTable.organizationId, createdOrganizationIds))
    await db.delete(ConfigObjectAccessGrantTable).where(inArray(ConfigObjectAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.organizationId, createdOrganizationIds))
    await db.delete(ConnectorMappingTable).where(inArray(ConnectorMappingTable.organizationId, createdOrganizationIds))
    await db.delete(ConnectorTargetTable).where(inArray(ConnectorTargetTable.organizationId, createdOrganizationIds))
    await db.delete(ConnectorInstanceAccessGrantTable).where(inArray(ConnectorInstanceAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(ConnectorInstanceTable).where(inArray(ConnectorInstanceTable.organizationId, createdOrganizationIds))
    await db.delete(ConnectorAccountTable).where(inArray(ConnectorAccountTable.organizationId, createdOrganizationIds))
    await db.delete(PluginAccessGrantTable).where(inArray(PluginAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplacePluginTable).where(inArray(MarketplacePluginTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplaceAccessGrantTable).where(inArray(MarketplaceAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(ConfigObjectTable).where(inArray(ConfigObjectTable.organizationId, createdOrganizationIds))
    await db.delete(PluginTable).where(inArray(PluginTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplaceTable).where(inArray(MarketplaceTable.organizationId, createdOrganizationIds))
    await db.delete(MemberTable).where(inArray(MemberTable.organizationId, createdOrganizationIds))
    await db.delete(TeamTable).where(inArray(TeamTable.organizationId, createdOrganizationIds))
    await db.delete(OrganizationTable).where(inArray(OrganizationTable.id, createdOrganizationIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, createdUserIds))
  }
  createdOrganizationIds.length = 0
  createdUserIds.length = 0
  connectExternalMcpMock.mockClear()
  connectExternalMcpMock.mockImplementation(connectedMcpResult)
  unsupportedExternalMcpRuntimeMock.mockClear()
})

function orgMetadata(enabled = true) {
  return enabled ? null : { capabilities: { mcpConnections: false } }
}

function contextFor(input: {
  memberId: DenTypeId<"member">
  metadata: Record<string, unknown> | null
  organizationId: DenTypeId<"organization">
  role: string
  userId: DenTypeId<"user">
}): PluginArchActorContext {
  const now = new Date()
  return {
    memberTeams: [],
    organizationContext: {
      organization: {
        id: input.organizationId,
        name: "Cloud Readiness Org",
        slug: `cloud-readiness-${input.organizationId}`,
        logo: null,
        allowedEmailDomains: [],
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: input.memberId,
        userId: input.userId,
        role: input.role,
        createdAt: now,
        joinedAt: now,
        isOwner: input.role === "owner",
      },
      members: [],
      invitations: [],
      roles: [],
      teams: [],
    },
    session: { createdAt: now },
  }
}

async function seedOrg(input: { enabled?: boolean; marketplaceGrant?: "none" | "orgWide"; role?: string } = {}): Promise<SeededOrg> {
  const now = new Date()
  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const marketplaceId = createDenTypeId("marketplace")
  const metadata = orgMetadata(input.enabled ?? true)
  const role = input.role ?? "admin"
  createdOrganizationIds.push(organizationId)
  createdUserIds.push(userId)

  await db.insert(AuthUserTable).values({
    id: userId,
    name: "Cloud Readiness Tester",
    email: `${userId}@cloud-readiness.test.local`,
  })
  await db.insert(OrganizationTable).values({
    id: organizationId,
    name: "Cloud Readiness Org",
    slug: `cloud-readiness-${organizationId}`,
    metadata,
  })
  await db.insert(MemberTable).values({ id: memberId, organizationId, userId, role })
  await db.insert(MarketplaceTable).values({
    id: marketplaceId,
    organizationId,
    name: "Cloud Readiness Marketplace",
    description: "Readiness tests",
    logoUrl: null,
    status: "active",
    createdByOrgMembershipId: memberId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  if (input.marketplaceGrant !== "none") {
    await db.insert(MarketplaceAccessGrantTable).values({
      id: createDenTypeId("marketplaceAccessGrant"),
      organizationId,
      marketplaceId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      role: "viewer",
      createdByOrgMembershipId: memberId,
      createdAt: now,
      removedAt: null,
    })
  }

  return {
    organizationId,
    userId,
    memberId,
    marketplaceId,
    context: contextFor({ memberId, metadata, organizationId, role, userId }),
  }
}

async function addMember(input: { org: SeededOrg; role?: string }) {
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const role = input.role ?? "member"
  createdUserIds.push(userId)
  await db.insert(AuthUserTable).values({
    id: userId,
    name: "Cloud Readiness Member",
    email: `${userId}@cloud-readiness.test.local`,
  })
  await db.insert(MemberTable).values({ id: memberId, organizationId: input.org.organizationId, userId, role })
  return {
    memberId,
    userId,
    context: contextFor({ memberId, metadata: orgMetadata(true), organizationId: input.org.organizationId, role, userId }),
  }
}

async function addTeam(input: { org: SeededOrg; name?: string }): Promise<SeededTeam> {
  const teamId = createDenTypeId("team")
  await db.insert(TeamTable).values({
    id: teamId,
    organizationId: input.org.organizationId,
    name: input.name ?? `Team ${teamId}`,
  })
  return { teamId }
}

async function listUsableConnectionIds(input: {
  memberId: DenTypeId<"member">
  org: SeededOrg
  teamIds?: DenTypeId<"team">[]
}) {
  const { listUsableExternalMcpConnections } = await import("../src/capability-sources/external-mcp-connections.js")
  const rows = await listUsableExternalMcpConnections({
    organizationId: input.org.organizationId,
    orgMembershipId: input.memberId,
    teamIds: input.teamIds ?? [],
  })
  return rows.map((row) => row.id)
}

async function sourceGrantCount(bindingId: DenTypeId<"pluginMcpRequirementBinding">) {
  const rows = await db
    .select()
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(eq(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId, bindingId))
  return rows.length
}

async function seedPlugin(input: {
  components?: Array<{
    objectType: ConfigObjectType
    title: string
    normalizedPayloadJson?: Record<string, unknown> | null
    rawSourceText?: string | null
    withVersion?: boolean
  }>
  name: string
  org: SeededOrg
}): Promise<SeededPlugin> {
  const now = new Date()
  const pluginId = createDenTypeId("plugin")
  await db.insert(PluginTable).values({
    id: pluginId,
    organizationId: input.org.organizationId,
    name: input.name,
    description: `${input.name} description`,
    status: "active",
    createdByOrgMembershipId: input.org.memberId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  await db.insert(MarketplacePluginTable).values({
    id: createDenTypeId("marketplacePlugin"),
    organizationId: input.org.organizationId,
    marketplaceId: input.org.marketplaceId,
    pluginId,
    membershipSource: "manual",
    createdByOrgMembershipId: input.org.memberId,
    createdAt: now,
    removedAt: null,
  })

  const configObjectIds: DenTypeId<"configObject">[] = []
  for (const component of input.components ?? []) {
    const configObjectId = createDenTypeId("configObject")
    configObjectIds.push(configObjectId)
    await db.insert(ConfigObjectTable).values({
      id: configObjectId,
      organizationId: input.org.organizationId,
      objectType: component.objectType,
      sourceMode: "cloud",
      title: component.title,
      description: `${component.title} description`,
      searchText: component.title,
      currentFileName: `${component.title}.md`,
      currentFileExtension: ".md",
      currentRelativePath: `${component.objectType}s/${component.title}.md`,
      status: "active",
      createdByOrgMembershipId: input.org.memberId,
      connectorInstanceId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    await db.insert(PluginConfigObjectTable).values({
      id: createDenTypeId("pluginConfigObject"),
      organizationId: input.org.organizationId,
      pluginId,
      configObjectId,
      membershipSource: "manual",
      connectorMappingId: null,
      createdByOrgMembershipId: input.org.memberId,
      createdAt: now,
      removedAt: null,
    })
    if (component.withVersion !== false) {
      await db.insert(ConfigObjectVersionTable).values({
        id: createDenTypeId("configObjectVersion"),
        organizationId: input.org.organizationId,
        configObjectId,
        normalizedPayloadJson: component.normalizedPayloadJson ?? null,
        rawSourceText: component.rawSourceText ?? null,
        schemaVersion: null,
        createdVia: "cloud",
        createdByOrgMembershipId: input.org.memberId,
        connectorSyncEventId: null,
        sourceRevisionRef: null,
        isDeletedVersion: false,
        createdAt: now,
      })
    }
  }

  return { configObjectIds, pluginId }
}

async function seedConnection(input: {
  credentialMode: "per_member" | "shared"
  name: string
  org: SeededOrg
  url: string
}) {
  const connectionId = createDenTypeId("externalMcpConnection")
  await db.insert(ExternalMcpConnectionTable).values({
    id: connectionId,
    organizationId: input.org.organizationId,
    name: input.name,
    url: input.url,
    authType: input.credentialMode === "per_member" ? "oauth" : "none",
    credentialMode: input.credentialMode,
    connectedAt: input.credentialMode === "shared" ? new Date() : null,
    createdByOrgMembershipId: input.org.memberId,
  })
  await db.insert(ExternalMcpConnectionAccessGrantTable).values({
    id: createDenTypeId("externalMcpConnectionAccessGrant"),
    organizationId: input.org.organizationId,
    externalMcpConnectionId: connectionId,
    orgMembershipId: null,
    teamId: null,
    orgWide: true,
    createdByOrgMembershipId: input.org.memberId,
  })
  return connectionId
}

async function connectMember(input: { connectionId: DenTypeId<"externalMcpConnection">; memberId: DenTypeId<"member">; org: SeededOrg }) {
  await db.insert(ConnectedAccountTable).values({
    id: createDenTypeId("connectedAccount"),
    organizationId: input.org.organizationId,
    orgMembershipId: input.memberId,
    providerId: input.connectionId,
    externalAccountId: input.memberId,
    scopes: ["read"],
    accessToken: "member-token",
    refreshToken: null,
    tokenType: "Bearer",
    expiresAt: null,
    pendingCodeVerifier: null,
  })
}

async function resolvedPlugin(input: { context: PluginArchActorContext; marketplaceId: DenTypeId<"marketplace">; pluginId: DenTypeId<"plugin"> }) {
  const resolved = await store.getMarketplaceResolved({ context: input.context, marketplaceId: input.marketplaceId })
  const plugin = resolved.plugins.find((candidate) => candidate.id === input.pluginId)
  if (!plugin) throw new Error(`Missing plugin ${input.pluginId}`)
  return plugin
}

function routeFailureStatus(error: unknown) {
  if (error instanceof store.PluginArchRouteFailure) return error.status
  throw error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function rawStoredApiKey(connectionId: string) {
  const result: unknown = await db.execute(sql`select api_key from external_mcp_connection where id = ${connectionId}`)
  if (!Array.isArray(result) || !Array.isArray(result[0])) throw new Error("Unexpected raw API key result")
  const first = result[0][0]
  if (!isRecord(first)) throw new Error("Missing raw API key row")
  const value = first.api_key
  if (typeof value !== "string") throw new Error("Missing raw API key value")
  return value
}

async function configurePluginMcp(input: {
  apiKey?: string
  authType?: "apikey" | "none" | "oauth"
  configObjectId: DenTypeId<"configObject">
  credentialMode?: "per_member" | "shared"
  org: SeededOrg
  pluginId: DenTypeId<"plugin">
  serverName?: string
}) {
  return store.configureMarketplacePluginMcpRequirement({
    apiKey: input.apiKey,
    authType: input.authType ?? "oauth",
    configObjectId: input.configObjectId,
    context: input.org.context,
    credentialMode: input.credentialMode ?? "per_member",
    pluginId: input.pluginId,
    serverName: input.serverName ?? "slack",
  })
}

describe("marketplace cloud readiness payload", () => {
  test("skill-only synced content is ready", async () => {
    const org = await seedOrg()
    const plugin = await seedPlugin({
      org,
      name: "Ready Skill Plugin",
      components: [{ objectType: "skill", title: "Ready Skill", rawSourceText: "# Ready Skill" }],
    })

    expect((await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })).cloudReadiness).toMatchObject({
      state: "ready",
      hasInstructional: true,
      connections: [],
    })
  })

  test("per-member MCP dependencies need sign-in until the caller connects", async () => {
    const org = await seedOrg()
    const url = "https://crm.example.test/mcp"
    const connectionId = await seedConnection({ org, name: "CRM", url, credentialMode: "per_member" })
    const plugin = await seedPlugin({
      org,
      name: "CRM Plugin",
      components: [{ objectType: "mcp", title: "CRM MCP", normalizedPayloadJson: { mcpServers: { crm: { url } } } }],
    })

    const before = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(before.cloudReadiness?.state).toBe("needs_signin")
    expect(before.cloudReadiness?.connections[0]).toMatchObject({ id: connectionId, credentialMode: "per_member", connectedForMe: false })

    await connectMember({ org, memberId: org.memberId, connectionId })
    const after = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(after.cloudReadiness?.state).toBe("ready")
    expect(after.cloudReadiness?.connections[0]).toMatchObject({ id: connectionId, connectedForMe: true })
  })

  test("shared connected MCP dependencies are ready", async () => {
    const org = await seedOrg()
    const url = "https://shared.example.test/mcp"
    const connectionId = await seedConnection({ org, name: "Shared MCP", url, credentialMode: "shared" })
    const plugin = await seedPlugin({
      org,
      name: "Shared MCP Plugin",
      components: [{ objectType: "mcp", title: "Shared MCP", normalizedPayloadJson: { url } }],
    })

    const resolved = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(resolved.cloudReadiness?.state).toBe("ready")
    expect(resolved.cloudReadiness?.connections[0]).toMatchObject({ id: connectionId, credentialMode: "shared", connectedForMe: true })
  })

  test("misclassified Slack bindings stay blocked until an admin repairs OAuth setup", async () => {
    const org = await seedOrg()
    const url = "https://mcp.slack.com/mcp"
    const plugin = await seedPlugin({
      org,
      name: "Imported Slack Plugin",
      components: [{
        objectType: "mcp",
        title: "Slack MCP",
        normalizedPayloadJson: {
          externalMcpConnectionOwnedByPlugin: true,
          mcpServers: { slack: { url } },
        },
      }],
    })
    const configObjectId = plugin.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")

    await expect(configurePluginMcp({
      authType: "none",
      configObjectId,
      credentialMode: "shared",
      org,
      pluginId: plugin.pluginId,
    })).rejects.toMatchObject({ status: 409, error: "mcp_auth_type_mismatch" })

    const oldConnectionId = createDenTypeId("externalMcpConnection")
    await db.insert(ExternalMcpConnectionTable).values({
      id: oldConnectionId,
      organizationId: org.organizationId,
      name: "Legacy misclassified Slack",
      url,
      authType: "none",
      credentialMode: "shared",
      connectedAt: new Date(),
      createdByOrgMembershipId: org.memberId,
    })
    await db.insert(PluginMcpRequirementBindingTable).values({
      id: createDenTypeId("pluginMcpRequirementBinding"),
      organizationId: org.organizationId,
      pluginId: plugin.pluginId,
      configObjectId,
      serverName: "slack",
      externalMcpConnectionId: oldConnectionId,
      requiredAuthType: "oauth",
      connectionOwnedByPlugin: true,
      createdByOrgMembershipId: org.memberId,
    })
    expect(await listUsableConnectionIds({ org, memberId: org.memberId })).not.toContain(oldConnectionId)

    const before = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(before.cloudReadiness).toMatchObject({
      state: "needs_admin_setup",
      connections: [{
        authType: "none",
        authTypeMismatch: true,
        id: oldConnectionId,
        oauthClientConfigured: false,
        oauthClientRequired: true,
        requiredAuthType: "oauth",
      }],
    })

    const repaired = await store.configureMarketplacePluginMcpRequirement({
      authType: "oauth",
      configObjectId,
      context: org.context,
      credentialMode: "per_member",
      oauthClient: { clientId: "slack-client", clientSecret: "slack-secret" },
      pluginId: plugin.pluginId,
      serverName: "slack",
    })
    expect(repaired.connection.id).not.toBe(oldConnectionId)
    expect(await db.select().from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, oldConnectionId))).toHaveLength(0)

    const after = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(after.cloudReadiness).toMatchObject({
      state: "needs_signin",
      connections: [{
        authType: "oauth",
        authTypeMismatch: false,
        id: repaired.connection.id,
        oauthClientConfigured: true,
        oauthClientRequired: true,
        requiredAuthType: "oauth",
      }],
    })
  })

  test("unmatched MCP dependencies need admin setup and include declared connection details", async () => {
    const org = await seedOrg()
    const url = "https://missing.example.test/mcp"
    const plugin = await seedPlugin({
      org,
      name: "Missing MCP Plugin",
      components: [{ objectType: "mcp", title: "Missing MCP", normalizedPayloadJson: { mcpServers: { missing: { url } } } }],
    })

    const resolved = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(resolved.cloudReadiness?.state).toBe("needs_admin_setup")
    expect(resolved.cloudReadiness?.connections).toEqual([{
      configObjectId: plugin.configObjectIds[0],
      id: null,
      name: "missing",
      serverName: "missing",
      url,
    }])
  })

  test("tool-only synced content is desktop-only", async () => {
    const org = await seedOrg()
    const plugin = await seedPlugin({
      org,
      name: "Tool Plugin",
      components: [{ objectType: "tool", title: "Local Tool", rawSourceText: "export default {}" }],
    })

    expect((await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })).cloudReadiness?.state).toBe("desktop_only")
  })

  test("plugins with no synced version are not synced", async () => {
    const org = await seedOrg()
    const plugin = await seedPlugin({
      org,
      name: "Unsynced Plugin",
      components: [{ objectType: "skill", title: "Unsynced Skill", rawSourceText: "# Later", withVersion: false }],
    })

    const resolved = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(resolved.cloudReadiness?.state).toBe("not_synced")
  })

  test("not-synced precedence wins over ready content while preserving instructional availability", async () => {
    const org = await seedOrg()
    const plugin = await seedPlugin({
      org,
      name: "Mixed Plugin",
      components: [
        { objectType: "skill", title: "Synced Skill", rawSourceText: "# Ready" },
        { objectType: "tool", title: "Unsynced Tool", rawSourceText: "later", withVersion: false },
      ],
    })

    const resolved = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(resolved.cloudReadiness).toMatchObject({ state: "not_synced", hasInstructional: true })
  })

  test("kill-switched organizations omit cloudReadiness for old-client compatibility", async () => {
    const org = await seedOrg({ enabled: false })
    const plugin = await seedPlugin({
      org,
      name: "Gated Off Plugin",
      components: [{ objectType: "skill", title: "Hidden Skill", rawSourceText: "# Hidden" }],
    })

    const resolved = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(resolved.cloudReadiness).toBeUndefined()
  })

  test("per-member readiness is isolated by caller", async () => {
    const org = await seedOrg()
    const other = await addMember({ org })
    const url = "https://isolated.example.test/mcp"
    const connectionId = await seedConnection({ org, name: "Isolated MCP", url, credentialMode: "per_member" })
    const plugin = await seedPlugin({
      org,
      name: "Isolated Plugin",
      components: [{ objectType: "mcp", title: "Isolated MCP", normalizedPayloadJson: { mcpServers: { isolated: { url } } } }],
    })
    await connectMember({ org, memberId: org.memberId, connectionId })

    const adminView = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    const memberView = await resolvedPlugin({ context: other.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(adminView.cloudReadiness?.state).toBe("ready")
    expect(memberView.cloudReadiness?.state).toBe("needs_signin")
  })

  test("plugin MCP requirement configuration derives URL, access, stable identity, and OAuth client", async () => {
    const org = await seedOrg()
    const url = "http://slack.local.test/mcp"
    const plugin = await seedPlugin({
      org,
      name: "Slack Revenue Plugin",
      components: [{ objectType: "mcp", title: "Slack MCP", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const configObjectId = plugin.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")

    const configured = await store.configureMarketplacePluginMcpRequirement({
      authType: "oauth",
      configObjectId,
      context: org.context,
      credentialMode: "per_member",
      oauthClient: { clientId: "slack-client", clientSecret: "slack-secret" },
      pluginId: plugin.pluginId,
      serverName: "slack",
    })

    expect(configured.binding).toMatchObject({ configObjectId, pluginId: plugin.pluginId, serverName: "slack" })
    expect(configured.connection).toMatchObject({ authType: "oauth", credentialMode: "per_member", url })
    const link = new URL(configured.links.yourConnections)
    expect([...link.searchParams.keys()]).toEqual(["connectionId"])
    expect(link.searchParams.get("connectionId")).toBe(configured.connection.id)
    const connectionId = normalizeDenTypeId("externalMcpConnection", configured.connection.id)

    const grants = await db.select().from(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, connectionId))
    expect(grants.some((grant) => grant.orgWide)).toBe(true)

    const clients = await db.select().from(OrgOAuthClientTable).where(and(
      eq(OrgOAuthClientTable.organizationId, org.organizationId),
      eq(OrgOAuthClientTable.providerId, configured.connection.id),
    ))
    expect(clients[0]?.clientId).toBe("slack-client")

    const resolved = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(resolved.cloudReadiness?.connections[0]).toMatchObject({
      configObjectId,
      id: configured.connection.id,
      serverName: "slack",
    })
  })

  test("same-key compatible plugin MCP requirements reuse one connection and keep existing grants", async () => {
    const org = await seedOrg()
    const member = await addMember({ org })
    const url = "http://compatible-slack.local.test/mcp"
    const first = await seedPlugin({
      org,
      name: "Sales Slack Plugin",
      components: [{ objectType: "mcp", title: "Sales Slack", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const second = await seedPlugin({
      org,
      name: "Support Slack Plugin",
      components: [{ objectType: "mcp", title: "Support Slack", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const firstConfigObjectId = first.configObjectIds[0]
    const secondConfigObjectId = second.configObjectIds[0]
    if (!firstConfigObjectId || !secondConfigObjectId) throw new Error("missing config object")

    const firstConfigured = await configurePluginMcp({ org, pluginId: first.pluginId, configObjectId: firstConfigObjectId })
    await db.insert(ExternalMcpConnectionAccessGrantTable).values({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: org.organizationId,
      externalMcpConnectionId: normalizeDenTypeId("externalMcpConnection", firstConfigured.connection.id),
      orgMembershipId: member.memberId,
      teamId: null,
      orgWide: false,
      createdByOrgMembershipId: org.memberId,
    })
    const secondConfigured = await configurePluginMcp({ org, pluginId: second.pluginId, configObjectId: secondConfigObjectId })

    expect(secondConfigured.connection.id).toBe(firstConfigured.connection.id)
    const reusedConnectionId = normalizeDenTypeId("externalMcpConnection", firstConfigured.connection.id)
    const bindings = await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, reusedConnectionId))
    expect(bindings).toHaveLength(2)
    expect(new Set(bindings.map((binding) => binding.configObjectId))).toEqual(new Set([firstConfigObjectId, secondConfigObjectId]))

    const grants = await db.select().from(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, reusedConnectionId))
    expect(grants.some((grant) => grant.orgMembershipId === member.memberId)).toBe(true)
  })

  test("same-key incompatible plugin MCP requirements create separate plugin-named connections", async () => {
    const org = await seedOrg()
    const url = "http://incompatible-slack.local.test/mcp"
    const first = await seedPlugin({
      org,
      name: "OAuth Slack Plugin",
      components: [{ objectType: "mcp", title: "OAuth Slack", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const second = await seedPlugin({
      org,
      name: "No Auth Slack Plugin",
      components: [{ objectType: "mcp", title: "No Auth Slack", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const firstConfigObjectId = first.configObjectIds[0]
    const secondConfigObjectId = second.configObjectIds[0]
    if (!firstConfigObjectId || !secondConfigObjectId) throw new Error("missing config object")

    const firstConfigured = await configurePluginMcp({ org, pluginId: first.pluginId, configObjectId: firstConfigObjectId })
    const secondConfigured = await configurePluginMcp({ authType: "none", credentialMode: "shared", org, pluginId: second.pluginId, configObjectId: secondConfigObjectId })

    expect(secondConfigured.connection.id).not.toBe(firstConfigured.connection.id)
    expect(secondConfigured.connection.name).toContain("No Auth Slack Plugin")
    expect(secondConfigured.connection).toMatchObject({ authType: "none", credentialMode: "shared", connected: true })
    const connections = await db.select().from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.organizationId, org.organizationId))
    expect(connections).toHaveLength(2)
  })

  test("shared config object attached to two plugins creates two scoped bindings for one compatible connection", async () => {
    const org = await seedOrg()
    const url = "http://shared-config-slack.local.test/mcp"
    const first = await seedPlugin({
      org,
      name: "Shared Config Sales Plugin",
      components: [{ objectType: "mcp", title: "Shared Slack", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const second = await seedPlugin({ org, name: "Shared Config Support Plugin" })
    const configObjectId = first.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")
    await db.insert(PluginConfigObjectTable).values({
      id: createDenTypeId("pluginConfigObject"),
      organizationId: org.organizationId,
      pluginId: second.pluginId,
      configObjectId,
      membershipSource: "manual",
      connectorMappingId: null,
      createdByOrgMembershipId: org.memberId,
      removedAt: null,
    })

    const firstConfigured = await configurePluginMcp({ org, pluginId: first.pluginId, configObjectId })
    const secondConfigured = await configurePluginMcp({ org, pluginId: second.pluginId, configObjectId })

    expect(secondConfigured.connection.id).toBe(firstConfigured.connection.id)
    const bindings = await db.select().from(PluginMcpRequirementBindingTable).where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, org.organizationId),
      eq(PluginMcpRequirementBindingTable.configObjectId, configObjectId),
      eq(PluginMcpRequirementBindingTable.serverName, "slack"),
    ))
    expect(bindings).toHaveLength(2)
    expect(new Set(bindings.map((binding) => binding.pluginId))).toEqual(new Set([first.pluginId, second.pluginId]))
  })

  test("setup connection matching keeps tenant query and path case distinct", async () => {
    const org = await seedOrg()
    const tenantA = await seedPlugin({
      org,
      name: "Tenant A Plugin",
      components: [{ objectType: "mcp", title: "Tenant A Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://tenant-slack.local.test/mcp?tenant=a" } } } }],
    })
    const tenantB = await seedPlugin({
      org,
      name: "Tenant B Plugin",
      components: [{ objectType: "mcp", title: "Tenant B Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://tenant-slack.local.test/mcp?tenant=b" } } } }],
    })
    const upperPath = await seedPlugin({
      org,
      name: "Upper Path Plugin",
      components: [{ objectType: "mcp", title: "Upper Path Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://case-slack.local.test/MCP" } } } }],
    })
    const lowerPath = await seedPlugin({
      org,
      name: "Lower Path Plugin",
      components: [{ objectType: "mcp", title: "Lower Path Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://case-slack.local.test/mcp" } } } }],
    })
    const tenantAConfig = tenantA.configObjectIds[0]
    const tenantBConfig = tenantB.configObjectIds[0]
    const upperConfig = upperPath.configObjectIds[0]
    const lowerConfig = lowerPath.configObjectIds[0]
    if (!tenantAConfig || !tenantBConfig || !upperConfig || !lowerConfig) throw new Error("missing config object")

    const tenantAConfigured = await configurePluginMcp({ authType: "none", credentialMode: "shared", org, pluginId: tenantA.pluginId, configObjectId: tenantAConfig })
    const tenantBConfigured = await configurePluginMcp({ authType: "none", credentialMode: "shared", org, pluginId: tenantB.pluginId, configObjectId: tenantBConfig })
    const upperConfigured = await configurePluginMcp({ authType: "none", credentialMode: "shared", org, pluginId: upperPath.pluginId, configObjectId: upperConfig })
    const lowerConfigured = await configurePluginMcp({ authType: "none", credentialMode: "shared", org, pluginId: lowerPath.pluginId, configObjectId: lowerConfig })

    expect(tenantBConfigured.connection.id).not.toBe(tenantAConfigured.connection.id)
    expect(lowerConfigured.connection.id).not.toBe(upperConfigured.connection.id)
  })

  test("setup rejects fragments and embedded URL credentials", async () => {
    const org = await seedOrg()
    const fragment = await seedPlugin({
      org,
      name: "Fragment Plugin",
      components: [{ objectType: "mcp", title: "Fragment MCP", normalizedPayloadJson: { mcpServers: { slack: { url: "http://fragment.local.test/mcp#secret" } } } }],
    })
    const embedded = await seedPlugin({
      org,
      name: "Embedded Credential Plugin",
      components: [{ objectType: "mcp", title: "Embedded MCP", normalizedPayloadJson: { mcpServers: { slack: { url: "http://user:pass@embedded.local.test/mcp" } } } }],
    })
    const fragmentConfig = fragment.configObjectIds[0]
    const embeddedConfig = embedded.configObjectIds[0]
    if (!fragmentConfig || !embeddedConfig) throw new Error("missing config object")

    try {
      await configurePluginMcp({ authType: "none", credentialMode: "shared", org, pluginId: fragment.pluginId, configObjectId: fragmentConfig })
      throw new Error("expected fragment URL rejection")
    } catch (error) {
      expect(routeFailureStatus(error)).toBe(400)
    }

    try {
      await configurePluginMcp({ authType: "none", credentialMode: "shared", org, pluginId: embedded.pluginId, configObjectId: embeddedConfig })
      throw new Error("expected embedded credential URL rejection")
    } catch (error) {
      expect(routeFailureStatus(error)).toBe(400)
    }
  })

  test("differing OAuth clients create separate connections without touching existing client or token state", async () => {
    const org = await seedOrg()
    const url = "http://oauth-slack.local.test/mcp"
    const first = await seedPlugin({
      org,
      name: "OAuth Client A Plugin",
      components: [{ objectType: "mcp", title: "OAuth A Slack", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const second = await seedPlugin({
      org,
      name: "OAuth Client B Plugin",
      components: [{ objectType: "mcp", title: "OAuth B Slack", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const firstConfig = first.configObjectIds[0]
    const secondConfig = second.configObjectIds[0]
    if (!firstConfig || !secondConfig) throw new Error("missing config object")

    const firstConfigured = await store.configureMarketplacePluginMcpRequirement({
      authType: "oauth",
      configObjectId: firstConfig,
      context: org.context,
      credentialMode: "shared",
      oauthClient: { clientId: "client-a", clientSecret: "secret-a" },
      pluginId: first.pluginId,
      serverName: "slack",
    })
    const firstConnectionId = normalizeDenTypeId("externalMcpConnection", firstConfigured.connection.id)
    const connectedAt = new Date("2026-01-02T03:04:05.000Z")
    await db.update(ExternalMcpConnectionTable).set({ accessToken: "shared-token-a", connectedAt }).where(eq(ExternalMcpConnectionTable.id, firstConnectionId))

    const secondConfigured = await store.configureMarketplacePluginMcpRequirement({
      authType: "oauth",
      configObjectId: secondConfig,
      context: org.context,
      credentialMode: "shared",
      oauthClient: { clientId: "client-b", clientSecret: "secret-b" },
      pluginId: second.pluginId,
      serverName: "slack",
    })

    expect(secondConfigured.connection.id).not.toBe(firstConfigured.connection.id)
    const firstClient = await db.select().from(OrgOAuthClientTable).where(and(
      eq(OrgOAuthClientTable.organizationId, org.organizationId),
      eq(OrgOAuthClientTable.providerId, firstConfigured.connection.id),
    ))
    expect(firstClient[0]?.clientId).toBe("client-a")
    const firstConnection = await db.select().from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, firstConnectionId))
    expect(firstConnection[0]?.connectedAt?.toISOString()).toBe(connectedAt.toISOString())
  })

  test("API-key plugin MCP setup validates shared secret combinations", async () => {
    const org = await seedOrg()
    const plugin = await seedPlugin({
      org,
      name: "API Key Validation Plugin",
      components: [{ objectType: "mcp", title: "Exa MCP", normalizedPayloadJson: { mcpServers: { exa: { type: "remote", url: "http://api-key-validation.local.test/mcp" } } } }],
    })
    const configObjectId = plugin.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")

    const invalidInputs: Array<{
      apiKey?: string
      authType: "apikey" | "none" | "oauth"
      credentialMode: "per_member" | "shared"
      oauthClient?: { clientId: string; clientSecret?: string }
    }> = [
      { authType: "apikey", credentialMode: "shared" },
      { apiKey: "exa-key", authType: "apikey", credentialMode: "per_member" },
      { apiKey: "exa-key", authType: "oauth", credentialMode: "shared" },
      { apiKey: "exa-key", authType: "none", credentialMode: "shared" },
      { apiKey: "exa-key", authType: "apikey", credentialMode: "shared", oauthClient: { clientId: "exa-client" } },
    ]

    for (const invalid of invalidInputs) {
      try {
        await store.configureMarketplacePluginMcpRequirement({
          ...invalid,
          configObjectId,
          context: org.context,
          pluginId: plugin.pluginId,
          serverName: "exa",
        })
        throw new Error("expected invalid API-key setup")
      } catch (error) {
        expect(routeFailureStatus(error)).toBe(400)
      }
    }
  })

  test("API-key plugin MCP setup stores encrypted Exa secret without exposing it", async () => {
    const org = await seedOrg()
    const url = "http://exa-api-key.local.test/mcp"
    const plugin = await seedPlugin({
      org,
      name: "Exa API Key Plugin",
      components: [{
        objectType: "mcp",
        title: "Exa MCP",
        normalizedPayloadJson: {
          mcpServers: {
            exa: {
              headers: { Authorization: "Bearer ${EXA_API_KEY}" },
              type: "remote",
              url,
            },
          },
        },
      }],
    })
    const configObjectId = plugin.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")

    const configured = await configurePluginMcp({
      apiKey: "exa-secret-key",
      authType: "apikey",
      configObjectId,
      credentialMode: "shared",
      org,
      pluginId: plugin.pluginId,
      serverName: "exa",
    })

    expect(configured.connection).toMatchObject({ authType: "apikey", connected: true, credentialMode: "shared", url })
    expect(JSON.stringify(configured)).not.toContain("exa-secret-key")
    const connectionId = normalizeDenTypeId("externalMcpConnection", configured.connection.id)
    const rows = await db.select().from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, connectionId))
    expect(rows[0]?.apiKey).toBe("exa-secret-key")
    const rawApiKey = await rawStoredApiKey(configured.connection.id)
    expect(rawApiKey.startsWith("enc:v1:")).toBe(true)
    expect(rawApiKey).not.toContain("exa-secret-key")
  })

  test("API-key plugin MCP setup rolls back a new connection when live validation fails", async () => {
    const org = await seedOrg()
    const url = "http://validation-fails-exa.local.test/mcp"
    const plugin = await seedPlugin({
      org,
      name: "Validation Failure Exa Plugin",
      components: [{ objectType: "mcp", title: "Validation Failure Exa", normalizedPayloadJson: { mcpServers: { exa: { type: "remote", url } } } }],
    })
    const configObjectId = plugin.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")
    connectExternalMcpMock.mockImplementationOnce(async () => {
      throw new Error("validation failed")
    })

    try {
      await configurePluginMcp({ apiKey: "bad-secret", authType: "apikey", configObjectId, credentialMode: "shared", org, pluginId: plugin.pluginId, serverName: "exa" })
      throw new Error("expected validation failure")
    } catch (error) {
      expect(routeFailureStatus(error)).toBe(502)
    }

    expect(await db.select().from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.url, url))).toHaveLength(0)
    expect(await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.configObjectId, configObjectId))).toHaveLength(0)
  })

  test("API-key plugin MCP setup preserves direct credentials and reuses only matching secrets", async () => {
    const org = await seedOrg()
    const url = "http://shared-exa-api-key.local.test/mcp"
    const directConnectionId = createDenTypeId("externalMcpConnection")
    await db.insert(ExternalMcpConnectionTable).values({
      id: directConnectionId,
      organizationId: org.organizationId,
      name: "Direct Exa Connection",
      url,
      authType: "apikey",
      credentialMode: "shared",
      apiKey: "direct-secret",
      createdByOrgMembershipId: org.memberId,
    })
    await db.insert(ExternalMcpConnectionAccessGrantTable).values({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: org.organizationId,
      externalMcpConnectionId: directConnectionId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      createdByOrgMembershipId: org.memberId,
    })

    const first = await seedPlugin({
      org,
      name: "First Exa API Plugin",
      components: [{ objectType: "mcp", title: "First Exa", normalizedPayloadJson: { mcpServers: { exa: { type: "remote", url } } } }],
    })
    const second = await seedPlugin({
      org,
      name: "Second Exa API Plugin",
      components: [{ objectType: "mcp", title: "Second Exa", normalizedPayloadJson: { mcpServers: { exa: { type: "remote", url } } } }],
    })
    const third = await seedPlugin({
      org,
      name: "Third Exa API Plugin",
      components: [{ objectType: "mcp", title: "Third Exa", normalizedPayloadJson: { mcpServers: { exa: { type: "remote", url } } } }],
    })
    const firstConfig = first.configObjectIds[0]
    const secondConfig = second.configObjectIds[0]
    const thirdConfig = third.configObjectIds[0]
    if (!firstConfig || !secondConfig || !thirdConfig) throw new Error("missing config object")

    const firstConfigured = await configurePluginMcp({ apiKey: "plugin-secret", authType: "apikey", configObjectId: firstConfig, credentialMode: "shared", org, pluginId: first.pluginId, serverName: "exa" })
    const secondConfigured = await configurePluginMcp({ apiKey: "plugin-secret", authType: "apikey", configObjectId: secondConfig, credentialMode: "shared", org, pluginId: second.pluginId, serverName: "exa" })
    const thirdConfigured = await configurePluginMcp({ apiKey: "third-secret", authType: "apikey", configObjectId: thirdConfig, credentialMode: "shared", org, pluginId: third.pluginId, serverName: "exa" })

    expect(firstConfigured.connection.id).not.toBe(directConnectionId)
    expect(secondConfigured.connection.id).toBe(firstConfigured.connection.id)
    expect(thirdConfigured.connection.id).not.toBe(firstConfigured.connection.id)
    const directRows = await db.select().from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, directConnectionId))
    expect(directRows[0]?.apiKey).toBe("direct-secret")
    const reusedRows = await db.select().from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, normalizeDenTypeId("externalMcpConnection", firstConfigured.connection.id)))
    expect(reusedRows[0]?.apiKey).toBe("plugin-secret")
  })

  test("derived connection access tracks marketplace grants, preserves direct grants, and revokes only sourced rows", async () => {
    const org = await seedOrg({ marketplaceGrant: "none" })
    const team = await addTeam({ org, name: "Revenue" })
    const member = await addMember({ org })
    const url = "http://access-slack.local.test/mcp"
    const plugin = await seedPlugin({
      org,
      name: "Access Slack Plugin",
      components: [{ objectType: "mcp", title: "Access Slack", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const configObjectId = plugin.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")
    const configured = await configurePluginMcp({ org, pluginId: plugin.pluginId, configObjectId })
    const connectionId = normalizeDenTypeId("externalMcpConnection", configured.connection.id)
    const bindingId = normalizeDenTypeId("pluginMcpRequirementBinding", configured.binding.id)

    expect(await listUsableConnectionIds({ org, memberId: member.memberId, teamIds: [team.teamId] })).not.toContain(connectionId)
    const grant = await store.createResourceAccessGrant({
      context: org.context,
      resourceId: org.marketplaceId,
      resourceKind: "marketplace",
      value: { role: "viewer", teamId: team.teamId },
    })
    expect(await listUsableConnectionIds({ org, memberId: member.memberId, teamIds: [team.teamId] })).toContain(connectionId)
    expect(await sourceGrantCount(bindingId)).toBe(1)

    await db.insert(ExternalMcpConnectionAccessGrantTable).values({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: org.organizationId,
      externalMcpConnectionId: connectionId,
      orgMembershipId: member.memberId,
      teamId: null,
      orgWide: false,
      pluginMcpRequirementBindingId: null,
      createdByOrgMembershipId: org.memberId,
    })
    await store.deleteResourceAccessGrant({
      context: org.context,
      grantId: normalizeDenTypeId("marketplaceAccessGrant", grant.id),
      resourceId: org.marketplaceId,
      resourceKind: "marketplace",
    })
    expect(await sourceGrantCount(bindingId)).toBe(0)
    expect(await listUsableConnectionIds({ org, memberId: member.memberId, teamIds: [team.teamId] })).toContain(connectionId)
  })

  test("marketplace lifecycle archives or deletes only that marketplace's sourced MCP audience", async () => {
    const org = await seedOrg({ marketplaceGrant: "none" })
    const archivedMarketplaceTeam = await addTeam({ org, name: "Archived Marketplace Team" })
    const otherMarketplaceTeam = await addTeam({ org, name: "Other Marketplace Team" })
    const pluginTeam = await addTeam({ org, name: "Plugin Team" })
    const configTeam = await addTeam({ org, name: "Config Team" })
    const archivedMarketplaceMember = await addMember({ org })
    const otherMarketplaceMember = await addMember({ org })
    const pluginMember = await addMember({ org })
    const configMember = await addMember({ org })
    const directMember = await addMember({ org })
    const plugin = await seedPlugin({
      org,
      name: "Marketplace Lifecycle Slack Plugin",
      components: [{ objectType: "mcp", title: "Marketplace Lifecycle Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://marketplace-lifecycle-slack.local.test/mcp" } } } }],
    })
    const configObjectId = plugin.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")
    const otherMarketplaceId = createDenTypeId("marketplace")
    const now = new Date()
    await db.insert(MarketplaceTable).values({
      id: otherMarketplaceId,
      organizationId: org.organizationId,
      name: "Other Marketplace",
      description: null,
      logoUrl: null,
      status: "active",
      createdByOrgMembershipId: org.memberId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    await db.insert(MarketplacePluginTable).values({
      id: createDenTypeId("marketplacePlugin"),
      organizationId: org.organizationId,
      marketplaceId: otherMarketplaceId,
      pluginId: plugin.pluginId,
      membershipSource: "manual",
      createdByOrgMembershipId: org.memberId,
      createdAt: now,
      removedAt: null,
    })
    await db.insert(MarketplaceAccessGrantTable).values([
      {
        id: createDenTypeId("marketplaceAccessGrant"),
        organizationId: org.organizationId,
        marketplaceId: org.marketplaceId,
        orgMembershipId: null,
        teamId: archivedMarketplaceTeam.teamId,
        orgWide: false,
        role: "viewer",
        createdByOrgMembershipId: org.memberId,
        createdAt: now,
        removedAt: null,
      },
      {
        id: createDenTypeId("marketplaceAccessGrant"),
        organizationId: org.organizationId,
        marketplaceId: otherMarketplaceId,
        orgMembershipId: null,
        teamId: otherMarketplaceTeam.teamId,
        orgWide: false,
        role: "viewer",
        createdByOrgMembershipId: org.memberId,
        createdAt: now,
        removedAt: null,
      },
    ])
    await db.insert(PluginAccessGrantTable).values({
      id: createDenTypeId("pluginAccessGrant"),
      organizationId: org.organizationId,
      pluginId: plugin.pluginId,
      orgMembershipId: null,
      teamId: pluginTeam.teamId,
      orgWide: false,
      role: "viewer",
      createdByOrgMembershipId: org.memberId,
      createdAt: now,
      removedAt: null,
    })
    await db.insert(ConfigObjectAccessGrantTable).values({
      id: createDenTypeId("configObjectAccessGrant"),
      organizationId: org.organizationId,
      configObjectId,
      orgMembershipId: null,
      teamId: configTeam.teamId,
      orgWide: false,
      role: "viewer",
      createdByOrgMembershipId: org.memberId,
      createdAt: now,
      removedAt: null,
    })

    const configured = await configurePluginMcp({ org, pluginId: plugin.pluginId, configObjectId })
    const connectionId = normalizeDenTypeId("externalMcpConnection", configured.connection.id)
    const bindingId = normalizeDenTypeId("pluginMcpRequirementBinding", configured.binding.id)
    await db.insert(ExternalMcpConnectionAccessGrantTable).values({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: org.organizationId,
      externalMcpConnectionId: connectionId,
      orgMembershipId: directMember.memberId,
      teamId: null,
      orgWide: false,
      pluginMcpRequirementBindingId: null,
      createdByOrgMembershipId: org.memberId,
    })

    expect(await sourceGrantCount(bindingId)).toBe(4)
    expect(await listUsableConnectionIds({ org, memberId: archivedMarketplaceMember.memberId, teamIds: [archivedMarketplaceTeam.teamId] })).toContain(connectionId)
    expect(await listUsableConnectionIds({ org, memberId: otherMarketplaceMember.memberId, teamIds: [otherMarketplaceTeam.teamId] })).toContain(connectionId)
    expect(await listUsableConnectionIds({ org, memberId: pluginMember.memberId, teamIds: [pluginTeam.teamId] })).toContain(connectionId)
    expect(await listUsableConnectionIds({ org, memberId: configMember.memberId, teamIds: [configTeam.teamId] })).toContain(connectionId)
    expect(await listUsableConnectionIds({ org, memberId: directMember.memberId })).toContain(connectionId)

    await store.setMarketplaceLifecycle({ action: "archive", context: org.context, marketplaceId: org.marketplaceId })
    expect(await sourceGrantCount(bindingId)).toBe(3)
    expect(await listUsableConnectionIds({ org, memberId: archivedMarketplaceMember.memberId, teamIds: [archivedMarketplaceTeam.teamId] })).not.toContain(connectionId)
    expect(await listUsableConnectionIds({ org, memberId: otherMarketplaceMember.memberId, teamIds: [otherMarketplaceTeam.teamId] })).toContain(connectionId)
    expect(await listUsableConnectionIds({ org, memberId: pluginMember.memberId, teamIds: [pluginTeam.teamId] })).toContain(connectionId)
    expect(await listUsableConnectionIds({ org, memberId: configMember.memberId, teamIds: [configTeam.teamId] })).toContain(connectionId)
    expect(await listUsableConnectionIds({ org, memberId: directMember.memberId })).toContain(connectionId)

    await store.setMarketplaceLifecycle({ action: "restore", context: org.context, marketplaceId: org.marketplaceId })
    expect(await sourceGrantCount(bindingId)).toBe(4)
    expect(await listUsableConnectionIds({ org, memberId: archivedMarketplaceMember.memberId, teamIds: [archivedMarketplaceTeam.teamId] })).toContain(connectionId)

    const deleted = await store.setMarketplaceLifecycle({ action: "delete", context: org.context, marketplaceId: org.marketplaceId })
    expect(deleted.status).toBe("deleted")
    expect(deleted.deletedAt).not.toBeNull()
    expect(await db.select().from(MarketplaceTable).where(eq(MarketplaceTable.id, org.marketplaceId))).toHaveLength(0)
    expect(await db.select().from(MarketplacePluginTable).where(eq(MarketplacePluginTable.marketplaceId, org.marketplaceId))).toHaveLength(0)
    expect(await db.select().from(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.marketplaceId, org.marketplaceId))).toHaveLength(0)
    expect(await db.select().from(PluginTable).where(eq(PluginTable.id, plugin.pluginId))).toHaveLength(1)
    expect(await sourceGrantCount(bindingId)).toBe(3)
    expect(await listUsableConnectionIds({ org, memberId: archivedMarketplaceMember.memberId, teamIds: [archivedMarketplaceTeam.teamId] })).not.toContain(connectionId)
  })

  test("marketplace lifecycle refuses to delete a managed marketplace", async () => {
    const org = await seedOrg()
    await seedPlugin({ org, name: "Built-in Plugin" })
    await db
      .update(MarketplacePluginTable)
      .set({ membershipSource: "system" })
      .where(eq(MarketplacePluginTable.marketplaceId, org.marketplaceId))

    await expect(store.setMarketplaceLifecycle({
      action: "delete",
      context: org.context,
      marketplaceId: org.marketplaceId,
    })).rejects.toMatchObject({
      error: "managed_marketplace_cannot_be_deleted",
      status: 409,
    })

    const [marketplace] = await db.select().from(MarketplaceTable).where(eq(MarketplaceTable.id, org.marketplaceId))
    expect(marketplace?.status).toBe("active")
    expect(marketplace?.deletedAt).toBeNull()
  })

  test("plugin lifecycle archives sourced MCP access without deleting bindings and restores it", async () => {
    const org = await seedOrg()
    const plugin = await seedPlugin({
      org,
      name: "Lifecycle Slack Plugin",
      components: [{ objectType: "mcp", title: "Lifecycle Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://lifecycle-slack.local.test/mcp" } } } }],
    })
    const configObjectId = plugin.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")
    const configured = await configurePluginMcp({ org, pluginId: plugin.pluginId, configObjectId })
    const bindingId = normalizeDenTypeId("pluginMcpRequirementBinding", configured.binding.id)
    expect(await sourceGrantCount(bindingId)).toBe(1)

    await store.setPluginLifecycle({ action: "archive", context: org.context, pluginId: plugin.pluginId })
    expect(await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.id, bindingId))).toHaveLength(1)
    expect(await sourceGrantCount(bindingId)).toBe(0)

    await store.setPluginLifecycle({ action: "restore", context: org.context, pluginId: plugin.pluginId })
    expect(await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.id, bindingId))).toHaveLength(1)
    expect(await sourceGrantCount(bindingId)).toBe(1)
  })

  test("config object lifecycle archives sourced MCP access without deleting bindings and restores it", async () => {
    const org = await seedOrg()
    const plugin = await seedPlugin({
      org,
      name: "Config Lifecycle Slack Plugin",
      components: [{ objectType: "mcp", title: "Config Lifecycle Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://config-lifecycle-slack.local.test/mcp" } } } }],
    })
    const configObjectId = plugin.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")
    const configured = await configurePluginMcp({ org, pluginId: plugin.pluginId, configObjectId })
    const bindingId = normalizeDenTypeId("pluginMcpRequirementBinding", configured.binding.id)
    expect(await sourceGrantCount(bindingId)).toBe(1)

    await store.setConfigObjectLifecycle({ action: "archive", configObjectId, context: org.context })
    expect(await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.id, bindingId))).toHaveLength(1)
    expect(await sourceGrantCount(bindingId)).toBe(0)

    await store.setConfigObjectLifecycle({ action: "restore", configObjectId, context: org.context })
    expect(await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.id, bindingId))).toHaveLength(1)
    expect(await sourceGrantCount(bindingId)).toBe(1)
  })

  test("connector mapping delete removes only exact mapping-owned bindings after pluginId reassignment", async () => {
    const org = await seedOrg()
    const oldPlugin = await seedPlugin({
      org,
      name: "Original Connector Plugin",
      components: [{ objectType: "mcp", title: "Connector Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://connector-mapping-slack.local.test/mcp" } } } }],
    })
    const otherConnectorPlugin = await seedPlugin({
      org,
      name: "Other Original Connector Plugin",
      components: [{ objectType: "mcp", title: "Other Connector Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://connector-mapping-slack.local.test/mcp" } } } }],
    })
    const manualPlugin = await seedPlugin({ org, name: "Manual Reassigned Connector Plugin" })
    const configObjectId = oldPlugin.configObjectIds[0]
    const otherConfigObjectId = otherConnectorPlugin.configObjectIds[0]
    if (!configObjectId || !otherConfigObjectId) throw new Error("missing config object")
    const now = new Date()
    const connectorAccountId = createDenTypeId("connectorAccount")
    const connectorInstanceId = createDenTypeId("connectorInstance")
    const connectorTargetId = createDenTypeId("connectorTarget")
    const connectorMappingId = createDenTypeId("connectorMapping")
    await db.insert(ConnectorAccountTable).values({
      id: connectorAccountId,
      organizationId: org.organizationId,
      connectorType: "github",
      remoteId: `account-${connectorAccountId}`,
      externalAccountRef: "connector-owner",
      displayName: "Connector Account",
      status: "active",
      createdByOrgMembershipId: org.memberId,
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(ConnectorInstanceTable).values({
      id: connectorInstanceId,
      organizationId: org.organizationId,
      connectorAccountId,
      connectorType: "github",
      remoteId: `repo-${connectorInstanceId}`,
      name: `Connector Instance ${connectorInstanceId}`,
      status: "active",
      instanceConfigJson: null,
      lastSyncedAt: null,
      lastSyncStatus: null,
      lastSyncCursor: null,
      createdByOrgMembershipId: org.memberId,
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(ConnectorInstanceAccessGrantTable).values({
      id: createDenTypeId("connectorInstanceAccessGrant"),
      organizationId: org.organizationId,
      connectorInstanceId,
      orgMembershipId: org.memberId,
      teamId: null,
      orgWide: false,
      role: "manager",
      createdByOrgMembershipId: org.memberId,
      createdAt: now,
      removedAt: null,
    })
    await db.insert(ConnectorTargetTable).values({
      id: connectorTargetId,
      organizationId: org.organizationId,
      connectorInstanceId,
      connectorType: "github",
      remoteId: `target-${connectorTargetId}`,
      targetKind: "repository_branch",
      externalTargetRef: "main",
      targetConfigJson: { branch: "main", repositoryFullName: "openwork/test", installationId: 1 },
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(ConnectorMappingTable).values({
      id: connectorMappingId,
      organizationId: org.organizationId,
      connectorInstanceId,
      connectorTargetId,
      connectorType: "github",
      remoteId: null,
      mappingKind: "path",
      selector: "mcp/slack.json",
      objectType: "mcp",
      pluginId: oldPlugin.pluginId,
      autoAddToPlugin: true,
      mappingConfigJson: null,
      createdAt: now,
      updatedAt: now,
    })
    await db.update(PluginConfigObjectTable).set({
      connectorMappingId,
      membershipSource: "connector",
    }).where(and(
      eq(PluginConfigObjectTable.organizationId, org.organizationId),
      eq(PluginConfigObjectTable.pluginId, oldPlugin.pluginId),
      eq(PluginConfigObjectTable.configObjectId, configObjectId),
    ))
    await db.update(PluginConfigObjectTable).set({
      connectorMappingId,
      membershipSource: "connector",
    }).where(and(
      eq(PluginConfigObjectTable.organizationId, org.organizationId),
      eq(PluginConfigObjectTable.pluginId, otherConnectorPlugin.pluginId),
      eq(PluginConfigObjectTable.configObjectId, otherConfigObjectId),
    ))
    await db.insert(PluginConfigObjectTable).values({
      id: createDenTypeId("pluginConfigObject"),
      organizationId: org.organizationId,
      pluginId: manualPlugin.pluginId,
      configObjectId,
      membershipSource: "manual",
      connectorMappingId: null,
      createdByOrgMembershipId: org.memberId,
      createdAt: now,
      removedAt: null,
    })
    await db.insert(PluginConfigObjectTable).values({
      id: createDenTypeId("pluginConfigObject"),
      organizationId: org.organizationId,
      pluginId: oldPlugin.pluginId,
      configObjectId: otherConfigObjectId,
      membershipSource: "manual",
      connectorMappingId: null,
      createdByOrgMembershipId: org.memberId,
      createdAt: now,
      removedAt: null,
    })

    const configured = await configurePluginMcp({ org, pluginId: oldPlugin.pluginId, configObjectId })
    const bindingId = normalizeDenTypeId("pluginMcpRequirementBinding", configured.binding.id)
    const otherConfigured = await configurePluginMcp({ org, pluginId: otherConnectorPlugin.pluginId, configObjectId: otherConfigObjectId })
    const otherBindingId = normalizeDenTypeId("pluginMcpRequirementBinding", otherConfigured.binding.id)
    const crossPairConfigured = await configurePluginMcp({ org, pluginId: oldPlugin.pluginId, configObjectId: otherConfigObjectId })
    const crossPairBindingId = normalizeDenTypeId("pluginMcpRequirementBinding", crossPairConfigured.binding.id)
    const manualConfigured = await configurePluginMcp({ org, pluginId: manualPlugin.pluginId, configObjectId })
    const manualBindingId = normalizeDenTypeId("pluginMcpRequirementBinding", manualConfigured.binding.id)
    expect(await sourceGrantCount(bindingId)).toBe(1)
    expect(await sourceGrantCount(otherBindingId)).toBe(1)
    expect(await sourceGrantCount(crossPairBindingId)).toBe(1)
    expect(manualConfigured.connection.id).toBe(configured.connection.id)
    expect(await sourceGrantCount(manualBindingId)).toBe(1)

    await store.updateConnectorMapping({ connectorMappingId, context: org.context, pluginId: manualPlugin.pluginId })
    await store.deleteConnectorMapping({ connectorMappingId, context: org.context })

    expect(await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.id, bindingId))).toHaveLength(0)
    expect(await sourceGrantCount(bindingId)).toBe(0)
    expect(await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.id, otherBindingId))).toHaveLength(0)
    expect(await sourceGrantCount(otherBindingId)).toBe(0)
    expect(await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.id, crossPairBindingId))).toHaveLength(1)
    expect(await sourceGrantCount(crossPairBindingId)).toBe(1)
    expect(await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.id, manualBindingId))).toHaveLength(1)
    expect(await sourceGrantCount(manualBindingId)).toBe(1)
    expect(await db.select().from(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.connectorMappingId, connectorMappingId))).toHaveLength(0)
    expect(await db.select().from(ConnectorMappingTable).where(eq(ConnectorMappingTable.id, connectorMappingId))).toHaveLength(0)
  })

  test("revoking one bound plugin audience preserves another plugin's sourced access to the shared connection", async () => {
    const org = await seedOrg({ marketplaceGrant: "none" })
    const teamA = await addTeam({ org, name: "Sales" })
    const teamB = await addTeam({ org, name: "Support" })
    const memberA = await addMember({ org })
    const memberB = await addMember({ org })
    const url = "http://shared-access-slack.local.test/mcp"
    const first = await seedPlugin({
      org,
      name: "Sales Shared Access Plugin",
      components: [{ objectType: "mcp", title: "Sales Shared Slack", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const second = await seedPlugin({
      org,
      name: "Support Shared Access Plugin",
      components: [{ objectType: "mcp", title: "Support Shared Slack", normalizedPayloadJson: { mcpServers: { slack: { url } } } }],
    })
    const firstConfig = first.configObjectIds[0]
    const secondConfig = second.configObjectIds[0]
    if (!firstConfig || !secondConfig) throw new Error("missing config object")
    const firstConfigured = await configurePluginMcp({ org, pluginId: first.pluginId, configObjectId: firstConfig })
    const secondConfigured = await configurePluginMcp({ org, pluginId: second.pluginId, configObjectId: secondConfig })
    const connectionId = normalizeDenTypeId("externalMcpConnection", firstConfigured.connection.id)
    expect(secondConfigured.connection.id).toBe(connectionId)
    const firstGrant = await store.createResourceAccessGrant({ context: org.context, resourceId: first.pluginId, resourceKind: "plugin", value: { role: "viewer", teamId: teamA.teamId } })
    await store.createResourceAccessGrant({ context: org.context, resourceId: second.pluginId, resourceKind: "plugin", value: { role: "viewer", teamId: teamB.teamId } })

    expect(await listUsableConnectionIds({ org, memberId: memberA.memberId, teamIds: [teamA.teamId] })).toContain(connectionId)
    expect(await listUsableConnectionIds({ org, memberId: memberB.memberId, teamIds: [teamB.teamId] })).toContain(connectionId)
    await store.deleteResourceAccessGrant({ context: org.context, grantId: normalizeDenTypeId("pluginAccessGrant", firstGrant.id), resourceId: first.pluginId, resourceKind: "plugin" })
    expect(await listUsableConnectionIds({ org, memberId: memberA.memberId, teamIds: [teamA.teamId] })).not.toContain(connectionId)
    expect(await listUsableConnectionIds({ org, memberId: memberB.memberId, teamIds: [teamB.teamId] })).toContain(connectionId)
  })

  test("new MCP config URL invalidates the old binding and sourced access", async () => {
    const org = await seedOrg()
    const plugin = await seedPlugin({
      org,
      name: "Changing URL Plugin",
      components: [{ objectType: "mcp", title: "Changing Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://old-slack.local.test/mcp" } } } }],
    })
    const configObjectId = plugin.configObjectIds[0]
    if (!configObjectId) throw new Error("missing config object")
    const configured = await configurePluginMcp({ org, pluginId: plugin.pluginId, configObjectId })
    const bindingId = normalizeDenTypeId("pluginMcpRequirementBinding", configured.binding.id)
    expect(await sourceGrantCount(bindingId)).toBe(1)

    const nextPayload = { mcpServers: { slack: { url: "http://new-slack.local.test/mcp" } } }
    await store.createConfigObjectVersion({
      configObjectId,
      context: org.context,
      value: {
        metadata: { name: "Changing Slack" },
        normalizedPayloadJson: nextPayload,
        rawSourceText: JSON.stringify(nextPayload),
      },
    })

    const bindings = await db.select().from(PluginMcpRequirementBindingTable).where(eq(PluginMcpRequirementBindingTable.id, bindingId))
    expect(bindings).toHaveLength(0)
    expect(await sourceGrantCount(bindingId)).toBe(0)
  })

  test("imported externalMcpConnectionId payload remains compatible with readiness", async () => {
    const org = await seedOrg()
    const url = "https://imported-slack.example.test/mcp"
    const connectionId = await seedConnection({ org, name: "Imported Slack", url, credentialMode: "shared" })
    const plugin = await seedPlugin({
      org,
      name: "Imported Payload Plugin",
      components: [{ objectType: "mcp", title: "Imported Slack MCP", normalizedPayloadJson: { mcpServers: { slack: { url, externalMcpConnectionId: connectionId } } } }],
    })

    const resolved = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(resolved.cloudReadiness?.connections[0]).toMatchObject({ id: connectionId, serverName: "slack" })
  })

  test("stale imported externalMcpConnectionId payload is not ready when the declared URL changes", async () => {
    const org = await seedOrg()
    const connectionId = await seedConnection({ org, name: "Old Imported Slack", url: "https://old-imported-slack.example.test/mcp", credentialMode: "shared" })
    const plugin = await seedPlugin({
      org,
      name: "Stale Imported Payload Plugin",
      components: [{ objectType: "mcp", title: "Stale Imported Slack MCP", normalizedPayloadJson: { mcpServers: { slack: { url: "https://new-imported-slack.example.test/mcp", externalMcpConnectionId: connectionId } } } }],
    })

    const resolved = await resolvedPlugin({ context: org.context, marketplaceId: org.marketplaceId, pluginId: plugin.pluginId })
    expect(resolved.cloudReadiness?.state).toBe("needs_admin_setup")
    expect(resolved.cloudReadiness?.connections[0]).toMatchObject({ id: null, serverName: "slack" })
  })

  test("plugin MCP requirement configuration rejects cross-org plugin or config object ids", async () => {
    const orgA = await seedOrg()
    const orgB = await seedOrg()
    const pluginA = await seedPlugin({
      org: orgA,
      name: "Org A Plugin",
      components: [{ objectType: "mcp", title: "Org A Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://org-a.local.test/mcp" } } } }],
    })
    const pluginB = await seedPlugin({
      org: orgB,
      name: "Org B Plugin",
      components: [{ objectType: "mcp", title: "Org B Slack", normalizedPayloadJson: { mcpServers: { slack: { url: "http://org-b.local.test/mcp" } } } }],
    })
    const orgAConfigObjectId = pluginA.configObjectIds[0]
    const orgBConfigObjectId = pluginB.configObjectIds[0]
    if (!orgAConfigObjectId || !orgBConfigObjectId) throw new Error("missing config object")

    try {
      await configurePluginMcp({ org: orgA, pluginId: pluginB.pluginId, configObjectId: orgBConfigObjectId })
      throw new Error("expected foreign plugin rejection")
    } catch (error) {
      expect(routeFailureStatus(error)).toBe(404)
    }

    try {
      await configurePluginMcp({ org: orgA, pluginId: pluginA.pluginId, configObjectId: orgBConfigObjectId })
      throw new Error("expected foreign config object rejection")
    } catch (error) {
      expect(routeFailureStatus(error)).toBe(404)
    }
  })
})
