import assert from "node:assert/strict";
import { test } from "node:test";
import { roleList, type RoleListEntry, type RoleSetLike } from "../../_lib/role-catalog";
import {
  allowedKeys,
  memberRoleEntry,
  memberRoleOptions,
  memberRoleStateAfter,
  memberRoleSteps,
  permissionSourceRoleLabel,
  roleKindLabel,
  roleName,
  teamRoleEntry,
  teamRoleLabel,
  teamRoleLabels,
  teamRoleLockReason,
  teamRoleOptions,
  teamRoleStateAfter,
  teamRoleSteps,
  type MemberRoleState,
  type TeamRoleState,
} from "./team-roles";

const sets: RoleSetLike[] = [
  { id: "set_member", kind: "member_default", name: "Member permissions", allowedCount: 0, team: null, teams: [] },
  { id: "set_admin", kind: "admin_default", name: "Admin permissions", allowedCount: 40, team: null, teams: [] },
  { id: "set_billing", kind: "billing_manager_default", name: "Billing manager permissions", allowedCount: 5, team: null, teams: [{ id: "tem_finance", name: "Finance" }] },
  { id: "set_super", kind: "super_admin_default", name: "Super admin permissions", allowedCount: 60, team: null, teams: [{ id: "tem_lead", name: "Leadership" }] },
  { id: "set_publisher", kind: "team", name: "Skill publisher", allowedCount: 3, team: null, teams: [{ id: "tem_sales", name: "Sales" }], directMemberIds: ["om_riley"] },
];
const roles = roleList({ sets });
function role(value: string): RoleListEntry {
  const entry = roles.find((candidate) => candidate.value === value);
  assert.ok(entry, value);
  return entry;
}
const all = { canManageAdminTeams: true, canManagePermissions: true, hasOwnerAuthority: true };

test("every screen names roles the same way, never by Den's stored set names", () => {
  assert.equal(roleName({ kind: "member_default", name: "Member permissions" }), "Member");
  assert.equal(roleName({ kind: "admin_default", name: "Admin permissions" }), "Admin");
  assert.equal(roleName({ kind: "billing_manager_default", name: "Billing manager permissions" }), "Billing manager");
  assert.equal(roleName({ kind: "super_admin_default", name: "Super admin permissions" }), "Super admin");
  assert.equal(roleName({ kind: "team", name: "Skill publisher" }), "Skill publisher");
  assert.equal(roleKindLabel({ kind: "team" }), "Custom role");
  assert.equal(roleKindLabel({ kind: "billing_manager_default" }), "Built-in role");
  assert.equal(permissionSourceRoleLabel({ kind: "admin_default", label: "Admin permissions (via Sales team)", via: "team", teamName: "Sales" }), "Admin via Sales");
  assert.equal(permissionSourceRoleLabel({ kind: "team", label: "x", teamName: "Sales", setName: "Skill publisher" }), "Skill publisher via Sales");
  assert.equal(permissionSourceRoleLabel({ kind: "team", label: "x", teamName: "Finance", setName: "Billing manager permissions" }), "Billing manager via Finance");
  assert.equal(permissionSourceRoleLabel({ kind: "direct", label: "Billing manager permissions (given directly)", setName: "Billing manager permissions" }), "Billing manager");
  assert.equal(permissionSourceRoleLabel({ kind: "direct", label: "x", setName: "Skill publisher" }), "Skill publisher");
  assert.equal(permissionSourceRoleLabel({ kind: "super_admin", label: "Super admin role" }), "Super admin");
  assert.equal(permissionSourceRoleLabel({ kind: "code_default", label: "Member permissions (default)", set: "member" }), "Member");
});

test("allowed keys keep catalog order and drop retired keys", () => {
  assert.deepEqual(allowedKeys([{ key: "teams.view", status: "allow" }, { key: "organization.update", status: "allow" }, { key: "retired.key", status: "allow" }, { key: "sso.view", status: "deny" }]), ["organization.update", "teams.view"]);
});

