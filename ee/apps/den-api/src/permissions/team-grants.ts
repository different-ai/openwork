import type { PermissionKey } from "@openwork/types/den/permissions"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import {
  allowedKeys,
  DefaultPermissionSetsMissingError,
  getDefaultPermissionSets,
  listActiveTeamPermissionSetsForTeams,
  readPermissionSetStates,
  type PermissionDatabase,
} from "@openwork-ee/den-db/permissions"
import { MemberTable, PermissionSetTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { INSUFFICIENT_SCOPE_CHALLENGE, requiresAdminError, type AgentErrorEnvelope } from "../agent-error-envelope.js"
import { db } from "../db.js"
import { appLogger } from "../observability/logger.js"
import { ORGANIZATION_ADMIN_ROLE, ORGANIZATION_SUPER_ADMIN_ROLE, organizationRoleValueIncludes } from "../organization-role-hierarchy.js"
import { permissionDeniedResponse, type PermissionDeniedResponse } from "./check.js"
import { permissionDeniedMessage, type MemberPermissions } from "./effective.js"
import { resolvePermissionsForMember } from "./resolve.js"
import {
  adminGrantDenial,
  decideRequiredPermission,
  decideRoleAssignment,
  firstMissingPermission,
  roleAssignmentNeedsAdminDefaultKeys,
  type RoleAssignmentDenial,
  type RoleAssignmentTarget,
} from "./role-assignment.js"

export { firstMissingPermission, type RoleAssignmentDenial, type RoleAssignmentTarget } from "./role-assignment.js"

type OrganizationId = typeof TeamTable.$inferSelect.organizationId
type TeamId = typeof TeamTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

const logger = appLogger.child({ component: "permissions" })

export const TEAM_GRANTS_FORBIDDEN_MESSAGE = "You can't add people to this team because it grants permissions you don't have."
export const ADMIN_TEAM_GRANTS_FORBIDDEN_MESSAGE = "You can't make this an Admin team because Admin permissions include permissions you don't have."

export async function adminDefaultPermissionKeys(
  organizationId: OrganizationId,
  database: PermissionDatabase = db,
  options: { lock?: "share" } = {},
): Promise<Set<PermissionKey>> {
  const sets = await getDefaultPermissionSets(database, organizationId, options)
  if (!sets.admin) {
    logger.error("admin default permission set missing", { organization_id: organizationId })
    throw new DefaultPermissionSetsMissingError(organizationId)
  }
  const states = await readPermissionSetStates(database, [sets.admin.id], options)
  return allowedKeys(states.get(sets.admin.id))
}

async function teamSetPermissionKeys(
  database: PermissionDatabase,
  organizationId: OrganizationId,
  teamId: TeamId,
  options: { lock?: "share" } = {},
): Promise<Set<PermissionKey>> {
  const teamSets = await listActiveTeamPermissionSetsForTeams(database, organizationId, [teamId], options)
  const keys = new Set<PermissionKey>()
  if (teamSets.length === 0) return keys
  const states = await readPermissionSetStates(database, teamSets.map((teamSet) => teamSet.permissionSetId), options)
  for (const teamSet of teamSets) {
    for (const key of allowedKeys(states.get(teamSet.permissionSetId))) keys.add(key)
  }
  return keys
}

async function lockTeamGrantInputs(tx: PermissionDatabase, organizationId: OrganizationId, actorMemberId: MemberId) {
  await tx.select({ id: TeamTable.id })
    .from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamMemberTable.orgMembershipId, actorMemberId)))
    .for("share")
  await tx.select({ id: PermissionSetTable.id })
    .from(PermissionSetTable)
    .where(eq(PermissionSetTable.organizationId, organizationId))
    .for("share")
}

export type TeamGrantDecision =
  | { ok: true }
  | { ok: false; reason: "permission_missing"; requiredPermission: PermissionKey }
  | { ok: false; reason: "requires_admin" }

export async function teamGrantDecisionInTransaction(input: {
  tx: PermissionDatabase
  organizationId: OrganizationId
  actor: MemberPermissions
  teamId: TeamId | null
  grantsOrganizationAdmin: boolean
  adminDefaultsOnly?: boolean
}): Promise<TeamGrantDecision> {
  const { actor } = input
  if (actor.isOwner) return { ok: true }
  const teamKeys = input.teamId && !input.adminDefaultsOnly
    ? await teamSetPermissionKeys(input.tx, input.organizationId, input.teamId, { lock: "share" })
    : new Set<PermissionKey>()
  if (input.grantsOrganizationAdmin) {
    const adminDenial = adminGrantDenial(actor, await adminDefaultPermissionKeys(input.organizationId, input.tx, { lock: "share" }))
    if (adminDenial === "requires_admin") return { ok: false, reason: "requires_admin" }
    if (adminDenial) return { ok: false, reason: "permission_missing", requiredPermission: adminDenial }
  }
  const missing = firstMissingPermission(actor, teamKeys)
  return missing ? { ok: false, reason: "permission_missing", requiredPermission: missing } : { ok: true }
}

