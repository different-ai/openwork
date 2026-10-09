import { permissionDefaultKeys, type PermissionKey } from "@openwork/types/den/permissions"
import type { MemberPermissions } from "./effective.js"

/**
 * Who may assign the organization admin role (docs/permissions/overview.md,
 * section 9). Pure, with no relative runtime imports, so plain `node --test`
 * can load it. team-grants.ts reads the roles and the Admin default set and
 * calls in.
 *
 * With the Permissions feature on (the owner bypasses all of these):
 * - Nobody may change their own role.
 * - Making someone an admin needs every key in the Admin default set (you
 *   can't grant what you don't hold). Only a member who already holds the
 *   admin role directly is exempt: a direct admin role outlives removal from
 *   an Admin team (e.g. by SCIM), so making a team-granted admin a direct
 *   admin still grants something durable and needs the full check.
 * - Changing a direct admin's role to member needs the caller to be an
 *   effective admin, so a team-granted `members.update` can't demote admins.
 *
 * With the feature off only the owner holds `members.update` (it was
 * super-admin only before Permissions), so these rules are skipped and the
 * owner decides every role change.
 */

export type RoleAssignmentCaller = Pick<MemberPermissions, "featureEnabled" | "isOwner" | "isAdmin" | "has">

/** The member whose role changes. Null for a new invitation. */
export type RoleAssignmentTarget = {
  memberId: string
  /** The stored `member.role` names admin (or legacy super-admin). Admin-team membership does not count. */
  isDirectAdmin: boolean
}

export type RoleAssignmentInput = {
  caller: RoleAssignmentCaller
  callerMemberId: string
  target: RoleAssignmentTarget | null
  /** The requested role names admin. */
  nextIsAdmin: boolean
}

export type RoleAssignmentDenial = {
  reason: "own_role" | "admin_permissions_missing" | "admin_role_change_requires_admin"
  message: string
  /** The first Admin default key the caller lacks, when that is the reason. */
  requiredPermission: PermissionKey | null
}

export const OWN_ROLE_CHANGE_MESSAGE = "You can't change your own role. Ask the owner or another admin."
export const ADMIN_ROLE_GRANT_FORBIDDEN_MESSAGE = "You can't make someone an admin because admins have permissions you don't have."
export const ADMIN_ROLE_CHANGE_REQUIRES_ADMIN_MESSAGE = "Only the owner or an admin can change an admin's role."

