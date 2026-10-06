import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConnectorInstanceAccessGrantTable,
  ConnectorInstanceTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import type { OrganizationContext } from "../../../orgs.js"
import { db } from "../../../db.js"
import { connectorInstanceExistsInOrganization, listConnectorInstanceAccessGrants } from "../../../modules/marketplace/github-sync/access-connector-instance.js"
import {
  isPluginArchOrgAdmin,
  maxRole,
  PluginArchAuthorizationError,
  resolvePluginArchGrantRole,
  roleSatisfies,
  type PluginArchActorContext,
  type PluginArchRole,
} from "../../../core/sharing/resource-access.js"

export {
  isPluginArchOrgAdmin,
  PluginArchAuthorizationError,
  resolvePluginArchGrantRole,
  type PluginArchActorContext,
  type PluginArchRole,
}

export type PluginArchResourceKind = "config_object" | "connector_instance" | "marketplace" | "plugin"
export type PluginArchCapability = "config_object.create" | "connector_account.create" | "connector_instance.create" | "marketplace.create" | "plugin.create"

type OrganizationId = OrganizationContext["organization"]["id"]
type ConfigObjectId = typeof ConfigObjectTable.$inferSelect.id
type MarketplaceId = typeof MarketplaceTable.$inferSelect.id
type PluginId = typeof PluginTable.$inferSelect.id
type ConnectorInstanceId = typeof ConnectorInstanceTable.$inferSelect.id
type ConfigObjectGrantRow = Pick<typeof ConfigObjectAccessGrantTable.$inferSelect, "orgMembershipId" | "orgWide" | "removedAt" | "role" | "teamId">
type MarketplaceGrantRow = Pick<typeof MarketplaceAccessGrantTable.$inferSelect, "orgMembershipId" | "orgWide" | "removedAt" | "role" | "teamId">
type PluginGrantRow = Pick<typeof PluginAccessGrantTable.$inferSelect, "orgMembershipId" | "orgWide" | "removedAt" | "role" | "teamId">
type ConnectorInstanceGrantRow = Pick<typeof ConnectorInstanceAccessGrantTable.$inferSelect, "orgMembershipId" | "orgWide" | "removedAt" | "role" | "teamId">
type GrantRow = ConfigObjectGrantRow | MarketplaceGrantRow | PluginGrantRow | ConnectorInstanceGrantRow

type MarketplaceResourceLookupInput = {
  context: PluginArchActorContext
  resourceId: MarketplaceId
  resourceKind: "marketplace"
}

type PluginResourceLookupInput = {
  context: PluginArchActorContext
  resourceId: PluginId
  resourceKind: "plugin"
}

type ConnectorInstanceResourceLookupInput = {
  context: PluginArchActorContext
  resourceId: ConnectorInstanceId
  resourceKind: "connector_instance"
}

type ConfigObjectResourceLookupInput = {
  context: PluginArchActorContext
  resourceId: ConfigObjectId
  resourceKind: "config_object"
}

type ResourceLookupInput =
  | PluginResourceLookupInput
  | ConnectorInstanceResourceLookupInput
  | MarketplaceResourceLookupInput
  | ConfigObjectResourceLookupInput

type RequireResourceRoleInput = ResourceLookupInput & {
  role: PluginArchRole
}

export function hasPluginArchCapability(context: PluginArchActorContext, capability: PluginArchCapability) {
  if (capability === "plugin.create" || capability === "config_object.create") {
    return true
  }
  return isPluginArchOrgAdmin(context)
}

async function filterPluginIdsInOrganization(organizationId: OrganizationId, pluginIds: PluginId[]) {
  if (pluginIds.length === 0) {
    return []
  }

  const rows = await db
    .select({ id: PluginTable.id })
    .from(PluginTable)
    .where(and(eq(PluginTable.organizationId, organizationId), inArray(PluginTable.id, pluginIds)))

  return rows.map((row) => row.id)
}

async function filterMarketplaceIdsInOrganization(organizationId: OrganizationId, marketplaceIds: MarketplaceId[]) {
  if (marketplaceIds.length === 0) {
    return []
  }

  const rows = await db
    .select({ id: MarketplaceTable.id })
    .from(MarketplaceTable)
    .where(and(eq(MarketplaceTable.organizationId, organizationId), inArray(MarketplaceTable.id, marketplaceIds)))

  return rows.map((row) => row.id)
}

