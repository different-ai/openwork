import assert from "node:assert/strict"
import { test } from "node:test"
import { PERMISSION_KEYS, getPermissionDefinition, isPermissionLockedOn, type PermissionKey } from "@openwork/types/den/permissions"
import {
  currentPermissionStatus,
  latestPermissionRows,
  permissionEditProblemMessage,
  permissionKeyDelta,
  permissionSetKeyStates,
  permissionSourceLabel,
  planPermissionSetCreate,
  planPermissionSetEdit,
  teamPermissionSetName,
  type PermissionEditor,
  type PermissionStatus,
} from "../src/permissions/set-edits.ts"

function editor(keys: readonly PermissionKey[], options: { isOwner?: boolean; isAdmin?: boolean } = {}): PermissionEditor {
  const held = new Set(keys)
  return { isOwner: options.isOwner ?? false, isAdmin: options.isAdmin ?? false, has: (key) => held.has(key) }
}

const OWNER = editor([], { isOwner: true })
const LOCKED_ADMIN_KEYS = PERMISSION_KEYS.filter((key) => isPermissionLockedOn(key, "admin"))
const UNLOCKED_KEYS = PERMISSION_KEYS.filter((key) => !isPermissionLockedOn(key, "admin"))
const [KEY_A, KEY_B, KEY_C] = UNLOCKED_KEYS

function states(entries: Record<string, PermissionStatus>): Map<string, PermissionStatus> {
  return new Map(Object.entries(entries))
}

test("catalog has locked admin keys and enough unlocked keys for these tests", () => {
  assert.ok(LOCKED_ADMIN_KEYS.includes("permissions.manage"))
  assert.ok(LOCKED_ADMIN_KEYS.includes("permissions.view"))
  assert.ok(KEY_A && KEY_B && KEY_C)
})

test("edit: only changes whose status differs are planned, in request order", () => {
  assert.ok(KEY_A && KEY_B && KEY_C)
  const plan = planPermissionSetEdit({
    defaultKey: null,
    current: states({ [KEY_A]: "allow", [KEY_B]: "deny" }),
    changes: [
      { key: KEY_C, status: "allow" },
      { key: KEY_A, status: "allow" },
      { key: KEY_B, status: "deny" },
    ],
    editor: OWNER,
  })
  assert.deepEqual(plan, { ok: true, changes: [{ key: KEY_C, status: "allow" }] })
})

test("edit: no row means denied, so denying an unseen key is a no-op", () => {
  assert.ok(KEY_A)
  const plan = planPermissionSetEdit({ defaultKey: "member", current: new Map(), changes: [{ key: KEY_A, status: "deny" }], editor: OWNER })
  assert.deepEqual(plan, { ok: true, changes: [] })
  assert.equal(currentPermissionStatus(new Map(), KEY_A), "deny")
})

test("edit: unknown keys are rejected before anything else", () => {
  const plan = planPermissionSetEdit({
    defaultKey: "admin",
    current: new Map(),
    changes: [{ key: "nope.never", status: "allow" }, { key: "permissions.manage", status: "deny" }],
    editor: editor([]),
  })
  assert.deepEqual(plan, { ok: false, problem: { error: "unknown_permission", keys: ["nope.never"] } })
})

test("edit: duplicate keys are rejected", () => {
  assert.ok(KEY_A)
  const plan = planPermissionSetEdit({
    defaultKey: null,
    current: new Map(),
    changes: [{ key: KEY_A, status: "allow" }, { key: KEY_A, status: "deny" }],
    editor: OWNER,
  })
  assert.deepEqual(plan, { ok: false, problem: { error: "duplicate_permission", keys: [KEY_A] } })
})

test("edit: denying a key locked on for admins is rejected in Admin permissions, even for the owner", () => {
  const plan = planPermissionSetEdit({
    defaultKey: "admin",
    current: states({ "permissions.manage": "allow", "permissions.view": "allow" }),
    changes: [{ key: "permissions.view", status: "deny" }, { key: "permissions.manage", status: "deny" }],
    editor: OWNER,
  })
  assert.deepEqual(plan, { ok: false, problem: { error: "permission_locked", keys: ["permissions.manage", "permissions.view"] } })
})

test("edit: locked keys can be denied in Member and team sets", () => {
  for (const defaultKey of ["member", null] as const) {
    const plan = planPermissionSetEdit({
      defaultKey,
      current: states({ "permissions.manage": "allow" }),
      changes: [{ key: "permissions.manage", status: "deny" }],
      editor: OWNER,
    })
    assert.deepEqual(plan, { ok: true, changes: [{ key: "permissions.manage", status: "deny" }] })
  }
})

