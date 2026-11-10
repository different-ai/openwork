import assert from "node:assert/strict";
import { test } from "node:test";
import { roleList, type RoleSetLike } from "../../_lib/role-catalog";
import {
  allowedKeys,
  customRoleChoice,
  memberRoleOptions,
  parseRoleChoice,
  permissionSourceRoleLabel,
  roleKindLabel,
  roleName,
  sharedTeamRole,
  sharedTeamRoleFromValue,
  sharedTeamRoleLockReason,
  sharedTeamRoleSteps,
  sharedTeamRoleValue,
  teamRole,
  teamRoleLabels,
  teamRoleLockReason,
  teamRoleOptions,
  teamRoleSteps,
} from "./team-roles";

const member = { admin: false, customSetId: null };
const admin = { admin: true, customSetId: null };
const custom = { admin: false, customSetId: "pms_team" };
const all = { canManageAdminTeams: true, canManagePermissions: true };

test("a team's role comes from the Admin flag and its permission set, Admin first", () => {
  assert.equal(teamRole(member), "member");
  assert.equal(teamRole(admin), "admin");
  assert.equal(teamRole(custom), "custom");
  assert.equal(teamRole({ admin: true, customSetId: "pms_team" }), "admin");
});

test("changing a team's role never leaves it with less access part way", () => {
  assert.deepEqual(teamRoleSteps(member, "admin", []), [{ kind: "set-admin", value: true }]);
  assert.deepEqual(teamRoleSteps(custom, "admin", []), [{ kind: "set-admin", value: true }, { kind: "remove-custom", setId: "pms_team" }]);
  assert.deepEqual(teamRoleSteps(admin, "custom", ["teams.view"]), [{ kind: "create-custom", keys: ["teams.view"] }, { kind: "set-admin", value: false }]);
  assert.deepEqual(teamRoleSteps(member, "custom", ["teams.view"]), [{ kind: "create-custom", keys: [] }]);
  assert.deepEqual(teamRoleSteps(admin, "member", []), [{ kind: "set-admin", value: false }]);
  assert.deepEqual(teamRoleSteps(custom, "member", []), [{ kind: "remove-custom", setId: "pms_team" }]);
  assert.deepEqual(teamRoleSteps(admin, "admin", []), []);
});

test("a role change is locked with the permission it needs", () => {
  assert.equal(teamRoleLockReason(member, "admin", all), null);
  assert.match(teamRoleLockReason(member, "admin", { ...all, canManageAdminTeams: false }) ?? "", /Manage Admin teams/);
  assert.match(teamRoleLockReason(admin, "member", { ...all, canManageAdminTeams: false }) ?? "", /Manage Admin teams/);
  assert.equal(teamRoleLockReason(member, "custom", all), null);
  assert.match(teamRoleLockReason(custom, "member", { ...all, canManagePermissions: false }) ?? "", /Manage permissions/);
  assert.equal(teamRoleLockReason(custom, "custom", { canManageAdminTeams: false, canManagePermissions: false }), null);
});

test("every screen names roles the same way, never by Den's stored set names", () => {
  assert.equal(roleName({ kind: "member_default", name: "Member permissions", team: null }), "Member");
  assert.equal(roleName({ kind: "admin_default", name: "Admin permissions", team: null }), "Admin");
  assert.equal(roleName({ kind: "team", name: "Engineering Permissions", team: { id: "tem_1", name: "Engineering" } }), "Engineering Permissions");
  assert.equal(roleKindLabel({ kind: "team" }), "Custom role");
  assert.equal(roleKindLabel({ kind: "admin_default" }), "Built-in role");
  assert.equal(permissionSourceRoleLabel({ kind: "admin_default", label: "Admin permissions (via Sales team)", via: "team", teamName: "Sales" }), "Admin via Sales");
  assert.equal(permissionSourceRoleLabel({ kind: "team", label: "Engineering Permissions (via Engineering team)", teamName: "Engineering" }), "Engineering");
  assert.equal(permissionSourceRoleLabel({ kind: "code_default", label: "Member permissions (default)", set: "member" }), "Member");
});

test("a person's team roles read Admin first, then custom roles by team", () => {
  const teams = [
    { id: "tem_eng", name: "Engineering", memberIds: ["om_1"], grantsOrganizationAdmin: false },
    { id: "tem_sales", name: "Sales", memberIds: ["om_1"], grantsOrganizationAdmin: true },
    { id: "tem_plain", name: "Book club", memberIds: ["om_1"], grantsOrganizationAdmin: false },
  ];
  const customTeamIds = new Set(["tem_eng"]);
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "member", teams, customTeamIds }), ["Admin via Sales", "Engineering"]);
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "admin", teams, customTeamIds }), ["Engineering"]);
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "owner", teams, customTeamIds }), []);
  assert.deepEqual(teamRoleLabels({ memberId: "om_2", ownRole: "member", teams, customTeamIds }), []);
});