async function resourceExistsInOrganization(input: ResourceLookupInput) {
  const organizationId = input.context.organizationContext.organization.id

  if (input.resourceKind === "marketplace") {
    const rows = await db
      .select({ id: MarketplaceTable.id })
      .from(MarketplaceTable)
      .where(and(eq(MarketplaceTable.organizationId, organizationId), eq(MarketplaceTable.id, input.resourceId)))
      .limit(1)
    return Boolean(rows[0])
  }

  if (input.resourceKind === "plugin") {
    const rows = await db
      .select({ id: PluginTable.id })
      .from(PluginTable)
      .where(and(eq(PluginTable.organizationId, organizationId), eq(PluginTable.id, input.resourceId)))
      .limit(1)
    return Boolean(rows[0])
  }

  if (input.resourceKind === "connector_instance") {
    // TODO(M-marketplace.githubSync): resolve this kind through a resource-kind registry instead of importing the sub-module.
    return connectorInstanceExistsInOrganization(organizationId, input.resourceId)
  }

  const rows = await db
    .select({ id: ConfigObjectTable.id })
    .from(ConfigObjectTable)
    .where(and(eq(ConfigObjectTable.organizationId, organizationId), eq(ConfigObjectTable.id, input.resourceId)))
    .limit(1)
  return Boolean(rows[0])
}

async function resolveGrantRole(input: {
  grants: GrantRow[]
  context: PluginArchActorContext
}) {
  return resolvePluginArchGrantRole({
    grants: input.grants,
    memberId: input.context.organizationContext.currentMember.id,
    teamIds: input.context.memberTeams.map((team) => team.id),
  })
}

async function resolvePluginRoleForIds(context: PluginArchActorContext, pluginIds: PluginId[]) {
  const organizationPluginIds = await filterPluginIdsInOrganization(context.organizationContext.organization.id, pluginIds)
  if (organizationPluginIds.length === 0) {
    return null
  }

  if (isPluginArchOrgAdmin(context)) {
    return "manager" satisfies PluginArchRole
  }

  const [owned] = await db.select({ id: PluginTable.id }).from(PluginTable).where(and(
    inArray(PluginTable.id, organizationPluginIds),
    eq(PluginTable.createdByOrgMembershipId, context.organizationContext.currentMember.id),
  )).limit(1)
  if (owned) return "manager" satisfies PluginArchRole

  const grants = await db
    .select({
      orgMembershipId: PluginAccessGrantTable.orgMembershipId,
      orgWide: PluginAccessGrantTable.orgWide,
      removedAt: PluginAccessGrantTable.removedAt,
      role: PluginAccessGrantTable.role,
      teamId: PluginAccessGrantTable.teamId,
    })
    .from(PluginAccessGrantTable)
    .where(and(
      inArray(PluginAccessGrantTable.pluginId, organizationPluginIds),
      eq(PluginAccessGrantTable.organizationId, context.organizationContext.organization.id),
    ))

  return resolveGrantRole({ context, grants })
}

async function resolveMarketplaceRoleForIds(context: PluginArchActorContext, marketplaceIds: MarketplaceId[]) {
  const organizationMarketplaceIds = await filterMarketplaceIdsInOrganization(context.organizationContext.organization.id, marketplaceIds)
  if (organizationMarketplaceIds.length === 0) {
    return null
  }

  if (isPluginArchOrgAdmin(context)) {
    return "manager" satisfies PluginArchRole
  }

  const grants = await db
    .select({
      orgMembershipId: MarketplaceAccessGrantTable.orgMembershipId,
      orgWide: MarketplaceAccessGrantTable.orgWide,
      removedAt: MarketplaceAccessGrantTable.removedAt,
      role: MarketplaceAccessGrantTable.role,
      teamId: MarketplaceAccessGrantTable.teamId,
    })
    .from(MarketplaceAccessGrantTable)
    .where(and(
      inArray(MarketplaceAccessGrantTable.marketplaceId, organizationMarketplaceIds),
      eq(MarketplaceAccessGrantTable.organizationId, context.organizationContext.organization.id),
    ))

  return resolveGrantRole({ context, grants })
}

function groupGrantsBy<TKey, TGrant>(grants: TGrant[], key: (grant: TGrant) => TKey) {
  const grouped = new Map<TKey, TGrant[]>()
  for (const grant of grants) {
    const id = key(grant)
    const existing = grouped.get(id)
    if (existing) existing.push(grant)
    else grouped.set(id, [grant])
  }
  return grouped
}

