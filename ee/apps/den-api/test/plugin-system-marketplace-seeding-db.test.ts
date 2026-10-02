import { afterAll, beforeAll, expect, test } from "bun:test"
import {
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
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "marketplace-seeding-test-key-1234567890"
process.env.BETTER_AUTH_SECRET ??= "marketplace-seeding-test-secret-123456"
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"

let db: typeof import("../src/db.js").db
let eq: typeof import("@openwork-ee/den-db/drizzle").eq
let store: typeof import("../src/routes/org/plugin-system/store.js")

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const legacyOrganizationIds = [createDenTypeId("organization"), createDenTypeId("organization")]

async function clearOrganizationRows(orgId: typeof organizationId) {
  await db.delete(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.organizationId, orgId))
  await db.delete(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, orgId))
  await db.delete(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, orgId))
  await db.delete(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, orgId))
  await db.delete(MarketplaceTable).where(eq(MarketplaceTable.organizationId, orgId))
  await db.delete(PluginTable).where(eq(PluginTable.organizationId, orgId))
  await db.delete(MemberTable).where(eq(MemberTable.organizationId, orgId))
  await db.delete(OrganizationTable).where(eq(OrganizationTable.id, orgId))
}

async function clearSeededRows() {
  for (const orgId of [organizationId, ...legacyOrganizationIds]) await clearOrganizationRows(orgId)
}

beforeAll(async () => {
  const [dbModule, drizzleModule, storeModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/routes/org/plugin-system/store.js"),
  ])
  db = dbModule.db
  eq = drizzleModule.eq
  store = storeModule
  await clearSeededRows()
})

afterAll(async () => {
  if (db) await clearSeededRows()
})

function ownerContext(orgId = organizationId, orgMemberId = memberId): PluginArchActorContext {
  const now = new Date("2026-07-22T00:00:00.000Z")
  return {
    memberTeams: [],
    organizationContext: {
      organization: {
        id: orgId,
        name: "Marketplace Seeding Test",
        slug: "marketplace-seeding-test",
        logo: null,
        allowedEmailDomains: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: orgMemberId,
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
    },
    session: { createdAt: now },
  }
}

test("concurrent marketplace lists seed one complete set of defaults", async () => {
  await db.insert(OrganizationTable).values({
    id: organizationId,
    name: "Marketplace Seeding Test",
    slug: "marketplace-seeding-test",
  })
  await db.insert(MemberTable).values({
    id: memberId,
    organizationId,
    role: "owner",
    userId,
  })

  const context = ownerContext()
  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.listMarketplaces({ context })),
  )

  for (const result of results) {
    expect(result.items.map((item) => item.name)).toEqual(["OpenWork Marketplace"])
  }

  const [marketplaces, plugins, memberships, marketplaceGrants, pluginGrants] = await Promise.all([
    db.select().from(MarketplaceTable).where(eq(MarketplaceTable.organizationId, organizationId)),
    db.select().from(PluginTable).where(eq(PluginTable.organizationId, organizationId)),
    db.select().from(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, organizationId)),
    db.select().from(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, organizationId)),
    db.select().from(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, organizationId)),
  ])

  expect(marketplaces).toHaveLength(1)
  expect(new Set(marketplaces.map((marketplace) => marketplace.name)).size).toBe(marketplaces.length)
  expect(new Set(plugins.map((plugin) => `${plugin.name}\n${plugin.description ?? ""}`)).size).toBe(plugins.length)
  expect(new Set(memberships.map((membership) => `${membership.marketplaceId}:${membership.pluginId}`)).size).toBe(memberships.length)
  expect(memberships).toHaveLength(plugins.length)
  expect(marketplaceGrants).toHaveLength(marketplaces.length)
  expect(pluginGrants).toHaveLength(plugins.length)
  expect(plugins.some((plugin) => plugin.name === "Google Workspace")).toBe(false)
  const openWorkMarketplace = marketplaces.find((marketplace) => marketplace.name === "OpenWork Marketplace")
  expect(openWorkMarketplace).toBeDefined()
  const openWorkPluginIds = new Set(memberships
    .filter((membership) => membership.marketplaceId === openWorkMarketplace?.id)
    .map((membership) => membership.pluginId))
  expect(plugins.filter((plugin) => openWorkPluginIds.has(plugin.id)).map((plugin) => plugin.name).sort()).toEqual([
    "Computer Use",
    "Ollama",
    "OpenAI Image Gen",
    "OpenWork Browser",
  ])

  await store.listMarketplaces({ context })
  const repeatedMemberships = await db.select().from(MarketplacePluginTable)
    .where(eq(MarketplacePluginTable.organizationId, organizationId))
  expect(repeatedMemberships).toHaveLength(memberships.length)
})

