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

export type AssignableOrganizationRole = "super-admin" | "admin" | "member"

export const ASSIGNABLE_ORGANIZATION_ROLES: readonly AssignableOrganizationRole[] = [
  ORGANIZATION_SUPER_ADMIN_ROLE,
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
]

function canonicalRoleName(role: string) {
  return role === ORGANIZATION_SUPER_ADMIN_ROLE ? ORGANIZATION_ADMIN_ROLE : role
}

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
  const roles = splitOrganizationRoles(roleValue)
  if (role === ORGANIZATION_SUPER_ADMIN_ROLE) return roles.includes(ORGANIZATION_SUPER_ADMIN_ROLE)
  const wanted = canonicalRoleName(role)
  return roles.some((entry) => canonicalRoleName(entry) === wanted)
}

export function isOrganizationSuperAdminRole(directRole: string) {
  return organizationRoleValueIncludes(directRole, ORGANIZATION_SUPER_ADMIN_ROLE)
    && !organizationRoleValueIncludes(directRole, ORGANIZATION_OWNER_ROLE)
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

export function assignableOrganizationRole(roleValue: string): AssignableOrganizationRole | null {
  const roles = splitOrganizationRoles(roleValue).map(normalizeOrganizationRoleName)
  if (roles.includes(ORGANIZATION_SUPER_ADMIN_ROLE)) return ORGANIZATION_SUPER_ADMIN_ROLE
  if (roles.includes(ORGANIZATION_ADMIN_ROLE)) return ORGANIZATION_ADMIN_ROLE
  if (roles.includes(ORGANIZATION_MEMBER_ROLE)) return ORGANIZATION_MEMBER_ROLE
  return null
}

export function isAssignableOrganizationRole(role: string): role is AssignableOrganizationRole {
  return role === ORGANIZATION_SUPER_ADMIN_ROLE || role === ORGANIZATION_ADMIN_ROLE || role === ORGANIZATION_MEMBER_ROLE
}

export function shouldRevokeSessionsForRoleChange(previousRole: string, nextRole: string) {
  if (previousRole === nextRole) {
    return false
  }

  const previousRoles = splitOrganizationRoles(previousRole)
  const nextRoles = splitOrganizationRoles(nextRole)
  if (previousRoles.length !== 1 || nextRoles.length !== 1) {
    return true
  }

  const previousLevel = builtInRoleLevel(previousRoles[0] ?? "")
  const nextLevel = builtInRoleLevel(nextRoles[0] ?? "")
  return previousLevel === null || nextLevel === null || nextLevel <= previousLevel
}

export function isEffectiveOrganizationAdmin(input: { directRole: string; adminTeamIds: readonly string[] }): boolean {
  if (input.adminTeamIds.length > 0) return true
  return organizationRoleValueIncludes(input.directRole, ORGANIZATION_ADMIN_ROLE)
}
