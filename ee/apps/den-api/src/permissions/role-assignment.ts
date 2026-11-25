import { permissionDefaultKeys, type PermissionKey } from "@openwork/types/den/permissions"
import type { MemberPermissions } from "./effective.js"

export type RoleAssignmentCaller = Pick<MemberPermissions, "isOwner" | "isSuperAdmin" | "isAdmin" | "has">

export function hasOwnerAuthority(held: Pick<MemberPermissions, "isOwner" | "isSuperAdmin">): boolean {
  return held.isOwner || held.isSuperAdmin
}

export type RoleAssignmentTarget = {
  memberId: string
  isDirectAdmin: boolean
  isDirectSuperAdmin: boolean
}

export type RoleAssignmentInput = {
  caller: RoleAssignmentCaller
  callerMemberId: string
  target: RoleAssignmentTarget | null
  nextIsAdmin: boolean
  nextIsSuperAdmin: boolean
}

export type RoleAssignmentDenial = {
  reason: "own_role" | "admin_permissions_missing" | "admin_grant_requires_admin" | "admin_role_change_requires_admin" | "super_admin_requires_super_admin" | "permission_not_held"
  message: string
  requiredPermission: PermissionKey | null
}

export const OWN_ROLE_CHANGE_MESSAGE = "You can't change your own role. Ask the owner or another admin."
export const SUPER_ADMIN_GRANT_REQUIRES_SUPER_ADMIN_MESSAGE = "Only the owner or a super admin can make someone a super admin."
export const SUPER_ADMIN_ROLE_CHANGE_REQUIRES_SUPER_ADMIN_MESSAGE = "Only the owner or a super admin can change a super admin's role."
export const SUPER_ADMIN_REMOVAL_REQUIRES_SUPER_ADMIN_MESSAGE = "Only the owner or a super admin can remove a super admin from the organization."
export const ADMIN_ROLE_GRANT_FORBIDDEN_MESSAGE = "You can't make someone an admin because admins have permissions you don't have."
export const ADMIN_ROLE_CHANGE_REQUIRES_ADMIN_MESSAGE = "Only the owner or an admin can change an admin's role."
export const ADMIN_GRANT_REQUIRES_ADMIN_MESSAGE = "Only the owner or an admin can make someone an admin."

export function adminGrantDenial(
  caller: Pick<MemberPermissions, "isOwner" | "isSuperAdmin" | "isAdmin" | "has">,
  adminDefaultKeys: Iterable<PermissionKey>,
): PermissionKey | "requires_admin" | null {
  if (caller.isOwner) return null
  if (!caller.isAdmin) return "requires_admin"
  return firstMissingPermission(caller, adminDefaultKeys)
}

