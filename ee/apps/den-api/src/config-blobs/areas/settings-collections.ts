/**
 * `settings.advanced.collections`: marketplaces (collections) and who can see
 * or manage them.
 *
 * Exported per marketplace: name, description, logo URL, whether it is
 * archived, and its access grants by role (everyone, teams, people by email).
 * Nothing in a marketplace is secret.
 *
 * Not in v1: which plugins a marketplace holds (`marketplace_plugin`). Plugins
 * are not exported yet, so an apply never adds or removes memberships: an
 * updated marketplace keeps its plugins, a created one starts empty. Built-in
 * and connected marketplaces can't be deleted (the store refuses).
 *
 * Applies through the plugin-system store, as the marketplace routes do
 * (`createMarketplace`, `updateMarketplace`, `setMarketplaceLifecycle`,
 * `createResourceAccessGrant`, `deleteResourceAccessGrant`), so role checks
 * and plugin MCP access syncing are the same as in the dashboard.
 */
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { MarketplaceAccessGrantTable, MarketplaceTable } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { listTeamsForMember } from "../../member-teams.js"
import { PluginArchAuthorizationError, requirePluginArchCapability, type PluginArchActorContext } from "../../routes/org/plugin-system/access.js"
import {
  PluginArchRouteFailure,
  createMarketplace,
  createResourceAccessGrant,
  deleteResourceAccessGrant,
  setMarketplaceLifecycle,
  updateMarketplace,
} from "../../routes/org/plugin-system/store.js"
import { defineConfigArea, type ConfigApplyResult, type ConfigItem } from "../area.js"
import {
  ConfigApplyError,
  configRouteContext,
  isJsonObject,
  loadMemberEmails,
  loadTeamNames,
  personRef,
  resolvedRefIds,
  specObject,
  specRefSchema,
  teamRef,
} from "./route-support.js"

const AREA = "settings.advanced.collections"
const ROLES = ["viewer", "editor", "manager"] as const
type Role = (typeof ROLES)[number]

const byRoleSchema = z.object({
  viewer: z.array(specRefSchema).max(500),
  editor: z.array(specRefSchema).max(500),
  manager: z.array(specRefSchema).max(500),
}).strict()

const specSchema = z.object({
  description: z.string().max(65535).nullable(),
  logoUrl: z.string().trim().min(1).max(1024).nullable(),
  archived: z.boolean(),
  /** Grants by role. `orgWide`: the role everyone in the organization has, or null. */
  access: z.object({
    orgWide: z.enum(ROLES).nullable(),
    teams: byRoleSchema,
    members: byRoleSchema,
  }).strict(),
}).strict()

const applySpecSchema = z.object({
  description: z.string().nullable(),
  logoUrl: z.string().nullable(),
  archived: z.boolean(),
  access: z.object({ orgWide: z.enum(ROLES).nullable() }).passthrough(),
}).passthrough()

function emptyByRole<T>(): Record<Role, T[]> {
  return { viewer: [], editor: [], manager: [] }
}

type GrantKey = string
type DesiredGrant = { key: GrantKey; role: Role; value: { orgWide?: boolean; teamId?: ReturnType<typeof normalizeTeamId>; orgMembershipId?: ReturnType<typeof normalizeMemberId> } }

function normalizeTeamId(id: string) {
  return normalizeDenTypeId("team", id)
}

function normalizeMemberId(id: string) {
  return normalizeDenTypeId("member", id)
}

function grantKey(grant: { orgWide: boolean; teamId: string | null; orgMembershipId: string | null }): GrantKey {
  if (grant.orgMembershipId) return `member:${grant.orgMembershipId}`
  if (grant.teamId) return `team:${grant.teamId}`
  return "org"
}

