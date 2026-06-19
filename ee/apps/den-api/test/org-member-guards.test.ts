import { expect, test } from "bun:test"
import {
  getRoleValueAfterOwnershipTransfer,
  validateOrganizationMemberRemoval,
  validateOrganizationMemberRoleChange,
  type MemberLifecycleGuardRow,
} from "../src/organization-member-guards.js"

function member(id: string, role: string, userId: string | null): MemberLifecycleGuardRow {
  return { id, role, userId }
}

test("member removal rejects organization owners", () => {
  const owner = member("member_owner", "owner", "user_owner")

  expect(validateOrganizationMemberRemoval({
    member: owner,
    activeMembers: [owner],
  })).toEqual({
    ok: false,
    error: "owner_role_locked",
    message: "The organization owner cannot be removed.",
  })
})

test("member removal rejects the last active privileged member", () => {
  const admin = member("member_admin", "admin", "user_admin")
  const inactiveOwner = member("member_owner", "owner", null)

  expect(validateOrganizationMemberRemoval({
    member: admin,
    activeMembers: [admin, inactiveOwner],
  })).toEqual({
    ok: false,
    error: "last_privileged_member",
    message: "Add another workspace owner or admin before removing this member.",
  })
})

test("member removal allows admins when another active privileged member remains", () => {
  const owner = member("member_owner", "owner", "user_owner")
  const admin = member("member_admin", "admin", "user_admin")

  expect(validateOrganizationMemberRemoval({
    member: admin,
    activeMembers: [owner, admin],
  })).toEqual({ ok: true })
})

test("member role changes reject the last active privileged downgrade", () => {
  const admin = member("member_admin", "admin", "user_admin")

  expect(validateOrganizationMemberRoleChange({
    member: admin,
    activeMembers: [admin],
    nextRole: "member",
  })).toEqual({
    ok: false,
    error: "last_privileged_member",
    message: "Add another workspace owner or admin before changing this member's role.",
  })
})

test("member role changes allow privileged downgrades when another active privileged member remains", () => {
  const owner = member("member_owner", "owner", "user_owner")
  const admin = member("member_admin", "admin", "user_admin")

  expect(validateOrganizationMemberRoleChange({
    member: admin,
    activeMembers: [owner, admin],
    nextRole: "member",
  })).toEqual({ ok: true })
})

test("ownership transfer makes the old owner an admin and preserves custom target roles", () => {
  expect(getRoleValueAfterOwnershipTransfer({
    currentRole: "owner,security-admin",
    targetRole: "admin,billing-admin",
  })).toEqual({
    previousOwnerRole: "admin,security-admin",
    newOwnerRole: "owner,billing-admin",
  })
})

test("ownership transfer promotes a basic member to owner", () => {
  expect(getRoleValueAfterOwnershipTransfer({
    currentRole: "owner",
    targetRole: "member",
  })).toEqual({
    previousOwnerRole: "admin",
    newOwnerRole: "owner",
  })
})
