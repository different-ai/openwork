import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ConnectedAccountTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  PluginMcpRequirementBindingTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
  OrganizationTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { memberFacingMcpConnectionsEnabled } from "../src/capability-sources/external-mcp-rollout.js"
import type { McpMemberIdentity } from "../src/mcp/external-capabilities.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr3"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type Db = typeof import("../src/db.js").db
type MarketplaceCapabilities = typeof import("../src/mcp/marketplace-capabilities.js")
type ExternalCapabilities = typeof import("../src/mcp/external-capabilities.js")
type ConfigObjectType = typeof ConfigObjectTable.$inferSelect.objectType

type SeededMember = {
  member: McpMemberIdentity
  memberId: DenTypeId<"member">
  organizationId: DenTypeId<"organization">
  userId: DenTypeId<"user">
}

type SeededCapability = {
  configObjectId: DenTypeId<"configObject">
  name: string
  pluginId: DenTypeId<"plugin">
}

let db: Db
let marketplaceCapabilities: MarketplaceCapabilities
let externalCapabilities: ExternalCapabilities

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
  marketplaceCapabilities = await import("../src/mcp/marketplace-capabilities.js")
  externalCapabilities = await import("../src/mcp/external-capabilities.js")
})

afterAll(() => {
  mock.restore()
})

