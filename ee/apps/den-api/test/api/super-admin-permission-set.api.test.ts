/**
 * superAdminPermissionSet: Super admin is a default permission set beside
 * Member and Admin, seeded with every catalog permission, resolved for direct
 * super-admins, editable only by the owner and super-admins, and created
 * lazily for organizations that predate it. Off, super-admins hold every
 * permission through the role and the set is hidden.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { PERMISSION_KEYS } from "@openwork/types/den/permissions"
import { bootDen, field, list, strings, summary, type Member } from "./harness.js"

const den = await bootDen()
after(() => den.close())

async function world(label: string, options: { feature?: boolean } = {}) {
  const olivia = await den.signUp(`Olivia ${label}`)
  const { orgId, owner } = await den.createOrg(olivia, `Super admin set ${label}`)
  const changed = await den.setFeature(orgId, "superAdminPermissionSet", options.feature !== false)
  assert.equal(changed.status, 200, summary(changed))
  const sam = await den.newMember(owner, orgId, `Sam ${label}`)
  const adam = await den.newMember(owner, orgId, `Adam ${label}`, "admin")
  const ownerCall = den.as(owner, orgId)
  const promoted = await ownerCall("POST", `/v1/members/${sam.memberId}/role`, { role: "super-admin" })
  assert.equal(promoted.status, 200, summary(promoted))

  async function sets() {
    const response = await ownerCall("GET", "/v1/permissions/sets")
    assert.equal(response.status, 200, summary(response))
    return list(field(response.body, "sets"))
  }
  async function held(member: Member): Promise<string[]> {
    const context = await den.as(member, orgId)("GET", "/v1/org")
    assert.equal(context.status, 200, summary(context))
    return strings(field(context.body, "currentMember", "permissions"))
  }
  return { orgId, owner, sam, adam, ownerCall, sets, held }
}

test("feature off: super-admins hold every permission through the role and the Super admin set is hidden", async () => {
  const w = await world("off", { feature: false })
  assert.deepEqual([...(await w.held(w.sam))].sort(), [...PERMISSION_KEYS].sort())
  const explained = await w.ownerCall("GET", `/v1/members/${w.sam.memberId}/permissions`)
  assert.equal(explained.status, 200, summary(explained))
  const ssoManage = list(field(explained.body, "permissions")).find((entry) => entry.key === "sso.manage")
  assert.deepEqual(list(ssoManage?.sources).map((source) => source.kind), ["super_admin"])

  const sets = await w.sets()
  assert.deepEqual(sets.slice(0, 2).map((set) => set.kind), ["member_default", "admin_default"])
  assert.equal(sets.some((set) => set.kind === "super_admin_default"), false)
  const catalog = await w.ownerCall("GET", "/v1/permissions/catalog")
  assert.ok(list(field(catalog.body, "permissions")).every((definition) => !strings(definition.defaultOn).includes("super-admin")))

  // The set exists already (seeded), so turning the feature on is instant; until then it can't be read or edited.
  const { db } = await import("../../src/db.js")
  const { and, eq } = await import("@openwork-ee/den-db/drizzle")
  const { PermissionSetTable } = await import("@openwork-ee/den-db/schema")
  const orgId = w.orgId as typeof PermissionSetTable.$inferSelect.organizationId
  const [hidden] = await db.select({ id: PermissionSetTable.id }).from(PermissionSetTable)
    .where(and(eq(PermissionSetTable.organizationId, orgId), eq(PermissionSetTable.defaultKey, "super-admin")))
  assert.ok(hidden)
  const detail = await w.ownerCall("GET", `/v1/permissions/sets/${hidden.id}`)
  assert.equal(detail.status, 404, summary(detail))
  const edit = await w.ownerCall("PUT", `/v1/permissions/sets/${hidden.id}/permissions`, { changes: [{ key: "sso.manage", status: "deny" }] })
  assert.equal(edit.status, 404, summary(edit))

  const enabled = await den.setFeature(w.orgId, "superAdminPermissionSet", true)
  assert.equal(enabled.status, 200, summary(enabled))
  assert.equal((await w.sets()).find((set) => set.kind === "super_admin_default")?.id, hidden.id)
})

test("every organization gets a Super admin permission set with every permission, after Member and Admin", async () => {
  const w = await world("seed")
  const sets = await w.sets()
  // Built-in sets in the order roles are listed: Billing manager sits between Admin and Super admin.
  assert.deepEqual(sets.slice(0, 4).map((set) => set.kind), ["member_default", "admin_default", "billing_manager_default", "super_admin_default"])
  const superAdminSet = sets[3]
  assert.equal(superAdminSet?.name, "Super admin permissions")
  assert.equal(superAdminSet?.allowedCount, PERMISSION_KEYS.length)
  assert.deepEqual(superAdminSet?.appliesTo, { kind: "super_admins", superAdminCount: 1 })

  const detail = await w.ownerCall("GET", `/v1/permissions/sets/${String(superAdminSet?.id)}`)
  assert.equal(detail.status, 200, summary(detail))
  assert.equal(field(detail.body, "set", "kind"), "super_admin_default")
  assert.equal(field(detail.body, "set", "appliesTo", "kind"), "super_admins")
  assert.deepEqual(list(field(detail.body, "set", "appliesTo", "superAdmins")).map((person) => person.memberId), [w.sam.memberId])
  assert.ok(list(field(detail.body, "set", "permissions")).every((state) => state.status === "allow" && state.lastChangeSource === "seed"))

  // The catalog reports Super admin as a default set of every permission, including owner-only ones.
  const catalog = await w.ownerCall("GET", "/v1/permissions/catalog")
  assert.equal(catalog.status, 200, summary(catalog))
  for (const definition of list(field(catalog.body, "permissions"))) {
    assert.ok(strings(definition.defaultOn).includes("super-admin"), String(definition.key))
  }
})

test("a super-admin's permissions come from the Super admin set, and trimming it takes effect", async () => {
  const w = await world("resolve")
  assert.deepEqual([...(await w.held(w.sam))].sort(), [...PERMISSION_KEYS].sort())

  const explained = await w.ownerCall("GET", `/v1/members/${w.sam.memberId}/permissions`)
  assert.equal(explained.status, 200, summary(explained))
  assert.equal(field(explained.body, "isSuperAdmin"), true)
  const ssoManage = list(field(explained.body, "permissions")).find((entry) => entry.key === "sso.manage")
  assert.deepEqual(list(ssoManage?.sources).map((source) => source.kind), ["super_admin_default"])
  assert.equal(list(ssoManage?.sources)[0]?.label, "Super admin permissions (super admin role)")

  const superAdminSet = String((await w.sets()).find((set) => set.kind === "super_admin_default")?.id)
  const trimmed = await w.ownerCall("PUT", `/v1/permissions/sets/${superAdminSet}/permissions`, { changes: [{ key: "billing_portal.use", status: "deny" }] })
  assert.equal(trimmed.status, 200, summary(trimmed))
  assert.equal((await w.held(w.sam)).includes("billing_portal.use"), false)
  // Admins never had it, so the owner still is the only other holder.
  assert.equal((await w.held(w.adam)).includes("billing_portal.use"), false)

  // A super-admin can restore a key that is on by default in their own set.
  const restored = await den.as(w.sam, w.orgId)("PUT", `/v1/permissions/sets/${superAdminSet}/permissions`, { changes: [{ key: "billing_portal.use", status: "allow" }] })
  assert.equal(restored.status, 200, summary(restored))
  assert.equal((await w.held(w.sam)).includes("billing_portal.use"), true)
})

test("an admin who may manage permissions still cannot change Super admin permissions", async () => {
  const w = await world("edit")
  const sets = await w.sets()
  const adminSet = String(sets.find((set) => set.kind === "admin_default")?.id)
  const superAdminSet = String(sets.find((set) => set.kind === "super_admin_default")?.id)
  const granted = await w.ownerCall("PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "permissions.manage", status: "allow" }] })
  assert.equal(granted.status, 200, summary(granted))

  const adam = den.as(w.adam, w.orgId)
  const denied = await adam("PUT", `/v1/permissions/sets/${superAdminSet}/permissions`, { changes: [{ key: "sso.manage", status: "deny" }] })
  assert.equal(denied.status, 403, summary(denied))
  assert.equal(field(denied.body, "error"), "super_admin_permissions_require_super_admin")
  assert.equal((await w.held(w.sam)).includes("sso.manage"), true)

  // Default sets keep their names and can't be deleted.
  const rename = await w.ownerCall("PATCH", `/v1/permissions/sets/${superAdminSet}`, { name: "Renamed" })
  assert.equal(rename.status, 400, summary(rename))
  assert.equal(field(rename.body, "error"), "default_permission_set")
  const remove = await w.ownerCall("DELETE", `/v1/permissions/sets/${superAdminSet}`)
  assert.equal(remove.status, 400, summary(remove))
  assert.equal(field(remove.body, "error"), "default_permission_set")
})

test("an organization created before the Super admin set gets it on first use, seeded with every permission", async () => {
  const w = await world("upgrade")
  const { db } = await import("../../src/db.js")
  const { and, eq } = await import("@openwork-ee/den-db/drizzle")
  const { PermissionSetPermissionTable, PermissionSetTable } = await import("@openwork-ee/den-db/schema")
  const existing = (await w.sets()).find((set) => set.kind === "super_admin_default")
  assert.ok(existing)
  const orgId = w.orgId as typeof PermissionSetTable.$inferSelect.organizationId
  const setId = String(existing.id) as typeof PermissionSetTable.$inferSelect.id
  // Simulate the state before this change: only Member and Admin exist.
  await db.delete(PermissionSetPermissionTable).where(eq(PermissionSetPermissionTable.permissionSetId, setId))
  await db.delete(PermissionSetTable).where(and(eq(PermissionSetTable.organizationId, orgId), eq(PermissionSetTable.id, setId)))

  // Resolution creates it again, so the super-admin keeps every permission.
  assert.deepEqual([...(await w.held(w.sam))].sort(), [...PERMISSION_KEYS].sort())
  const recreated = (await w.sets()).find((set) => set.kind === "super_admin_default")
  assert.ok(recreated)
  assert.notEqual(recreated.id, existing.id)
  assert.equal(recreated.allowedCount, PERMISSION_KEYS.length)
})