export function firstMissingPermission(held: Pick<MemberPermissions, "isOwner" | "has">, keys: Iterable<PermissionKey>): PermissionKey | null {
  if (held.isOwner) return null
  const sorted = [...new Set(keys)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return sorted.find((key) => !held.has(key)) ?? null
}

export function roleAssignmentNeedsAdminDefaultKeys(input: RoleAssignmentInput): boolean {
  if (input.caller.isOwner) return false
  if ((input.nextIsSuperAdmin || input.target?.isDirectSuperAdmin) && !hasOwnerAuthority(input.caller)) return false
  if (input.target && input.target.memberId === input.callerMemberId) return false
  return input.nextIsAdmin && !(input.target?.isDirectAdmin ?? false)
}

export function decideRoleAssignment(
  input: RoleAssignmentInput & { adminDefaultKeys?: Iterable<PermissionKey> | null },
): RoleAssignmentDenial | null {
  const { caller, target } = input
  if (caller.isOwner) return null

  if (target && target.memberId === input.callerMemberId) {
    return { reason: "own_role", message: OWN_ROLE_CHANGE_MESSAGE, requiredPermission: null }
  }

  if (!hasOwnerAuthority(caller)) {
    if (input.nextIsSuperAdmin && !(target?.isDirectSuperAdmin ?? false)) {
      return { reason: "super_admin_requires_super_admin", message: SUPER_ADMIN_GRANT_REQUIRES_SUPER_ADMIN_MESSAGE, requiredPermission: null }
    }
    if (target?.isDirectSuperAdmin && !input.nextIsSuperAdmin) {
      return { reason: "super_admin_requires_super_admin", message: SUPER_ADMIN_ROLE_CHANGE_REQUIRES_SUPER_ADMIN_MESSAGE, requiredPermission: null }
    }
  }

  if (input.nextIsAdmin && !(target?.isDirectAdmin ?? false)) {
    const missing = adminGrantDenial(caller, input.adminDefaultKeys ?? permissionDefaultKeys("admin"))
    if (missing === "requires_admin") return { reason: "admin_grant_requires_admin", message: ADMIN_GRANT_REQUIRES_ADMIN_MESSAGE, requiredPermission: null }
    return missing
      ? { reason: "admin_permissions_missing", message: ADMIN_ROLE_GRANT_FORBIDDEN_MESSAGE, requiredPermission: missing }
      : null
  }

  if (!input.nextIsAdmin && (target?.isDirectAdmin ?? false) && !caller.isAdmin) {
    return { reason: "admin_role_change_requires_admin", message: ADMIN_ROLE_CHANGE_REQUIRES_ADMIN_MESSAGE, requiredPermission: null }
  }

  return null
}

export function decideRequiredPermission(input: {
  actor: Pick<MemberPermissions, "has"> | null
  requiredPermission: PermissionKey | undefined
}): { reason: "permission_not_held"; requiredPermission: PermissionKey } | null {
  if (!input.requiredPermission) return null
  if (input.actor?.has(input.requiredPermission)) return null
  return { reason: "permission_not_held", requiredPermission: input.requiredPermission }
}

export const ADMIN_REMOVAL_REQUIRES_ADMIN_MESSAGE = "Only the owner or an admin can remove an admin from the organization."

export function decideMemberRemoval(input: {
  actor: Pick<MemberPermissions, "isOwner" | "isSuperAdmin" | "isAdmin">
  targetIsDirectSuperAdmin?: boolean
  targetIsDirectAdmin: boolean
  targetIsAdminViaTeam: boolean
  targetIsPendingInvitation: boolean
}): { reason: "admin_removal_requires_admin" | "super_admin_removal_requires_super_admin"; message: string } | null {
  if (hasOwnerAuthority(input.actor)) return null
  if (input.targetIsDirectSuperAdmin && !input.targetIsPendingInvitation) {
    return { reason: "super_admin_removal_requires_super_admin", message: SUPER_ADMIN_REMOVAL_REQUIRES_SUPER_ADMIN_MESSAGE }
  }
  if (input.actor.isAdmin) return null
  if (!(input.targetIsDirectAdmin || input.targetIsAdminViaTeam) || input.targetIsPendingInvitation) return null
  return { reason: "admin_removal_requires_admin", message: ADMIN_REMOVAL_REQUIRES_ADMIN_MESSAGE }
}

export const SCIM_SUPER_ADMIN_REMOVAL_MESSAGE = "SCIM can remove a super admin only when the SCIM connection was set up by the owner or a super admin. Ask the owner to remove them, or to set up SCIM again."

export function decideActorlessSuperAdminRemoval(input: {
  targetIsDirectSuperAdmin: boolean
  targetIsPendingInvitation: boolean
  authority: Pick<MemberPermissions, "isOwner" | "isSuperAdmin"> | null
}): { reason: "scim_super_admin_removal_requires_super_admin"; message: string } | null {
  if (!input.targetIsDirectSuperAdmin || input.targetIsPendingInvitation) return null
  if (input.authority && hasOwnerAuthority(input.authority)) return null
  return { reason: "scim_super_admin_removal_requires_super_admin", message: SCIM_SUPER_ADMIN_REMOVAL_MESSAGE }
}

export const ADMIN_TEAM_REQUIRES_ADMIN_MESSAGE = "Only the owner or an admin can make a team an Admin team or add people to one."
export const ADMIN_TEAM_REMOVAL_REQUIRES_ADMIN_MESSAGE = "Only the owner or an admin can delete an Admin team, turn it off, or remove people from it."

export function decideAdminTeamChange(input: {
  actor: Pick<MemberPermissions, "isOwner" | "isSuperAdmin" | "isAdmin">
  makesAdminTeam?: boolean
  addsMembersToAdminTeam?: boolean
  unmakesAdminTeam?: boolean
  removesMembersFromAdminTeam?: boolean
  deletesAdminTeam?: boolean
}): { reason: "admin_team_requires_admin"; message: string } | null {
  if (hasOwnerAuthority(input.actor) || input.actor.isAdmin) return null
  if (input.makesAdminTeam || input.addsMembersToAdminTeam) return { reason: "admin_team_requires_admin", message: ADMIN_TEAM_REQUIRES_ADMIN_MESSAGE }
  if (input.unmakesAdminTeam || input.removesMembersFromAdminTeam || input.deletesAdminTeam) {
    return { reason: "admin_team_requires_admin", message: ADMIN_TEAM_REMOVAL_REQUIRES_ADMIN_MESSAGE }
  }
  return null
}
