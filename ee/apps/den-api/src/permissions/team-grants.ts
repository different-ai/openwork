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
import { ORGANIZATION_ADMIN_ROLE, organizationRoleValueIncludes } from "../organization-role-hierarchy.js"
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

/**
 * What joining a team grants (docs/permissions/overview.md, section 9.3):
 * the keys its active team permission sets allow, plus the Admin default keys
 * when the team is an Admin team. Only meaningful with the Permissions
 * feature on; with it off team sets do not apply and Admin teams are gated by
 * `teams.manage_admin` alone.
 */

type OrganizationId = typeof TeamTable.$inferSelect.organizationId
type TeamId = typeof TeamTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

const logger = appLogger.child({ component: "permissions" })

export const TEAM_GRANTS_FORBIDDEN_MESSAGE = "You can't add people to this team because it grants permissions you don't have."
export const ADMIN_TEAM_GRANTS_FORBIDDEN_MESSAGE = "You can't make this an Admin team because Admin permissions include permissions you don't have."

/**
 * Keys the organization's Admin default set allows. A missing set throws
 * DefaultPermissionSetsMissingError: callers run with the feature on, where the
 * set is created before any check, so a missing set is a data problem and these
 * grant checks fail closed rather than assuming the code defaults.
 */
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

/** Keys the team's active team permission sets allow (not the Admin defaults). */
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

/**
 * Share-locks what a team grant decision reads, in a fixed order and before
 * any team link or permission history row: the actor's team rows, then every
 * permission_set row of the organization (a handful; the decision reads the
 * default sets, the actor's team sets and the target team's sets). Callers
 * already hold the organization row and, when editing a team, that team's
 * row FOR UPDATE.
 *
 * Why this order cannot deadlock with permission set writes, none of which
 * touch the organization row or team memberships:
 * - Editing a set locks its permission_set row FOR UPDATE, then reads and
 *   inserts its history. Archiving a set locks its row, then its team links.
 *   Both take the set row first, as this does before reading links or
 *   history, so whichever transaction reaches the set row second waits
 *   holding nothing the other needs.
 * - Creating a team set locks the team row FOR UPDATE, then inserts the set,
 *   its link and history. Team rows are locked here before any permission_set
 *   row, so a create for one of these teams finishes first or waits for this;
 *   a create for another team never needs anything held here.
 */
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

/**
 * Safety rule 9.3 (docs/permissions/overview.md), decided inside the team's
 * write transaction `tx`: with the Permissions feature on, the actor must hold
 * every key members would gain (the team's sets unless `adminDefaultsOnly`,
 * plus the Admin defaults when `grantsOrganizationAdmin`). Granting admin with
 * an empty Admin default set needs the owner or an effective admin
 * (adminGrantDenial). The actor and every set are read through `tx` under
 * share locks (lockTeamGrantInputs, taken by resolveTeamActorInTransaction),
 * so a concurrent permission set edit either commits first and is seen, or
 * waits for the membership write.
 */
export async function teamGrantDecisionInTransaction(input: {
  tx: PermissionDatabase
  organizationId: OrganizationId
  /** The actor from resolveTeamActorInTransaction in this same transaction. */
  actor: MemberPermissions
  /** The team members join; null for a team being created (no sets yet). */
  teamId: TeamId | null
  grantsOrganizationAdmin: boolean
  /** Only the Admin defaults count (making an existing team an Admin team). */
  adminDefaultsOnly?: boolean
}): Promise<TeamGrantDecision> {
  const { actor } = input
  if (!actor.featureEnabled || actor.isOwner) return { ok: true }
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

/**
 * The actor of a team write, resolved once per transaction through `tx`
 * after lockTeamGrantInputs, so every check in that transaction (teams.manage,
 * teams.manage_admin, the Admin-team rule and safety rule 9.3) reads the same
 * locked snapshot. Callers hold the organization row and, when editing or
 * deleting a team, that team's row FOR UPDATE first.
 */
export async function resolveTeamActorInTransaction(tx: PermissionDatabase, organizationId: OrganizationId, actorMemberId: MemberId): Promise<MemberPermissions> {
  await lockTeamGrantInputs(tx, organizationId, actorMemberId)
  return resolvePermissionsForMember({ organizationId, memberId: actorMemberId, database: tx })
}

/** 403 body for a team grant the caller does not fully hold. */
export function teamGrantsForbiddenResponse(key: PermissionKey, message = TEAM_GRANTS_FORBIDDEN_MESSAGE): PermissionDeniedResponse {
  return { ...permissionDeniedResponse(key), message }
}

/** The role-change target built from a stored `member.role`, e.g. a row locked inside the update transaction. */
export function roleAssignmentTargetFromRole(memberId: string, role: string): RoleAssignmentTarget {
  return { memberId, isDirectAdmin: organizationRoleValueIncludes(role, ORGANIZATION_ADMIN_ROLE) }
}

/**
 * The role-change target: whether its stored role names admin. Admin-team
 * membership does not count (src/permissions/role-assignment.ts). Null when
 * the member is not active in the organization.
 */
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

/**
 * Who may assign `nextRole`, decided inside the write transaction `tx`: the
 * caller's permissions are re-resolved through it and the Admin default set is
 * re-read with share locks on its permission_set row and permission rows. An
 * Admin permissions edit locks that row FOR UPDATE first (lockPermissionSet),
 * so it and this decision serialize: the role write either sees the edit or
 * commits before it. Use after a pre-transaction check (roleAssignmentDecider)
 * that gives the quick 403.
 */
export async function roleAssignmentDenialInTransaction(input: {
  tx: PermissionDatabase
  organizationId: OrganizationId
  callerMemberId: MemberId
  target: RoleAssignmentTarget | null
  nextRole: string
  /**
   * The permission the route required (members.update for a role change), re-checked against the
   * caller resolved through `tx` before the role rules; a caller who lost it is refused.
   */
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
  }
  const adminDefaultKeys = roleAssignmentNeedsAdminDefaultKeys(decision)
    ? await adminDefaultPermissionKeys(input.organizationId, input.tx, { lock: "share" })
    : null
  return decideRoleAssignment({ ...decision, adminDefaultKeys })
}

/**
 * Who may assign `nextRole` (src/permissions/role-assignment.ts), as a
 * synchronous decision over any target. The Admin default set is read up
 * front whenever some target could need it, so the decision can be re-run on
 * a row locked inside a transaction without further reads.
 */
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
  }
  const adminDefaultKeys = roleAssignmentNeedsAdminDefaultKeys({ ...decision, target: null })
    ? await adminDefaultPermissionKeys(input.organizationId, input.database ?? db)
    : null
  return (target) => decideRoleAssignment({ ...decision, target, adminDefaultKeys })
}

/**
 * Who may assign a role: `target` is null for a new invitation. Null means
 * allowed.
 */
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

/** 403 body for a denied role assignment: requiredPermission when a missing key is the reason. */
export function roleAssignmentDeniedResponse(denial: RoleAssignmentDenial): RoleAssignmentDeniedResponse {
  if (denial.requiredPermission) return { ...permissionDeniedResponse(denial.requiredPermission), message: denial.message }
  return { error: "forbidden", ...requiresAdminError(denial.message) }
}

/** Headers for a denied role assignment: the insufficient-scope challenge when a missing permission is the reason. */
export function roleAssignmentDeniedHeaders(denial: RoleAssignmentDenial): Record<string, string> {
  return denial.requiredPermission ? { "WWW-Authenticate": INSUFFICIENT_SCOPE_CHALLENGE } : {}
}