/** An org seeded by an earlier Den build: the starter marketplace and its name-only plugins. */
async function seedLegacyStarterCatalog(orgId: typeof organizationId, pluginNames: string[]) {
  const orgMemberId = createDenTypeId("member")
  await db.insert(OrganizationTable).values({ id: orgId, name: "Legacy Starter", slug: `legacy-starter-${orgId.slice(-8).toLowerCase()}` })
  await db.insert(MemberTable).values({ id: orgMemberId, organizationId: orgId, role: "owner", userId: createDenTypeId("user") })
  const marketplaceId = createDenTypeId("marketplace")
  await db.insert(MarketplaceTable).values({
    createdByOrgMembershipId: orgMemberId,
    description: "Starter marketplace for Claude/Anthropic-compatible plugin repos. Example source: https://github.com/anthropics/knowledge-work-plugins.",
    id: marketplaceId,
    logoUrl: "https://cdn.simpleicons.org/anthropic",
    name: "Anthropic-Compatible Plugins",
    organizationId: orgId,
  })
  const pluginIds = new Map<string, ReturnType<typeof createDenTypeId<"plugin">>>()
  for (const name of pluginNames) {
    const pluginId = createDenTypeId("plugin")
    pluginIds.set(name, pluginId)
    await db.insert(PluginTable).values({ createdByOrgMembershipId: orgMemberId, description: `${name} starter`, id: pluginId, name, organizationId: orgId })
    await db.insert(MarketplacePluginTable).values({ id: createDenTypeId("marketplacePlugin"), marketplaceId, membershipSource: "system", organizationId: orgId, pluginId })
  }
  return { context: ownerContext(orgId, orgMemberId), marketplaceId, pluginIds }
}

test("empty starter plugins and their marketplace are retired from orgs seeded earlier", async () => {
  const orgId = legacyOrganizationIds[0]!
  const legacy = await seedLegacyStarterCatalog(orgId, ["PDF Viewer", "Sales"])

  const result = await store.listMarketplaces({ context: legacy.context, status: "active" })
  expect(result.items.map((item) => item.name)).toEqual(["OpenWork Marketplace"])

  const plugins = await db.select().from(PluginTable).where(eq(PluginTable.organizationId, orgId))
  const starterPlugins = plugins.filter((plugin) => plugin.name === "PDF Viewer" || plugin.name === "Sales")
  expect(starterPlugins.map((plugin) => [plugin.name, plugin.status, plugin.deletedAt !== null]).sort()).toEqual([
    ["PDF Viewer", "deleted", true],
    ["Sales", "deleted", true],
  ])
  const [starterMarketplace] = await db.select().from(MarketplaceTable).where(eq(MarketplaceTable.id, legacy.marketplaceId))
  expect(starterMarketplace?.status).toBe("deleted")
})

test("starter plugins that were imported or filled in are kept", async () => {
  const orgId = legacyOrganizationIds[1]!
  const legacy = await seedLegacyStarterCatalog(orgId, ["PDF Viewer", "Sales", "Legal"])
  await db.update(PluginTable)
    .set({ sourceFormat: "claude-plugin", sourceRepositoryUrl: "https://github.com/anthropics/knowledge-work-plugins" })
    .where(eq(PluginTable.id, legacy.pluginIds.get("Sales")!))
  await db.insert(PluginConfigObjectTable).values({
    configObjectId: createDenTypeId("configObject"),
    id: createDenTypeId("pluginConfigObject"),
    organizationId: orgId,
    pluginId: legacy.pluginIds.get("Legal")!,
  })

  const result = await store.listMarketplaces({ context: legacy.context, status: "active" })
  expect(result.items.map((item) => item.name).sort()).toEqual(["Anthropic-Compatible Plugins", "OpenWork Marketplace"])

  const plugins = await db.select().from(PluginTable).where(eq(PluginTable.organizationId, orgId))
  const statusByName = Object.fromEntries(plugins.map((plugin) => [plugin.name, plugin.status]))
  expect(statusByName["PDF Viewer"]).toBe("deleted")
  expect(statusByName.Sales).toBe("active")
  expect(statusByName.Legal).toBe("active")

  const memberships = await db.select().from(MarketplacePluginTable).where(eq(MarketplacePluginTable.marketplaceId, legacy.marketplaceId))
  expect(memberships.filter((membership) => membership.removedAt === null)).toHaveLength(2)
})
