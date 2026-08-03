import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { inArray } from "@openwork-ee/den-db/drizzle"
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
import type { McpMemberIdentity } from "../src/mcp/external-capabilities.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_grantnative"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type Db = typeof import("../src/db.js").db
type MarketplaceCapabilities = typeof import("../src/mcp/marketplace-capabilities.js")

type SeededMember = {
  member: McpMemberIdentity
  memberId: DenTypeId<"member">
  organizationId: DenTypeId<"organization">
  userId: DenTypeId<"user">
}

type SeededCapability = {
  configObjectId: DenTypeId<"configObject">
  marketplaceId: DenTypeId<"marketplace"> | null
  name: string
  pluginId: DenTypeId<"plugin">
}

type PluginGrant = {
  orgMembershipId?: DenTypeId<"member">
  role: "viewer" | "editor" | "manager"
  teamId?: DenTypeId<"team">
}

let db: Db
let marketplaceCapabilities: MarketplaceCapabilities

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

async function seedMember(input: {
  organization?: SeededMember
  role?: string
  teamIds?: DenTypeId<"team">[]
} = {}): Promise<SeededMember> {
  const organizationId = input.organization?.organizationId ?? createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  createdUserIds.push(userId)

  await db.insert(AuthUserTable).values({
    id: userId,
    name: "Grant Native Tester",
    email: `${userId}@grant-native.test.local`,
  })
  if (!input.organization) {
    createdOrganizationIds.push(organizationId)
    await db.insert(OrganizationTable).values({
      id: organizationId,
      name: "Grant Native Test Org",
      slug: `grant-native-${organizationId}`,
      metadata: null,
    })
  }
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
    member: { orgMembershipId: memberId, teamIds: input.teamIds ?? [] },
  }
}

async function seedTeam(owner: SeededMember): Promise<DenTypeId<"team">> {
  const teamId = createDenTypeId("team")
  await db.insert(TeamTable).values({
    id: teamId,
    organizationId: owner.organizationId,
    name: `Team ${teamId}`,
  })
  return teamId
}

