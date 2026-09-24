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
  TeamTable,
  TeamMemberTable,
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
  const effectiveAdminUserId = createDenTypeId("user")
  const effectiveAdminMemberId = createDenTypeId("member")
  const adminTeamId = createDenTypeId("team")
  const memberId = createDenTypeId("member")
  const creatorId = createDenTypeId("member")
  const teamAdminId = createDenTypeId("member")
  const teamId = createDenTypeId("team")
  const visibleMarketplaceId = createDenTypeId("marketplace")
  const teamMarketplaceId = createDenTypeId("marketplace")
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
    marketplaceTeam: createDenTypeId("plugin"),
    ownedOnly: createDenTypeId("plugin"),
    none: createDenTypeId("plugin"),
    archivedOrgWide: createDenTypeId("plugin"),
  }
  const otherOrgPluginId = createDenTypeId("plugin")
  const organizationPluginIds: PluginId[] = Object.values(plugins)
  const allPluginIds: PluginId[] = [...organizationPluginIds, otherOrgPluginId]

  function actor(input: { isOwner: boolean; role: string; id?: typeof memberId }): PluginArchActorContext {
    return {
      memberTeams: input.id === creatorId ? [] : [{ id: teamId, name: "Batch team", organizationId, createdAt: now, updatedAt: now }],
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
        currentMember: { id: input.id ?? memberId, userId, role: input.role, createdAt: now, joinedAt: now, isOwner: input.isOwner },
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
    await database.delete(TeamMemberTable).where(inArray(TeamMemberTable.teamId, [teamId, adminTeamId]))
    await database.delete(TeamTable).where(inArray(TeamTable.id, [teamId, adminTeamId]))
    await database.delete(MemberTable).where(inArray(MemberTable.organizationId, organizations))
    await database.delete(OrganizationTable).where(inArray(OrganizationTable.id, organizations))
    await database.delete(AuthUserTable).where(inArray(AuthUserTable.id, [userId, effectiveAdminUserId]))
  }

  try {
    await database.insert(AuthUserTable).values([
      { id: userId, name: "Batch Member", email: `${userId}@example.com`, emailVerified: true },
      { id: effectiveAdminUserId, name: "Team Admin", email: `${effectiveAdminUserId}@example.com`, emailVerified: true },
    ])
    await database.insert(OrganizationTable).values([
      { id: organizationId, name: "Batch Roles", slug: `batch-roles-${organizationId}` },
      { id: otherOrganizationId, name: "Batch Roles Other", slug: `batch-roles-${otherOrganizationId}` },
    ])
    await database.insert(MemberTable).values([
      { id: memberId, organizationId, userId, role: "member" },
      { id: creatorId, organizationId, role: "member" },
      { id: teamAdminId, organizationId, role: "member,admin" },
      { id: effectiveAdminMemberId, organizationId, userId: effectiveAdminUserId, role: "member" },
    ])
    await database.insert(TeamTable).values([
      { id: teamId, organizationId, name: "Batch team" },
      { id: adminTeamId, organizationId, name: "Admin team", grantsOrganizationAdmin: true },
    ])
    await database.insert(TeamMemberTable).values([
      { id: createDenTypeId("teamMember"), teamId, orgMembershipId: memberId },
      { id: createDenTypeId("teamMember"), teamId, orgMembershipId: teamAdminId },
      { id: createDenTypeId("teamMember"), teamId: adminTeamId, orgMembershipId: effectiveAdminMemberId },
    ])
    const statusFor = (id: PluginId): PluginStatus => id === plugins.archivedOrgWide ? "archived" : "active"
    await database.insert(PluginTable).values([
      ...organizationPluginIds.map((id) => ({
        id,
        organizationId,
        name: id === plugins.team ? "Alpha % team" : `Plugin ${id}`,
        description: id === plugins.direct ? "Special description" : null,
        status: statusFor(id),
        createdByOrgMembershipId: id === plugins.ownedOnly ? memberId : creatorId,
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
      { id: teamMarketplaceId, organizationId, name: "Team collection", status: "active", createdByOrgMembershipId: creatorId },
      { id: hiddenMarketplaceId, organizationId, name: "Hidden", status: "active", createdByOrgMembershipId: creatorId },
      { id: otherOrgMarketplaceId, organizationId: otherOrganizationId, name: "Other org", status: "active", createdByOrgMembershipId: creatorId },
    ])
    await database.insert(MarketplaceAccessGrantTable).values([
      { id: createDenTypeId("marketplaceAccessGrant"), organizationId, marketplaceId: visibleMarketplaceId, orgMembershipId: memberId, orgWide: false, role: "viewer", createdByOrgMembershipId: creatorId },
      { id: createDenTypeId("marketplaceAccessGrant"), organizationId, marketplaceId: teamMarketplaceId, teamId, orgWide: false, role: "viewer", createdByOrgMembershipId: creatorId },
      { id: createDenTypeId("marketplaceAccessGrant"), organizationId: otherOrganizationId, marketplaceId: otherOrgMarketplaceId, orgWide: true, role: "viewer", createdByOrgMembershipId: creatorId },
    ])
    await database.insert(MarketplacePluginTable).values([
      { id: createDenTypeId("marketplacePlugin"), organizationId, marketplaceId: visibleMarketplaceId, pluginId: plugins.viaMarketplace, membershipSource: "manual", createdByOrgMembershipId: creatorId },
      { id: createDenTypeId("marketplacePlugin"), organizationId, marketplaceId: hiddenMarketplaceId, pluginId: plugins.hiddenMarketplace, membershipSource: "manual", createdByOrgMembershipId: creatorId },
      { id: createDenTypeId("marketplacePlugin"), organizationId, marketplaceId: visibleMarketplaceId, pluginId: plugins.removedMembership, membershipSource: "manual", createdByOrgMembershipId: creatorId, removedAt: now },
      { id: createDenTypeId("marketplacePlugin"), organizationId: otherOrganizationId, marketplaceId: otherOrgMarketplaceId, pluginId: plugins.otherOrgMarketplace, membershipSource: "manual", createdByOrgMembershipId: creatorId },
      { id: createDenTypeId("marketplacePlugin"), organizationId, marketplaceId: visibleMarketplaceId, pluginId: plugins.directAndMarketplace, membershipSource: "manual", createdByOrgMembershipId: creatorId },
      { id: createDenTypeId("marketplacePlugin"), organizationId, marketplaceId: teamMarketplaceId, pluginId: plugins.marketplaceTeam, membershipSource: "manual", createdByOrgMembershipId: creatorId },
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
      marketplaceTeam: "viewer",
      ownedOnly: "manager",
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
      plugins.marketplaceTeam,
      plugins.ownedOnly,
    ].sort())
    expect(memberList.items.filter((item) => "access" in item).map((item) => item.id).sort()).toEqual([plugins.manager, plugins.ownedOnly].sort())
    const managerItem = memberItems.get(plugins.manager)
    expect(managerItem && "access" in managerItem ? managerItem.access.map((entry) => entry.role) : null).toEqual(["manager"])

    const adminList = await listPlugins({ context: admin, includeAccess: true })
    expect(adminList.items.map((item) => item.id).sort()).toEqual([...organizationPluginIds].sort())
    expect(adminList.items.every((item) => "access" in item && item.access.every((entry) => entry.removedAt === null))).toBe(true)

    const owned = await listPlugins({ context: admin, ownerId: memberId, status: "active", includeTotal: true, includeFacets: true })
    expect(owned.items.map((item) => item.id)).toEqual([plugins.ownedOnly])
    expect(owned.total).toBe(1)
    expect(owned.teamCounts?.every((entry) => entry.count === 0)).toBe(true)
    const facets = await listPlugins({ context: member, ownerId: creatorId, status: "active", includeFacets: true, limit: 1 })
    expect(facets.items).toHaveLength(1)
    expect(facets.ownerCounts?.find((entry) => entry.id === creatorId)?.count).toBe(7)
    expect(facets.ownerCounts?.find((entry) => entry.id === memberId)?.count).toBe(1)
    expect(facets.teamCounts?.find((entry) => entry.id === teamId)?.count).toBe(3)
    const combined = await listPlugins({ context: admin, ownerId: memberId, teamId, status: "active", includeTotal: true })
    expect(combined.items).toEqual([])
    expect(combined.total).toBe(0)
    expect((await listPlugins({ context: admin, ownerId: creatorId, includeTotal: true })).items.some((item) => item.id === otherOrgPluginId)).toBe(false)

    const withoutAccess = await listPlugins({ context: admin })
    expect(withoutAccess.items.some((item) => "access" in item)).toBe(false)

    const nameSearch = await listPlugins({ context: admin, q: "%", status: "active" })
    expect(nameSearch.items.map((item) => item.id)).toEqual([plugins.team])
    expect((await listPlugins({ context: admin, q: "Special", status: "active" })).items.map((item) => item.id)).toEqual([plugins.direct])
    expect((await listPlugins({ context: admin, name: "Special", status: "active" })).items).toEqual([])
    const teamAudience = await listPlugins({ context: admin, teamId, status: "active", includeTotal: true, limit: 2 })
    expect(teamAudience.total).toBe(3)
    expect(teamAudience.items).toHaveLength(2)
    const teamCursor = (await import("../src/list-pagination.js")).decodeKeysetCursor(teamAudience.nextCursor ?? "")
    expect(teamCursor).not.toBeNull()
    const teamNext = await listPlugins({ context: admin, teamId, status: "active", limit: 2, cursor: teamCursor ?? undefined })
    expect([...teamAudience.items, ...teamNext.items].map((item) => item.id).sort()).toEqual([
      plugins.team, plugins.orgWide, plugins.marketplaceTeam,
    ].sort())
    expect(teamNext.nextCursor).toBeNull()
    expect("total" in teamNext).toBe(false)
    const memberAudience = await listPlugins({ context: admin, memberId, status: "active", includeTotal: true })
    expect(memberAudience.items.map((item) => item.id).sort()).toEqual([
      plugins.direct, plugins.team, plugins.orgWide, plugins.manager, plugins.viaMarketplace,
      plugins.directAndMarketplace, plugins.marketplaceTeam, plugins.ownedOnly,
    ].sort())
    expect(memberAudience.total).toBe(memberAudience.items.length)
    expect((await listPlugins({ context: admin, memberId: teamAdminId, status: "active", includeTotal: true })).total).toBe(organizationPluginIds.length - 1)
    expect((await listPlugins({ context: admin, memberId: effectiveAdminMemberId, status: "active", includeTotal: true })).total).toBe(organizationPluginIds.length - 1)
    expect((await listPlugins({ context: admin, teamId: adminTeamId, status: "active", includeTotal: true })).items.map((item) => item.id)).toEqual([plugins.orgWide])
    expect((await listPlugins({ context: member, teamId, status: "active" })).items.map((item) => item.id).sort()).toEqual([
      plugins.team, plugins.orgWide, plugins.marketplaceTeam,
    ].sort())
    expect((await listPlugins({ context: member, memberId: creatorId, status: "active" })).items.map((item) => item.id).sort()).toEqual(memberList.items.filter((item) => item.id !== plugins.ownedOnly).map((item) => item.id).sort())
    const visibleToMember: PluginId[] = []
    let memberCursor: { at: Date; id: string } | undefined
    do {
      const page = await listPlugins({ context: member, status: "active", limit: 2, cursor: memberCursor })
      visibleToMember.push(...page.items.map((item) => item.id))
      memberCursor = page.nextCursor ? (await import("../src/list-pagination.js")).decodeKeysetCursor(page.nextCursor) ?? undefined : undefined
      if (!page.nextCursor) break
    } while (memberCursor)
    expect(visibleToMember.sort()).toEqual(memberList.items.map((item) => item.id).sort())
    expect(new Set(visibleToMember).size).toBe(visibleToMember.length)
    const creator = actor({ isOwner: false, role: "member", id: creatorId })
    expect(await resolvePluginArchResourceRole({ context: creator, resourceId: plugins.none, resourceKind: "plugin" })).toBe("manager")
    expect((await listPlugins({ context: creator, status: "active", name: `Plugin ${plugins.none}` })).items.map((item) => item.id)).toEqual([plugins.none])
    expect((await listPlugins({ context: admin, teamId: createDenTypeId("team"), status: "active" })).items).toEqual([])

    const extraPlugins = Array.from({ length: 120 }, (_, index) => ({
      id: createDenTypeId("plugin"), organizationId, name: `Directory extra ${String(index).padStart(3, "0")}`,
      createdByOrgMembershipId: creatorId,
    }))
    await database.insert(PluginTable).values(extraPlugins)
    expect((await listPlugins({ context: admin, q: "Directory extra 119", status: "active" })).items.map((item) => item.name)).toEqual(["Directory extra 119"])

    const collected: PluginId[] = []
    let cursor: { at: Date; id: string } | undefined
    do {
      const page = await listPlugins({ context: admin, status: "active", limit: 25, cursor })
      collected.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor ? (await import("../src/list-pagination.js")).decodeKeysetCursor(page.nextCursor) ?? undefined : undefined
      if (!page.nextCursor) break
    } while (cursor)
    expect(collected.length).toBe(organizationPluginIds.length - 1 + extraPlugins.length)
    expect(new Set(collected).size).toBe(collected.length)
    expect(collected.sort()).toEqual([...organizationPluginIds.filter((id) => id !== plugins.archivedOrgWide), ...extraPlugins.map((item) => item.id)].sort())
  } finally {
    await cleanup()
  }
})
