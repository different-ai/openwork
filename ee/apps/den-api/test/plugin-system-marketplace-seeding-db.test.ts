import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrganizationTable,
  PluginAccessGrantTable,
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

async function clearSeededRows() {
  await db.delete(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, organizationId))
  await db.delete(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, organizationId))
  await db.delete(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, organizationId))
  await db.delete(MarketplaceTable).where(eq(MarketplaceTable.organizationId, organizationId))
  await db.delete(PluginTable).where(eq(PluginTable.organizationId, organizationId))
  await db.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
  await db.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
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

function ownerContext(): PluginArchActorContext {
  const now = new Date("2026-07-22T00:00:00.000Z")
  return {
    memberTeams: [],
    organizationContext: {
      organization: {
        id: organizationId,
        name: "Marketplace Seeding Test",
        slug: "marketplace-seeding-test",
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
    expect(result.items.map((item) => item.name).sort()).toEqual([
      "Anthropic-Compatible Plugins",
      "OpenWork Marketplace",
    ])
  }

  const [marketplaces, plugins, memberships, marketplaceGrants, pluginGrants] = await Promise.all([
    db.select().from(MarketplaceTable).where(eq(MarketplaceTable.organizationId, organizationId)),
    db.select().from(PluginTable).where(eq(PluginTable.organizationId, organizationId)),
    db.select().from(MarketplacePluginTable).where(eq(MarketplacePluginTable.organizationId, organizationId)),
    db.select().from(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.organizationId, organizationId)),
    db.select().from(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.organizationId, organizationId)),
  ])

  expect(marketplaces).toHaveLength(2)
  expect(new Set(marketplaces.map((marketplace) => marketplace.name)).size).toBe(marketplaces.length)
  expect(new Set(plugins.map((plugin) => `${plugin.name}\n${plugin.description ?? ""}`)).size).toBe(plugins.length)
  expect(new Set(memberships.map((membership) => `${membership.marketplaceId}:${membership.pluginId}`)).size).toBe(memberships.length)
  expect(memberships).toHaveLength(plugins.length)
  expect(marketplaceGrants).toHaveLength(marketplaces.length)
  expect(pluginGrants).toHaveLength(plugins.length)

  await store.listMarketplaces({ context })
  const repeatedMemberships = await db.select().from(MarketplacePluginTable)
    .where(eq(MarketplacePluginTable.organizationId, organizationId))
  expect(repeatedMemberships).toHaveLength(memberships.length)
})
