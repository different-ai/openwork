import assert from "node:assert/strict";
import { test } from "node:test";
import { BILLING_MANAGER_PERMISSION_KEYS, PERMISSION_DEFAULT_SET_KEYS, PERMISSION_KEYS, permissionDefaultKeys } from "@openwork/types/den/permissions";
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_IDS,
  ROLE_STARTS,
  builtInRoleForSetKind,
  customRoleSetId,
  customRoleValue,
  defaultSetForSetKind,
  isRoleStart,
  roleHeldByLabel,
  roleList,
  roleOptions,
  roleSetKindRank,
  roleSetTeams,
  roleStartKeys,
  roleStartLabel,
  roleStartMissingLabels,
  roleUnavailableReason,
  type RoleSetLike,
} from "./role-catalog";

/** Older responses carry one `team` instead of `teams`, and no directMemberIds. */
const legacySet: RoleSetLike = { id: "set_legacy", kind: "team", name: "Support Permissions", allowedCount: 1, team: { id: "tem_support", name: "Support" }, teams: [] };
const sets: RoleSetLike[] = [
  { id: "set_publisher", kind: "team", name: "Skill publisher", allowedCount: 3, team: null, teams: [{ id: "tem_sales", name: "Sales" }, { id: "tem_eng", name: "Engineering" }], directMemberIds: ["om_riley"] },
  { id: "set_billing", kind: "billing_manager_default", name: "Billing manager permissions", allowedCount: 5, team: null, teams: [{ id: "tem_finance", name: "Finance" }], directMemberIds: ["om_casey"] },
  { id: "set_admin", kind: "admin_default", name: "Admin permissions", allowedCount: 40, team: null, teams: [] },
  { id: "set_member", kind: "member_default", name: "Member permissions", allowedCount: 0, team: null, teams: [] },
  legacySet,
];

test("every screen lists roles in one order: built-in roles, then custom roles", () => {
  const roles = roleList({ sets });
  assert.deepEqual(roles.map((role) => [role.kind, role.value, role.label]), [
    ["built_in", "member", "Member"],
    ["built_in", "admin", "Admin"],
    ["built_in", "billing-manager", "Billing manager"],
    ["built_in", "super-admin", "Super admin"],
    ["built_in", "owner", "Owner"],
    ["custom", "role:set_publisher", "Skill publisher"],
    ["custom", "role:set_legacy", "Support Permissions"],
  ]);
  // A built-in role opens its permission set when the organization has one.
  assert.deepEqual(roles.flatMap((role) => role.kind === "built_in" ? [role.setId] : []), ["set_member", "set_admin", "set_billing", null, null]);
  // Who a role was given to by link travels with it.
  const billing = roles.find((role) => role.value === "billing-manager");
  assert.deepEqual([billing?.teams.map((team) => team.id), billing?.directMemberIds], [["tem_finance"], ["om_casey"]]);
  assert.deepEqual(roleSetTeams(legacySet), [{ id: "tem_support", name: "Support" }]);
  assert.deepEqual(roles.find((role) => role.value === "role:set_legacy")?.directMemberIds, []);
});

test("a picker lists exactly the roles the Roles tab lists, locking the ones it can't give with the reason", () => {
  const roles = roleList({ sets });
  for (const holder of ["person", "team"] as const) {
    const options = roleOptions({ roles, holder });
    assert.deepEqual(options.map((option) => option.value), roles.map((role) => role.value));
    for (const option of options) assert.equal(option.disabled, option.lockReason !== null, option.label);
  }
  // A person can be given every role but Owner.
  assert.deepEqual(roleOptions({ roles, holder: "person" }).filter((option) => option.disabled).map((option) => [option.value, option.lockReason]), [["owner", "Changes by transferring ownership."]]);
  // A team can too, except Super admin while the organization has no Super admin set to give.
  assert.deepEqual(roleOptions({ roles, holder: "team" }).filter((option) => option.disabled).map((option) => [option.value, option.lockReason]), [
    ["super-admin", "Given to people, not teams."],
    ["owner", "Held by one person, not a team."],
  ]);
  const withSuperAdminSet = roleList({ sets: [...sets, { id: "set_super", kind: "super_admin_default", name: "Super admin permissions", allowedCount: 60, team: null, teams: [] }] });
  assert.deepEqual(roleOptions({ roles: withSuperAdminSet, holder: "team" }).filter((option) => option.disabled).map((option) => option.value), ["owner"]);
  // The caller's own locks apply on top, and never unlock a role that can't be given.
  const locked = roleOptions({ roles, holder: "person", lockReason: () => "Ask the owner" });
  assert.equal(locked.every((option) => option.disabled), true);
  assert.equal(locked.find((option) => option.value === "owner")?.lockReason, "Changes by transferring ownership.");
});