test("a team shows one role: Super admin, then Admin, then the role it was given, then Member", () => {
  assert.equal(teamRoleEntry({ admin: false, setId: null }, roles).value, "member");
  assert.equal(teamRoleEntry({ admin: true, setId: null }, roles).value, "admin");
  assert.equal(teamRoleEntry({ admin: false, setId: "set_billing" }, roles).value, "billing-manager");
  assert.equal(teamRoleEntry({ admin: false, setId: "set_publisher" }, roles).value, "role:set_publisher");
  // An Admin team that also has a custom role is Admin; one that holds the Super admin set is Super admin.
  assert.equal(teamRoleEntry({ admin: true, setId: "set_publisher" }, roles).value, "admin");
  assert.equal(teamRoleEntry({ admin: true, setId: "set_super" }, roles).value, "super-admin");
  // A set that no longer exists gives nothing.
  assert.equal(teamRoleEntry({ admin: false, setId: "set_gone" }, roles).value, "member");
  assert.equal(teamRoleLabel({ admin: false, setId: null }, roles), null);
  assert.equal(teamRoleLabel({ admin: false, setId: "set_billing" }, roles), "Billing manager");
});

test("changing a team's role never leaves it with less access part way", () => {
  const member: TeamRoleState = { admin: false, setId: null };
  const admin: TeamRoleState = { admin: true, setId: null };
  const publisher: TeamRoleState = { admin: false, setId: "set_publisher" };
  const superAdmin: TeamRoleState = { admin: true, setId: "set_super" };
  assert.deepEqual(teamRoleSteps(member, role("admin")), [{ kind: "set-admin", value: true }]);
  assert.deepEqual(teamRoleSteps(member, role("billing-manager")), [{ kind: "assign", setId: "set_billing" }]);
  assert.deepEqual(teamRoleSteps(publisher, role("billing-manager")), [{ kind: "assign", setId: "set_billing" }]);
  // Raise before lowering: the Admin switch goes on before the set comes off, and a new set is given before the switch goes off.
  assert.deepEqual(teamRoleSteps(publisher, role("admin")), [{ kind: "set-admin", value: true }, { kind: "assign", setId: null }]);
  assert.deepEqual(teamRoleSteps(admin, role("role:set_publisher")), [{ kind: "assign", setId: "set_publisher" }, { kind: "set-admin", value: false }]);
  // Super admin is an Admin team that holds the Super admin set.
  assert.deepEqual(teamRoleSteps(member, role("super-admin")), [{ kind: "set-admin", value: true }, { kind: "assign", setId: "set_super" }]);
  assert.deepEqual(teamRoleSteps(admin, role("super-admin")), [{ kind: "assign", setId: "set_super" }]);
  assert.deepEqual(teamRoleSteps(superAdmin, role("admin")), [{ kind: "assign", setId: null }]);
  assert.deepEqual(teamRoleSteps(superAdmin, role("member")), [{ kind: "assign", setId: null }, { kind: "set-admin", value: false }]);
  assert.deepEqual(teamRoleSteps(superAdmin, role("billing-manager")), [{ kind: "assign", setId: "set_billing" }, { kind: "set-admin", value: false }]);
  assert.deepEqual(teamRoleSteps(admin, role("member")), [{ kind: "set-admin", value: false }]);
  assert.deepEqual(teamRoleSteps(publisher, role("member")), [{ kind: "assign", setId: null }]);
  // Nothing to do for the role it has, or for a role teams can't have.
  assert.deepEqual(teamRoleSteps(publisher, role("role:set_publisher")), []);
  assert.deepEqual(teamRoleSteps(member, role("owner")), []);
});

test("every role a team can be given leads back to that role, so Undo is exact", () => {
  for (const next of roles) {
    if (next.kind === "built_in" && next.id === "owner") continue;
    for (const start of [{ admin: false, setId: null }, { admin: true, setId: null }, { admin: false, setId: "set_publisher" }, { admin: true, setId: "set_super" }]) {
      let state: TeamRoleState = start;
      for (const step of teamRoleSteps(state, next)) state = step.kind === "set-admin" ? { ...state, admin: step.value } : { ...state, setId: step.setId };
      assert.deepEqual(state, teamRoleStateAfter(next), `${JSON.stringify(start)} to ${next.label}`);
      assert.equal(teamRoleEntry(state, roles).value, next.value, `${JSON.stringify(start)} to ${next.label}`);
    }
  }
});

