import assert from "node:assert/strict";
import { test } from "node:test";
import { BILLING_MANAGER_PERMISSION_KEYS, PERMISSION_DEFAULT_SET_KEYS, PERMISSION_KEYS, permissionDefaultKeys } from "@openwork/types/den/permissions";
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_IDS,
  READY_MADE_ROLES,
  READY_MADE_ROLE_IDS,
  ROLE_STARTS,
  builtInRoleForSetKind,
  customRoleSetId,
  customRoleValue,
  defaultSetForSetKind,
  isRoleStart,
  roleList,
  roleOptions,
  roleSetKindRank,
  roleSetTeams,
  roleStartKeys,
  roleStartLabel,
  roleStartMissingLabels,
  type RoleSetLike,
} from "./role-catalog";

const sets: RoleSetLike[] = [
  { id: "set_publisher", kind: "team", name: "Skill publisher", allowedCount: 3, team: null, teams: [{ id: "tem_sales", name: "Sales" }, { id: "tem_eng", name: "Engineering" }] },
  { id: "set_admin", kind: "admin_default", name: "Admin permissions", allowedCount: 40, team: null, teams: [] },
  { id: "set_member", kind: "member_default", name: "Member permissions", allowedCount: 0, team: null, teams: [] },
];
/** Older responses carry one `team` instead of `teams`. */
const legacySet: RoleSetLike = { id: "set_legacy", kind: "team", name: "Support Permissions", allowedCount: 1, team: { id: "tem_support", name: "Support" }, teams: [] };
sets.push(legacySet);

test("every screen lists roles in one order: built-in, then custom, then ready-made", () => {
  const roles = roleList({ sets, readyMade: true });
  assert.deepEqual(roles.map((role) => [role.kind, role.value, role.label]), [
    ["built_in", "member", "Member"],
    ["built_in", "admin", "Admin"],
    ["built_in", "super-admin", "Super admin"],
    ["built_in", "owner", "Owner"],
    ["custom", "role:set_publisher", "Skill publisher"],
    ["custom", "role:set_legacy", "Support Permissions"],
    ["ready_made", "ready:billing", "Billing manager"],
  ]);
  // A built-in role opens its permission set when the organization has one.
  assert.deepEqual(roles.flatMap((role) => role.kind === "built_in" ? [role.setId] : []), ["set_member", "set_admin", null, null]);
  assert.deepEqual(roleSetTeams(legacySet), [{ id: "tem_support", name: "Support" }]);
});

test("ready-made roles are listed only with readyMadeRoles on, and only until someone adds them", () => {
  assert.equal(roleList({ sets, readyMade: false }).some((role) => role.kind === "ready_made"), false);
  const added: RoleSetLike[] = [...sets, { id: "set_billing", kind: "team", name: " billing Manager ", allowedCount: 5, team: null, teams: [] }];
  assert.equal(roleList({ sets: added, readyMade: true }).some((role) => role.kind === "ready_made"), false);
});

test("a picker never offers a ready-made role, and leaves out roles it can't give unless asked to show them locked", () => {
  const roles = roleList({ sets, readyMade: true });
  for (const holder of ["person", "team"] as const) {
    const shown = roleOptions({ roles, holder, showUnavailable: true });
    // With showUnavailable, a picker lists exactly the roles the Roles tab lists, in the same order.
    assert.deepEqual(shown.map((option) => option.value), roles.filter((role) => role.kind !== "ready_made").map((role) => role.value));
    const hidden = roleOptions({ roles, holder, showUnavailable: false });
    assert.deepEqual(hidden.map((option) => option.value), shown.filter((option) => !option.disabled).map((option) => option.value));
    for (const option of shown) assert.equal(option.disabled, option.lockReason !== null);
  }
  assert.deepEqual(roleOptions({ roles, holder: "team", showUnavailable: false }).map((option) => option.value), ["member", "admin", "role:set_publisher", "role:set_legacy"]);
  assert.deepEqual(roleOptions({ roles, holder: "person", showUnavailable: false }).map((option) => option.value), ["member", "admin", "super-admin", "role:set_publisher", "role:set_legacy"]);
  const locked = roleOptions({ roles, holder: "person", showUnavailable: false, lockReason: (role) => role.kind === "custom" ? "Ask the owner" : null });
  assert.deepEqual(locked.filter((option) => option.disabled).map((option) => option.group), ["custom", "custom"]);
});