test("edit: allowing a key the editor doesn't hold is rejected; the owner holds everything", () => {
  assert.ok(KEY_A && KEY_B)
  const changes = [{ key: KEY_A, status: "allow" as const }, { key: KEY_B, status: "allow" as const }]
  const denied = planPermissionSetEdit({ defaultKey: null, current: new Map(), changes, editor: editor([KEY_A]) })
  assert.deepEqual(denied, { ok: false, problem: { error: "permission_not_held", keys: [KEY_B] } })

  const allowed = planPermissionSetEdit({ defaultKey: null, current: new Map(), changes, editor: editor([KEY_A, KEY_B]) })
  assert.equal(allowed.ok, true)
  const owner = planPermissionSetEdit({ defaultKey: null, current: new Map(), changes, editor: OWNER })
  assert.equal(owner.ok, true)
})

test("edit: resending an allow the editor doesn't hold is fine when nothing changes, and denying is always fine", () => {
  assert.ok(KEY_A && KEY_B)
  for (const defaultKey of ["admin", "member", null] as const) {
    const plan = planPermissionSetEdit({
      defaultKey,
      current: states({ [KEY_A]: "allow", [KEY_B]: "allow" }),
      changes: [{ key: KEY_A, status: "allow" }, { key: KEY_B, status: "deny" }],
      editor: editor([], { isAdmin: true }),
    })
    assert.deepEqual(plan, { ok: true, changes: [{ key: KEY_B, status: "deny" }] })
  }
})

test("edit: only the owner or an effective admin can change Admin permissions, allow or deny", () => {
  assert.ok(KEY_A && KEY_B)
  // permissions.manage from a team set, but not an admin.
  const teamManager = editor(["permissions.manage", "permissions.view", KEY_A, KEY_B])
  for (const status of ["allow", "deny"] as const) {
    const plan = planPermissionSetEdit({
      defaultKey: "admin",
      current: states({ [KEY_A]: status === "allow" ? "deny" : "allow" }),
      changes: [{ key: KEY_B, status }, { key: KEY_A, status }],
      editor: teamManager,
    })
    assert.deepEqual(plan, { ok: false, problem: { error: "admin_permissions_require_admin", keys: [KEY_A, KEY_B].sort() } })
  }
  // Rejected even when nothing would change.
  const noop = planPermissionSetEdit({ defaultKey: "admin", current: new Map(), changes: [{ key: KEY_A, status: "deny" }], editor: teamManager })
  assert.equal(noop.ok, false)

  // The same editor can still change Member and team sets.
  for (const defaultKey of ["member", null] as const) {
    const plan = planPermissionSetEdit({ defaultKey, current: new Map(), changes: [{ key: KEY_A, status: "allow" }], editor: teamManager })
    assert.deepEqual(plan, { ok: true, changes: [{ key: KEY_A, status: "allow" }] })
  }

  const admin = planPermissionSetEdit({ defaultKey: "admin", current: states({ [KEY_A]: "allow" }), changes: [{ key: KEY_A, status: "deny" }], editor: editor([KEY_A], { isAdmin: true }) })
  assert.deepEqual(admin, { ok: true, changes: [{ key: KEY_A, status: "deny" }] })
  const owner = planPermissionSetEdit({ defaultKey: "admin", current: states({ [KEY_A]: "allow" }), changes: [{ key: KEY_A, status: "deny" }], editor: OWNER })
  assert.deepEqual(owner, { ok: true, changes: [{ key: KEY_A, status: "deny" }] })
  assert.match(permissionEditProblemMessage({ error: "admin_permissions_require_admin", keys: [KEY_A] }), /owner and admins/)
})

test("edit: re-allowing a shipped default in its default set doesn't require holding it", () => {
  assert.ok(KEY_A && KEY_B)
  const adminDefault = PERMISSION_KEYS.filter((key) => getPermissionDefinition(key).defaultOn.includes("admin"))
  assert.ok(adminDefault.includes(KEY_A))
  // An admin removed KEY_A from Admin permissions (so no longer holds it) and restores it.
  const restore = planPermissionSetEdit({
    defaultKey: "admin",
    current: states({ [KEY_A]: "deny" }),
    changes: [{ key: KEY_A, status: "allow" }],
    editor: editor(["permissions.manage"], { isAdmin: true }),
  })
  assert.deepEqual(restore, { ok: true, changes: [{ key: KEY_A, status: "allow" }] })

  // Not waived for a team set, nor for a key that isn't on by default in that set.
  const team = planPermissionSetEdit({ defaultKey: null, current: new Map(), changes: [{ key: KEY_A, status: "allow" }], editor: editor([], { isAdmin: true }) })
  assert.deepEqual(team, { ok: false, problem: { error: "permission_not_held", keys: [KEY_A] } })
  const notMemberDefault = UNLOCKED_KEYS.find((key) => !getPermissionDefinition(key).defaultOn.includes("member"))
  assert.ok(notMemberDefault)
  const member = planPermissionSetEdit({ defaultKey: "member", current: new Map(), changes: [{ key: notMemberDefault, status: "allow" }], editor: editor([], { isAdmin: true }) })
  assert.deepEqual(member, { ok: false, problem: { error: "permission_not_held", keys: [notMemberDefault] } })
})

