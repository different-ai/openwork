import {
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
  ORGANIZATION_OWNER_ROLE,
  normalizeOrganizationRoleName,
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
  return splitOrganizationRoles(roleValue).filter((role) => {
    const normalized = normalizeOrganizationRoleName(role)
    return normalized !== ORGANIZATION_OWNER_ROLE
      && normalized !== ORGANIZATION_ADMIN_ROLE
      && normalized !== ORGANIZATION_MEMBER_ROLE
  })
}

/** The previous owner becomes an admin; the new owner keeps any other (non built-in) role entries. */
export function getRoleValueAfterOwnershipTransfer(input: {
  currentRole: string
  targetRole: string
}) {
  const currentRoles = removeTransferManagedRoles(input.currentRole)
  const previousOwnerRole = addRole(currentRoles.join(","), ORGANIZATION_ADMIN_ROLE)
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

export function roleIncludesAdmin(roleValue: string) {
  return organizationRoleValueIncludes(roleValue, ORGANIZATION_ADMIN_ROLE)
}

export function roleIncludesPrivileged(roleValue: string) {
  return roleIncludesOwner(roleValue) || roleIncludesAdmin(roleValue)
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
      message: "Add another workspace owner or admin before changing this member's role.",
    }
  }

  return { ok: true }
}