function desiredGrants(spec: z.infer<typeof applySpecSchema>, raw: unknown): DesiredGrant[] {
  const access = isJsonObject(raw) && isJsonObject(raw.access) ? raw.access : {}
  const teams = isJsonObject(access.teams) ? access.teams : {}
  const members = isJsonObject(access.members) ? access.members : {}
  const out = new Map<GrantKey, DesiredGrant>()
  if (spec.access.orgWide) out.set("org", { key: "org", role: spec.access.orgWide, value: { orgWide: true } })
  // Higher roles win when a team or person is listed twice.
  for (const role of ROLES) {
    for (const id of resolvedRefIds(teams[role], `access.teams.${role}`)) {
      const teamId = normalizeTeamId(id)
      out.set(`team:${teamId}`, { key: `team:${teamId}`, role, value: { teamId } })
    }
    for (const id of resolvedRefIds(members[role], `access.members.${role}`)) {
      const orgMembershipId = normalizeMemberId(id)
      out.set(`member:${orgMembershipId}`, { key: `member:${orgMembershipId}`, role, value: { orgMembershipId } })
    }
  }
  return [...out.values()]
}

async function storeCall<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof PluginArchRouteFailure) throw new ConfigApplyError(error.error, `${action}: ${error.message}`, error.status)
    if (error instanceof PluginArchAuthorizationError) throw new ConfigApplyError(error.error, `${action}: ${error.message}`, error.status)
    throw error
  }
}