test("a role that is a set given by link needs that set", () => {
  const withoutSets = roleList({ sets: [] });
  const billing = withoutSets.find((role) => role.value === "billing-manager");
  assert.ok(billing);
  // Someone who can't read permission sets can't give Billing manager.
  assert.match(roleUnavailableReason(billing, "person") ?? "", /View permissions/);
  const admin = withoutSets.find((role) => role.value === "admin");
  assert.ok(admin);
  assert.equal(roleUnavailableReason(admin, "person"), null);
  assert.equal(roleUnavailableReason(admin, "team"), null);
});

test("each built-in permission set is exactly one built-in role, and Owner has none", () => {
  const defaults = BUILT_IN_ROLE_IDS.flatMap((id) => BUILT_IN_ROLES[id].defaultSet ?? []);
  assert.deepEqual(defaults, [...PERMISSION_DEFAULT_SET_KEYS]);
  assert.equal(BUILT_IN_ROLES.owner.setKind, null);
  assert.equal(builtInRoleForSetKind("billing_manager_default"), "billing-manager");
  assert.equal(builtInRoleForSetKind("super_admin_default"), "super-admin");
  assert.equal(builtInRoleForSetKind("team"), null);
  assert.equal(defaultSetForSetKind("admin_default"), "admin");
  assert.equal(defaultSetForSetKind("team"), null);
  const kinds: RoleSetLike["kind"][] = ["team", "super_admin_default", "member_default", "billing_manager_default", "admin_default"];
  assert.deepEqual(kinds.sort((a, b) => roleSetKindRank(a) - roleSetKindRank(b)), ["member_default", "admin_default", "billing_manager_default", "super_admin_default", "team"]);
  const labels = BUILT_IN_ROLE_IDS.map((id) => BUILT_IN_ROLES[id].label.toLocaleLowerCase());
  assert.equal(new Set(labels).size, labels.length);
});

test("a new role starts from Member, Admin, Billing manager or everything, limited to what the creator holds", () => {
  const owner = new Set<string>(PERMISSION_KEYS);
  assert.deepEqual([...ROLE_STARTS], ["member", "admin", "billing-manager", "everything"]);
  assert.deepEqual(ROLE_STARTS.map(roleStartLabel), ["Member", "Admin", "Billing manager", "Everything the owner can do"]);
  assert.deepEqual(roleStartKeys("everything", owner), [...PERMISSION_KEYS]);
  assert.deepEqual(roleStartKeys("admin", owner), permissionDefaultKeys("admin"));
  assert.deepEqual(roleStartKeys("member", owner), permissionDefaultKeys("member"));
  assert.deepEqual(roleStartKeys("billing-manager", owner), [...BILLING_MANAGER_PERMISSION_KEYS]);
  // Limited to what the creator holds, like every other starting point.
  assert.deepEqual(roleStartKeys("billing-manager", new Set(["billing.view", "billing_invoices.view"])), ["billing.view", "billing_invoices.view"]);
  assert.deepEqual(roleStartKeys("everything", new Set(["teams.view"])), ["teams.view"]);
  assert.equal(isRoleStart("billing-manager"), true);
  assert.equal(isRoleStart("owner"), false);
});

test("Create role says which of a starting point's permissions the creator can't give", () => {
  const admin = new Set<string>(permissionDefaultKeys("admin"));
  assert.deepEqual(roleStartMissingLabels("billing-manager", new Set<string>(PERMISSION_KEYS)), []);
  // The billing portal is owner-only for admins, so an admin's copy of Billing manager starts without it.
  assert.deepEqual(roleStartMissingLabels("billing-manager", admin), ["Open the billing portal"]);
  assert.deepEqual(roleStartMissingLabels("everything", admin), []);
});

test("lists say who holds a role the same way everywhere", () => {
  assert.equal(roleHeldByLabel(0, []), "Nobody yet");
  assert.equal(roleHeldByLabel(1, []), "1 person");
  assert.equal(roleHeldByLabel(2, ["Finance", "Sales"]), "2 people, Finance, Sales");
  assert.equal(roleHeldByLabel(0, ["Finance"]), "Finance");
});

test("a custom role's picker value round-trips to its permission set", () => {
  assert.equal(customRoleSetId(customRoleValue("set_publisher")), "set_publisher");
  assert.equal(customRoleSetId("admin"), null);
  assert.equal(customRoleSetId("role:"), null);
});
