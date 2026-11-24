import type { PermissionKey } from "@openwork/types/den/permissions"
import type { RoleAssignmentDenial } from "./permissions/role-assignment.js"
import { createAccessControl } from "better-auth/plugins/access"
import { defaultRoles, defaultStatements } from "better-auth/plugins/organization/access"
import {
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
  ORGANIZATION_OWNER_ROLE,
  ORGANIZATION_SUPER_ADMIN_ROLE,
  isAssignableOrganizationRole,
  normalizeOrganizationRoleName,
  splitOrganizationRoles,
  type AssignableOrganizationRole,
} from "./organization-role-hierarchy.js"

export const SECURITY_CONFIGURATION_PERMISSION_RESOURCE = "security_configuration"
export const SECURITY_CONFIGURATION_PERMISSION_ACTION = "manage"

const denOrganizationStatements = {
  ...defaultStatements,
  [SECURITY_CONFIGURATION_PERMISSION_RESOURCE]: [SECURITY_CONFIGURATION_PERMISSION_ACTION],
} as const

export const denOrganizationAccess = createAccessControl(denOrganizationStatements)

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

export const denOrganizationStaticRoles = {
  owner: denOrganizationAccess.newRole(denOwnerStatements),
  "super-admin": denOrganizationAccess.newRole(denOwnerStatements),
  admin: denOrganizationAccess.newRole(denAdminStatements),
  member: denOrganizationAccess.newRole(defaultRoles.member.statements),
} as const

export type PermissionHolder = {
  isOwner: boolean
  isSuperAdmin: boolean
  has(key: PermissionKey): boolean
}

export type InvitationRoleValidationResult = {
  ok: true
  role: AssignableOrganizationRole
} | {
  ok: false
  error: "invalid_role" | "forbidden"
  message: string
  requiredPermission?: PermissionKey
}

export async function validateInvitationRoleAssignment(input: {
  role: string
  permissions: PermissionHolder
  decideAdminAssignment: (role: typeof ORGANIZATION_ADMIN_ROLE | typeof ORGANIZATION_SUPER_ADMIN_ROLE) => Promise<RoleAssignmentDenial | null>
}): Promise<InvitationRoleValidationResult> {
  const requestedRoles = [...new Set(splitOrganizationRoles(input.role || ORGANIZATION_MEMBER_ROLE)
    .map((role) => normalizeOrganizationRoleName(role))
    .filter(Boolean))]

  if (requestedRoles.includes(ORGANIZATION_OWNER_ROLE)) {
    return {
      ok: false,
      error: "forbidden",
      message: "Owner can only be assigned by the Den ownership transfer API.",
    }
  }

  if (!input.permissions.has("invitations.manage")) {
    return {
      ok: false,
      error: "forbidden",
      message: "You don't have permission to invite members. Ask an admin to change your permissions.",
    }
  }

  if (requestedRoles.some((role) => !isAssignableOrganizationRole(role))) {
    return {
      ok: false,
      error: "invalid_role",
      message: "Choose Member, Admin or Super admin.",
    }
  }

  const grantsSuperAdmin = requestedRoles.includes(ORGANIZATION_SUPER_ADMIN_ROLE)
  if (!grantsSuperAdmin && !requestedRoles.includes(ORGANIZATION_ADMIN_ROLE)) {
    return { ok: true, role: ORGANIZATION_MEMBER_ROLE }
  }
  const role = grantsSuperAdmin ? ORGANIZATION_SUPER_ADMIN_ROLE : ORGANIZATION_ADMIN_ROLE

  if (grantsSuperAdmin && !input.permissions.isOwner && !input.permissions.isSuperAdmin) {
    return {
      ok: false,
      error: "forbidden",
      message: "Only the owner or a super admin can invite someone as a super admin.",
    }
  }

  if (!input.permissions.has("members.update")) {
    return {
      ok: false,
      error: "forbidden",
      message: "You can only invite members. Inviting someone as an admin needs the Change member roles permission. Ask the organization owner.",
    }
  }

  const adminAssignmentDenial = await input.decideAdminAssignment(role)
  if (adminAssignmentDenial) {
    return {
      ok: false,
      error: "forbidden",
      message: adminAssignmentDenial.message,
      ...(adminAssignmentDenial.requiredPermission ? { requiredPermission: adminAssignmentDenial.requiredPermission } : {}),
    }
  }

  return { ok: true, role }
}
