import { createAccessControl } from "better-auth/plugins/access"
import { defaultRoles, defaultStatements } from "better-auth/plugins/organization/access"

export const SECURITY_CONFIGURATION_PERMISSION_RESOURCE = "security_configuration"
export const SECURITY_CONFIGURATION_PERMISSION_ACTION = "manage"

const denOrganizationStatements = {
  ...defaultStatements,
  [SECURITY_CONFIGURATION_PERMISSION_RESOURCE]: [SECURITY_CONFIGURATION_PERMISSION_ACTION],
} as const

export const denOrganizationAccess = createAccessControl(denOrganizationStatements)

export type OrganizationPermissionRecord = Record<string, string[]>

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

const denOwnerRole = denOrganizationAccess.newRole({
  ...defaultRoles.owner.statements,
  [SECURITY_CONFIGURATION_PERMISSION_RESOURCE]: [SECURITY_CONFIGURATION_PERMISSION_ACTION],
})
const denAdminRole = denOrganizationAccess.newRole(defaultRoles.admin.statements)
const denMemberRole = denOrganizationAccess.newRole(defaultRoles.member.statements)

const denOrganizationPermissionCatalogEntries = Object.entries(denOrganizationStatements)

export const denOrganizationStaticRoles = {
  owner: denOwnerRole,
  admin: denAdminRole,
  member: denMemberRole,
} as const

export const denDefaultDynamicOrganizationRoles = {
  admin: defaultRoles.admin.statements,
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

export function canManageSecurityConfiguration(payload: SecurityConfigurationPermissionPayload | null | undefined) {
  if (!payload) {
    return false
  }

  if (payload.currentMember.isOwner) {
    return true
  }

  const permissions = resolveOrganizationPermissionRecord(payload.currentMember.role, payload.roles)
  return permissions[SECURITY_CONFIGURATION_PERMISSION_RESOURCE]?.includes(SECURITY_CONFIGURATION_PERMISSION_ACTION) ?? false
}
