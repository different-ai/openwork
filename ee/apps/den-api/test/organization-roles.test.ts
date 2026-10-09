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
  adminGrantDenial,
  decideAdminTeamChange,
  decideMemberRemoval,
  decideRequiredPermission,
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

const memberTarget = { memberId: "member_target", isDirectAdmin: false }
const adminTarget = { memberId: "member_target", isDirectAdmin: true }
// Admin only through an Admin team: the decision looks at the direct role alone.
const teamAdminTarget = { memberId: "member_target", isDirectAdmin: false }

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

test("making an Admin-team member a direct admin still needs every Admin default permission", () => {
  // A direct admin role outlives removal from the Admin team (e.g. by SCIM), so it is a durable grant.
  const partial = caller({ keys: ["members.update"] })
  const denial = decide({ caller: partial, target: teamAdminTarget, nextIsAdmin: true })
  assert.equal(denial?.reason, "admin_permissions_missing")
  assert.equal(denial?.requiredPermission, "permissions.manage")
  assert.equal(roleAssignmentNeedsAdminDefaultKeys({ caller: partial, callerMemberId: "member_caller", target: teamAdminTarget, nextIsAdmin: true }), true)
  assert.equal(decide({ caller: caller({ keys: ADMIN_DEFAULTS }), target: teamAdminTarget, nextIsAdmin: true }), null)
})