/** The first key (in sorted order) the caller lacks, or null when they hold all of them. The owner holds everything. */
export function firstMissingPermission(held: Pick<MemberPermissions, "isOwner" | "has">, keys: Iterable<PermissionKey>): PermissionKey | null {
  if (held.isOwner) return null
  const sorted = [...new Set(keys)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return sorted.find((key) => !held.has(key)) ?? null
}

/** Whether deciding needs the organization's Admin default keys (so callers skip the read otherwise). */
export function roleAssignmentNeedsAdminDefaultKeys(input: RoleAssignmentInput): boolean {
  if (input.caller.isOwner || !input.caller.featureEnabled) return false
  if (input.target && input.target.memberId === input.callerMemberId) return false
  return input.nextIsAdmin && !(input.target?.isDirectAdmin ?? false)
}

/**
 * Null when the caller may assign the requested role to the target. `adminDefaultKeys`
 * is the organization's Admin default set; when omitted the Admin code
 * defaults are used.
 */
export function decideRoleAssignment(
  input: RoleAssignmentInput & { adminDefaultKeys?: Iterable<PermissionKey> | null },
): RoleAssignmentDenial | null {
  const { caller, target } = input
  if (caller.isOwner || !caller.featureEnabled) return null

  if (target && target.memberId === input.callerMemberId) {
    return { reason: "own_role", message: OWN_ROLE_CHANGE_MESSAGE, requiredPermission: null }
  }

  if (input.nextIsAdmin && !(target?.isDirectAdmin ?? false)) {
    const missing = firstMissingPermission(caller, input.adminDefaultKeys ?? permissionDefaultKeys("admin"))
    return missing
      ? { reason: "admin_permissions_missing", message: ADMIN_ROLE_GRANT_FORBIDDEN_MESSAGE, requiredPermission: missing }
      : null
  }

  if (!input.nextIsAdmin && (target?.isDirectAdmin ?? false) && !caller.isAdmin) {
    return { reason: "admin_role_change_requires_admin", message: ADMIN_ROLE_CHANGE_REQUIRES_ADMIN_MESSAGE, requiredPermission: null }
  }

  return null
}

/**
 * The permission a route required, re-checked inside its write transaction
 * against the caller's permissions resolved there. A route that passes no
 * `requiredPermission` (invitation cancellation, SCIM deprovisioning) has its
 * own authorization and is not checked here; a required permission with no
 * caller fails closed. Null means allowed.
 */
export function decideRequiredPermission(input: {
  actor: Pick<MemberPermissions, "has"> | null
  requiredPermission: PermissionKey | undefined
}): { reason: "permission_not_held"; requiredPermission: PermissionKey } | null {
  if (!input.requiredPermission) return null
  if (input.actor?.has(input.requiredPermission)) return null
  return { reason: "permission_not_held", requiredPermission: input.requiredPermission }
}

export const ADMIN_REMOVAL_REQUIRES_ADMIN_MESSAGE = "Only the owner or an admin can remove an admin from the organization."

/**
 * Removing an admin: someone who holds the admin role directly, or is an
 * effective admin through an Admin team (authoritative membership, the same
 * rule permission resolution uses). With the Permissions feature on,
 * `members.delete` and `teams.manage_admin` can be granted to non-admins
 * through team sets, so removing an admin also needs the actor to be the
 * owner or an effective admin (the same rule as demoting one).
 * Pending-invitation placeholders hold no access yet and stay governed by the
 * invitation rules. With the feature off only admins hold `members.delete`,
 * so nothing changes. Null means allowed.
 */
export function decideMemberRemoval(input: {
  actor: Pick<MemberPermissions, "featureEnabled" | "isOwner" | "isAdmin">
  targetIsDirectAdmin: boolean
  /** The target is a member of an Admin team through a membership that carries authority. */
  targetIsAdminViaTeam: boolean
  targetIsPendingInvitation: boolean
}): { reason: "admin_removal_requires_admin"; message: string } | null {
  if (!input.actor.featureEnabled || input.actor.isOwner || input.actor.isAdmin) return null
  if (!(input.targetIsDirectAdmin || input.targetIsAdminViaTeam) || input.targetIsPendingInvitation) return null
  return { reason: "admin_removal_requires_admin", message: ADMIN_REMOVAL_REQUIRES_ADMIN_MESSAGE }
}

export const ADMIN_TEAM_REQUIRES_ADMIN_MESSAGE = "Only the owner or an admin can make a team an Admin team or add people to one."

/**
 * Making a team an Admin team, or adding people to one. Membership of an
 * Admin team makes someone an effective admin, which carries powers beyond the
 * catalog (changing Admin permissions, changing and removing admins). With the
 * Permissions feature on, `teams.manage_admin` can be granted to non-admins
 * through team sets, so these changes also need the actor to be the owner or
 * an effective admin. SCIM writes Admin-team membership through
 * scim-groups.ts, not this rule. With the feature off nothing changes. Null
 * means allowed.
 */
export function decideAdminTeamChange(input: {
  actor: Pick<MemberPermissions, "featureEnabled" | "isOwner" | "isAdmin">
  makesAdminTeam: boolean
  addsMembersToAdminTeam: boolean
}): { reason: "admin_team_requires_admin"; message: string } | null {
  if (!input.actor.featureEnabled || input.actor.isOwner || input.actor.isAdmin) return null
  if (!input.makesAdminTeam && !input.addsMembersToAdminTeam) return null
  return { reason: "admin_team_requires_admin", message: ADMIN_TEAM_REQUIRES_ADMIN_MESSAGE }
}
