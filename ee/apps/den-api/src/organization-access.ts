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

/**
 * Better Auth's organization plugin needs an access-control object and static
 * roles. Den never authorizes through them: every Better Auth endpoint that
 * checks them is denied (getRawBetterAuthMutationDenial) and Den routes check
 * catalog permissions instead (src/permissions).
 */
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

/** Anything that answers "does this member hold this permission", e.g. MemberPermissions. */
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
  /** Set when a missing permission is the reason. */
  requiredPermission?: PermissionKey
}

/**
 * Which role an invitation may carry, for the inviter's effective permissions.
 * Inviting needs `invitations.manage`; inviting an admin also needs
 * `members.update` and every Admin default permission; inviting a super-admin
 * needs the owner or a super-admin.
 * `decideAdminAssignment` evaluates that rule (permissions/team-grants.ts
 * roleAssignmentDenial with no target and the admin role); it is required and
 * called whenever the normalized roles include admin or super-admin, so such
 * an invitation is never approved without the rule being evaluated. Only
 * `member`, `admin` and `super-admin` can be assigned: owner moves by
 * ownership transfer and custom roles are removed.
 */
export async function validateInvitationRoleAssignment(input: {
  role: string
  permissions: PermissionHolder
  /** Decides the admin rules for the role being granted (admin or super-admin). */
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
