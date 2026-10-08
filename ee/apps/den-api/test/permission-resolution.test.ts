import assert from "node:assert/strict"
import { test } from "node:test"
import {
  PERMISSIONS,
  PERMISSION_KEYS,
  permissionDefaultKeys,
  type PermissionKey,
} from "@openwork/types/den/permissions"
import {
  allowedKeys,
  buildPermissionRows,
  currentPermissionStates,
  monotonicPermissionRowTime,
  reconcileDecisions,
  type PermissionCatalogEntry,
  type PermissionHistoryRow,
} from "@openwork-ee/den-db/permission-states"
import { DefaultPermissionSetsMissingError, isDefaultPermissionSetsMissingError } from "@openwork-ee/den-db/permission-states"
import {
  allPermissionKeys,
  codeDefaultPermissionGrants,
  explainPermissionGrants,
  memberPermissionsFromGrants,
  ownerPermissionGrants,
  permissionDeniedMessage,
} from "../src/permissions/effective.ts"
import { isEffectiveOrganizationAdmin } from "../src/organization-role-hierarchy.ts"

const SET = "pms_01kx0000000000000000000set"
const OTHER_SET = "pms_01kx000000000000000000other"

function row(input: Partial<PermissionHistoryRow> & Pick<PermissionHistoryRow, "id" | "permissionKey" | "status"> & { at: number }): PermissionHistoryRow {
  return {
    id: input.id,
    permissionSetId: input.permissionSetId ?? SET,
    permissionKey: input.permissionKey,
    status: input.status,
    createdAt: new Date(input.at),
  }
}

test("the latest row per set and key wins", () => {
  const states = currentPermissionStates([
    row({ id: "psp_2", permissionKey: "billing.view", status: "deny", at: 2_000 }),
    row({ id: "psp_1", permissionKey: "billing.view", status: "allow", at: 1_000 }),
    row({ id: "psp_3", permissionKey: "billing.view", status: "allow", at: 1_500, permissionSetId: OTHER_SET }),
  ])
  assert.equal(states.get(SET)?.get("billing.view"), "deny")
  assert.equal(states.get(OTHER_SET)?.get("billing.view"), "allow")
})

test("rows with the same timestamp are ordered by id", () => {
  const forward = currentPermissionStates([
    row({ id: "psp_01kx000000000000000000000a", permissionKey: "billing.view", status: "allow", at: 1_000 }),
    row({ id: "psp_01kx000000000000000000000b", permissionKey: "billing.view", status: "deny", at: 1_000 }),
  ])
  const reversed = currentPermissionStates([
    row({ id: "psp_01kx000000000000000000000b", permissionKey: "billing.view", status: "deny", at: 1_000 }),
    row({ id: "psp_01kx000000000000000000000a", permissionKey: "billing.view", status: "allow", at: 1_000 }),
  ])
  assert.equal(forward.get(SET)?.get("billing.view"), "deny")
  assert.equal(reversed.get(SET)?.get("billing.view"), "deny")
})

test("deny after allow denies, allow after deny allows", () => {
  const states = currentPermissionStates([
    row({ id: "psp_1", permissionKey: "billing.view", status: "allow", at: 1_000 }),
    row({ id: "psp_2", permissionKey: "billing.view", status: "deny", at: 2_000 }),
    row({ id: "psp_3", permissionKey: "audit.view", status: "deny", at: 1_000 }),
    row({ id: "psp_4", permissionKey: "audit.view", status: "allow", at: 2_000 }),
  ])
  assert.deepEqual([...allowedKeys(states.get(SET))], ["audit.view"])
})

test("no row means denied, and keys no longer in the catalog are ignored", () => {
  const states = currentPermissionStates([
    row({ id: "psp_1", permissionKey: "retired.permission", status: "allow", at: 1_000 }),
    row({ id: "psp_2", permissionKey: "billing.view", status: "allow", at: 1_000 }),
  ])
  assert.equal(states.get(SET)?.get("retired.permission"), "allow")
  assert.deepEqual([...allowedKeys(states.get(SET))], ["billing.view"])
  assert.deepEqual([...allowedKeys(undefined)], [])
  assert.deepEqual([...allowedKeys(states.get(SET), ["audit.view"])], [])
})