test("a team role change is locked with what it needs, and Super admin needs the owner or a super admin", () => {
  const member: TeamRoleState = { admin: false, setId: null };
  assert.equal(teamRoleLockReason(member, role("admin"), roles, all), null);
  assert.match(teamRoleLockReason(member, role("admin"), roles, { ...all, canManageAdminTeams: false }) ?? "", /Manage Admin teams/);
  assert.match(teamRoleLockReason(member, role("billing-manager"), roles, { ...all, canManagePermissions: false }) ?? "", /Manage permissions/);
  assert.match(teamRoleLockReason(member, role("super-admin"), roles, { ...all, hasOwnerAuthority: false }) ?? "", /owner or a super admin/);
  // Taking Super admin away is protected the same way, whatever it becomes.
  assert.match(teamRoleLockReason({ admin: true, setId: "set_super" }, role("member"), roles, { ...all, hasOwnerAuthority: false }) ?? "", /owner or a super admin/);

  const options = teamRoleOptions({ roles, state: { admin: false, setId: "set_publisher" }, abilities: { canManageAdminTeams: false, canManagePermissions: true, hasOwnerAuthority: false }, lockReasons: new Map([["set_billing", "Ask the owner"]]) });
  assert.deepEqual(options.map((option) => [option.value, option.disabled]), [
    ["member", false], ["admin", true], ["billing-manager", true], ["super-admin", true], ["owner", true], ["role:set_publisher", false],
  ]);
  assert.equal(options[2]?.lockReason, "Ask the owner");
  // The team's current role is never locked, whatever the person can change.
  const none = teamRoleOptions({ roles, state: { admin: false, setId: "set_publisher" }, abilities: { canManageAdminTeams: false, canManagePermissions: false, hasOwnerAuthority: false } });
  assert.deepEqual(none.filter((option) => !option.disabled).map((option) => option.value), ["role:set_publisher"]);
});

test("a person shows one role: their organization role, then the role given to them directly, then Member", () => {
  assert.equal(memberRoleEntry({ role: "owner", setId: null }, roles).value, "owner");
  assert.equal(memberRoleEntry({ role: "super-admin", setId: null }, roles).value, "super-admin");
  assert.equal(memberRoleEntry({ role: "admin", setId: "set_publisher" }, roles).value, "admin");
  assert.equal(memberRoleEntry({ role: "member", setId: "set_billing" }, roles).value, "billing-manager");
  assert.equal(memberRoleEntry({ role: "member", setId: "set_publisher" }, roles).value, "role:set_publisher");
  assert.equal(memberRoleEntry({ role: "member", setId: null }, roles).value, "member");
  // Super admin is never given to a person by link, so a stray link doesn't make one.
  assert.equal(memberRoleEntry({ role: "member", setId: "set_super" }, roles).value, "member");
});

test("changing a person's role never leaves them with less access part way", () => {
  const member: MemberRoleState = { role: "member", setId: null };
  const admin: MemberRoleState = { role: "admin", setId: null };
  const billing: MemberRoleState = { role: "member", setId: "set_billing" };
  assert.deepEqual(memberRoleSteps(member, role("admin")), [{ kind: "set-role", role: "admin" }]);
  assert.deepEqual(memberRoleSteps(member, role("billing-manager")), [{ kind: "assign", setId: "set_billing" }]);
  // Raise before lowering.
  assert.deepEqual(memberRoleSteps(admin, role("billing-manager")), [{ kind: "assign", setId: "set_billing" }, { kind: "set-role", role: "member" }]);
  assert.deepEqual(memberRoleSteps(billing, role("super-admin")), [{ kind: "set-role", role: "super-admin" }, { kind: "assign", setId: null }]);
  assert.deepEqual(memberRoleSteps(billing, role("role:set_publisher")), [{ kind: "assign", setId: "set_publisher" }]);
  assert.deepEqual(memberRoleSteps(billing, role("member")), [{ kind: "assign", setId: null }]);
  assert.deepEqual(memberRoleSteps(admin, role("member")), [{ kind: "set-role", role: "member" }]);
  // Owner moves only by transferring ownership.
  assert.deepEqual(memberRoleSteps(member, role("owner")), []);
  assert.deepEqual(memberRoleSteps({ role: "owner", setId: null }, role("admin")), []);
});