test("a custom role in a role picker invites a Member into that team", () => {
  assert.deepEqual(parseRoleChoice(customRoleChoice("tem_eng")), { role: "member", teamId: "tem_eng" });
  assert.deepEqual(parseRoleChoice("admin"), { role: "admin", teamId: null });
  assert.deepEqual(parseRoleChoice("member"), { role: "member", teamId: null });
});

test("allowed keys keep catalog order and drop retired keys", () => {
  assert.deepEqual(allowedKeys([{ key: "teams.view", status: "allow" }, { key: "organization.update", status: "allow" }, { key: "retired.key", status: "allow" }, { key: "sso.view", status: "deny" }]), ["organization.update", "teams.view"]);
});

test("shared roles: changing a team's role never leaves it with less access part way", () => {
  const member = { admin: false, setId: null };
  const admin = { admin: true, setId: null };
  const publisher = { admin: false, setId: "pms_publisher" };
  assert.deepEqual(sharedTeamRoleSteps(member, { kind: "custom", setId: "pms_publisher" }), [{ kind: "assign", setId: "pms_publisher" }]);
  assert.deepEqual(sharedTeamRoleSteps(publisher, { kind: "custom", setId: "pms_billing" }), [{ kind: "assign", setId: "pms_billing" }]);
  assert.deepEqual(sharedTeamRoleSteps(admin, { kind: "custom", setId: "pms_publisher" }), [{ kind: "assign", setId: "pms_publisher" }, { kind: "set-admin", value: false }]);
  assert.deepEqual(sharedTeamRoleSteps(publisher, { kind: "admin" }), [{ kind: "set-admin", value: true }, { kind: "assign", setId: null }]);
  assert.deepEqual(sharedTeamRoleSteps(publisher, { kind: "member" }), [{ kind: "assign", setId: null }]);
  assert.deepEqual(sharedTeamRoleSteps(publisher, { kind: "custom", setId: "pms_publisher" }), []);
  assert.deepEqual(sharedTeamRole({ admin: true, setId: "pms_publisher" }), { kind: "admin" });
});

test("shared roles: a role change is locked with the permission it needs", () => {
  const abilities = { canManageAdminTeams: false, canManagePermissions: true };
  assert.match(sharedTeamRoleLockReason({ admin: false, setId: null }, { kind: "admin" }, abilities) ?? "", /Manage Admin teams/);
  assert.equal(sharedTeamRoleLockReason({ admin: false, setId: null }, { kind: "custom", setId: "pms_publisher" }, abilities), null);
  assert.match(sharedTeamRoleLockReason({ admin: false, setId: null }, { kind: "custom", setId: "pms_publisher" }, { ...abilities, canManagePermissions: false }) ?? "", /Manage permissions/);
});

test("shared roles: custom roles read by their own name", () => {
  const set = { kind: "team" as const, name: "Skill publisher", team: { id: "tem_sales", name: "Sales" } };
  assert.equal(roleName(set), "Skill publisher");
  assert.equal(permissionSourceRoleLabel({ kind: "team", label: "x", teamName: "Sales", setName: "Skill publisher" }), "Skill publisher via Sales");
  const teams = [{ id: "tem_sales", name: "Sales", memberIds: ["om_1"], grantsOrganizationAdmin: false }, { id: "tem_eng", name: "Engineering", memberIds: ["om_1"], grantsOrganizationAdmin: false }];
  const names = new Map([["tem_sales", "Skill publisher"], ["tem_eng", "Skill publisher"]]);
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "member", teams, customTeamIds: new Set(["tem_sales", "tem_eng"]), customRoleNameByTeam: names }), ["Skill publisher"]);
});

const roleSets: RoleSetLike[] = [
  { id: "set_member", kind: "member_default", name: "Member permissions", allowedCount: 0, team: null, teams: [] },
  { id: "set_admin", kind: "admin_default", name: "Admin permissions", allowedCount: 40, team: null, teams: [] },
  { id: "set_publisher", kind: "team", name: "Skill publisher", allowedCount: 3, team: null, teams: [{ id: "tem_sales", name: "Sales" }, { id: "tem_eng", name: "Engineering" }] },
  { id: "set_empty", kind: "team", name: "Unassigned", allowedCount: 0, team: null, teams: [] },
];
const roles = roleList({ sets: roleSets, readyMade: false });
const builtInOnly = roleList({ sets: [], readyMade: false });