export async function resolveTeamActorInTransaction(tx: PermissionDatabase, organizationId: OrganizationId, actorMemberId: MemberId): Promise<MemberPermissions> {
  await lockTeamGrantInputs(tx, organizationId, actorMemberId)
  return resolvePermissionsForMember({ organizationId, memberId: actorMemberId, database: tx })
}

export function teamGrantsForbiddenResponse(key: PermissionKey, message = TEAM_GRANTS_FORBIDDEN_MESSAGE): PermissionDeniedResponse {
  return { ...permissionDeniedResponse(key), message }
}

export function roleAssignmentTargetFromRole(memberId: string, role: string): RoleAssignmentTarget {
  return {
    memberId,
    isDirectAdmin: organizationRoleValueIncludes(role, ORGANIZATION_ADMIN_ROLE),
    isDirectSuperAdmin: organizationRoleValueIncludes(role, ORGANIZATION_SUPER_ADMIN_ROLE),
  }
}

export async function roleAssignmentTarget(
  organizationId: OrganizationId,
  memberId: MemberId,
  database: PermissionDatabase = db,
): Promise<RoleAssignmentTarget | null> {
  const [member] = await database.select({ role: MemberTable.role })
    .from(MemberTable)
    .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
    .limit(1)
  return member ? roleAssignmentTargetFromRole(memberId, member.role) : null
}

export type RoleAssignmentDecider = (target: RoleAssignmentTarget | null) => RoleAssignmentDenial | null

export async function roleAssignmentDenialInTransaction(input: {
  tx: PermissionDatabase
  organizationId: OrganizationId
  callerMemberId: MemberId
  target: RoleAssignmentTarget | null
  nextRole: string
  requiredPermission?: PermissionKey
}): Promise<RoleAssignmentDenial | null> {
  const caller = await resolvePermissionsForMember({ organizationId: input.organizationId, memberId: input.callerMemberId, database: input.tx })
  const permissionDenial = decideRequiredPermission({ actor: caller, requiredPermission: input.requiredPermission })
  if (permissionDenial) {
    return { reason: "permission_not_held", message: permissionDeniedMessage(permissionDenial.requiredPermission), requiredPermission: permissionDenial.requiredPermission }
  }
  const decision = {
    caller,
    callerMemberId: input.callerMemberId,
    target: input.target,
    nextIsAdmin: organizationRoleValueIncludes(input.nextRole, ORGANIZATION_ADMIN_ROLE),
    nextIsSuperAdmin: organizationRoleValueIncludes(input.nextRole, ORGANIZATION_SUPER_ADMIN_ROLE),
  }
  const adminDefaultKeys = roleAssignmentNeedsAdminDefaultKeys(decision)
    ? await adminDefaultPermissionKeys(input.organizationId, input.tx, { lock: "share" })
    : null
  return decideRoleAssignment({ ...decision, adminDefaultKeys })
}

export async function roleAssignmentDecider(input: {
  organizationId: OrganizationId
  caller: MemberPermissions
  callerMemberId: string
  nextRole: string
  database?: PermissionDatabase
}): Promise<RoleAssignmentDecider> {
  const decision = {
    caller: input.caller,
    callerMemberId: input.callerMemberId,
    nextIsAdmin: organizationRoleValueIncludes(input.nextRole, ORGANIZATION_ADMIN_ROLE),
    nextIsSuperAdmin: organizationRoleValueIncludes(input.nextRole, ORGANIZATION_SUPER_ADMIN_ROLE),
  }
  const adminDefaultKeys = roleAssignmentNeedsAdminDefaultKeys({ ...decision, target: null })
    ? await adminDefaultPermissionKeys(input.organizationId, input.database ?? db)
    : null
  return (target) => decideRoleAssignment({ ...decision, target, adminDefaultKeys })
}

export async function roleAssignmentDenial(input: {
  organizationId: OrganizationId
  caller: MemberPermissions
  callerMemberId: string
  target: RoleAssignmentTarget | null
  nextRole: string
  database?: PermissionDatabase
}): Promise<RoleAssignmentDenial | null> {
  const decide = await roleAssignmentDecider(input)
  return decide(input.target)
}

export type RoleAssignmentDeniedResponse = PermissionDeniedResponse | (AgentErrorEnvelope & { error: "forbidden" })

export function roleAssignmentDeniedResponse(denial: RoleAssignmentDenial): RoleAssignmentDeniedResponse {
  if (denial.requiredPermission) return { ...permissionDeniedResponse(denial.requiredPermission), message: denial.message }
  return { error: "forbidden", ...requiresAdminError(denial.message) }
}

export function roleAssignmentDeniedHeaders(denial: RoleAssignmentDenial): Record<string, string> {
  return denial.requiredPermission ? { "WWW-Authenticate": INSUFFICIENT_SCOPE_CHALLENGE } : {}
}
