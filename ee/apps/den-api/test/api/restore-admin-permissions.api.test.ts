/**
 * Migration 0158 restores full admin rights after the Permissions release.
 *
 * Arranges what self-hosted Dens look like after upgrading through 0137/0138:
 * admins hold only the narrow seeded Admin set (former super-admin actions are
 * owner-only), some owners trimmed it further, and some organizations never had
 * their default sets created. Then runs the exact migration SQL against the
 * test database and checks, through the public API, that every admin can do
 * everything the owner can, while owners and members are unchanged.
 */
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { after, test } from "node:test"
import { PERMISSION_KEYS, isPermissionKey } from "@openwork/types/den/permissions"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, strings, summary, text, type Member } from "./harness.js"

const MIGRATION_URL = new URL("../../../../packages/den-db/drizzle/0158_restore_admin_permissions.sql", import.meta.url)

const den = await bootDen()
after(() => den.close())

async function mysql() {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("this test needs MySQL mode")
  return client
}

async function runMigration() {
  const source = await readFile(MIGRATION_URL, "utf8")
  const client = await mysql()
  for (const statement of source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await client.query(statement)
  }
}

async function rowCount(table: "permission_set" | "permission_set_permission") {
  const [rows] = await (await mysql()).query(`SELECT COUNT(*) AS n FROM \`${table}\``)
  const first = Array.isArray(rows) ? rows[0] : undefined
  return Number(field(first, "n"))
}

async function permissionsOf(person: Member, orgId: string) {
  const result = await den.as(person, orgId)("GET", "/v1/org")
  assert.equal(result.status, 200, summary(result))
  return strings(field(result.body, "currentMember", "permissions")).sort()
}

async function roleOf(viewer: Member, orgId: string, memberId: string) {
  const result = await den.as(viewer, orgId)("GET", "/v1/org")
  return list(field(result.body, "members")).find((entry) => entry.id === memberId)?.role
}

function migrationKeys(source: string) {
  return [...source.matchAll(/SELECT '([a-z_]+\.[a-z_]+)'/g)].map((match) => match[1] ?? "")
}

const everyKey = [...PERMISSION_KEYS].sort()

// An organization that went through the upgrade: owner, a former super-admin
// (now admin), and a plain member. The owner also deliberately turned audit
// history off for admins; the migration must keep that decision.
const trimmed = await den.createOrg(await den.signUp("Trimmed Owner"), "Trimmed admin workspace")
const trimmedAdmin = await den.newMember(trimmed.owner, trimmed.orgId, "Former Super Admin", "admin")
const trimmedMember = await den.newMember(trimmed.owner, trimmed.orgId, "Plain Member")

// An organization whose default permission sets were never created.
const untouched = await den.createOrg(await den.signUp("Untouched Owner"), "Untouched workspace")
const untouchedAdmin = await den.newMember(untouched.owner, untouched.orgId, "Untouched Admin", "admin")

test("admins lost the former super-admin actions before the migration", async () => {
  const sets = await den.as(trimmed.owner, trimmed.orgId)("GET", "/v1/permissions/sets")
  assert.equal(sets.status, 200, summary(sets))
  const adminSetId = text(list(field(sets.body, "sets")).find((set) => set.kind === "admin_default")?.id, "Admin permission set")
  const denied = await den.as(trimmed.owner, trimmed.orgId)("PUT", `/v1/permissions/sets/${adminSetId}/permissions`, {
    changes: [{ key: "audit.view", status: "deny" }],
  })
  assert.equal(denied.status, 200, summary(denied))

  const before = await permissionsOf(trimmedAdmin, trimmed.orgId)
  for (const key of ["members.update", "permissions.manage", "sso.manage", "audit.view"]) {
    assert.equal(before.includes(key), false, `admin should not hold ${key} before the migration`)
  }
  const audit = await den.as(trimmedAdmin, trimmed.orgId)("GET", "/v1/audit/event-types")
  assert.equal(audit.status, 403, summary(audit))

  // ARRANGE ONLY: remove the untouched organization's default sets, as if no request had resolved them yet.
  const client = await mysql()
  const untouchedId = normalizeDenTypeId("organization", untouched.orgId)
  await client.query("DELETE p FROM permission_set_permission p JOIN permission_set s ON s.id = p.permission_set_id WHERE s.organization_id = ?", [untouchedId])
  await client.query("DELETE FROM permission_set WHERE organization_id = ?", [untouchedId])
})

test("the migration restores what admins lost, keeps deliberate denies, and leaves owners and members alone", async () => {
  const source = await readFile(MIGRATION_URL, "utf8")
  const keys = migrationKeys(source)
  assert.ok(keys.length > 0)
  for (const key of keys) assert.ok(isPermissionKey(key), `${key} must be a catalog key`)

  const ownerBefore = await permissionsOf(trimmed.owner, trimmed.orgId)
  const memberBefore = await permissionsOf(trimmedMember, trimmed.orgId)
  assert.deepEqual(ownerBefore, everyKey)

  await runMigration()

  assert.deepEqual(await permissionsOf(untouchedAdmin, untouched.orgId), everyKey, "an admin whose organization chose nothing holds every permission the owner holds")
  const trimmedAfter = await permissionsOf(trimmedAdmin, trimmed.orgId)
  for (const key of keys.filter((key) => key !== "audit.view")) assert.ok(trimmedAfter.includes(key), `${trimmedAdmin.name} should hold ${key} after the migration`)
  assert.deepEqual(trimmedAfter, everyKey.filter((key) => key !== "audit.view"), "only the owner's deliberate deny remains")
  const audit = await den.as(trimmedAdmin, trimmed.orgId)("GET", "/v1/audit/event-types")
  assert.equal(audit.status, 403, `the owner's deny on audit history still applies: ${summary(audit)}`)

  assert.deepEqual(await permissionsOf(trimmed.owner, trimmed.orgId), ownerBefore)
  assert.deepEqual(await permissionsOf(trimmedMember, trimmed.orgId), memberBefore)
  assert.deepEqual(await permissionsOf(untouched.owner, untouched.orgId), everyKey)
  assert.equal(await roleOf(trimmed.owner, trimmed.orgId, trimmedAdmin.memberId), "admin")
  assert.equal(await roleOf(trimmed.owner, trimmed.orgId, trimmedMember.memberId), "member")

  // Rows written by the migration carry valid TypeIDs that sort as the current state.
  const [rows] = await (await mysql()).query("SELECT id FROM permission_set_permission WHERE source = 'migration'")
  const ids = (Array.isArray(rows) ? rows : []).map((row) => text(field(row, "id"), "migration row id"))
  assert.ok(ids.length > 0)
  for (const id of ids) assert.equal(normalizeDenTypeId("permissionSetPermission", id), id)
})

test("running the migration again changes nothing", async () => {
  const sets = await rowCount("permission_set")
  const rows = await rowCount("permission_set_permission")
  await runMigration()
  assert.equal(await rowCount("permission_set"), sets)
  assert.equal(await rowCount("permission_set_permission"), rows)
  assert.deepEqual(await permissionsOf(trimmedAdmin, trimmed.orgId), everyKey.filter((key) => key !== "audit.view"))
})