test("every role a person can be given leads back to that role, so Undo is exact", () => {
  for (const next of roles) {
    if (next.kind === "built_in" && next.id === "owner") continue;
    for (const start of [{ role: "member", setId: null }, { role: "admin", setId: null }, { role: "super-admin", setId: null }, { role: "member", setId: "set_billing" }] satisfies MemberRoleState[]) {
      let state: MemberRoleState = start;
      for (const step of memberRoleSteps(state, next)) state = step.kind === "set-role" ? { ...state, role: step.role } : { ...state, setId: step.setId };
      assert.deepEqual(state, memberRoleStateAfter(next), `${JSON.stringify(start)} to ${next.label}`);
      assert.equal(memberRoleEntry(state, roles).value, next.value, `${JSON.stringify(start)} to ${next.label}`);
    }
  }
});

test("Add member and a person's row list the same roles as a team, each locked with what the change needs", () => {
  const options = memberRoleOptions({ roles, lockReasons: new Map([["set_publisher", "Ask the owner"]]), superAdminLockReason: "Only the owner or a super admin can make someone a super admin." });
  assert.deepEqual(options.map((option) => option.value), teamRoleOptions({ roles, state: { admin: false, setId: null }, abilities: all }).map((option) => option.value));
  assert.deepEqual(options.map((option) => [option.value, option.caption, option.disabled]), [
    ["member", "What everyone can do", false],
    ["admin", "Invite people, manage teams, and run connections and models", false],
    ["billing-manager", "See plan, usage and invoices, and manage payment details", false],
    ["super-admin", "Everything the owner can do, except delete the organization", true],
    ["owner", "Can do everything", true],
    ["role:set_publisher", "3 permissions", true],
  ]);
  assert.equal(options[5]?.lockReason, "Ask the owner");
  // Without Change member roles nothing can be picked but the role they already have.
  const locked = memberRoleOptions({ roles, current: role("billing-manager"), changeLockReason: "Needs Change member roles" });
  assert.deepEqual(locked.filter((option) => !option.disabled).map((option) => option.value), ["billing-manager"]);
  // Admin has permissions the person doesn't hold: Admin and Super admin are locked for that reason.
  const noAdmin = memberRoleOptions({ roles, adminLockReason: "This role grants permissions you don't have." });
  assert.deepEqual(noAdmin.filter((option) => option.disabled).map((option) => option.value), ["admin", "super-admin", "owner"]);
});

test("a person's roles from teams read Admin first, then every other role with its teams", () => {
  const teams = [
    { id: "tem_sales", name: "Sales", memberIds: ["om_1"], grantsOrganizationAdmin: false },
    { id: "tem_ops", name: "Operations", memberIds: ["om_1"], grantsOrganizationAdmin: true },
    { id: "tem_finance", name: "Finance", memberIds: ["om_1"], grantsOrganizationAdmin: false },
    { id: "tem_lead", name: "Leadership", memberIds: ["om_1"], grantsOrganizationAdmin: true },
    { id: "tem_plain", name: "Book club", memberIds: ["om_1"], grantsOrganizationAdmin: false },
  ];
  const setIdByTeam = new Map([["tem_sales", "set_publisher"], ["tem_finance", "set_billing"], ["tem_lead", "set_super"]]);
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "member", teams, setIdByTeam, roles }), ["Admin via Operations", "Skill publisher via Sales", "Billing manager via Finance", "Super admin via Leadership"]);
  // An admin needs no "Admin via"; the owner already has everything.
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "admin", teams, setIdByTeam, roles }), ["Skill publisher via Sales", "Billing manager via Finance", "Super admin via Leadership"]);
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "owner", teams, setIdByTeam, roles }), []);
  assert.deepEqual(teamRoleLabels({ memberId: "om_2", ownRole: "member", teams, setIdByTeam, roles }), []);
});
