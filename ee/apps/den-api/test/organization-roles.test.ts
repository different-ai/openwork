import assert from "node:assert/strict"
import { test } from "node:test"
import { matchingDesktopPolicyAssignmentRoles } from "@openwork/types/den/desktop-policies"
import { permissionDefaultKeys, type PermissionKey } from "@openwork/types/den/permissions"
import {
  assignableOrganizationRole,
  isEffectiveOrganizationAdmin,
  normalizeOrganizationRoleName,
  organizationRoleValueIncludes,
  organizationRoleValueSatisfies,
} from "../src/organization-role-hierarchy.ts"
import {
  decideRoleAssignment,
  firstMissingPermission,
  roleAssignmentNeedsAdminDefaultKeys,
  type RoleAssignmentCaller,
  type RoleAssignmentTarget,
} from "../src/permissions/role-assignment.ts"

test("only member and admin are assignable; owner and custom role names are dropped", () => {
  assert.equal(assignableOrganizationRole("member"), "member")
  assert.equal(assignableOrganizationRole("admin"), "admin")
  assert.equal(assignableOrganizationRole("member, admin"), "admin")
  assert.equal(assignableOrganizationRole("owner"), null)
  assert.equal(assignableOrganizationRole("billing-lead"), null)
  assert.equal(assignableOrganizationRole("billing-lead,member"), "member")
})

test("a stray legacy super-admin value reads as admin", () => {
  assert.equal(normalizeOrganizationRoleName(" Super-Admin "), "admin")
  assert.equal(assignableOrganizationRole("super-admin"), "admin")
  assert.equal(organizationRoleValueIncludes("member,super-admin", "admin"), true)
  assert.equal(organizationRoleValueSatisfies({ roleValue: "super-admin", requiredRole: "admin" }), true)
  assert.equal(organizationRoleValueSatisfies({ roleValue: "super-admin", requiredRole: "owner" }), false)
  assert.equal(organizationRoleValueSatisfies({ roleValue: "admin", requiredRole: "super-admin" }), true)
  assert.equal(isEffectiveOrganizationAdmin({ directRole: "super-admin", adminTeamIds: [] }), true)
})

test("desktop policy admin assignments match effective admins", () => {
  assert.deepEqual(matchingDesktopPolicyAssignmentRoles("member"), ["member"])
  assert.deepEqual(matchingDesktopPolicyAssignmentRoles("member", { adminViaTeam: true }), ["admin", "member"])
  assert.deepEqual(matchingDesktopPolicyAssignmentRoles("admin"), ["admin", "member"])
  assert.deepEqual(matchingDesktopPolicyAssignmentRoles("owner"), ["owner", "admin", "member"])
  assert.deepEqual(matchingDesktopPolicyAssignmentRoles("custom-role"), ["member"])
})

const ADMIN_DEFAULTS: PermissionKey[] = ["members.update", "permissions.manage", "teams.manage_admin"]

function caller(input: { featureEnabled?: boolean; isOwner?: boolean; isAdmin?: boolean; keys?: readonly PermissionKey[] }): RoleAssignmentCaller {
  const keys = new Set(input.keys ?? [])
  return {
    featureEnabled: input.featureEnabled ?? true,
    isOwner: input.isOwner ?? false,
    isAdmin: input.isAdmin ?? false,
    has: (key) => input.isOwner === true || keys.has(key),
  }
}

const memberTarget = { memberId: "member_target", isDirectAdmin: false, isEffectiveAdmin: false }
const adminTarget = { memberId: "member_target", isDirectAdmin: true, isEffectiveAdmin: true }
const teamAdminTarget = { memberId: "member_target", isDirectAdmin: false, isEffectiveAdmin: true }

function decide(input: { caller: RoleAssignmentCaller; target: RoleAssignmentTarget | null; nextIsAdmin: boolean; callerMemberId?: string }) {
  return decideRoleAssignment({ callerMemberId: "member_caller", adminDefaultKeys: ADMIN_DEFAULTS, ...input })
}