afterEach(async () => {
  if (createdOrganizationIds.length > 0) {
    await db.delete(ConnectedAccountTable).where(inArray(ConnectedAccountTable.organizationId, createdOrganizationIds))
    await db.delete(PluginMcpRequirementBindingTable).where(inArray(PluginMcpRequirementBindingTable.organizationId, createdOrganizationIds))
    await db.delete(ExternalMcpConnectionAccessGrantTable).where(inArray(ExternalMcpConnectionAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(ExternalMcpConnectionTable).where(inArray(ExternalMcpConnectionTable.organizationId, createdOrganizationIds))
    await db.delete(ConfigObjectVersionTable).where(inArray(ConfigObjectVersionTable.organizationId, createdOrganizationIds))
    await db.delete(ConfigObjectAccessGrantTable).where(inArray(ConfigObjectAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.organizationId, createdOrganizationIds))
    await db.delete(PluginAccessGrantTable).where(inArray(PluginAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplacePluginTable).where(inArray(MarketplacePluginTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplaceAccessGrantTable).where(inArray(MarketplaceAccessGrantTable.organizationId, createdOrganizationIds))
    await db.delete(ConfigObjectTable).where(inArray(ConfigObjectTable.organizationId, createdOrganizationIds))
    await db.delete(PluginTable).where(inArray(PluginTable.organizationId, createdOrganizationIds))
    await db.delete(TeamTable).where(inArray(TeamTable.organizationId, createdOrganizationIds))
    await db.delete(MarketplaceTable).where(inArray(MarketplaceTable.organizationId, createdOrganizationIds))
    await db.delete(MemberTable).where(inArray(MemberTable.organizationId, createdOrganizationIds))
    await db.delete(OrganizationTable).where(inArray(OrganizationTable.id, createdOrganizationIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, createdUserIds))
  }
  createdOrganizationIds.length = 0
  createdUserIds.length = 0
})

async function seedMember(input: { metadata?: Record<string, unknown> | null; role?: string } = {}): Promise<SeededMember> {
  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  createdOrganizationIds.push(organizationId)
  createdUserIds.push(userId)

  await db.insert(AuthUserTable).values({
    id: userId,
    name: "Marketplace Tester",
    email: `${userId}@marketplace.test.local`,
  })
  await db.insert(OrganizationTable).values({
    id: organizationId,
    name: "Marketplace Test Org",
    slug: `marketplace-${organizationId}`,
    metadata: input.metadata ?? null,
  })
  await db.insert(MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: input.role ?? "member",
  })

  return {
    organizationId,
    userId,
    memberId,
    member: { orgMembershipId: memberId, teamIds: [] },
  }
}

async function seedCapability(input: {
  description?: string | null
  grant?: "config_object" | "marketplace" | "none" | "plugin"
  normalizedPayloadJson?: Record<string, unknown> | null
  objectType: ConfigObjectType
  owner: SeededMember
  pluginName?: string
  rawSourceText?: string | null
  title: string
  withVersion?: boolean
}): Promise<SeededCapability> {
  const now = new Date()
  const marketplaceId = createDenTypeId("marketplace")
  const pluginId = createDenTypeId("plugin")
  const configObjectId = createDenTypeId("configObject")
  const description = input.description ?? null
  const rawSourceText = input.rawSourceText ?? null

  await db.insert(MarketplaceTable).values({
    id: marketplaceId,
    organizationId: input.owner.organizationId,
    name: "Team Marketplace",
    description: "Curated marketplace for tests",
    logoUrl: null,
    status: "active",
    createdByOrgMembershipId: input.owner.memberId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  await db.insert(PluginTable).values({
    id: pluginId,
    organizationId: input.owner.organizationId,
    name: input.pluginName ?? "Revenue Ops Plugin",
    description: "Helps with revenue work",
    status: "active",
    createdByOrgMembershipId: input.owner.memberId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  await db.insert(ConfigObjectTable).values({
    id: configObjectId,
    organizationId: input.owner.organizationId,
    objectType: input.objectType,
    sourceMode: "cloud",
    title: input.title,
    description,
    searchText: [input.title, description, rawSourceText].filter(Boolean).join("\n"),
    currentFileName: `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
    currentFileExtension: ".md",
    currentRelativePath: `${input.objectType}s/${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
    status: "active",
    createdByOrgMembershipId: input.owner.memberId,
    connectorInstanceId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  await db.insert(MarketplacePluginTable).values({
    id: createDenTypeId("marketplacePlugin"),
    organizationId: input.owner.organizationId,
    marketplaceId,
    pluginId,
    membershipSource: "manual",
    createdByOrgMembershipId: input.owner.memberId,
    createdAt: now,
    removedAt: null,
  })
  await db.insert(PluginConfigObjectTable).values({
    id: createDenTypeId("pluginConfigObject"),
    organizationId: input.owner.organizationId,
    pluginId,
    configObjectId,
    membershipSource: "manual",
    connectorMappingId: null,
    createdByOrgMembershipId: input.owner.memberId,
    createdAt: now,
    removedAt: null,
  })
  if (input.withVersion !== false) {
    await db.insert(ConfigObjectVersionTable).values({
      id: createDenTypeId("configObjectVersion"),
      organizationId: input.owner.organizationId,
      configObjectId,
      normalizedPayloadJson: input.normalizedPayloadJson ?? null,
      rawSourceText,
      schemaVersion: null,
      createdVia: "cloud",
      createdByOrgMembershipId: input.owner.memberId,
      connectorSyncEventId: null,
      sourceRevisionRef: null,
      isDeletedVersion: false,
      createdAt: now,
    })
  }

  const grant = input.grant ?? "marketplace"
  if (grant === "marketplace") {
    await db.insert(MarketplaceAccessGrantTable).values({
      id: createDenTypeId("marketplaceAccessGrant"),
      organizationId: input.owner.organizationId,
      marketplaceId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      role: "viewer",
      createdByOrgMembershipId: input.owner.memberId,
      createdAt: now,
      removedAt: null,
    })
  }
  if (grant === "plugin") {
    await db.insert(PluginAccessGrantTable).values({
      id: createDenTypeId("pluginAccessGrant"),
      organizationId: input.owner.organizationId,
      pluginId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      role: "viewer",
      createdByOrgMembershipId: input.owner.memberId,
      createdAt: now,
      removedAt: null,
    })
  }
  if (grant === "config_object") {
    await db.insert(ConfigObjectAccessGrantTable).values({
      id: createDenTypeId("configObjectAccessGrant"),
      organizationId: input.owner.organizationId,
      configObjectId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      role: "viewer",
      createdByOrgMembershipId: input.owner.memberId,
      createdAt: now,
      removedAt: null,
    })
  }

  return {
    configObjectId,
    pluginId,
    name: marketplaceCapabilities.buildMarketplaceCapabilityName(pluginId, configObjectId),
  }
}

async function addTeamToMember(input: { member: SeededMember }) {
  const teamId = createDenTypeId("team")
  await db.insert(TeamTable).values({
    id: teamId,
    organizationId: input.member.organizationId,
    name: `Team ${teamId}`,
  })
  return {
    ...input.member,
    teamId,
    member: { orgMembershipId: input.member.memberId, teamIds: [teamId] },
  }
}

async function grantPluginToTeam(input: {
  owner: SeededMember
  pluginId: DenTypeId<"plugin">
  teamId: DenTypeId<"team">
}) {
  await db.insert(PluginAccessGrantTable).values({
    id: createDenTypeId("pluginAccessGrant"),
    organizationId: input.owner.organizationId,
    pluginId: input.pluginId,
    orgMembershipId: null,
    teamId: input.teamId,
    orgWide: false,
    role: "viewer",
    createdByOrgMembershipId: input.owner.memberId,
    createdAt: new Date(),
    removedAt: null,
  })
}

async function addMcpRequirement(input: {
  owner: SeededMember
  pluginId: DenTypeId<"plugin">
  servers: Record<string, { url: string }>
  title: string
}) {
  const now = new Date()
  const configObjectId = createDenTypeId("configObject")
  const normalizedPayloadJson = { mcpServers: input.servers }
  await db.insert(ConfigObjectTable).values({
    id: configObjectId,
    organizationId: input.owner.organizationId,
    objectType: "mcp",
    sourceMode: "cloud",
    title: input.title,
    description: `${input.title} description`,
    searchText: input.title,
    currentFileName: `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`,
    currentFileExtension: ".json",
    currentRelativePath: `mcps/${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`,
    status: "active",
    createdByOrgMembershipId: input.owner.memberId,
    connectorInstanceId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  await db.insert(PluginConfigObjectTable).values({
    id: createDenTypeId("pluginConfigObject"),
    organizationId: input.owner.organizationId,
    pluginId: input.pluginId,
    configObjectId,
    membershipSource: "manual",
    connectorMappingId: null,
    createdByOrgMembershipId: input.owner.memberId,
    createdAt: now,
    removedAt: null,
  })
  await db.insert(ConfigObjectVersionTable).values({
    id: createDenTypeId("configObjectVersion"),
    organizationId: input.owner.organizationId,
    configObjectId,
    normalizedPayloadJson,
    rawSourceText: JSON.stringify(normalizedPayloadJson),
    schemaVersion: null,
    createdVia: "cloud",
    createdByOrgMembershipId: input.owner.memberId,
    connectorSyncEventId: null,
    sourceRevisionRef: null,
    isDeletedVersion: false,
    createdAt: now,
  })
  return configObjectId
}

async function seedExternalConnection(input: {
  authType?: "none" | "oauth"
  connected?: boolean
  credentialMode?: "per_member" | "shared"
  grant?: boolean
  name: string
  owner: SeededMember
  url: string
}) {
  const connectionId = createDenTypeId("externalMcpConnection")
  const authType = input.authType ?? "oauth"
  const credentialMode = input.credentialMode ?? "per_member"
  await db.insert(ExternalMcpConnectionTable).values({
    id: connectionId,
    organizationId: input.owner.organizationId,
    name: input.name,
    url: input.url,
    authType,
    credentialMode,
    accessToken: authType === "oauth" && credentialMode === "shared" && input.connected ? "shared-token" : null,
    connectedAt: input.connected ? new Date() : null,
    createdByOrgMembershipId: input.owner.memberId,
  })
  if (input.grant !== false) {
    await db.insert(ExternalMcpConnectionAccessGrantTable).values({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: input.owner.organizationId,
      externalMcpConnectionId: connectionId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      createdByOrgMembershipId: input.owner.memberId,
    })
  }
  return connectionId
}

async function bindPluginMcpRequirement(input: {
  configObjectId: DenTypeId<"configObject">
  connectionId: DenTypeId<"externalMcpConnection">
  owner: SeededMember
  pluginId: DenTypeId<"plugin">
  serverName: string
}) {
  const bindingId = createDenTypeId("pluginMcpRequirementBinding")
  await db.insert(PluginMcpRequirementBindingTable).values({
    id: bindingId,
    organizationId: input.owner.organizationId,
    pluginId: input.pluginId,
    configObjectId: input.configObjectId,
    serverName: input.serverName,
    externalMcpConnectionId: input.connectionId,
    createdByOrgMembershipId: input.owner.memberId,
  })
  return bindingId
}

async function connectMemberToConnection(input: {
  connectionId: DenTypeId<"externalMcpConnection">
  member: SeededMember
  token?: string
}) {
  await db.insert(ConnectedAccountTable).values({
    id: createDenTypeId("connectedAccount"),
    organizationId: input.member.organizationId,
    orgMembershipId: input.member.memberId,
    providerId: input.connectionId,
    externalAccountId: input.member.memberId,
    scopes: ["read"],
    accessToken: input.token ?? "member-token",
    refreshToken: null,
    tokenType: "Bearer",
    expiresAt: null,
    pendingCodeVerifier: null,
  })
}

async function execute(owner: SeededMember, seeded: SeededCapability, body?: unknown) {
  return marketplaceCapabilities.executeMarketplaceCapability({
    organizationId: owner.organizationId,
    member: owner.member,
    pluginId: seeded.pluginId,
    configObjectId: seeded.configObjectId,
    body,
    enabled: true,
  })
}

function expectYourConnectionsUrl(value: string | undefined, connectionId: string) {
  if (!value) throw new Error("missing action url")
  const url = new URL(value)
  expect(url.pathname).toBe("/dashboard/your-connections")
  expect([...url.searchParams.keys()]).toEqual(["connectionId"])
  expect(url.searchParams.get("connectionId")).toBe(connectionId)
}

function expectOrganizationConnectionsUrl(value: string | undefined) {
  if (!value) throw new Error("missing action url")
  const url = new URL(value)
  expect(url.pathname).toBe("/dashboard/mcp-connections")
  expect([...url.searchParams.keys()]).toEqual([])
}

describe("marketplace capabilities source", () => {
  test("search finds a published plugin skill and execute returns provenance-framed raw content", async () => {
    const owner = await seedMember()
    const seeded = await seedCapability({
      owner,
      objectType: "skill",
      title: "Renewal Playbook",
      description: "Use for enterprise renewal strategy",
      rawSourceText: "# Renewal Playbook\n\nAlways mention expansion risk.",
    })

    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: owner.organizationId,
      member: owner.member,
      query: "renewal expansion",
      limit: 5,
      enabled: true,
    })
    const match = matches.find((candidate) => candidate.name === seeded.name)
    expect(match?.method).toBe("PLUGIN")
    expect(match?.kind).toBe("skill")
    expect(match?.plugin).toBe("Revenue Ops Plugin")
    expect(match?.marketplace).toBe("Team Marketplace")
    expect(match?.hasBody).toBe(false)

    const result = await execute(owner, seeded)
    if (!result.ok) throw new Error(result.message)
    expect(result.result).toMatchObject({
      kind: "skill",
      plugin: "Revenue Ops Plugin",
      marketplace: "Team Marketplace",
      name: "Renewal Playbook",
      content: "# Renewal Playbook\n\nAlways mention expansion risk.",
      provenance: "Content from marketplace plugin Revenue Ops Plugin in your organization's library.",
    })
  })

  test("command execute substitutes $ARGUMENTS without running anything server-side", async () => {
    const owner = await seedMember()
    const seeded = await seedCapability({
      owner,
      objectType: "command",
      title: "Draft Follow-up",
      rawSourceText: "Create the follow-up for $ARGUMENTS.",
    })

    const result = await execute(owner, seeded, { arguments: "Acme renewal" })
    if (!result.ok) throw new Error(result.message)
    expect(result.result.kind).toBe("command")
    expect(result.result.content).toBe("Create the follow-up for Acme renewal.")
  })

  test("mcp objects return server specs and existing-connection or admin-install hints", async () => {
    const owner = await seedMember()
    const url = "https://mcp.example.test/remote"
    const serverSpec = { mcpServers: { brief: { url } } }
    const seeded = await seedCapability({
      owner,
      objectType: "mcp",
      title: "Brief MCP",
      rawSourceText: JSON.stringify(serverSpec),
      normalizedPayloadJson: serverSpec,
    })

    const missingConnection = await execute(owner, seeded)
    if (!missingConnection.ok) throw new Error(missingConnection.message)
    expect(missingConnection.result.serverSpec).toEqual(serverSpec)
    expect(missingConnection.result.status).toBe("needs_connection")
    expect(missingConnection.result.hint).toContain("OpenWork Cloud -> Connectors")

    const connectionId = createDenTypeId("externalMcpConnection")
    await db.insert(ExternalMcpConnectionTable).values({
      id: connectionId,
      organizationId: owner.organizationId,
      name: "Brief Remote",
      url,
      authType: "none",
      credentialMode: "shared",
      createdByOrgMembershipId: owner.memberId,
    })
    await db.insert(ExternalMcpConnectionAccessGrantTable).values({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: owner.organizationId,
      externalMcpConnectionId: connectionId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      createdByOrgMembershipId: owner.memberId,
    })

    const matchingConnection = await execute(owner, seeded)
    if (!matchingConnection.ok) throw new Error(matchingConnection.message)
    expect(matchingConnection.result.status).toBe("connection_available")
    expect(matchingConnection.result.hint).toContain("Brief Remote")
  })

  test("tool and hook objects return honest local-only and unsupported statuses", async () => {
    const owner = await seedMember()
    const tool = await seedCapability({
      owner,
      objectType: "tool",
      title: "Local CSV Tool",
      rawSourceText: "export function run() { return 'csv' }",
    })
    const hook = await seedCapability({
      owner,
      objectType: "hook",
      title: "Preflight Hook",
      rawSourceText: "hooks:\n  before: echo nope",
    })

    const toolResult = await execute(owner, tool)
    if (!toolResult.ok) throw new Error(toolResult.message)
    expect(toolResult.result.status).toBe("needs_install")
    expect(toolResult.result.source).toContain("csv")
    expect(toolResult.result.hint).toContain("Revenue Ops Plugin")

    const hookResult = await execute(owner, hook)
    if (!hookResult.ok) throw new Error(hookResult.message)
    expect(hookResult.result.status).toBe("unsupported")
    expect(hookResult.result.definition).toContain("before")
    expect(hookResult.result.hint).toContain("not supported")
  })

  test("execute reports content_not_synced when a config object has no latest version", async () => {
    const owner = await seedMember()
    const seeded = await seedCapability({
      owner,
      objectType: "skill",
      title: "Unsynced Skill",
      rawSourceText: null,
      withVersion: false,
    })

    const result = await execute(owner, seeded)
    if (!result.ok) throw new Error(result.message)
    expect(result.result.status).toBe("content_not_synced")
    expect(result.result.hint).toContain("has not synced content")
  })

  test("org kill switch hides marketplace search and makes execute unknown", async () => {
    const disabledMetadata = { capabilities: { mcpConnections: false } }
    const disabledOrg = await seedMember({ metadata: disabledMetadata })
    const disabledCapability = await seedCapability({
      owner: disabledOrg,
      objectType: "skill",
      title: "Hidden Capability",
      rawSourceText: "Do not expose while disabled.",
    })
    const disabled = memberFacingMcpConnectionsEnabled(disabledMetadata, { gatingEnabled: true })
    expect(disabled).toBe(false)
    expect(await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: disabledOrg.organizationId,
      member: disabledOrg.member,
      query: "hidden",
      enabled: disabled,
    })).toEqual([])
    const disabledExecute = await marketplaceCapabilities.executeMarketplaceCapability({
      organizationId: disabledOrg.organizationId,
      member: disabledOrg.member,
      pluginId: disabledCapability.pluginId,
      configObjectId: disabledCapability.configObjectId,
      enabled: disabled,
    })
    expect(disabledExecute.ok).toBe(false)
    if (disabledExecute.ok) throw new Error("expected disabled execute to fail")
    expect(disabledExecute.error).toBe("unknown_capability")

    const defaultOn = await seedMember()
    const visibleCapability = await seedCapability({
      owner: defaultOn,
      objectType: "skill",
      title: "Visible Capability",
      rawSourceText: "Expose by default.",
    })
    const enabled = memberFacingMcpConnectionsEnabled(null, { gatingEnabled: true })
    expect(enabled).toBe(true)
    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: defaultOn.organizationId,
      member: defaultOn.member,
      query: "visible",
      enabled,
    })
    expect(matches.some((match) => match.name === visibleCapability.name)).toBe(true)
  })

  test("members cannot search or execute marketplace content from another organization", async () => {
    const orgA = await seedMember()
    const orgB = await seedMember()
    const orgBCapability = await seedCapability({
      owner: orgB,
      objectType: "skill",
      title: "Org B Secret",
      rawSourceText: "Only org B should see this.",
    })

    const orgBMatches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: orgB.organizationId,
      member: orgB.member,
      query: "secret",
      enabled: true,
    })
    expect(orgBMatches.some((match) => match.name === orgBCapability.name)).toBe(true)

    const orgAMatches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: orgA.organizationId,
      member: orgA.member,
      query: "secret",
      enabled: true,
    })
    expect(orgAMatches.some((match) => match.name === orgBCapability.name)).toBe(false)

    const orgAExecute = await marketplaceCapabilities.executeMarketplaceCapability({
      organizationId: orgA.organizationId,
      member: orgA.member,
      pluginId: orgBCapability.pluginId,
      configObjectId: orgBCapability.configObjectId,
      enabled: true,
    })
    expect(orgAExecute.ok).toBe(false)
    if (orgAExecute.ok) throw new Error("expected cross-org execute to fail")
    expect(orgAExecute.error).toBe("unknown_capability")
  })

  test("team-assigned skill discovery reports missing plugin MCP admin setup deterministically", async () => {
    const seededMember = await seedMember()
    const teamMember = await addTeamToMember({ member: seededMember })
    const seeded = await seedCapability({
      owner: teamMember,
      grant: "none",
      objectType: "skill",
      title: "Team Renewal Playbook",
      rawSourceText: "# Team Renewal Playbook",
    })
    await grantPluginToTeam({ owner: teamMember, pluginId: seeded.pluginId, teamId: teamMember.teamId })
    await addMcpRequirement({
      owner: teamMember,
      pluginId: seeded.pluginId,
      title: "Team Revenue MCPs",
      servers: {
        slack: { url: "https://slack.example.test/mcp" },
        alpha: { url: "https://alpha.example.test/mcp" },
      },
    })

    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: teamMember.organizationId,
      member: teamMember.member,
      query: "team renewal",
      limit: 5,
      enabled: true,
    })
    const match = matches.find((candidate) => candidate.name === seeded.name)
    expect(match?.status).toBe("needs_admin_setup")
    expect(match?.mcpRequirements?.map((requirement) => requirement.serverName)).toEqual(["alpha", "slack"])
    expect(match?.mcpRequirements?.every((requirement) => requirement.pluginName === "Revenue Ops Plugin")).toBe(true)
    expect(match?.mcpRequirements?.every((requirement) => requirement.state === "needs_admin_setup")).toBe(true)
    expect(match?.action?.surface).toBe("openwork_organization_connections")
    expectOrganizationConnectionsUrl(match?.action?.url)

    const result = await execute(teamMember, seeded)
    if (!result.ok) throw new Error(result.message)
    expect(result.result.status).toBe("needs_admin_setup")
    expect(result.result.action?.surface).toBe("openwork_organization_connections")
    expect(result.result.mcpRequirements?.map((requirement) => requirement.serverName)).toEqual(["alpha", "slack"])
  })

  test("per-member plugin MCP requirement blocks skill execute with secure Your Connections URL", async () => {
    const owner = await seedMember()
    const seeded = await seedCapability({
      owner,
      objectType: "skill",
      title: "Slack Renewal Playbook",
      rawSourceText: "# Slack Renewal Playbook",
    })
    const providerUrl = "https://slack.example.test/mcp?token=provider-secret"
    const mcpConfigObjectId = await addMcpRequirement({
      owner,
      pluginId: seeded.pluginId,
      title: "Slack MCP",
      servers: { slack: { url: providerUrl } },
    })
    const connectionId = await seedExternalConnection({
      owner,
      name: "Shared Slack",
      url: providerUrl,
      credentialMode: "per_member",
      authType: "oauth",
    })
    await bindPluginMcpRequirement({ owner, pluginId: seeded.pluginId, configObjectId: mcpConfigObjectId, serverName: "slack", connectionId })

    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: owner.organizationId,
      member: owner.member,
      query: "slack renewal",
      limit: 5,
      enabled: true,
    })
    const match = matches.find((candidate) => candidate.name === seeded.name)
    const requirement = match?.mcpRequirements?.[0]
    expect(match?.status).toBe("needs_connection")
    expect(requirement?.state).toBe("needs_connection")
    expect(requirement?.connectionId).toBe(connectionId)
    expectYourConnectionsUrl(requirement?.action.url, connectionId)
    const requirementJson = JSON.stringify(match?.mcpRequirements)
    expect(requirementJson).not.toContain("provider-secret")
    expect(requirementJson).not.toContain("slack.example.test")

    const result = await execute(owner, seeded)
    if (!result.ok) throw new Error(result.message)
    expect(result.result.status).toBe("needs_connection")
    expect(result.result.content).toBeUndefined()
    expectYourConnectionsUrl(result.result.action?.url, connectionId)
    const resultJson = JSON.stringify(result.result)
    expect(resultJson).not.toContain("provider-secret")
    expect(resultJson).not.toContain("slack.example.test")
  })

  test("per-member plugin MCP requirement allows assigned skill once the member connected", async () => {
    const owner = await seedMember()
    const seeded = await seedCapability({
      owner,
      objectType: "skill",
      title: "Connected Slack Playbook",
      rawSourceText: "# Connected Slack Playbook",
    })
    const mcpConfigObjectId = await addMcpRequirement({
      owner,
      pluginId: seeded.pluginId,
      title: "Connected Slack MCP",
      servers: { slack: { url: "https://connected-slack.example.test/mcp" } },
    })
    const connectionId = await seedExternalConnection({ owner, name: "Connected Slack", url: "https://connected-slack.example.test/mcp" })
    await bindPluginMcpRequirement({ owner, pluginId: seeded.pluginId, configObjectId: mcpConfigObjectId, serverName: "slack", connectionId })
    await connectMemberToConnection({ member: owner, connectionId })

    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: owner.organizationId,
      member: owner.member,
      query: "connected slack",
      limit: 5,
      enabled: true,
    })
    const match = matches.find((candidate) => candidate.name === seeded.name)
    expect(match?.status).toBe("ready")
    expect(match?.mcpRequirements?.[0]?.state).toBe("ready")

    const result = await execute(owner, seeded)
    if (!result.ok) throw new Error(result.message)
    expect(result.result).toMatchObject({
      kind: "skill",
      name: "Connected Slack Playbook",
      content: "# Connected Slack Playbook",
    })
    expect(result.result.mcpRequirements).toBeUndefined()
  })

  test("shared plugin MCP requirement allows skill execute without member credential", async () => {
    const owner = await seedMember()
    const seeded = await seedCapability({
      owner,
      objectType: "skill",
      title: "Shared Slack Playbook",
      rawSourceText: "# Shared Slack Playbook",
    })
    const mcpConfigObjectId = await addMcpRequirement({
      owner,
      pluginId: seeded.pluginId,
      title: "Shared Slack MCP",
      servers: { slack: { url: "https://shared-slack.example.test/mcp" } },
    })
    const connectionId = await seedExternalConnection({
      owner,
      name: "Org Slack",
      url: "https://shared-slack.example.test/mcp",
      authType: "none",
      credentialMode: "shared",
      connected: true,
    })
    await bindPluginMcpRequirement({ owner, pluginId: seeded.pluginId, configObjectId: mcpConfigObjectId, serverName: "slack", connectionId })

    const result = await execute(owner, seeded)
    if (!result.ok) throw new Error(result.message)
    expect(result.result.content).toBe("# Shared Slack Playbook")
  })

  test("two plugins sharing Slack keep distinct requirement provenance", async () => {
    const owner = await seedMember()
    const connectionId = await seedExternalConnection({
      owner,
      name: "Shared Slack",
      url: "https://shared-provenance-slack.example.test/mcp",
      authType: "none",
      credentialMode: "shared",
      connected: true,
    })
    const sales = await seedCapability({
      owner,
      pluginName: "Sales Slack Plugin",
      objectType: "skill",
      title: "Sales Slack Playbook",
      rawSourceText: "# Sales Slack Playbook",
    })
    const support = await seedCapability({
      owner,
      pluginName: "Support Slack Plugin",
      objectType: "skill",
      title: "Support Slack Playbook",
      rawSourceText: "# Support Slack Playbook",
    })
    const salesMcpId = await addMcpRequirement({
      owner,
      pluginId: sales.pluginId,
      title: "Sales Slack MCP",
      servers: { slack: { url: "https://shared-provenance-slack.example.test/mcp" } },
    })
    const supportMcpId = await addMcpRequirement({
      owner,
      pluginId: support.pluginId,
      title: "Support Slack MCP",
      servers: { slack: { url: "https://shared-provenance-slack.example.test/mcp" } },
    })
    await bindPluginMcpRequirement({ owner, pluginId: sales.pluginId, configObjectId: salesMcpId, serverName: "slack", connectionId })
    await bindPluginMcpRequirement({ owner, pluginId: support.pluginId, configObjectId: supportMcpId, serverName: "slack", connectionId })

    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: owner.organizationId,
      member: owner.member,
      query: "slack playbook",
      limit: 10,
      enabled: true,
    })
    const salesMatch = matches.find((candidate) => candidate.name === sales.name)
    const supportMatch = matches.find((candidate) => candidate.name === support.name)
    expect(salesMatch?.mcpRequirements?.[0]).toMatchObject({ pluginName: "Sales Slack Plugin", connectionId })
    expect(supportMatch?.mcpRequirements?.[0]).toMatchObject({ pluginName: "Support Slack Plugin", connectionId })
  })

  test("two plugins sharing one MCP config object keep plugin-scoped provenance", async () => {
    const owner = await seedMember()
    const connectionId = await seedExternalConnection({
      owner,
      name: "Shared Config Slack",
      url: "https://shared-config-provenance-slack.example.test/mcp",
      authType: "none",
      credentialMode: "shared",
      connected: true,
    })
    const sales = await seedCapability({
      owner,
      pluginName: "Sales Shared Config Plugin",
      objectType: "skill",
      title: "Sales Shared Config Playbook",
      rawSourceText: "# Sales Shared Config Playbook",
    })
    const support = await seedCapability({
      owner,
      pluginName: "Support Shared Config Plugin",
      objectType: "skill",
      title: "Support Shared Config Playbook",
      rawSourceText: "# Support Shared Config Playbook",
    })
    const sharedMcpId = await addMcpRequirement({
      owner,
      pluginId: sales.pluginId,
      title: "Shared Config Slack MCP",
      servers: { slack: { url: "https://shared-config-provenance-slack.example.test/mcp" } },
    })
    await db.insert(PluginConfigObjectTable).values({
      id: createDenTypeId("pluginConfigObject"),
      organizationId: owner.organizationId,
      pluginId: support.pluginId,
      configObjectId: sharedMcpId,
      membershipSource: "manual",
      connectorMappingId: null,
      createdByOrgMembershipId: owner.memberId,
      removedAt: null,
    })
    await bindPluginMcpRequirement({ owner, pluginId: sales.pluginId, configObjectId: sharedMcpId, serverName: "slack", connectionId })
    await bindPluginMcpRequirement({ owner, pluginId: support.pluginId, configObjectId: sharedMcpId, serverName: "slack", connectionId })

    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: owner.organizationId,
      member: owner.member,
      query: "shared config playbook",
      limit: 10,
      enabled: true,
    })
    const salesMatch = matches.find((candidate) => candidate.name === sales.name)
    const supportMatch = matches.find((candidate) => candidate.name === support.name)
    expect(salesMatch?.mcpRequirements?.[0]).toMatchObject({ configObjectId: sharedMcpId, pluginName: "Sales Shared Config Plugin", connectionId })
    expect(supportMatch?.mcpRequirements?.[0]).toMatchObject({ configObjectId: sharedMcpId, pluginName: "Support Shared Config Plugin", connectionId })
  })

  test("plugin requirement status does not leak unusable connection metadata", async () => {
    const owner = await seedMember()
    const connectionId = await seedExternalConnection({
      owner,
      grant: false,
      name: "Narrow Slack Secret Name",
      url: "https://narrow-slack.example.test/mcp",
    })
    const seeded = await seedCapability({
      owner,
      objectType: "skill",
      title: "Narrow Slack Playbook",
      rawSourceText: "# Narrow Slack Playbook",
    })
    const mcpConfigObjectId = await addMcpRequirement({
      owner,
      pluginId: seeded.pluginId,
      title: "Narrow Slack MCP",
      servers: { slack: { url: "https://narrow-slack.example.test/mcp" } },
    })
    await bindPluginMcpRequirement({ owner, pluginId: seeded.pluginId, configObjectId: mcpConfigObjectId, serverName: "slack", connectionId })

    const matches = await marketplaceCapabilities.searchMarketplaceCapabilities({
      organizationId: owner.organizationId,
      member: owner.member,
      query: "narrow slack",
      limit: 5,
      enabled: true,
    })
    const requirement = matches.find((candidate) => candidate.name === seeded.name)?.mcpRequirements?.[0]
    expect(requirement?.state).toBe("needs_admin_setup")
    expect(requirement?.connectionId).toBeUndefined()
    expect(requirement?.connectionName).toBeUndefined()
    expect(requirement?.credentialMode).toBeUndefined()
    expect(JSON.stringify(requirement)).not.toContain("Narrow Slack Secret Name")
  })

  test("orphan and stale sourced MCP grants are inert while direct and valid sourced grants still work", async () => {
    const owner = await seedMember()
    const directConnectionId = await seedExternalConnection({
      owner,
      name: "Direct Calendar",
      url: "https://direct-calendar.example.test/mcp",
      grant: true,
    })
    const validConnectionId = await seedExternalConnection({
      owner,
      name: "Valid Sourced Slack",
      url: "https://valid-sourced-slack.example.test/mcp",
      grant: false,
    })
    const staleConnectionId = await seedExternalConnection({
      owner,
      name: "Stale Sourced Slack",
      url: "https://old-sourced-slack.example.test/mcp",
      grant: false,
    })
    const orphanConnectionId = await seedExternalConnection({
      owner,
      name: "Orphan Sourced Slack",
      url: "https://orphan-sourced-slack.example.test/mcp",
      grant: false,
    })
    const validSkill = await seedCapability({
      owner,
      objectType: "skill",
      title: "Valid Sourced Playbook",
      rawSourceText: "# Valid Sourced Playbook",
    })
    const staleSkill = await seedCapability({
      owner,
      objectType: "skill",
      title: "Stale Sourced Playbook",
      rawSourceText: "# Stale Sourced Playbook",
    })
    const validMcpConfigObjectId = await addMcpRequirement({
      owner,
      pluginId: validSkill.pluginId,
      title: "Valid Sourced Slack MCP",
      servers: { slack: { url: "https://valid-sourced-slack.example.test/mcp" } },
    })
    const staleMcpConfigObjectId = await addMcpRequirement({
      owner,
      pluginId: staleSkill.pluginId,
      title: "Stale Sourced Slack MCP",
      servers: { slack: { url: "https://new-sourced-slack.example.test/mcp" } },
    })
    const validBindingId = await bindPluginMcpRequirement({ owner, pluginId: validSkill.pluginId, configObjectId: validMcpConfigObjectId, serverName: "slack", connectionId: validConnectionId })
    const staleBindingId = await bindPluginMcpRequirement({ owner, pluginId: staleSkill.pluginId, configObjectId: staleMcpConfigObjectId, serverName: "slack", connectionId: staleConnectionId })
    const orphanBindingId = createDenTypeId("pluginMcpRequirementBinding")
    await db.insert(ExternalMcpConnectionAccessGrantTable).values([
      {
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: owner.organizationId,
        externalMcpConnectionId: validConnectionId,
        pluginMcpRequirementBindingId: validBindingId,
        sourceKey: validBindingId,
        orgMembershipId: null,
        teamId: null,
        orgWide: true,
        createdByOrgMembershipId: owner.memberId,
      },
      {
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: owner.organizationId,
        externalMcpConnectionId: staleConnectionId,
        pluginMcpRequirementBindingId: staleBindingId,
        sourceKey: staleBindingId,
        orgMembershipId: null,
        teamId: null,
        orgWide: true,
        createdByOrgMembershipId: owner.memberId,
      },
      {
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: owner.organizationId,
        externalMcpConnectionId: orphanConnectionId,
        pluginMcpRequirementBindingId: orphanBindingId,
        sourceKey: orphanBindingId,
        orgMembershipId: null,
        teamId: null,
        orgWide: true,
        createdByOrgMembershipId: owner.memberId,
      },
    ])

    const { listUsableExternalMcpConnections } = await import("../src/capability-sources/external-mcp-connections.js")
    const usableIds = (await listUsableExternalMcpConnections({ organizationId: owner.organizationId, orgMembershipId: owner.memberId, teamIds: [] })).map((connection) => connection.id)
    expect(usableIds).toContain(directConnectionId)
    expect(usableIds).toContain(validConnectionId)
    expect(usableIds).not.toContain(staleConnectionId)
    expect(usableIds).not.toContain(orphanConnectionId)

    for (const connectionId of [directConnectionId, validConnectionId]) {
      const result = await externalCapabilities.executeExternalCapability({
        organizationId: owner.organizationId,
        member: owner.member,
        connectionId,
        toolName: "*",
        args: {},
        redirectUriBase: "http://127.0.0.1:8790",
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected connection-status execution result")
      expect(result.error).not.toBe("forbidden")
    }

    for (const connectionId of [staleConnectionId, orphanConnectionId]) {
      const result = await externalCapabilities.executeExternalCapability({
        organizationId: owner.organizationId,
        member: owner.member,
        connectionId,
        toolName: "*",
        args: {},
        redirectUriBase: "http://127.0.0.1:8790",
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected forbidden execution result")
      expect(result.error).toBe("forbidden")
    }

  })

  test("sourced MCP grants must target their binding connection even when URLs match", async () => {
    const owner = await seedMember()
    const sameUrl = "https://same-url-sourced-slack.example.test/mcp"
    const staleConnectionId = await seedExternalConnection({
      owner,
      name: "Stale Same URL Slack A",
      url: sameUrl,
      grant: false,
    })
    const boundConnectionId = await seedExternalConnection({
      owner,
      name: "Bound Same URL Slack B",
      url: sameUrl,
      grant: false,
    })
    const skill = await seedCapability({
      owner,
      objectType: "skill",
      title: "Same URL Sourced Playbook",
      rawSourceText: "# Same URL Sourced Playbook",
    })
    const mcpConfigObjectId = await addMcpRequirement({
      owner,
      pluginId: skill.pluginId,
      title: "Same URL Sourced Slack MCP",
      servers: { slack: { url: sameUrl } },
    })
    const bindingId = await bindPluginMcpRequirement({
      owner,
      pluginId: skill.pluginId,
      configObjectId: mcpConfigObjectId,
      serverName: "slack",
      connectionId: boundConnectionId,
    })
    const insertSourcedGrant = async (connectionId: DenTypeId<"externalMcpConnection">) => {
      await db.insert(ExternalMcpConnectionAccessGrantTable).values({
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: owner.organizationId,
        externalMcpConnectionId: connectionId,
        pluginMcpRequirementBindingId: bindingId,
        sourceKey: bindingId,
        orgMembershipId: null,
        teamId: null,
        orgWide: true,
        createdByOrgMembershipId: owner.memberId,
      })
    }
    const usableIds = async () => {
      const { listUsableExternalMcpConnections } = await import("../src/capability-sources/external-mcp-connections.js")
      return (await listUsableExternalMcpConnections({ organizationId: owner.organizationId, orgMembershipId: owner.memberId, teamIds: [] })).map((connection) => connection.id)
    }
    const execute = (connectionId: DenTypeId<"externalMcpConnection">) => externalCapabilities.executeExternalCapability({
      organizationId: owner.organizationId,
      member: owner.member,
      connectionId,
      toolName: "*",
      args: {},
      redirectUriBase: "http://127.0.0.1:8790",
    })

    await insertSourcedGrant(staleConnectionId)
    expect(await usableIds()).not.toContain(staleConnectionId)
    expect(await usableIds()).not.toContain(boundConnectionId)
    const staleBeforeOwnGrant = await execute(staleConnectionId)
    expect(staleBeforeOwnGrant.ok).toBe(false)
    if (staleBeforeOwnGrant.ok) throw new Error("expected stale same-URL connection to be forbidden")
    expect(staleBeforeOwnGrant.error).toBe("forbidden")
    const boundBeforeOwnGrant = await execute(boundConnectionId)
    expect(boundBeforeOwnGrant.ok).toBe(false)
    if (boundBeforeOwnGrant.ok) throw new Error("expected bound connection to require its own sourced grant")
    expect(boundBeforeOwnGrant.error).toBe("forbidden")

    await insertSourcedGrant(boundConnectionId)
    const usableAfterOwnGrant = await usableIds()
    expect(usableAfterOwnGrant).not.toContain(staleConnectionId)
    expect(usableAfterOwnGrant).toContain(boundConnectionId)
    const staleAfterOwnGrant = await execute(staleConnectionId)
    expect(staleAfterOwnGrant.ok).toBe(false)
    if (staleAfterOwnGrant.ok) throw new Error("expected stale same-URL connection to stay forbidden")
    expect(staleAfterOwnGrant.error).toBe("forbidden")
    const boundAfterOwnGrant = await execute(boundConnectionId)
    expect(boundAfterOwnGrant.ok).toBe(false)
    if (boundAfterOwnGrant.ok) throw new Error("expected connection-status execution result")
    expect(boundAfterOwnGrant.error).not.toBe("forbidden")
  })

  test("existing external-connection capabilities still surface their needs_connection pseudo-match", async () => {
    const owner = await seedMember()
    const connectionId = createDenTypeId("externalMcpConnection")
    await db.insert(ExternalMcpConnectionTable).values({
      id: connectionId,
      organizationId: owner.organizationId,
      name: "Calendar Bridge",
      url: "https://calendar.example.test/mcp",
      authType: "oauth",
      credentialMode: "per_member",
      createdByOrgMembershipId: owner.memberId,
    })
    await db.insert(ExternalMcpConnectionAccessGrantTable).values({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: owner.organizationId,
      externalMcpConnectionId: connectionId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      createdByOrgMembershipId: owner.memberId,
    })

    const matches = await externalCapabilities.searchExternalCapabilities({
      organizationId: owner.organizationId,
      member: owner.member,
      query: "calendar",
      redirectUriBase: "http://127.0.0.1:8790",
      limit: 5,
    })
    expect(matches).toHaveLength(1)
    expect(matches[0]?.name).toBe(externalCapabilities.buildExternalCapabilityName(connectionId, "*"))
    expect(matches[0]?.method).toBe("MCP")
    expect(matches[0]?.status).toBe("needs_connection")
    expectYourConnectionsUrl(matches[0]?.connectionStatus?.action.url, connectionId)

    const executeResult = await externalCapabilities.executeExternalCapability({
      organizationId: owner.organizationId,
      member: owner.member,
      connectionId,
      toolName: "*",
      args: {},
      redirectUriBase: "http://127.0.0.1:8790",
    })
    expect(executeResult.ok).toBe(false)
    if (executeResult.ok) throw new Error("expected connection status execute to fail")
    expect(executeResult.error).toBe("needs_connection")
    expectYourConnectionsUrl(executeResult.connectionStatus?.action.url, connectionId)
  })
})
