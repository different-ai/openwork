import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSION_KEYS, permissionDefaultKeys } from "@openwork/types/den/permissions";
import {
  allowedKeys,
  customRoleChoice,
  memberRoleOptions,
  parseRoleChoice,
  permissionSourceRoleLabel,
  roleKindLabel,
  roleName,
  roleStartKeys,
  permissionSetTeams,
  teamRole,
  teamRoleLabels,
} from "./team-roles";

const member = { admin: false, customSetId: null };
const admin = { admin: true, customSetId: null };
const custom = { admin: false, customSetId: "pms_team" };

test("a team's role comes from the Admin flag and its permission set, Admin first", () => {
  assert.equal(teamRole(member), "member");
  assert.equal(teamRole(admin), "admin");
  assert.equal(teamRole(custom), "custom");
  assert.equal(teamRole({ admin: true, customSetId: "pms_team" }), "admin");
});

test("shared team associations take precedence over the legacy first-team projection", () => {
  const first = { id: "tem_first", name: "First" };
  const second = { id: "tem_second", name: "Second" };
  assert.deepEqual(permissionSetTeams({ teams: [first, second], team: first }), [first, second]);
  assert.deepEqual(permissionSetTeams({ teams: [], team: first }), [first]);
  assert.deepEqual(permissionSetTeams({ teams: [], team: null }), []);
});

test("a new role starts from Member, Admin or everything, limited to what the creator holds", () => {
  const owner = new Set<string>(PERMISSION_KEYS);
  assert.deepEqual(roleStartKeys("everything", owner), [...PERMISSION_KEYS]);
  assert.deepEqual(roleStartKeys("admin", owner), permissionDefaultKeys("admin"));
  assert.deepEqual(roleStartKeys("member", owner), permissionDefaultKeys("member"));
  assert.deepEqual(roleStartKeys("everything", new Set(["teams.view"])), ["teams.view"]);
});

test("every screen names roles the same way, never by Den's stored set names", () => {
  assert.equal(roleName({ kind: "member_default", name: "Member permissions", team: null }), "Member");
  assert.equal(roleName({ kind: "admin_default", name: "Admin permissions", team: null }), "Admin");
  assert.equal(roleName({ kind: "team", name: "Engineering Permissions", team: { id: "tem_1", name: "Engineering" } }), "Engineering");
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

test("an Admin team still contributes its independent custom role", () => {
  const teams = [{ id: "tem_dual", name: "Editors", memberIds: ["om_1"], grantsOrganizationAdmin: true }];
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "member", teams, customTeamIds: new Set(["tem_dual"]), customRoleNameByTeam: new Map([["tem_dual", "Publisher"]]) }), ["Admin via Editors", "Publisher"]);
});

test("sharedRoles: custom roles read by their own name", () => {
  const set = { kind: "team" as const, name: "Skill publisher", team: { id: "tem_sales", name: "Sales" } };
  assert.equal(roleName(set), "Sales");
  assert.equal(roleName(set, { shared: true }), "Skill publisher");
  assert.equal(permissionSourceRoleLabel({ kind: "team", label: "x", teamName: "Sales", setName: "Skill publisher" }, { shared: true }), "Skill publisher via Sales");
  const teams = [{ id: "tem_sales", name: "Sales", memberIds: ["om_1"], grantsOrganizationAdmin: false }, { id: "tem_eng", name: "Engineering", memberIds: ["om_1"], grantsOrganizationAdmin: false }];
  const names = new Map([["tem_sales", "Skill publisher"], ["tem_eng", "Skill publisher"]]);
  assert.deepEqual(teamRoleLabels({ memberId: "om_1", ownRole: "member", teams, customTeamIds: new Set(["tem_sales", "tem_eng"]), customRoleNameByTeam: names }), ["Skill publisher"]);
});

test("Invite and Edit role list built-ins first, then every shared role by name, with grant locks", () => {
  const customRoles = [
    { id: "set_publisher", name: "Skill publisher", teams: [{ id: "tem_sales", name: "Sales" }, { id: "tem_eng", name: "Engineering" }] },
    { id: "set_empty", name: "Unassigned", teams: [] },
  ];
  const options = memberRoleOptions({ sharedRoles: true, customRoleTeams: [], customRoles, canManageTeams: true, lockReasons: new Map([["set_publisher", "Ask the owner"]]) });
  assert.deepEqual(options.map((option) => [option.value, option.label, option.caption, option.disabled]), [
    ["member", "Member", null, false], ["admin", "Admin", null, false],
    ["role:set_publisher", "Skill publisher", "On Sales, Engineering", true],
    ["role:set_empty", "Unassigned", "No teams yet", false],
  ]);
  assert.equal(options[2]?.lockReason, "Ask the owner");
  assert.deepEqual(parseRoleChoice("role:set_publisher"), { role: "member", teamId: null });
  assert.ok(memberRoleOptions({ sharedRoles: true, customRoleTeams: [], customRoles, canManageTeams: false }).slice(2).every((option) => option.disabled));
});

test("Without shared roles, Invite and Edit role retain custom roles by team", () => {
  const customRoleTeams = [{ id: "tem_eng", name: "test Permissions" }, { id: "tem_scim", name: "Directory", managedByScim: true }];
  const shared = memberRoleOptions({ sharedRoles: true, customRoleTeams, canManageTeams: true });
  assert.deepEqual(shared.map((option) => option.value), ["member", "admin"]);
  const byTeam = memberRoleOptions({ sharedRoles: false, customRoleTeams, canManageTeams: true });
  assert.deepEqual(byTeam.map((option) => [option.value, option.label, option.caption, option.disabled]), [
    ["member", "Member", null, false],
    ["admin", "Admin", null, false],
    ["team:tem_eng", "test Permissions", "Custom role", false],
    ["team:tem_scim", "Directory", "Custom role", true],
  ]);
  assert.ok(memberRoleOptions({ sharedRoles: false, customRoleTeams, canManageTeams: false }).filter((option) => option.caption).every((option) => option.disabled));
  assert.deepEqual(parseRoleChoice(byTeam[2]?.value ?? ""), { role: "member", teamId: "tem_eng" });
});