/** Resolves the caller's role for many plugins with the same rules as resolvePluginArchResourceRole. */
export async function resolvePluginArchPluginRoles(context: PluginArchActorContext, pluginIds: PluginId[]) {
  const roles = new Map<PluginId, PluginArchRole>()
  const organizationId = context.organizationContext.organization.id
  if (pluginIds.length === 0) return roles
  const pluginRows = await db.select({ id: PluginTable.id, createdByOrgMembershipId: PluginTable.createdByOrgMembershipId })
    .from(PluginTable)
    .where(and(eq(PluginTable.organizationId, organizationId), inArray(PluginTable.id, pluginIds)))
  const organizationPluginIds = pluginRows.map((plugin) => plugin.id)
  if (organizationPluginIds.length === 0) return roles

  if (isPluginArchOrgAdmin(context)) {
    for (const pluginId of organizationPluginIds) roles.set(pluginId, "manager")
    return roles
  }

  const memberId = context.organizationContext.currentMember.id
  const teamIds = context.memberTeams.map((team) => team.id)
  const grants = await db
    .select({
      orgMembershipId: PluginAccessGrantTable.orgMembershipId,
      orgWide: PluginAccessGrantTable.orgWide,
      pluginId: PluginAccessGrantTable.pluginId,
      removedAt: PluginAccessGrantTable.removedAt,
      role: PluginAccessGrantTable.role,
      teamId: PluginAccessGrantTable.teamId,
    })
    .from(PluginAccessGrantTable)
    .where(and(
      inArray(PluginAccessGrantTable.pluginId, organizationPluginIds),
      eq(PluginAccessGrantTable.organizationId, organizationId),
    ))
  const grantsByPlugin = groupGrantsBy(grants, (grant) => grant.pluginId)

  const unresolvedPluginIds: PluginId[] = []
  for (const plugin of pluginRows) {
    const role = resolvePluginArchGrantRole({ grants: grantsByPlugin.get(plugin.id) ?? [], memberId, teamIds })
    if (plugin.createdByOrgMembershipId === memberId) roles.set(plugin.id, "manager")
    else if (role) roles.set(plugin.id, role)
    else unresolvedPluginIds.push(plugin.id)
  }
  if (unresolvedPluginIds.length === 0) {
    return roles
  }

  const memberships = await db
    .select({ marketplaceId: MarketplacePluginTable.marketplaceId, pluginId: MarketplacePluginTable.pluginId })
    .from(MarketplacePluginTable)
    .where(and(inArray(MarketplacePluginTable.pluginId, unresolvedPluginIds), isNull(MarketplacePluginTable.removedAt)))
  const organizationMarketplaceIds = await filterMarketplaceIdsInOrganization(
    organizationId,
    [...new Set(memberships.map((membership) => membership.marketplaceId))],
  )
  if (organizationMarketplaceIds.length === 0) {
    return roles
  }

  const marketplaceGrants = await db
    .select({
      marketplaceId: MarketplaceAccessGrantTable.marketplaceId,
      orgMembershipId: MarketplaceAccessGrantTable.orgMembershipId,
      orgWide: MarketplaceAccessGrantTable.orgWide,
      removedAt: MarketplaceAccessGrantTable.removedAt,
      role: MarketplaceAccessGrantTable.role,
      teamId: MarketplaceAccessGrantTable.teamId,
    })
    .from(MarketplaceAccessGrantTable)
    .where(and(
      inArray(MarketplaceAccessGrantTable.marketplaceId, organizationMarketplaceIds),
      eq(MarketplaceAccessGrantTable.organizationId, organizationId),
    ))
  const grantsByMarketplace = groupGrantsBy(marketplaceGrants, (grant) => grant.marketplaceId)
  const visibleMarketplaceIds = new Set(organizationMarketplaceIds.filter((marketplaceId) =>
    resolvePluginArchGrantRole({ grants: grantsByMarketplace.get(marketplaceId) ?? [], memberId, teamIds }) !== null))

  for (const membership of memberships) {
    if (visibleMarketplaceIds.has(membership.marketplaceId)) roles.set(membership.pluginId, "viewer")
  }
  return roles
}

