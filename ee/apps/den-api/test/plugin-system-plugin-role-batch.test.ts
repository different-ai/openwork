import { expect, mock, test } from "bun:test"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
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

type PluginId = typeof PluginTable.$inferSelect.id
type PluginStatus = typeof PluginTable.$inferSelect.status

test("batched plugin roles and list access match per-plugin resolution", async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DB_MODE ??= "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "batch-roles-test-encryption-key-1234567890"
  process.env.BETTER_AUTH_SECRET ??= "batch-roles-test-secret-12345678901234567"
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"

  mock.restore()
  const database = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: database }))
  const { resolvePluginArchPluginRoles, resolvePluginArchResourceRole } = await import("../src/routes/org/plugin-system/access.js")
  const { listPlugins } = await import("../src/routes/org/plugin-system/store.js")

  const now = new Date()
  const organizationId = createDenTypeId("organization")
  const otherOrganizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const creatorId = createDenTypeId("member")
  const teamId = createDenTypeId("team")
  const visibleMarketplaceId = createDenTypeId("marketplace")
  const hiddenMarketplaceId = createDenTypeId("marketplace")
  const otherOrgMarketplaceId = createDenTypeId("marketplace")
  const plugins = {
    direct: createDenTypeId("plugin"),
    team: createDenTypeId("plugin"),
    orgWide: createDenTypeId("plugin"),
    removedGrant: createDenTypeId("plugin"),
    manager: createDenTypeId("plugin"),
    viaMarketplace: createDenTypeId("plugin"),
    hiddenMarketplace: createDenTypeId("plugin"),
    removedMembership: createDenTypeId("plugin"),
    otherOrgMarketplace: createDenTypeId("plugin"),
    directAndMarketplace: createDenTypeId("plugin"),
    none: createDenTypeId("plugin"),
    archivedOrgWide: createDenTypeId("plugin"),
  }
  const otherOrgPluginId = createDenTypeId("plugin")
  const organizationPluginIds: PluginId[] = Object.values(plugins)
  const allPluginIds: PluginId[] = [...organizationPluginIds, otherOrgPluginId]

  function actor(input: { isOwner: boolean; role: string }): PluginArchActorContext {
    return {
      memberTeams: [{ id: teamId, name: "Batch team", organizationId, createdAt: now, updatedAt: now }],
      organizationContext: {
        organization: {
          id: organizationId,
          name: "Batch Roles",
          slug: `batch-roles-${organizationId}`,
          logo: null,
          allowedEmailDomains: null,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        },
        currentMember: { id: memberId, userId, role: input.role, createdAt: now, joinedAt: now, isOwner: input.isOwner },
        invitations: [],
        members: [],
        roles: [],
        teams: [],
      },
      session: null,
    }
  }

  function grant(pluginId: PluginId, target: { orgMembershipId?: typeof memberId; teamId?: typeof teamId; orgWide?: true }, role: "viewer" | "editor" | "manager", removedAt: Date | null = null) {
    return {
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      pluginId,
      orgMembershipId: target.orgMembershipId ?? null,
      teamId: target.teamId ?? null,
      orgWide: target.orgWide ?? false,
      role,
      createdByOrgMembershipId: creatorId,
      removedAt,
    }
  }

  const cleanup = async () => {
    const organizations = [organizationId, otherOrganizationId]
    await database.delete(MarketplacePluginTable).where(inArray(MarketplacePluginTable.organizationId, organizations))
    await database.delete(MarketplaceAccessGrantTable).where(inArray(MarketplaceAccessGrantTable.organizationId, organizations))
    await database.delete(MarketplaceTable).where(inArray(MarketplaceTable.organizationId, organizations))
    await database.delete(PluginAccessGrantTable).where(inArray(PluginAccessGrantTable.organizationId, organizations))
    await database.delete(PluginTable).where(inArray(PluginTable.organizationId, organizations))
    await database.delete(MemberTable).where(inArray(MemberTable.organizationId, organizations))
    await database.delete(OrganizationTable).where(inArray(OrganizationTable.id, organizations))
    await database.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
  }

  try {
    await database.insert(AuthUserTable).values({ id: userId, name: "Batch Member", email: `${userId}@example.com`, emailVerified: true })
    await database.insert(OrganizationTable).values([
      { id: organizationId, name: "Batch Roles", slug: `batch-roles-${organizationId}` },
      { id: otherOrganizationId, name: "Batch Roles Other", slug: `batch-roles-${otherOrganizationId}` },
    ])
    await database.insert(MemberTable).values({ id: memberId, organizationId, userId, role: "member" })
    const statusFor = (id: PluginId): PluginStatus => id === plugins.archivedOrgWide ? "archived" : "active"
    await database.insert(PluginTable).values([
      ...organizationPluginIds.map((id) => ({
        id,
        organizationId,
        name: `Plugin ${id}`,
        status: statusFor(id),
        createdByOrgMembershipId: creatorId,
      })),
      { id: otherOrgPluginId, organizationId: otherOrganizationId, name: "Other org plugin", status: "active", createdByOrgMembershipId: creatorId },
    ])
    await database.insert(PluginAccessGrantTable).values([
      grant(plugins.direct, { orgMembershipId: memberId }, "viewer"),
      grant(plugins.team, { teamId }, "editor"),
      grant(plugins.orgWide, { orgWide: true }, "viewer"),
      grant(plugins.removedGrant, { orgMembershipId: memberId }, "editor", now),
      grant(plugins.manager, { orgMembershipId: memberId }, "manager"),
      grant(plugins.manager, { orgWide: true }, "viewer", now),
      grant(plugins.directAndMarketplace, { orgMembershipId: memberId }, "editor"),
      grant(plugins.archivedOrgWide, { orgWide: true }, "viewer"),
      { ...grant(otherOrgPluginId, { orgWide: true }, "viewer"), organizationId: otherOrganizationId },
    ])
    await database.insert(MarketplaceTable).values([
      { id: visibleMarketplaceId, organizationId, name: "Visible", status: "active", createdByOrgMembershipId: creatorId },
      { id: hiddenMarketplaceId, organizationId, name: "Hidden", status: "active", createdByOrgMembershipId: creatorId },
      { id: otherOrgMarketplaceId, organizationId: otherOrganizationId, name: "Other org", status: "active", createdByOrgMembershipId: creatorId },
    ])
    await database.insert(MarketplaceAccessGrantTable).values([
      { id: createDenTypeId("marketplaceAccessGrant"), organizationId, marketplaceId: visibleMarketplaceId, orgMembershipId: memberId, orgWide: false, role: "viewer", createdByOrgMembershipId: creatorId },
      { id: createDenTypeId("marketplaceAccessGrant"), organizationId: otherOrganizationId, marketplaceId: otherOrgMarketplaceId, orgWide: true, role: "viewer", createdByOrgMembershipId: creatorId },
    ])
    await database.insert(MarketplacePluginTable).values([
      { id: createDenTypeId("marketplacePlugin"), organizationId, marketplaceId: visibleMarketplaceId, pluginId: plugins.viaMarketplace, membershipSource: "manual", createdByOrgMembershipId: creatorId },
      { id: createDenTypeId("marketplacePlugin"), organizationId, marketplaceId: hiddenMarketplaceId, pluginId: plugins.hiddenMarketplace, membershipSource: "manual", createdByOrgMembershipId: creatorId },
      { id: createDenTypeId("marketplacePlugin"), organizationId, marketplaceId: visibleMarketplaceId, pluginId: plugins.removedMembership, membershipSource: "manual", createdByOrgMembershipId: creatorId, removedAt: now },
      { id: createDenTypeId("marketplacePlugin"), organizationId: otherOrganizationId, marketplaceId: otherOrgMarketplaceId, pluginId: plugins.otherOrgMarketplace, membershipSource: "manual", createdByOrgMembershipId: creatorId },
      { id: createDenTypeId("marketplacePlugin"), organizationId, marketplaceId: visibleMarketplaceId, pluginId: plugins.directAndMarketplace, membershipSource: "manual", createdByOrgMembershipId: creatorId },
    ])

    const member = actor({ isOwner: false, role: "member" })
    const admin = actor({ isOwner: false, role: "member,admin" })

    for (const context of [member, admin]) {
      const batched = await resolvePluginArchPluginRoles(context, allPluginIds)
      for (const pluginId of allPluginIds) {
        const single = await resolvePluginArchResourceRole({ context, resourceId: pluginId, resourceKind: "plugin" })
        expect({ pluginId, role: batched.get(pluginId) ?? null }).toEqual({ pluginId, role: single })
      }
    }

    const memberRoles = await resolvePluginArchPluginRoles(member, allPluginIds)
    expect(Object.fromEntries(Object.entries(plugins).map(([key, id]) => [key, memberRoles.get(id) ?? null]))).toEqual({
      direct: "viewer",
      team: "editor",
      orgWide: "viewer",
      removedGrant: null,
      manager: "manager",
      viaMarketplace: "viewer",
      hiddenMarketplace: null,
      removedMembership: null,
      otherOrgMarketplace: null,
      directAndMarketplace: "editor",
      none: null,
      archivedOrgWide: "viewer",
    })
    expect(memberRoles.has(otherOrgPluginId)).toBe(false)

    const memberList = await listPlugins({ context: member, includeAccess: true, status: "active" })
    const memberItems = new Map(memberList.items.map((item) => [item.id, item]))
    expect([...memberItems.keys()].sort()).toEqual([
      plugins.direct,
      plugins.team,
      plugins.orgWide,
      plugins.manager,
      plugins.viaMarketplace,
      plugins.directAndMarketplace,
    ].sort())
    expect(memberList.items.filter((item) => "access" in item).map((item) => item.id)).toEqual([plugins.manager])
    const managerItem = memberItems.get(plugins.manager)
    expect(managerItem && "access" in managerItem ? managerItem.access.map((entry) => entry.role) : null).toEqual(["manager"])

    const adminList = await listPlugins({ context: admin, includeAccess: true })
    expect(adminList.items.map((item) => item.id).sort()).toEqual([...organizationPluginIds].sort())
    expect(adminList.items.every((item) => "access" in item && item.access.every((entry) => entry.removedAt === null))).toBe(true)

    const withoutAccess = await listPlugins({ context: admin })
    expect(withoutAccess.items.some((item) => "access" in item)).toBe(false)
  } finally {
    await cleanup()
  }
})