async function seedCapability(input: {
  marketplace?: boolean
  marketplaceGrant?: boolean
  owner: SeededMember
  pluginGrants?: PluginGrant[]
  pluginName?: string
  rawSourceText: string
  title: string
}): Promise<SeededCapability> {
  const now = new Date()
  const marketplaceId = input.marketplace ? createDenTypeId("marketplace") : null
  const pluginId = createDenTypeId("plugin")
  const configObjectId = createDenTypeId("configObject")

  if (marketplaceId) {
    await db.insert(MarketplaceTable).values({
      id: marketplaceId,
      organizationId: input.owner.organizationId,
      name: "Team Marketplace",
      description: "Curated marketplace for grant-native tests",
      logoUrl: null,
      status: "active",
      createdByOrgMembershipId: input.owner.memberId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
  }
  await db.insert(PluginTable).values({
    id: pluginId,
    organizationId: input.owner.organizationId,
    name: input.pluginName ?? "Grant Native Plugin",
    description: "Grant-native capability test plugin",
    status: "active",
    createdByOrgMembershipId: input.owner.memberId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  await db.insert(ConfigObjectTable).values({
    id: configObjectId,
    organizationId: input.owner.organizationId,
    objectType: "skill",
    sourceMode: "cloud",
    title: input.title,
    description: `Use ${input.title}`,
    searchText: `${input.title}\n${input.rawSourceText}`,
    currentFileName: "SKILL.md",
    currentFileExtension: ".md",
    currentRelativePath: `skills/${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/SKILL.md`,
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
    pluginId,
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
    normalizedPayloadJson: null,
    rawSourceText: input.rawSourceText,
    schemaVersion: null,
    createdVia: "cloud",
    createdByOrgMembershipId: input.owner.memberId,
    connectorSyncEventId: null,
    sourceRevisionRef: null,
    isDeletedVersion: false,
    createdAt: now,
  })

  if (marketplaceId) {
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
  }
  if (marketplaceId && input.marketplaceGrant) {
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
  for (const grant of input.pluginGrants ?? []) {
    await db.insert(PluginAccessGrantTable).values({
      id: createDenTypeId("pluginAccessGrant"),
      organizationId: input.owner.organizationId,
      pluginId,
      orgMembershipId: grant.orgMembershipId ?? null,
      teamId: grant.teamId ?? null,
      orgWide: false,
      role: grant.role,
      createdByOrgMembershipId: input.owner.memberId,
      createdAt: now,
      removedAt: null,
    })
  }

  return {
    configObjectId,
    marketplaceId,
    pluginId,
    name: marketplaceCapabilities.buildMarketplaceCapabilityName(pluginId, configObjectId),
  }
}

async function search(member: SeededMember, query: string) {
  return marketplaceCapabilities.searchMarketplaceCapabilities({
    organizationId: member.organizationId,
    member: member.member,
    query,
    limit: 20,
    enabled: true,
  })
}

async function execute(member: SeededMember, capability: SeededCapability) {
  return marketplaceCapabilities.executeMarketplaceCapability({
    organizationId: member.organizationId,
    member: member.member,
    pluginId: capability.pluginId,
    configObjectId: capability.configObjectId,
    enabled: true,
  })
}

describe("grant-native marketplace capabilities", () => {
  test("A1 creator grant makes a marketplace-free skill discoverable and executable", async () => {
    const creator = await seedMember()
    const rawSourceText = "---\nname: creator-ready\ndescription: Creator-ready skill\n---\n\n# Creator Ready"
    const capability = await seedCapability({
      owner: creator,
      title: "Creator Ready",
      rawSourceText,
      pluginGrants: [{ orgMembershipId: creator.memberId, role: "manager" }],
    })

    const matches = await search(creator, "creator ready")
    const match = matches.find((candidate) => candidate.name === capability.name)
    expect(match).toMatchObject({
      method: "PLUGIN",
      kind: "skill",
      plugin: "Grant Native Plugin",
      summary: "[Grant Native Plugin] Creator Ready: Use Creator Ready",
    })
    expect(match?.marketplace).toBeUndefined()

    const result = await execute(creator, capability)
    if (!result.ok) throw new Error(result.message)
    expect(result.result).toMatchObject({
      kind: "skill",
      plugin: "Grant Native Plugin",
      marketplace: null,
      name: "Creator Ready",
      content: rawSourceText,
    })

    const descriptors = await marketplaceCapabilities.listAccessibleMarketplaceSkillDescriptors({
      organizationId: creator.organizationId,
      member: creator.member,
      enabled: true,
    })
    const descriptor = descriptors.find((candidate) => candidate.capability === capability.name)
    expect(descriptor).toMatchObject({
      title: "Creator Ready",
      pluginName: "Grant Native Plugin",
      capability: capability.name,
    })
    expect(descriptor?.marketplaceName).toBeUndefined()

    const references = await marketplaceCapabilities.listAccessibleMarketplaceCapabilityReferences({
      organizationId: creator.organizationId,
      member: creator.member,
      enabled: true,
    })
    expect(references).toContainEqual({
      configObjectId: capability.configObjectId,
      marketplaceId: null,
      objectType: "skill",
      pluginId: capability.pluginId,
    })
  })

  test("A2 team grant permits team members and denies non-members", async () => {
    const owner = await seedMember()
    const teamId = await seedTeam(owner)
    const teamMember = await seedMember({ organization: owner, teamIds: [teamId] })
    const nonMember = await seedMember({ organization: owner })
    const capability = await seedCapability({
      owner,
      title: "Team Shared Skill",
      rawSourceText: "# Team Shared Skill",
      pluginGrants: [{ teamId, role: "viewer" }],
    })

    expect((await search(teamMember, "team shared")).some((match) => match.name === capability.name)).toBe(true)
    const teamResult = await execute(teamMember, capability)
    expect(teamResult.ok).toBe(true)
    if (!teamResult.ok) throw new Error(teamResult.message)
    expect(teamResult.result.marketplace).toBeNull()

    expect((await search(nonMember, "team shared")).some((match) => match.name === capability.name)).toBe(false)
    expect(await execute(nonMember, capability)).toMatchObject({ ok: false, error: "forbidden" })
  })

  test("A3 a marketplace-free skill with no grants stays inaccessible", async () => {
    const owner = await seedMember()
    const capability = await seedCapability({
      owner,
      title: "Nobody Skill",
      rawSourceText: "# Nobody Skill",
    })

    expect((await search(owner, "nobody skill")).some((match) => match.name === capability.name)).toBe(false)
    expect(await execute(owner, capability)).toMatchObject({ ok: false, error: "forbidden" })
  })

  test("A4 marketplace-attached capabilities keep their marketplace payload", async () => {
    const owner = await seedMember()
    const capability = await seedCapability({
      owner,
      title: "Marketplace Skill",
      rawSourceText: "# Marketplace Skill",
      marketplace: true,
      marketplaceGrant: true,
    })

    const matches = await search(owner, "marketplace skill")
    const match = matches.find((candidate) => candidate.name === capability.name)
    expect(match?.marketplace).toBe("Team Marketplace")
    expect(match?.summary).toBe("[Team Marketplace / Grant Native Plugin] Marketplace Skill: Use Marketplace Skill")

    const result = await execute(owner, capability)
    if (!result.ok) throw new Error(result.message)
    expect(result.result.marketplace).toBe("Team Marketplace")

    const references = await marketplaceCapabilities.listAccessibleMarketplaceCapabilityReferences({
      organizationId: owner.organizationId,
      member: owner.member,
      enabled: true,
    })
    expect(references).toContainEqual({
      configObjectId: capability.configObjectId,
      marketplaceId: capability.marketplaceId,
      objectType: "skill",
      pluginId: capability.pluginId,
    })
  })

  test("A5 marketplace membership wins over a direct grant without duplicate search matches", async () => {
    const owner = await seedMember()
    const capability = await seedCapability({
      owner,
      title: "Catalog And Direct",
      rawSourceText: "# Catalog And Direct",
      marketplace: true,
      pluginGrants: [{ orgMembershipId: owner.memberId, role: "manager" }],
    })

    const matches = (await search(owner, "catalog direct"))
      .filter((candidate) => candidate.name === capability.name)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.marketplace).toBe("Team Marketplace")

    const result = await execute(owner, capability)
    if (!result.ok) throw new Error(result.message)
    expect(result.result.marketplace).toBe("Team Marketplace")
  })
})