const testCatalog = {
  "alpha.view": { defaultOn: ["member", "admin"] },
  "alpha.manage": { defaultOn: ["admin"], follows: "alpha.view" },
  "beta.view": { defaultOn: ["admin"] },
  "beta.manage": { defaultOn: ["admin"], follows: "beta.view" },
  "gamma.view": { defaultOn: [] },
} satisfies Record<string, PermissionCatalogEntry>

function decide(input: { set: "member" | "admin"; states: Record<string, "allow" | "deny"> }) {
  const currentStates = new Map(Object.entries(input.states))
  return reconcileDecisions({
    setDefaultKey: input.set,
    existingKeysEverSeen: new Set(currentStates.keys()),
    currentStates,
    catalog: testCatalog,
  })
}

test("reconcile allows default keys that were never seen", () => {
  assert.deepEqual(decide({ set: "member", states: {} }), [{ key: "alpha.view", status: "allow" }])
})

test("reconcile never touches explicit choices", () => {
  assert.deepEqual(decide({
    set: "admin",
    states: { "alpha.view": "deny", "alpha.manage": "deny", "beta.view": "allow", "beta.manage": "allow" },
  }), [])
})

test("reconcile denies a key whose follows is not allowed", () => {
  assert.deepEqual(decide({ set: "admin", states: { "alpha.view": "deny", "beta.view": "allow" } }), [
    { key: "alpha.manage", status: "deny" },
    { key: "beta.manage", status: "allow" },
  ])
})

test("reconcile decides a new key's follows target first", () => {
  assert.deepEqual(decide({ set: "admin", states: {} }), [
    { key: "alpha.view", status: "allow" },
    { key: "alpha.manage", status: "allow" },
    { key: "beta.view", status: "allow" },
    { key: "beta.manage", status: "allow" },
  ])
})

test("reconcile against the real catalog seeds exactly the code defaults", () => {
  for (const set of ["member", "admin"] as const) {
    const decisions = reconcileDecisions({ setDefaultKey: set, existingKeysEverSeen: new Set(), currentStates: new Map(), catalog: PERMISSIONS })
    assert.deepEqual(decisions.map((decision) => decision.key).sort(), [...permissionDefaultKeys(set)].sort())
    assert.ok(decisions.every((decision) => decision.status === "allow"))
  }
})

test("effective admin: direct admin, legacy super-admin, or an Admin team", () => {
  assert.equal(isEffectiveOrganizationAdmin({ directRole: "member", adminTeamIds: [] }), false)
  assert.equal(isEffectiveOrganizationAdmin({ directRole: "admin", adminTeamIds: [] }), true)
  assert.equal(isEffectiveOrganizationAdmin({ directRole: "member, super-admin", adminTeamIds: [] }), true)
  assert.equal(isEffectiveOrganizationAdmin({ directRole: "member", adminTeamIds: ["tem_1"] }), true)
})

test("the owner holds every catalog key", () => {
  const permissions = memberPermissionsFromGrants({ featureEnabled: true, isOwner: true, isAdmin: false, grants: ownerPermissionGrants() })
  assert.equal(permissions.keys.size, PERMISSION_KEYS.length)
  for (const key of PERMISSION_KEYS) assert.ok(permissions.has(key))
  assert.deepEqual(allPermissionKeys(), [...PERMISSION_KEYS].sort())
})

test("the owner holds every key even when grants are empty", () => {
  const permissions = memberPermissionsFromGrants({ featureEnabled: true, isOwner: true, isAdmin: false, grants: [] })
  assert.equal(permissions.keys.size, PERMISSION_KEYS.length)
})

function featureOffKeys(input: { directRole: string; adminTeamIds: string[] }): ReadonlySet<PermissionKey> {
  const isAdmin = isEffectiveOrganizationAdmin(input)
  return memberPermissionsFromGrants({ featureEnabled: false, isOwner: false, isAdmin, grants: codeDefaultPermissionGrants({ isAdmin }) }).keys
}

test("feature off: members get Member code defaults only", () => {
  assert.deepEqual([...featureOffKeys({ directRole: "member", adminTeamIds: [] })].sort(), [...permissionDefaultKeys("member")].sort())
})

test("feature off: admins and Admin team members also get Admin code defaults", () => {
  const expected = [...new Set([...permissionDefaultKeys("member"), ...permissionDefaultKeys("admin")])].sort()
  assert.deepEqual([...featureOffKeys({ directRole: "admin", adminTeamIds: [] })].sort(), expected)
  assert.deepEqual([...featureOffKeys({ directRole: "member", adminTeamIds: ["tem_1"] })].sort(), expected)
  assert.ok(featureOffKeys({ directRole: "admin", adminTeamIds: [] }).has("permissions.view"))
  assert.equal(featureOffKeys({ directRole: "member", adminTeamIds: [] }).has("permissions.view"), false)
})