test("create: only allow rows are planned and the editor must hold each", () => {
  assert.ok(KEY_A && KEY_B && KEY_C)
  const plan = planPermissionSetCreate({
    permissions: [{ key: KEY_A, status: "allow" }, { key: KEY_B, status: "deny" }, { key: KEY_C, status: "allow" }],
    editor: editor([KEY_A, KEY_C]),
  })
  assert.deepEqual(plan, { ok: true, changes: [{ key: KEY_A, status: "allow" }, { key: KEY_C, status: "allow" }] })

  const denied = planPermissionSetCreate({ permissions: [{ key: KEY_B, status: "allow" }], editor: editor([KEY_A]) })
  assert.deepEqual(denied, { ok: false, problem: { error: "permission_not_held", keys: [KEY_B] } })

  const unknown = planPermissionSetCreate({ permissions: [{ key: "x.y", status: "deny" }], editor: OWNER })
  assert.deepEqual(unknown, { ok: false, problem: { error: "unknown_permission", keys: ["x.y"] } })

  assert.deepEqual(planPermissionSetCreate({ permissions: [], editor: editor([]) }), { ok: true, changes: [] })
})

test("problem messages name the keys", () => {
  const message = permissionEditProblemMessage({ error: "permission_locked", keys: ["permissions.manage"] })
  assert.match(message, /permissions\.manage/)
  assert.match(permissionEditProblemMessage({ error: "permission_not_held", keys: ["a.b"] }), /You don't have: a\.b/)
})

test("latest rows: later createdAt wins, then the larger id", () => {
  const at = (ms: number) => new Date(ms)
  const latest = latestPermissionRows([
    { id: "psp_2", permissionKey: "a.b", createdAt: at(10), status: "deny" as const },
    { id: "psp_1", permissionKey: "a.b", createdAt: at(20), status: "allow" as const },
    { id: "psp_3", permissionKey: "c.d", createdAt: at(5), status: "allow" as const },
    { id: "psp_4", permissionKey: "c.d", createdAt: at(5), status: "deny" as const },
  ])
  assert.equal(latest.get("a.b")?.id, "psp_1")
  assert.equal(latest.get("c.d")?.id, "psp_4")
})

test("key states: every catalog key, deny without rows, locked only in Admin permissions", () => {
  assert.ok(KEY_A)
  const rows = [
    { id: "psp_1", permissionKey: KEY_A, createdAt: new Date(1), status: "allow" as const },
    { id: "psp_2", permissionKey: "retired.key", createdAt: new Date(1), status: "allow" as const },
  ]
  const admin = permissionSetKeyStates({ defaultKey: "admin", rows })
  assert.equal(admin.length, PERMISSION_KEYS.length)
  assert.deepEqual(admin.map((state) => state.key), [...PERMISSION_KEYS])
  assert.equal(admin.find((state) => state.key === KEY_A)?.status, "allow")
  assert.equal(admin.find((state) => state.key === KEY_A)?.latest?.id, "psp_1")
  assert.equal(admin.find((state) => state.key === "permissions.manage")?.status, "deny")
  assert.equal(admin.find((state) => state.key === "permissions.manage")?.locked, true)

  const team = permissionSetKeyStates({ defaultKey: null, rows })
  assert.ok(team.every((state) => !state.locked))
})

test("delta lists granted and revoked keys", () => {
  assert.ok(KEY_A && KEY_B && KEY_C)
  assert.deepEqual(permissionKeyDelta(new Set([KEY_A, KEY_B]), new Set([KEY_B, KEY_C])), { granted: [KEY_C], revoked: [KEY_A] })
})

test("team set names are fixed at creation and fit the column", () => {
  assert.equal(teamPermissionSetName("Support"), "Support Permissions")
  const long = teamPermissionSetName("x".repeat(255))
  assert.equal(long.length, 255)
  assert.ok(long.endsWith(" Permissions"))
})

test("source labels", () => {
  assert.equal(permissionSourceLabel({ kind: "owner" }), "Organization owner")
  assert.equal(permissionSourceLabel({ kind: "member_default", setId: "pms_1", setName: "Member permissions" }), "Member permissions")
  assert.equal(permissionSourceLabel({ kind: "admin_default", setId: "pms_2", setName: "Admin permissions", via: "role" }), "Admin permissions (admin role)")
  assert.equal(
    permissionSourceLabel({ kind: "admin_default", setId: "pms_2", setName: "Admin permissions", via: "team", teamId: "tem_1", teamName: "Ops" }),
    "Admin permissions (via Ops team)",
  )
  assert.equal(
    permissionSourceLabel({ kind: "team", setId: "pms_3", setName: "Support Permissions", teamId: "tem_2", teamName: "Support" }),
    "Support Permissions (via Support team)",
  )
  assert.equal(permissionSourceLabel({ kind: "code_default", set: "admin" }), "Admin permissions (default)")
})