test("making someone an admin needs every Admin default permission when Permissions is on", () => {
  const partial = caller({ keys: ["members.update", "permissions.manage"] })
  const denial = decide({ caller: partial, target: memberTarget, nextIsAdmin: true })
  assert.equal(denial?.reason, "admin_permissions_missing")
  assert.equal(denial?.requiredPermission, "teams.manage_admin")
  assert.equal(denial?.message, "You can't make someone an admin because admins have permissions you don't have.")
  assert.equal(roleAssignmentNeedsAdminDefaultKeys({ caller: partial, callerMemberId: "member_caller", target: memberTarget, nextIsAdmin: true }), true)

  assert.equal(decide({ caller: caller({ keys: ADMIN_DEFAULTS }), target: memberTarget, nextIsAdmin: true }), null)
  // Inviting a new person as admin follows the same rule.
  assert.equal(decide({ caller: partial, target: null, nextIsAdmin: true })?.requiredPermission, "teams.manage_admin")
  assert.equal(decide({ caller: caller({ keys: ADMIN_DEFAULTS }), target: null, nextIsAdmin: true }), null)
})

test("the first missing key is reported in sorted order and code defaults apply without a set", () => {
  const none = caller({ keys: [] })
  assert.equal(decide({ caller: none, target: memberTarget, nextIsAdmin: true })?.requiredPermission, "members.update")
  assert.equal(firstMissingPermission(none, ["teams.manage_admin", "audit.view"]), "audit.view")
  const fallback = decideRoleAssignment({ caller: none, callerMemberId: "member_caller", target: null, nextIsAdmin: true })
  assert.equal(fallback?.reason, "admin_permissions_missing")
  assert.ok(fallback?.requiredPermission && permissionDefaultKeys("admin").includes(fallback.requiredPermission))
})

test("someone who is already an effective admin gains nothing from the admin role", () => {
  const partial = caller({ keys: ["members.update"] })
  assert.equal(decide({ caller: partial, target: teamAdminTarget, nextIsAdmin: true }), null)
  assert.equal(roleAssignmentNeedsAdminDefaultKeys({ caller: partial, callerMemberId: "member_caller", target: teamAdminTarget, nextIsAdmin: true }), false)
})

test("only the owner or an admin can demote a direct admin", () => {
  const teamGranted = caller({ keys: ADMIN_DEFAULTS })
  const denial = decide({ caller: teamGranted, target: adminTarget, nextIsAdmin: false })
  assert.equal(denial?.reason, "admin_role_change_requires_admin")
  assert.equal(denial?.requiredPermission, null)
  assert.equal(decide({ caller: caller({ isAdmin: true, keys: ["members.update"] }), target: adminTarget, nextIsAdmin: false }), null)
  assert.equal(decide({ caller: caller({ isOwner: true }), target: adminTarget, nextIsAdmin: false }), null)
  // A team admin whose direct role is member keeps that role; nothing to demote.
  assert.equal(decide({ caller: teamGranted, target: teamAdminTarget, nextIsAdmin: false }), null)
  assert.equal(decide({ caller: teamGranted, target: memberTarget, nextIsAdmin: false }), null)
})

test("nobody but the owner changes their own role", () => {
  const self = { memberId: "member_caller", isDirectAdmin: true, isEffectiveAdmin: true }
  assert.equal(decide({ caller: caller({ isAdmin: true, keys: ADMIN_DEFAULTS }), target: self, nextIsAdmin: false })?.reason, "own_role")
  assert.equal(decide({ caller: caller({ keys: ["members.update"] }), target: { ...memberTarget, memberId: "member_caller" }, nextIsAdmin: true })?.reason, "own_role")
  assert.equal(decide({ caller: caller({ isOwner: true }), target: { ...self, isDirectAdmin: false }, nextIsAdmin: true }), null)
})

test("with Permissions off the role-assignment rules change nothing", () => {
  const off = caller({ featureEnabled: false, isAdmin: true, keys: ["members.update"] })
  assert.equal(decide({ caller: off, target: memberTarget, nextIsAdmin: true }), null)
  assert.equal(decide({ caller: off, target: adminTarget, nextIsAdmin: false }), null)
  assert.equal(decide({ caller: off, target: { ...adminTarget, memberId: "member_caller" }, nextIsAdmin: false }), null)
  assert.equal(decide({ caller: caller({ featureEnabled: false }), target: null, nextIsAdmin: true }), null)
  assert.equal(roleAssignmentNeedsAdminDefaultKeys({ caller: off, callerMemberId: "member_caller", target: memberTarget, nextIsAdmin: true }), false)
})
