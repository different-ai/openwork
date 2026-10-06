import type { MemberTeamSummary, OrganizationContext } from "../../orgs.js"
import { memberHasRole } from "../../routes/org/shared.js"

export type PluginArchRole = "viewer" | "editor" | "manager"

export type PluginArchActorContext = {
  apiKey?: true
  automation?: true
  memberTeams: MemberTeamSummary[]
  organizationContext: OrganizationContext
  session: { createdAt?: Date | string | null } | null | undefined
}

type MemberId = OrganizationContext["currentMember"]["id"]
type TeamId = MemberTeamSummary["id"]

type GrantRow = {
  orgMembershipId: MemberId | null
  orgWide: boolean
  removedAt: Date | null
  role: PluginArchRole
  teamId: TeamId | null
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

export function maxRole(current: PluginArchRole | null, candidate: PluginArchRole | null) {
  if (!candidate) return current
  if (!current) return candidate
  return rolePriority[candidate] > rolePriority[current] ? candidate : current
}

export function isPluginArchOrgAdmin(context: PluginArchActorContext) {
  return context.organizationContext.currentMember.isOwner || memberHasRole(context.organizationContext.currentMember.role, "admin")
}

export function roleSatisfies(role: PluginArchRole | null, required: PluginArchRole) {
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
