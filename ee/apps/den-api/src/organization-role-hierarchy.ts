export const ORGANIZATION_OWNER_ROLE = "owner"
export const ORGANIZATION_SUPER_ADMIN_ROLE = "super-admin"
export const ORGANIZATION_ADMIN_ROLE = "admin"
export const ORGANIZATION_MEMBER_ROLE = "member"

export type BuiltInOrganizationRole = "owner" | "super-admin" | "admin" | "member"

export const BUILT_IN_ORGANIZATION_ROLES: readonly BuiltInOrganizationRole[] = [
  ORGANIZATION_OWNER_ROLE,
  ORGANIZATION_SUPER_ADMIN_ROLE,
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
]

function builtInRoleLevel(role: string) {
  switch (role) {
    case ORGANIZATION_OWNER_ROLE:
      return 3
    case ORGANIZATION_SUPER_ADMIN_ROLE:
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
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
}

export function organizationRoleValueIncludes(roleValue: string, role: string) {
  return splitOrganizationRoles(roleValue).includes(role)
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

export function isProtectedOrganizationRoleName(role: string) {
  return BUILT_IN_ORGANIZATION_ROLES.some((builtInRole) => builtInRole === role)
}