export async function resolvePluginArchResourceRole(input: ResourceLookupInput) {
  if (!(await resourceExistsInOrganization(input))) {
    return null
  }

  if (isPluginArchOrgAdmin(input.context)) {
    return "manager" satisfies PluginArchRole
  }

  if (input.resourceKind === "marketplace") {
    const grants = await db
      .select({
        orgMembershipId: MarketplaceAccessGrantTable.orgMembershipId,
        orgWide: MarketplaceAccessGrantTable.orgWide,
        removedAt: MarketplaceAccessGrantTable.removedAt,
        role: MarketplaceAccessGrantTable.role,
        teamId: MarketplaceAccessGrantTable.teamId,
      })
      .from(MarketplaceAccessGrantTable)
      .where(and(
        eq(MarketplaceAccessGrantTable.marketplaceId, input.resourceId),
        eq(MarketplaceAccessGrantTable.organizationId, input.context.organizationContext.organization.id),
      ))
    return resolveGrantRole({ context: input.context, grants })
  }

  if (input.resourceKind === "plugin") {
    const [plugin] = await db.select({ createdByOrgMembershipId: PluginTable.createdByOrgMembershipId })
      .from(PluginTable)
      .where(and(eq(PluginTable.id, input.resourceId), eq(PluginTable.organizationId, input.context.organizationContext.organization.id)))
      .limit(1)
    if (plugin?.createdByOrgMembershipId === input.context.organizationContext.currentMember.id) return "manager"
    const grants = await db
      .select({
        orgMembershipId: PluginAccessGrantTable.orgMembershipId,
        orgWide: PluginAccessGrantTable.orgWide,
        removedAt: PluginAccessGrantTable.removedAt,
        role: PluginAccessGrantTable.role,
        teamId: PluginAccessGrantTable.teamId,
      })
      .from(PluginAccessGrantTable)
      .where(and(
        eq(PluginAccessGrantTable.pluginId, input.resourceId),
        eq(PluginAccessGrantTable.organizationId, input.context.organizationContext.organization.id),
      ))
    const resolved = await resolveGrantRole({ context: input.context, grants })
    if (resolved) {
      return resolved
    }

    const memberships = await db
      .select({ marketplaceId: MarketplacePluginTable.marketplaceId })
      .from(MarketplacePluginTable)
      .where(and(eq(MarketplacePluginTable.pluginId, input.resourceId), isNull(MarketplacePluginTable.removedAt)))

    const marketplaceRole = await resolveMarketplaceRoleForIds(input.context, memberships.map((membership) => membership.marketplaceId))
    return maxRole(resolved, marketplaceRole ? "viewer" : null)
  }

  if (input.resourceKind === "connector_instance") {
    const grants = await listConnectorInstanceAccessGrants({ connectorInstanceId: input.resourceId, organizationId: input.context.organizationContext.organization.id })
    return resolveGrantRole({ context: input.context, grants })
  }

  const directGrants = await db
    .select({
      orgMembershipId: ConfigObjectAccessGrantTable.orgMembershipId,
      orgWide: ConfigObjectAccessGrantTable.orgWide,
      removedAt: ConfigObjectAccessGrantTable.removedAt,
      role: ConfigObjectAccessGrantTable.role,
      teamId: ConfigObjectAccessGrantTable.teamId,
    })
    .from(ConfigObjectAccessGrantTable)
    .where(and(
      eq(ConfigObjectAccessGrantTable.configObjectId, input.resourceId),
      eq(ConfigObjectAccessGrantTable.organizationId, input.context.organizationContext.organization.id),
    ))

  let resolved = await resolveGrantRole({ context: input.context, grants: directGrants })
  if (resolved) {
    return resolved
  }

  const memberships = await db
    .select({ pluginId: PluginConfigObjectTable.pluginId })
    .from(PluginConfigObjectTable)
    .where(and(eq(PluginConfigObjectTable.configObjectId, input.resourceId), isNull(PluginConfigObjectTable.removedAt)))

  const pluginRole = await resolvePluginRoleForIds(input.context, memberships.map((membership) => membership.pluginId))
  resolved = maxRole(resolved, pluginRole ? "viewer" : null)
  return resolved
}

export async function requirePluginArchCapability(context: PluginArchActorContext, capability: PluginArchCapability) {
  if (hasPluginArchCapability(context, capability)) {
    return
  }

  throw new PluginArchAuthorizationError(403, "forbidden", `Missing organization capability: ${capability}`)
}

export async function requirePluginArchResourceRole(input: {
  context: PluginArchActorContext
  resourceId: ConfigObjectId | ConnectorInstanceId | MarketplaceId | PluginId
  resourceKind: PluginArchResourceKind
  role: PluginArchRole
}) {
  const resolved = await resolvePluginArchResourceRole(input as RequireResourceRoleInput)
  if (roleSatisfies(resolved, input.role)) {
    return resolved
  }

  throw new PluginArchAuthorizationError(
    403,
    "forbidden",
    `Missing ${input.role} access for ${input.resourceKind.replace(/_/g, " ")}.`,
  )
}
