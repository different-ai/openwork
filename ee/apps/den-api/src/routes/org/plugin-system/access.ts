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
import type { MemberTeamSummary, OrganizationContext } from "../../../orgs.js"
import { db } from "../../../db.js"
import { getFreshPrivilegedSessionRequiredResponse, hasFreshPrivilegedSession, memberHasRole } from "../shared.js"

export type PluginArchResourceKind = "config_object" | "connector_instance" | "marketplace" | "plugin"
export type PluginArchRole = "viewer" | "editor" | "manager"
export type PluginArchCapability = "config_object.create" | "connector_account.create" | "connector_instance.create" | "marketplace.create" | "plugin.create"

export type PluginArchActorContext = {
  apiKey?: true
  automation?: true
  memberTeams: MemberTeamSummary[]
  organizationContext: OrganizationContext
  session: { createdAt?: Date | string | null } | null | undefined
}

type MemberId = OrganizationContext["currentMember"]["id"]
type TeamId = MemberTeamSummary["id"]
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
type ExposureGrantRow = Pick<PluginGrantRow, "orgMembershipId" | "orgWide" | "teamId">

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

type ExposureResourceLookupInput = PluginResourceLookupInput | ConfigObjectResourceLookupInput

type RequireResourceRoleInput = ResourceLookupInput & {
  requireFreshSession?: boolean
  role: PluginArchRole
}

export class PluginArchAuthorizationError extends Error {
  constructor(
    readonly status: 403,
    readonly error: "forbidden" | "reauth",
    message: string,
    readonly reason?: string,
  ) {
    super(message)
    this.name = "PluginArchAuthorizationError"
  }
}

const rolePriority: Record<PluginArchRole, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
}

function maxRole(current: PluginArchRole | null, candidate: PluginArchRole | null) {
  if (!candidate) return current
  if (!current) return candidate
  return rolePriority[candidate] > rolePriority[current] ? candidate : current
}

export function isPluginArchOrgAdmin(context: PluginArchActorContext) {
  return context.organizationContext.currentMember.isOwner || memberHasRole(context.organizationContext.currentMember.role, "admin")
}

export function hasPluginArchCapability(context: PluginArchActorContext, capability: PluginArchCapability) {
  if (capability === "plugin.create" || capability === "config_object.create") {
    return true
  }
  return isPluginArchOrgAdmin(context)
}

function ensureFreshPluginArchAdmin(context: PluginArchActorContext) {
  if (context.apiKey === true || context.automation === true) {
    // Session freshness is a step-up check for interactive humans. API keys and connector automation
    // are non-interactive principals authorized by their scoped organization membership.
    return
  }
  if (!isPluginArchOrgAdmin(context) || hasFreshPrivilegedSession({ session: context.session })) {
    return
  }

  const response = getFreshPrivilegedSessionRequiredResponse()
  throw new PluginArchAuthorizationError(403, response.error, response.message, response.reason)
}

function roleSatisfies(role: PluginArchRole | null, required: PluginArchRole) {
  if (!role) return false
  return rolePriority[role] >= rolePriority[required]
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
    const rows = await db
      .select({ id: ConnectorInstanceTable.id })
      .from(ConnectorInstanceTable)
      .where(and(eq(ConnectorInstanceTable.organizationId, organizationId), eq(ConnectorInstanceTable.id, input.resourceId)))
      .limit(1)
    return Boolean(rows[0])
  }

  const rows = await db
    .select({ id: ConfigObjectTable.id })
    .from(ConfigObjectTable)
    .where(and(eq(ConfigObjectTable.organizationId, organizationId), eq(ConfigObjectTable.id, input.resourceId)))
    .limit(1)
  return Boolean(rows[0])
}

export function resolvePluginArchGrantRole(input: {
  grants: GrantRow[]
  memberId: MemberId
  teamIds: TeamId[]
}) {
  const teamIds = new Set(input.teamIds)
  let resolved: PluginArchRole | null = null

  for (const grant of input.grants) {
    if (grant.removedAt) continue
    const applies = grant.orgWide || grant.orgMembershipId === input.memberId || (grant.teamId ? teamIds.has(grant.teamId) : false)
    if (!applies) continue
    resolved = maxRole(resolved, grant.role)
  }

  return resolved
}

