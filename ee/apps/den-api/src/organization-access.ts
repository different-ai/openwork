import { createAccessControl } from "better-auth/plugins/access"
import { defaultRoles, defaultStatements } from "better-auth/plugins/organization/access"
import {
  ORGANIZATION_MEMBER_ROLE,
  ORGANIZATION_OWNER_ROLE,
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_SUPER_ADMIN_ROLE,
  normalizeOrganizationRoleName,
  organizationRoleValueSatisfies,
  splitOrganizationRoles,
} from "./organization-role-hierarchy.js"

export const SECURITY_CONFIGURATION_PERMISSION_RESOURCE = "security_configuration"
export const SECURITY_CONFIGURATION_PERMISSION_ACTION = "manage"

const denOrganizationStatements = {
  ...defaultStatements,
  [SECURITY_CONFIGURATION_PERMISSION_RESOURCE]: [SECURITY_CONFIGURATION_PERMISSION_ACTION],
} as const

export const denOrganizationAccess = createAccessControl(denOrganizationStatements)

export type OrganizationPermissionRecord = Record<string, readonly string[]>

export type OrganizationRolePermission = {
  role: string
  permission: OrganizationPermissionRecord
}

export type SecurityConfigurationPermissionPayload = {
  currentMember: {
    isOwner: boolean
    role: string
  }
  roles: readonly OrganizationRolePermission[]
}

type PermissionValidationResult = {
  ok: true
} | {
  ok: false
  error: "invalid_permission"
  message: string
}

type InvitationRoleValidationResult = {
  ok: true
  role: string
} | {
  ok: false
  error: "invalid_role" | "forbidden"
  message: string
}

const denOwnerStatements = {
  ...defaultRoles.owner.statements,
  [SECURITY_CONFIGURATION_PERMISSION_RESOURCE]: [SECURITY_CONFIGURATION_PERMISSION_ACTION],
} as const
const denAdminStatements = {
  invitation: ["create", "cancel"],
  member: ["delete"],
  team: ["create", "update", "delete"],
  ac: ["read"],
} as const

const denOwnerRole = denOrganizationAccess.newRole(denOwnerStatements)
const denSuperAdminRole = denOrganizationAccess.newRole(denOwnerStatements)
const denAdminRole = denOrganizationAccess.newRole(denAdminStatements)
const denMemberRole = denOrganizationAccess.newRole(defaultRoles.member.statements)

const denOrganizationPermissionCatalogEntries = Object.entries(denOrganizationStatements)

export const denOrganizationStaticRoles = {
  owner: denOwnerRole,
  "super-admin": denSuperAdminRole,
  admin: denAdminRole,
  member: denMemberRole,
} as const

export const denDefaultDynamicOrganizationRoles = {
  "super-admin": denOwnerStatements,
  admin: denAdminStatements,
  member: defaultRoles.member.statements,
} as const

function getAllowedPermissionActions(resource: string): readonly string[] | null {
  const entry = denOrganizationPermissionCatalogEntries.find(([knownResource]) => knownResource === resource)
  return entry?.[1] ?? null
}

