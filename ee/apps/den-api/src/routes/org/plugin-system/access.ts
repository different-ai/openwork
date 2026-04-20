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
import { memberHasRole } from "../shared.js"

export type PluginArchResourceKind = "config_object" | "connector_instance" | "marketplace" | "plugin"
export type PluginArchRole = "viewer" | "editor" | "manager"
export type PluginArchCapability = "config_object.create" | "connector_account.create" | "connector_instance.create" | "marketplace.create" | "plugin.create"

export type PluginArchActorContext = {
  memberTeams: MemberTeamSummary[]
  organizationContext: OrganizationContext
}

type MemberId = OrganizationContext["currentMember"]["id"]
type TeamId = MemberTeamSummary["id"]
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

type RequireResourceRoleInput = ResourceLookupInput & { role: PluginArchRole }

export class PluginArchAuthorizationError extends Error {
  constructor(
    readonly status: 403,
    readonly error: "forbidden",
    message: string,
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

export function hasPluginArchCapability(context: PluginArchActorContext, _capability: PluginArchCapability) {
  return isPluginArchOrgAdmin(context)
}

function roleSatisfies(role: PluginArchRole | null, required: PluginArchRole) {
  if (!role) return false
  return rolePriority[role] >= rolePriority[required]
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
  if (pluginIds.length === 0) {
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
    .where(inArray(PluginAccessGrantTable.pluginId, pluginIds))

  return resolveGrantRole({ context, grants })
}

async function resolveMarketplaceRoleForIds(context: PluginArchActorContext, marketplaceIds: MarketplaceId[]) {
  if (marketplaceIds.length === 0) {
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
    .where(inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIds))

  return resolveGrantRole({ context, grants })
}

export async function resolvePluginArchResourceRole(input: ResourceLookupInput) {
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
      .where(eq(MarketplaceAccessGrantTable.marketplaceId, input.resourceId))
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
      .where(eq(PluginAccessGrantTable.pluginId, input.resourceId))
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
      .where(eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, input.resourceId))
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
    .where(eq(ConfigObjectAccessGrantTable.configObjectId, input.resourceId))

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