test("feature off: former super-admin actions stay with the owner, not admins", () => {
  for (const key of ["permissions.manage", "members.update", "teams.manage_admin", "sso.manage", "scim.manage", "api_keys.manage", "connections.update", "connections.delete", "billing_portal.use"] as const) {
    assert.equal(featureOffKeys({ directRole: "admin", adminTeamIds: [] }).has(key), false, key)
    assert.equal(featureOffKeys({ directRole: "member", adminTeamIds: ["tem_1"] }).has(key), false, key)
  }
})

test("permissions are the union of grants, and explanations list every source", () => {
  const grants = [
    { source: { kind: "member_default" as const, setId: "pms_m", setName: "Member permissions" }, keys: new Set<PermissionKey>(["billing.view"]) },
    { source: { kind: "team" as const, setId: "pms_t", setName: "Support Permissions", teamId: "tem_s", teamName: "Support" }, keys: new Set<PermissionKey>(["billing.view", "audit.view"]) },
  ]
  const permissions = memberPermissionsFromGrants({ featureEnabled: true, isOwner: false, isAdmin: false, grants })
  assert.deepEqual([...permissions.keys].sort(), ["audit.view", "billing.view"])
  assert.equal(permissions.has("billing.manage"), false)
  assert.deepEqual(explainPermissionGrants(grants), [
    { key: "audit.view", sources: [grants[1]?.source] },
    { key: "billing.view", sources: [grants[0]?.source, grants[1]?.source] },
  ])
})

test("denied messages come from the catalog label", () => {
  assert.equal(
    permissionDeniedMessage("llm_providers.delete"),
    "You don't have permission to delete any provider. Ask an admin to change your permissions.",
  )
  assert.equal(permissionDeniedMessage("sso.manage"), "You don't have permission to manage single sign-on. Ask the organization owner.")
})

test("new rows sort after the set's latest row even when the clock is behind", () => {
  const now = new Date(10_000)
  assert.equal(monotonicPermissionRowTime(now, null).getTime(), 10_000)
  assert.equal(monotonicPermissionRowTime(now, new Date(5_000)).getTime(), 10_000)
  assert.equal(monotonicPermissionRowTime(now, new Date(10_000)).getTime(), 10_001)
  assert.equal(monotonicPermissionRowTime(now, new Date(20_000)).getTime(), 20_001)

  const latest = new Date(20_000)
  const built = buildPermissionRows({
    organizationId: "org_01kx0000000000000000000org",
    permissionSetId: SET,
    changes: [{ key: "billing.view", status: "deny" }, { key: "audit.view", status: "allow" }],
    source: "user",
    now,
    notBefore: latest,
  })
  assert.ok(built.every((entry) => entry.createdAt?.getTime() === 20_001))

  // The new deny wins over an earlier allow written at the later clock time.
  const states = currentPermissionStates([
    row({ id: "psp_01kx00000000000000000000zz", permissionKey: "billing.view", status: "allow", at: 20_000 }),
    ...built.map((entry) => row({ id: entry.id, permissionKey: entry.permissionKey, status: entry.status, at: entry.createdAt?.getTime() ?? 0 })),
  ])
  assert.equal(states.get(SET)?.get("billing.view"), "deny")
  assert.equal(states.get(SET)?.get("audit.view"), "allow")
  assert.equal(buildPermissionRows({ organizationId: "org_01kx0000000000000000000org", permissionSetId: SET, changes: [{ key: "billing.view", status: "allow" }], source: "seed", now })[0]?.createdAt?.getTime(), 10_000)
})

test("only the missing-default-sets error is treated as a fallback", () => {
  assert.equal(isDefaultPermissionSetsMissingError(new DefaultPermissionSetsMissingError("org_01kx0000000000000000000org")), true)
  assert.equal(isDefaultPermissionSetsMissingError(new Error("Connection lost")), false)
  assert.equal(isDefaultPermissionSetsMissingError({ code: "ER_DUP_ENTRY" }), false)
  assert.equal(isDefaultPermissionSetsMissingError(null), false)
})
