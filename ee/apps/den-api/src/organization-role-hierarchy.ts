export const ORGANIZATION_OWNER_ROLE = "owner"
export const ORGANIZATION_ADMIN_ROLE = "admin"
export const ORGANIZATION_MEMBER_ROLE = "member"

export type BuiltInOrganizationRole = "owner" | "admin" | "member"

export const BUILT_IN_ORGANIZATION_ROLES: readonly BuiltInOrganizationRole[] = [
  ORGANIZATION_OWNER_ROLE,
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
]

/** Roles an invitation or a member role change may assign. Owner moves only by ownership transfer. */
export type AssignableOrganizationRole = "admin" | "member"

export const ASSIGNABLE_ORGANIZATION_ROLES: readonly AssignableOrganizationRole[] = [
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
]

/**
 * Super-admin was merged into admin, and custom roles were removed (migration
 * 0133_deprecate_super_admin rewrites stored role lists to member / admin / owner).
 * A stray value, e.g. from an old invitation link or a client that still sends
 * it, is read as admin rather than rejected or treated as a custom role.
 */
const LEGACY_SUPER_ADMIN_ROLE = "super-admin"

function canonicalRoleName(role: string) {
  return role === LEGACY_SUPER_ADMIN_ROLE ? ORGANIZATION_ADMIN_ROLE : role
}

function builtInRoleLevel(role: string) {
  switch (canonicalRoleName(role)) {
    case ORGANIZATION_OWNER_ROLE:
      return 2
    case ORGANIZATION_ADMIN_ROLE:
      return 1
    case ORGANIZATION_MEMBER_ROLE:
      return 0
    default:
      return null
  }
}

export function splitOrganizationRoles(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function normalizeOrganizationRoleName(value: string) {
  return canonicalRoleName(value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-"))
}

export function organizationRoleValueIncludes(roleValue: string, role: string) {
  const wanted = canonicalRoleName(role)
  return splitOrganizationRoles(roleValue).some((entry) => canonicalRoleName(entry) === wanted)
}

export function organizationRoleSatisfies(assignedRole: string, requiredRole: string) {
  if (requiredRole === ORGANIZATION_MEMBER_ROLE) {
    return true
  }

  const requiredLevel = builtInRoleLevel(requiredRole)
  if (requiredLevel === null) {
    return assignedRole === requiredRole
  }

  const assignedLevel = builtInRoleLevel(assignedRole)
  return assignedLevel !== null && assignedLevel >= requiredLevel
}

export function organizationRoleValueSatisfies(input: {
  roleValue: string
  requiredRole: string
  isOwner?: boolean
}) {
  const roles = splitOrganizationRoles(input.roleValue)
  if (input.isOwner && !roles.includes(ORGANIZATION_OWNER_ROLE)) {
    roles.push(ORGANIZATION_OWNER_ROLE)
  }

  return roles.some((role) => organizationRoleSatisfies(role, input.requiredRole))
}

/**
 * The built-in role an invitation or role change assigns: `admin` when the
 * value names admin (or legacy super-admin), else `member`. Owner and custom
 * role names are dropped; custom roles were removed and never authorized
 * anything beyond member. Returns null when nothing assignable is named.
 */
export function assignableOrganizationRole(roleValue: string): AssignableOrganizationRole | null {
  const roles = splitOrganizationRoles(roleValue).map(normalizeOrganizationRoleName)
  if (roles.includes(ORGANIZATION_ADMIN_ROLE)) return ORGANIZATION_ADMIN_ROLE
  if (roles.includes(ORGANIZATION_MEMBER_ROLE)) return ORGANIZATION_MEMBER_ROLE
  return null
}

export function isAssignableOrganizationRole(role: string): role is AssignableOrganizationRole {
  return role === ORGANIZATION_ADMIN_ROLE || role === ORGANIZATION_MEMBER_ROLE
}

export function shouldRevokeSessionsForRoleChange(previousRole: string, nextRole: string) {
  if (previousRole === nextRole) {
    return false
  }

  const previousRoles = splitOrganizationRoles(previousRole)
  const nextRoles = splitOrganizationRoles(nextRole)
  // Only single built-in roles have a provable ordering; ambiguous changes fail closed.
  if (previousRoles.length !== 1 || nextRoles.length !== 1) {
    return true
  }

  const previousLevel = builtInRoleLevel(previousRoles[0] ?? "")
  const nextLevel = builtInRoleLevel(nextRoles[0] ?? "")
  return previousLevel === null || nextLevel === null || nextLevel <= previousLevel
}

/**
 * Effective admin status for permissions (Admin defaults apply): a direct
 * admin role, or membership of a team that grants organization admin.
 */
export function isEffectiveOrganizationAdmin(input: { directRole: string; adminTeamIds: readonly string[] }): boolean {
  if (input.adminTeamIds.length > 0) return true
  return organizationRoleValueIncludes(input.directRole, ORGANIZATION_ADMIN_ROLE)
}