export const settingsCollectionsArea = defineConfigArea({
  key: AREA,
  label: "Collections",
  path: ["Settings", "Advanced", "Collections"],
  idPrefix: denTypeIdPrefixes.marketplace,
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams", "members.people"],
  deployments: ["cloud", "self_hosted"],
  // There is no separate view permission: listing every marketplace (and its grants) is a manager's view.
  viewPermission: "marketplaces.manage",
  managePermission: "marketplaces.manage",
  tables: ["marketplace", "marketplace_access_grant"],
  naturalKeys: [{
    label: "name",
    get: (item) => item.name.trim().toLowerCase() || null,
  }],
  secretFields: [],
  transactional: false,

  async exportItems(ctx) {
    const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
    const rows = await ctx.db
      .select()
      .from(MarketplaceTable)
      .where(and(eq(MarketplaceTable.organizationId, organizationId), isNull(MarketplaceTable.deletedAt), inArray(MarketplaceTable.status, ["active", "archived"])))
    if (rows.length === 0) return []
    const grants = await ctx.db
      .select()
      .from(MarketplaceAccessGrantTable)
      .where(and(inArray(MarketplaceAccessGrantTable.marketplaceId, rows.map((row) => row.id)), isNull(MarketplaceAccessGrantTable.removedAt)))
    const [teamNames, memberEmails] = await Promise.all([
      loadTeamNames(ctx.db, organizationId, grants.flatMap((grant) => grant.teamId ? [grant.teamId] : [])),
      loadMemberEmails(ctx.db, organizationId, grants.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : [])),
    ])

    const items: ConfigItem[] = rows.map((row) => {
      const rowGrants = grants.filter((grant) => grant.marketplaceId === row.id)
      const teams = emptyByRole<{ id: string; name: string | undefined }>()
      const members = emptyByRole<string>()
      let orgWide: Role | null = null
      for (const grant of rowGrants) {
        if (grant.orgMembershipId) {
          const email = memberEmails.get(grant.orgMembershipId)
          if (email) members[grant.role].push(email)
        } else if (grant.teamId) {
          teams[grant.role].push({ id: grant.teamId, name: teamNames.get(grant.teamId) })
        } else if (grant.orgWide) {
          orgWide = grant.role
        }
      }
      const teamRefs = Object.fromEntries(ROLES.map((role) => [role, teams[role].sort((left, right) => left.id.localeCompare(right.id)).map((team) => teamRef(team.id, team.name))]))
      const memberRefs = Object.fromEntries(ROLES.map((role) => [role, [...new Set(members[role])].sort().map(personRef)]))
      return {
        id: row.id,
        key: row.externalKey,
        name: row.name,
        spec: {
          description: row.description ?? null,
          logoUrl: row.logoUrl ?? null,
          archived: row.status === "archived",
          access: { orgWide, teams: teamRefs, members: memberRefs },
        },
      }
    })
    return items.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  },

  async apply(ctx, op): Promise<ConfigApplyResult> {
    const { payload, c } = await configRouteContext(ctx)
    const context: PluginArchActorContext = {
      memberTeams: await listTeamsForMember({ organizationId: payload.organization.id, memberId: payload.currentMember.id }),
      organizationContext: payload,
      session: c.get("session"),
    }

    if (op.kind === "delete") {
      await storeCall(`Remove "${op.previous.name}"`, () => setMarketplaceLifecycle({ context, marketplaceId: normalizeDenTypeId("marketplace", op.targetId), action: "delete" }))
      return { localId: op.targetId }
    }

    const raw = specObject(op.item.spec)
    const parsed = applySpecSchema.safeParse(raw)
    if (!parsed.success) throw new ConfigApplyError("invalid_spec", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
    const spec = parsed.data
    const desired = desiredGrants(spec, raw)
    const warnings: string[] = []
    const label = `"${op.item.name}"`

    let marketplaceId: ReturnType<typeof normalizeDenTypeId<"marketplace">>
    let status: string
    if (op.kind === "create") {
      await storeCall(`Create ${label}`, () => requirePluginArchCapability(context, "marketplace.create"))
      const created = await storeCall(`Create ${label}`, () => createMarketplace({
        context,
        name: op.item.name,
        description: spec.description,
        logoUrl: spec.logoUrl,
        ...(op.item.key ? { externalKey: op.item.key } : {}),
        ...(op.preferredId ? { id: normalizeDenTypeId("marketplace", op.preferredId) } : {}),
      }))
      marketplaceId = normalizeDenTypeId("marketplace", created.id)
      status = "active"
    } else {
      marketplaceId = normalizeDenTypeId("marketplace", op.targetId)
      const [row] = await ctx.db.select().from(MarketplaceTable).where(and(eq(MarketplaceTable.id, marketplaceId), eq(MarketplaceTable.organizationId, payload.organization.id))).limit(1)
      if (!row || row.deletedAt) throw new ConfigApplyError("marketplace_not_found", `The collection "${op.previous.name}" no longer exists.`, 404)
      if ((op.item.key ?? null) !== (row.externalKey ?? null)) warnings.push("A collection's key can't change; the existing key was kept.")
      status = row.status
      if (status !== "active" && !spec.archived) {
        await storeCall(`Restore ${label}`, () => setMarketplaceLifecycle({ context, marketplaceId, action: "restore" }))
        status = "active"
      }
      await storeCall(`Update ${label}`, () => updateMarketplace({ context, marketplaceId, name: op.item.name, description: spec.description, logoUrl: spec.logoUrl }))
    }

    // Grants: make the active grants exactly the blob's, through the same store calls as the access routes.
    const current = await ctx.db
      .select()
      .from(MarketplaceAccessGrantTable)
      .where(and(eq(MarketplaceAccessGrantTable.marketplaceId, marketplaceId), isNull(MarketplaceAccessGrantTable.removedAt)))
    const currentByKey = new Map(current.map((grant) => [grantKey(grant), grant]))
    for (const grant of desired) {
      if (currentByKey.get(grant.key)?.role === grant.role) continue
      await storeCall(`Grant access to ${label}`, () => createResourceAccessGrant({ context, resourceId: marketplaceId, resourceKind: "marketplace", value: { ...grant.value, role: grant.role } }))
    }
    const desiredKeys = new Set(desired.map((grant) => grant.key))
    for (const grant of current) {
      const key = grantKey(grant)
      if (desiredKeys.has(key)) continue
      if (grant.orgMembershipId === payload.currentMember.id && grant.role === "manager") {
        // Same rule as the creator grant in the dashboard: the person applying keeps managing it.
        warnings.push("Your own manager access was kept.")
        continue
      }
      await storeCall(`Remove access to ${label}`, () => deleteResourceAccessGrant({ context, resourceId: marketplaceId, resourceKind: "marketplace", grantId: grant.id }))
    }

    if (spec.archived && status === "active") {
      await storeCall(`Archive ${label}`, () => setMarketplaceLifecycle({ context, marketplaceId, action: "archive" }))
    }
    return { localId: marketplaceId, ...(warnings.length > 0 ? { warnings } : {}) }
  },
})
