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

test("member removal allows non-owner privileged members", () => {
  const admin = member("member_admin", "super-admin", "user_admin")
  const inactiveOwner = member("member_owner", "owner", null)

  expect(validateOrganizationMemberRemoval({
    member: admin,
    activeMembers: [admin, inactiveOwner],
  })).toEqual({ ok: true })
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
    message: "Add another workspace owner, super-admin, or admin before changing this member's role.",
  })
})

test("member role changes reject organization owners", () => {
  const owner = member("member_owner", "owner", "user_owner")
  const superAdmin = member("member_super", "super-admin", "user_super")

  expect(validateOrganizationMemberRoleChange({
    member: owner,
    activeMembers: [owner, superAdmin],
    nextRole: "super-admin",
  })).toEqual({
    ok: false,
    error: "owner_role_locked",
    message: "The organization owner role cannot be changed.",
  })
})

test("member role changes reject owner assignment", () => {
  const admin = member("member_admin", "admin", "user_admin")
  const superAdmin = member("member_super", "super-admin", "user_super")

  expect(validateOrganizationMemberRoleChange({
    member: admin,
    activeMembers: [admin, superAdmin],
    nextRole: "owner",
  })).toEqual({
    ok: false,
    error: "owner_role_locked",
    message: "The organization owner role cannot be assigned.",
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

test("ownership transfer makes the old owner a super-admin and preserves custom target roles", () => {
  expect(getRoleValueAfterOwnershipTransfer({
    currentRole: "owner,security-admin",
    targetRole: "super-admin,billing-admin",
  })).toEqual({
    previousOwnerRole: "super-admin,security-admin",
    newOwnerRole: "owner,billing-admin",
  })
})

test("ownership transfer removes redundant built-in roles from the new owner", () => {
  expect(getRoleValueAfterOwnershipTransfer({
    currentRole: "owner",
    targetRole: "super-admin,admin,member",
  })).toEqual({
    previousOwnerRole: "super-admin",
    newOwnerRole: "owner",
  })
})