test("keeping a direct admin an admin needs no Admin default permissions", () => {
  const partial = caller({ keys: ["members.update"] })
  assert.equal(decide({ caller: partial, target: adminTarget, nextIsAdmin: true }), null)
  assert.equal(roleAssignmentNeedsAdminDefaultKeys({ caller: partial, callerMemberId: "member_caller", target: adminTarget, nextIsAdmin: true }), false)
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
  const self = { memberId: "member_caller", isDirectAdmin: true }
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

test("with Permissions on only the owner or an admin can remove a direct admin", () => {
  const teamGranted = caller({ keys: ["members.delete", "teams.manage_admin"] })
  const direct = { targetIsDirectAdmin: true, targetIsAdminViaTeam: false, targetIsPendingInvitation: false }
  const denial = decideMemberRemoval({ actor: teamGranted, ...direct })
  assert.equal(denial?.reason, "admin_removal_requires_admin")
  assert.equal(denial?.message, "Only the owner or an admin can remove an admin from the organization.")
  assert.equal(decideMemberRemoval({ actor: caller({ isAdmin: true }), ...direct }), null)
  assert.equal(decideMemberRemoval({ actor: caller({ isOwner: true }), ...direct }), null)
  // Members, and pending admin invitations (cancelled under the invitation rules), are unaffected.
  assert.equal(decideMemberRemoval({ actor: teamGranted, ...direct, targetIsDirectAdmin: false }), null)
  assert.equal(decideMemberRemoval({ actor: teamGranted, ...direct, targetIsPendingInvitation: true }), null)
  // Feature off: unchanged (only admins hold members.delete).
  assert.equal(decideMemberRemoval({ actor: caller({ featureEnabled: false }), ...direct }), null)
})

test("with Permissions on removing someone who is admin through an Admin team needs the owner or an admin too", () => {
  const teamGranted = caller({ keys: ["members.delete", "teams.manage_admin"] })
  const viaTeam = { targetIsDirectAdmin: false, targetIsAdminViaTeam: true, targetIsPendingInvitation: false }
  assert.equal(decideMemberRemoval({ actor: teamGranted, ...viaTeam })?.reason, "admin_removal_requires_admin")
  assert.equal(decideMemberRemoval({ actor: caller({ isAdmin: true }), ...viaTeam }), null)
  assert.equal(decideMemberRemoval({ actor: caller({ isOwner: true }), ...viaTeam }), null)
  // Feature off: unchanged.
  assert.equal(decideMemberRemoval({ actor: caller({ featureEnabled: false, keys: ["members.delete", "teams.manage_admin"] }), ...viaTeam }), null)
})

test("with Permissions on only the owner or an admin can make an Admin team or add people to one", () => {
  const teamGranted = caller({ keys: ["teams.manage", "teams.manage_admin", ...ADMIN_DEFAULTS] })
  assert.equal(decideAdminTeamChange({ actor: teamGranted, makesAdminTeam: true, addsMembersToAdminTeam: false })?.reason, "admin_team_requires_admin")
  const denial = decideAdminTeamChange({ actor: teamGranted, makesAdminTeam: false, addsMembersToAdminTeam: true })
  assert.equal(denial?.message, "Only the owner or an admin can make a team an Admin team or add people to one.")
  assert.equal(decideAdminTeamChange({ actor: teamGranted, makesAdminTeam: false, addsMembersToAdminTeam: false }), null)
  assert.equal(decideAdminTeamChange({ actor: caller({ isAdmin: true }), makesAdminTeam: true, addsMembersToAdminTeam: true }), null)
  assert.equal(decideAdminTeamChange({ actor: caller({ isOwner: true }), makesAdminTeam: true, addsMembersToAdminTeam: true }), null)
  assert.equal(decideAdminTeamChange({ actor: caller({ featureEnabled: false }), makesAdminTeam: true, addsMembersToAdminTeam: true }), null)
})

test("direct member removal re-checks Remove members against the permissions resolved in its transaction", () => {
  // members DELETE passes members.delete: a caller who lost it after the route check is refused.
  assert.deepEqual(decideRequiredPermission({ actor: caller({ keys: [] }), requiredPermission: "members.delete" }), { reason: "permission_not_held", requiredPermission: "members.delete" })
  assert.equal(decideRequiredPermission({ actor: caller({ keys: ["members.delete"] }), requiredPermission: "members.delete" }), null)
  assert.equal(decideRequiredPermission({ actor: caller({ isOwner: true }), requiredPermission: "members.delete" }), null)
  // A required permission with no resolved caller fails closed.
  assert.equal(decideRequiredPermission({ actor: null, requiredPermission: "members.delete" })?.reason, "permission_not_held")
  // Invitation cancellation and SCIM deprovisioning pass no required permission: they authorize separately.
  assert.equal(decideRequiredPermission({ actor: caller({ keys: [] }), requiredPermission: undefined }), null)
  assert.equal(decideRequiredPermission({ actor: null, requiredPermission: undefined }), null)
})

test("an admin assignment decided in the transaction uses the Admin default set read there", () => {
  // The caller held every Admin default key before; the owner then added billing.manage to Admin permissions.
  const held = caller({ keys: ADMIN_DEFAULTS })
  assert.equal(decideRoleAssignment({ caller: held, callerMemberId: "member_caller", target: memberTarget, nextIsAdmin: true, adminDefaultKeys: ADMIN_DEFAULTS }), null)
  const denial = decideRoleAssignment({ caller: held, callerMemberId: "member_caller", target: memberTarget, nextIsAdmin: true, adminDefaultKeys: [...ADMIN_DEFAULTS, "billing.manage"] })
  assert.equal(denial?.reason, "admin_permissions_missing")
  assert.equal(denial?.requiredPermission, "billing.manage")
})

test("with Permissions on and an empty Admin default set, only the owner or an admin can grant admin", () => {
  const teamGranted = caller({ keys: ["members.update", "invitations.manage"] })
  // Making a member an admin: firstMissingPermission over no keys would allow anyone.
  const denial = decideRoleAssignment({ caller: teamGranted, callerMemberId: "member_caller", target: memberTarget, nextIsAdmin: true, adminDefaultKeys: [] })
  assert.equal(denial?.reason, "admin_grant_requires_admin")
  assert.equal(denial?.requiredPermission, null)
  assert.equal(denial?.message, "Only the owner or an admin can make someone an admin while Admin permissions allow nothing.")
  // Inviting as admin decides with no target, through the same rule.
  assert.equal(decideRoleAssignment({ caller: teamGranted, callerMemberId: "member_caller", target: null, nextIsAdmin: true, adminDefaultKeys: [] })?.reason, "admin_grant_requires_admin")
  assert.equal(decideRoleAssignment({ caller: caller({ isAdmin: true }), callerMemberId: "member_caller", target: memberTarget, nextIsAdmin: true, adminDefaultKeys: [] }), null)
  assert.equal(decideRoleAssignment({ caller: caller({ isOwner: true }), callerMemberId: "member_caller", target: null, nextIsAdmin: true, adminDefaultKeys: [] }), null)
  // Feature off: unchanged (only the owner holds members.update there).
  assert.equal(decideRoleAssignment({ caller: caller({ featureEnabled: false }), callerMemberId: "member_caller", target: memberTarget, nextIsAdmin: true, adminDefaultKeys: [] }), null)

  // The shared rule the team-grant check uses for Admin teams.
  assert.equal(adminGrantDenial(teamGranted, []), "requires_admin")
  assert.equal(adminGrantDenial(caller({ isAdmin: true }), []), null)
  assert.equal(adminGrantDenial(caller({ isOwner: true }), []), null)
  assert.equal(adminGrantDenial(teamGranted, ["members.update"]), null)
  assert.equal(adminGrantDenial(teamGranted, ["members.update", "billing.manage"]), "billing.manage")
  // Making an Admin team or adding people to one needs the owner or an admin regardless of the set.
  assert.equal(decideAdminTeamChange({ actor: caller({ keys: ["teams.manage", "teams.manage_admin"] }), makesAdminTeam: true, addsMembersToAdminTeam: false })?.reason, "admin_team_requires_admin")
})