function splitRoleValue(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function addPermissions(target: OrganizationPermissionRecord, source: OrganizationPermissionRecord) {
  for (const [resource, actions] of Object.entries(source)) {
    const merged = new Set(target[resource] ?? [])
    for (const action of actions) {
      merged.add(action)
    }
    target[resource] = [...merged]
  }
}

function hasPermission(permission: OrganizationPermissionRecord, resource: string, action: string) {
  return permission[resource]?.includes(action) ?? false
}

export function cloneOrganizationPermissionCatalog() {
  const permission: OrganizationPermissionRecord = {}
  for (const [resource, actions] of denOrganizationPermissionCatalogEntries) {
    permission[resource] = [...actions]
  }
  return permission
}

export function filterOrganizationPermissionRecord(permission: OrganizationPermissionRecord) {
  const filtered: OrganizationPermissionRecord = {}
  for (const [resource, actions] of Object.entries(permission)) {
    const allowedActions = getAllowedPermissionActions(resource)
    if (!allowedActions) {
      continue
    }

    const validActions = actions.filter((action) => allowedActions.includes(action))
    if (validActions.length > 0) {
      filtered[resource] = validActions
    }
  }
  return filtered
}

export function validateOrganizationPermissionRecord(permission: OrganizationPermissionRecord): PermissionValidationResult {
  for (const [resource, actions] of Object.entries(permission)) {
    const allowedActions = getAllowedPermissionActions(resource)
    if (!allowedActions) {
      return {
        ok: false,
        error: "invalid_permission",
        message: `Unsupported permission resource "${resource}".`,
      }
    }

    for (const action of actions) {
      if (!allowedActions.includes(action)) {
        return {
          ok: false,
          error: "invalid_permission",
          message: `Unsupported permission action "${resource}.${action}".`,
        }
      }
    }
  }

  return { ok: true }
}

export function resolveOrganizationPermissionRecord(roleValue: string, roles: readonly OrganizationRolePermission[]) {
  const roleNames = splitRoleValue(roleValue)
  const permission: OrganizationPermissionRecord = {}

  for (const role of roles) {
    if (!roleNames.includes(role.role)) {
      continue
    }
    addPermissions(permission, role.permission)
  }

  return filterOrganizationPermissionRecord(permission)
}

export function validateAssignableOrganizationPermissionRecord(input: {
  permission: OrganizationPermissionRecord
  roleValue: string
  roles: readonly OrganizationRolePermission[]
}): PermissionValidationResult {
  const validPermission = validateOrganizationPermissionRecord(input.permission)
  if (!validPermission.ok) {
    return validPermission
  }

  const assignablePermission = resolveOrganizationPermissionRecord(input.roleValue, input.roles)
  for (const [resource, actions] of Object.entries(input.permission)) {
    for (const action of actions) {
      if (!hasPermission(assignablePermission, resource, action)) {
        return {
          ok: false,
          error: "invalid_permission",
          message: `Cannot assign permission "${resource}.${action}".`,
        }
      }
    }
  }

  return { ok: true }
}

export function validateInvitationRoleAssignment(input: {
  role: string
  availableRoles: ReadonlySet<string>
  currentMember: {
    isOwner: boolean
    role: string
  }
  roles: readonly OrganizationRolePermission[]
}): InvitationRoleValidationResult {
  const requestedRoles = splitOrganizationRoles(input.role || ORGANIZATION_MEMBER_ROLE)
    .map((role) => normalizeOrganizationRoleName(role))
    .filter(Boolean)
  const roleValue = requestedRoles[0] ? requestedRoles.join(",") : ORGANIZATION_MEMBER_ROLE

  if (requestedRoles.includes(ORGANIZATION_OWNER_ROLE)) {
    return {
      ok: false,
      error: "forbidden",
      message: "Owner can only be assigned by the Den ownership transfer API.",
    }
  }

  const canInviteMembers = organizationRoleValueSatisfies({
    roleValue: input.currentMember.role,
    requiredRole: ORGANIZATION_ADMIN_ROLE,
    isOwner: input.currentMember.isOwner,
  })
  if (!canInviteMembers) {
    return {
      ok: false,
      error: "forbidden",
      message: "Only workspace owners and admins can create invitations.",
    }
  }

  const canAssignRoles = organizationRoleValueSatisfies({
    roleValue: input.currentMember.role,
    requiredRole: ORGANIZATION_SUPER_ADMIN_ROLE,
    isOwner: input.currentMember.isOwner,
  })
  if (!canAssignRoles) {
    if (roleValue === ORGANIZATION_MEMBER_ROLE) {
      return { ok: true, role: ORGANIZATION_MEMBER_ROLE }
    }

    return {
      ok: false,
      error: "forbidden",
      message: "Workspace admins can only invite members.",
    }
  }

  const missingRole = requestedRoles.find((role) => !input.availableRoles.has(role))
  if (missingRole) {
    return {
      ok: false,
      error: "invalid_role",
      message: "Choose one of the existing organization roles.",
    }
  }

  const assignableRole = validateAssignableOrganizationPermissionRecord({
    permission: resolveOrganizationPermissionRecord(roleValue, input.roles),
    roleValue: input.currentMember.role,
    roles: input.roles,
  })
  if (!assignableRole.ok) {
    return {
      ok: false,
      error: "forbidden",
      message: "You can only invite members into roles with permissions you already have.",
    }
  }

  return { ok: true, role: roleValue }
}

export function canManageSecurityConfiguration(payload: SecurityConfigurationPermissionPayload | null | undefined) {
  if (!payload) {
    return false
  }

  return organizationRoleValueSatisfies({
    roleValue: payload.currentMember.role,
    requiredRole: ORGANIZATION_SUPER_ADMIN_ROLE,
    isOwner: payload.currentMember.isOwner,
  })
}
