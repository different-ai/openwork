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
 *   can't grant what you don't hold). Someone who is already an effective
 *   admin (directly or through an Admin team) gains nothing new.
 * - Changing a direct admin's role to member needs the caller to be an
 *   effective admin, so a team-granted `members.update` can't demote admins.
 *
 * With the feature off only admins hold `members.update` and every admin holds
 * the Admin defaults, so these rules are skipped and behaviour is unchanged.
 */

export type RoleAssignmentCaller = Pick<MemberPermissions, "featureEnabled" | "isOwner" | "isAdmin" | "has">

/** The member whose role changes. Null for a new invitation. */
export type RoleAssignmentTarget = {
  memberId: string
  /** The stored `member.role` names admin (or legacy super-admin). */
  isDirectAdmin: boolean
  /** Direct admin role or membership of an Admin team. */
  isEffectiveAdmin: boolean
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
  return input.nextIsAdmin && !(input.target?.isEffectiveAdmin ?? false)
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

  if (input.nextIsAdmin && !(target?.isEffectiveAdmin ?? false)) {
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
