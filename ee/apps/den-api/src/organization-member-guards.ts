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

function splitRoles(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function addRole(roleValue: string, roleName: string) {
  const roles = splitRoles(roleValue).filter((role) => role !== roleName)
  return [roleName, ...roles].join(",")
}

function removeRole(roleValue: string, roleName: string) {
  return splitRoles(roleValue).filter((role) => role !== roleName)
}

export function getRoleValueAfterOwnershipTransfer(input: {
  currentRole: string
  targetRole: string
}) {
  const currentRoles = removeRole(input.currentRole, "owner")
  const previousOwnerRole = currentRoles.includes("admin")
    ? currentRoles.join(",")
    : addRole(currentRoles.join(","), "admin")
  const targetRoles = removeRole(input.targetRole, "owner")
    .filter((role) => role !== "admin" && role !== "member")
  const newOwnerRole = addRole(targetRoles.join(","), "owner")

  return {
    previousOwnerRole,
    newOwnerRole,
  }
}

export function roleIncludesOwner(roleValue: string) {
  return splitRoles(roleValue).includes("owner")
}

export function roleIncludesPrivileged(roleValue: string) {
  const roles = splitRoles(roleValue)
  return roles.includes("owner") || roles.includes("admin")
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

  if (
    roleIncludesPrivileged(input.member.role)
    && !hasOtherActivePrivilegedMember({ memberId: input.member.id, members: input.activeMembers })
  ) {
    return {
      ok: false,
      error: "last_privileged_member",
      message: "Add another workspace owner or admin before removing this member.",
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