export function pluginArchGrantExpandsAudience(grant: ExposureGrantRow, memberId: MemberId) {
  return grant.orgWide
    || grant.teamId !== null
    || (grant.orgMembershipId !== null && grant.orgMembershipId !== memberId)
}

async function pluginIdsHaveExpandedAudience(context: PluginArchActorContext, pluginIds: PluginId[]) {
  if (pluginIds.length === 0) return false

  const organizationId = context.organizationContext.organization.id
  const memberId = context.organizationContext.currentMember.id
  const grants = await db
    .select({
      orgMembershipId: PluginAccessGrantTable.orgMembershipId,
      orgWide: PluginAccessGrantTable.orgWide,
      teamId: PluginAccessGrantTable.teamId,
    })
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.organizationId, organizationId),
      inArray(PluginAccessGrantTable.pluginId, pluginIds),
      isNull(PluginAccessGrantTable.removedAt),
    ))
  if (grants.some((grant) => pluginArchGrantExpandsAudience(grant, memberId))) return true

  const marketplaceMemberships = await db
    .select({ id: MarketplacePluginTable.id })
    .from(MarketplacePluginTable)
    .where(and(
      eq(MarketplacePluginTable.organizationId, organizationId),
      inArray(MarketplacePluginTable.pluginId, pluginIds),
      isNull(MarketplacePluginTable.removedAt),
    ))
  return marketplaceMemberships.length > 0
}

export async function pluginArchResourceHasExpandedAudience(input: ExposureResourceLookupInput) {
  if (input.resourceKind === "plugin") {
    return pluginIdsHaveExpandedAudience(input.context, [input.resourceId])
  }

  const organizationId = input.context.organizationContext.organization.id
  const memberId = input.context.organizationContext.currentMember.id
  const grants = await db
    .select({
      orgMembershipId: ConfigObjectAccessGrantTable.orgMembershipId,
      orgWide: ConfigObjectAccessGrantTable.orgWide,
      teamId: ConfigObjectAccessGrantTable.teamId,
    })
    .from(ConfigObjectAccessGrantTable)
    .where(and(
      eq(ConfigObjectAccessGrantTable.organizationId, organizationId),
      eq(ConfigObjectAccessGrantTable.configObjectId, input.resourceId),
      isNull(ConfigObjectAccessGrantTable.removedAt),
    ))
  if (grants.some((grant) => pluginArchGrantExpandsAudience(grant, memberId))) return true

  const memberships = await db
    .select({ pluginId: PluginConfigObjectTable.pluginId })
    .from(PluginConfigObjectTable)
    .where(and(
      eq(PluginConfigObjectTable.organizationId, organizationId),
      eq(PluginConfigObjectTable.configObjectId, input.resourceId),
      isNull(PluginConfigObjectTable.removedAt),
    ))
  return pluginIdsHaveExpandedAudience(input.context, memberships.map((membership) => membership.pluginId))
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
    const grants = await db
      .select({
        orgMembershipId: ConnectorInstanceAccessGrantTable.orgMembershipId,
        orgWide: ConnectorInstanceAccessGrantTable.orgWide,
        removedAt: ConnectorInstanceAccessGrantTable.removedAt,
        role: ConnectorInstanceAccessGrantTable.role,
        teamId: ConnectorInstanceAccessGrantTable.teamId,
      })
      .from(ConnectorInstanceAccessGrantTable)
      .where(and(
        eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, input.resourceId),
        eq(ConnectorInstanceAccessGrantTable.organizationId, input.context.organizationContext.organization.id),
      ))
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

export async function requirePluginArchCapability(context: PluginArchActorContext, capability: PluginArchCapability, requireFreshSession?: boolean) {
  if (hasPluginArchCapability(context, capability)) {
    if (requireFreshSession !== false) ensureFreshPluginArchAdmin(context)
    return
  }

  throw new PluginArchAuthorizationError(403, "forbidden", `Missing organization capability: ${capability}`)
}

export async function requirePluginArchResourceRole(input: {
  context: PluginArchActorContext
  requireFreshSession?: boolean
  resourceId: ConfigObjectId | ConnectorInstanceId | MarketplaceId | PluginId
  resourceKind: PluginArchResourceKind
  role: PluginArchRole
}) {
  if (input.role !== "viewer" && input.requireFreshSession !== false) {
    ensureFreshPluginArchAdmin(input.context)
  }

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
