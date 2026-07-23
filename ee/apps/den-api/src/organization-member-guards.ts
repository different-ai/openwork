import {
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
  ORGANIZATION_OWNER_ROLE,
  ORGANIZATION_SUPER_ADMIN_ROLE,
  organizationRoleValueIncludes,
  splitOrganizationRoles,
} from "./organization-role-hierarchy.js"

export type MemberLifecycleGuardRow = {
  id: string
  role: string
  userId: string | null
}

export type MemberLifecycleValidation = {
  ok: true
} | {
  ok: false
  error: "owner_role_locked" | "last_privileged_member"
  message: string
}

function addRole(roleValue: string, roleName: string) {
  const roles = splitOrganizationRoles(roleValue).filter((role) => role !== roleName)
  return [roleName, ...roles].join(",")
}

function removeTransferManagedRoles(roleValue: string) {
  return splitOrganizationRoles(roleValue).filter((role) => (
    role !== ORGANIZATION_OWNER_ROLE
    && role !== ORGANIZATION_SUPER_ADMIN_ROLE
    && role !== ORGANIZATION_ADMIN_ROLE
    && role !== ORGANIZATION_MEMBER_ROLE
  ))
}

export function getRoleValueAfterOwnershipTransfer(input: {
  currentRole: string
  targetRole: string
}) {
  const currentRoles = removeTransferManagedRoles(input.currentRole)
  const previousOwnerRole = addRole(currentRoles.join(","), ORGANIZATION_SUPER_ADMIN_ROLE)
  const targetRoles = removeTransferManagedRoles(input.targetRole)
  const newOwnerRole = addRole(targetRoles.join(","), ORGANIZATION_OWNER_ROLE)

  return {
    previousOwnerRole,
    newOwnerRole,
  }
}

export function roleIncludesOwner(roleValue: string) {
  return organizationRoleValueIncludes(roleValue, ORGANIZATION_OWNER_ROLE)
}

export function roleIncludesSuperAdmin(roleValue: string) {
  return organizationRoleValueIncludes(roleValue, ORGANIZATION_SUPER_ADMIN_ROLE)
}

export function roleIncludesPrivileged(roleValue: string) {
  return roleIncludesOwner(roleValue)
    || roleIncludesSuperAdmin(roleValue)
    || organizationRoleValueIncludes(roleValue, ORGANIZATION_ADMIN_ROLE)
}

function hasOtherActivePrivilegedMember(input: {
  memberId: string
  members: readonly MemberLifecycleGuardRow[]
}) {
  return input.members.some((member) => (
    member.id !== input.memberId
    && member.userId !== null
    && roleIncludesPrivileged(member.role)
  ))
}

export function validateOrganizationMemberRemoval(input: {
  member: MemberLifecycleGuardRow
  activeMembers: readonly MemberLifecycleGuardRow[]
}): MemberLifecycleValidation {
  if (roleIncludesOwner(input.member.role)) {
    return {
      ok: false,
      error: "owner_role_locked",
      message: "The organization owner cannot be removed.",
    }
  }

  return { ok: true }
}

export function validateOrganizationMemberRoleChange(input: {
  member: MemberLifecycleGuardRow
  activeMembers: readonly MemberLifecycleGuardRow[]
  nextRole: string
}): MemberLifecycleValidation {
  if (roleIncludesOwner(input.member.role)) {
    return {
      ok: false,
      error: "owner_role_locked",
      message: "The organization owner role cannot be changed.",
    }
  }

  if (roleIncludesOwner(input.nextRole)) {
    return {
      ok: false,
      error: "owner_role_locked",
      message: "The organization owner role cannot be assigned.",
    }
  }

  if (
    roleIncludesPrivileged(input.member.role)
    && !roleIncludesPrivileged(input.nextRole)
    && !hasOtherActivePrivilegedMember({ memberId: input.member.id, members: input.activeMembers })
  ) {
    return {
      ok: false,
      error: "last_privileged_member",
      message: "Add another workspace owner, super-admin, or admin before changing this member's role.",
    }
  }

  return { ok: true }
}