test("Invite and Edit role list built-ins first, then every shared role by name, with grant locks", () => {
  const options = memberRoleOptions({ roles, canManageTeams: true, lockReasons: new Map([["set_publisher", "Ask the owner"]]) });
  assert.deepEqual(options.map((option) => [option.value, option.label, option.caption, option.disabled]), [
    ["member", "Member", "What everyone can do", false],
    ["admin", "Admin", "Invite people, manage teams, and run connections and models", false],
    ["super-admin", "Super admin", "Everything the owner can do, except delete the organization", false],
    ["role:set_publisher", "Skill publisher", "On Sales, Engineering", true],
    ["role:set_empty", "Unassigned", "No teams yet", false],
  ]);
  assert.equal(options[3]?.lockReason, "Ask the owner");
  assert.deepEqual(parseRoleChoice("role:set_publisher"), { role: "member", teamId: null });
  assert.deepEqual(parseRoleChoice("super-admin"), { role: "super-admin", teamId: null });
  assert.ok(memberRoleOptions({ roles, canManageTeams: false }).slice(3).every((option) => option.disabled));
});

test("Invite and Edit role keep built-ins when no custom roles exist", () => {
  assert.deepEqual(memberRoleOptions({ roles: builtInOnly, canManageTeams: true }).map((option) => option.value), ["member", "admin", "super-admin"]);
});

test("a team's Change role lists the same roles, each locked with the permission the change needs", () => {
  const state = { admin: false, setId: "set_publisher" };
  const options = teamRoleOptions({ roles, state, abilities: { canManageAdminTeams: false, canManagePermissions: true } });
  assert.deepEqual(options.map((option) => [option.value, option.label, option.caption, option.disabled]), [
    ["member", "Member", "What everyone can do", false],
    ["admin", "Admin", "Invite people, manage teams, and run connections and models", true],
    ["role:set_publisher", "Skill publisher", "On Sales, Engineering", false],
    ["role:set_empty", "Unassigned", "No teams yet", false],
  ]);
  assert.match(options[1]?.lockReason ?? "", /Manage Admin teams/);
  // The team's current role is never locked, whatever the person can change.
  const none = teamRoleOptions({ roles, state, abilities: { canManageAdminTeams: false, canManagePermissions: false } });
  assert.deepEqual(none.map((option) => option.disabled), [true, true, false, true]);
});

test("every role a team can pick is one Change role knows how to give", () => {
  for (const option of teamRoleOptions({ roles, state: { admin: false, setId: null }, abilities: all, showUnavailable: true })) {
    const role = sharedTeamRoleFromValue(option.value);
    if (option.disabled) continue;
    assert.ok(role, `${option.label} can be picked for a team but Change role can't give it`);
    assert.equal(sharedTeamRoleValue(role), option.value);
  }
});

test("readyMadeRoles: pickers list every role, with a lock and the reason on roles that can't be given there", () => {
  const team = teamRoleOptions({ roles, state: { admin: false, setId: null }, abilities: all, showUnavailable: true });
  assert.deepEqual(team.map((option) => [option.value, option.disabled]), [
    ["member", false], ["admin", false], ["super-admin", true], ["owner", true], ["role:set_publisher", false], ["role:set_empty", false],
  ]);
  assert.equal(team[2]?.lockReason, "Given to people, not teams.");
  const person = memberRoleOptions({ roles, canManageTeams: true, showUnavailable: true });
  assert.deepEqual(person.map((option) => option.value), team.map((option) => option.value));
  assert.deepEqual(person.filter((option) => option.disabled).map((option) => option.value), ["owner"]);
});

test("only the owner and super-admins can pick Super admin", () => {
  const locked = memberRoleOptions({ roles: builtInOnly, canManageTeams: true, superAdminLockReason: "Only the owner or a super admin can make someone a super admin." });
  const superAdmin = locked.find((option) => option.value === "super-admin");
  assert.equal(superAdmin?.disabled, true);
  assert.equal(superAdmin?.lockReason, "Only the owner or a super admin can make someone a super admin.");
  assert.equal(locked.find((option) => option.value === "admin")?.disabled, false);
  // Without Change member roles, Super admin is locked for the same reason as Admin.
  const noRoles = memberRoleOptions({ roles: builtInOnly, canManageTeams: true, adminLockReason: "Needs Change member roles" });
  assert.equal(noRoles.find((option) => option.value === "super-admin")?.lockReason, "Needs Change member roles");
  assert.equal(permissionSourceRoleLabel({ kind: "super_admin", label: "Super admin role" }), "Super admin");
});

test("the Super admin permission set reads as the Super admin built-in role", () => {
  assert.equal(roleName({ kind: "super_admin_default", name: "Super admin permissions", team: null }), "Super admin");
  assert.equal(roleKindLabel({ kind: "super_admin_default" }), "Built-in role");
  assert.equal(
    permissionSourceRoleLabel({ kind: "super_admin_default", label: "Super admin permissions (super admin role)", setName: "Super admin permissions" }),
    "Super admin",
  );
  assert.equal(permissionSourceRoleLabel({ kind: "code_default", label: "Super admin permissions (default)", set: "super-admin" }), "Super admin");
});