test("each default permission set is exactly one built-in role, and Owner has none", () => {
  const defaults = BUILT_IN_ROLE_IDS.flatMap((id) => BUILT_IN_ROLES[id].defaultSet ?? []);
  assert.deepEqual(defaults, [...PERMISSION_DEFAULT_SET_KEYS]);
  assert.equal(BUILT_IN_ROLES.owner.setKind, null);
  assert.equal(builtInRoleForSetKind("super_admin_default"), "super-admin");
  assert.equal(builtInRoleForSetKind("team"), null);
  assert.equal(defaultSetForSetKind("admin_default"), "admin");
  assert.equal(defaultSetForSetKind("team"), null);
  const kinds: RoleSetLike["kind"][] = ["team", "super_admin_default", "member_default", "admin_default"];
  assert.deepEqual(kinds.sort((a, b) => roleSetKindRank(a) - roleSetKindRank(b)), ["member_default", "admin_default", "super_admin_default", "team"]);
});

test("role names are unique, so a role is never listed twice under one name", () => {
  const labels = [...BUILT_IN_ROLE_IDS.map((id) => BUILT_IN_ROLES[id].label), ...READY_MADE_ROLE_IDS.map((id) => READY_MADE_ROLES[id].label)].map((label) => label.toLocaleLowerCase());
  assert.equal(new Set(labels).size, labels.length);
});

test("a new role starts from Member, Admin, a ready-made role or everything, limited to what the creator holds", () => {
  const owner = new Set<string>(PERMISSION_KEYS);
  assert.deepEqual([...ROLE_STARTS], ["member", "admin", "billing", "everything"]);
  assert.deepEqual(ROLE_STARTS.map(roleStartLabel), ["Member", "Admin", "Billing manager", "Everything the owner can do"]);
  assert.deepEqual(roleStartKeys("everything", owner), [...PERMISSION_KEYS]);
  assert.deepEqual(roleStartKeys("admin", owner), permissionDefaultKeys("admin"));
  assert.deepEqual(roleStartKeys("member", owner), permissionDefaultKeys("member"));
  assert.deepEqual(roleStartKeys("billing", owner), [...BILLING_MANAGER_PERMISSION_KEYS]);
  // Limited to what the creator holds, like every other starting point.
  assert.deepEqual(roleStartKeys("billing", new Set(["billing.view", "billing_invoices.view"])), ["billing.view", "billing_invoices.view"]);
  assert.deepEqual(roleStartKeys("everything", new Set(["teams.view"])), ["teams.view"]);
  assert.equal(isRoleStart("billing"), true);
  assert.equal(isRoleStart("owner"), false);
});

test("Create role says which of a starting point's permissions the creator can't give", () => {
  const admin = new Set<string>(permissionDefaultKeys("admin"));
  assert.deepEqual(roleStartMissingLabels("billing", new Set<string>(PERMISSION_KEYS)), []);
  // The billing portal is owner-only by default, so an admin's Billing manager starts without it.
  assert.deepEqual(roleStartMissingLabels("billing", admin), ["Open the billing portal"]);
  assert.deepEqual(roleStartMissingLabels("everything", admin), []);
});

test("a custom role's picker value round-trips to its permission set", () => {
  assert.equal(customRoleSetId(customRoleValue("set_publisher")), "set_publisher");
  assert.equal(customRoleSetId("admin"), null);
  assert.equal(customRoleSetId("role:"), null);
});
