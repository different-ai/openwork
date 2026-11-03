import assert from "node:assert/strict"
import { after, test } from "node:test"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { permissionDefaultKeys } from "@openwork/types/den/permissions"
import { recoverAdministratorsFromEnv } from "../../../../packages/den-db/scripts/administrator-recovery.ts"
import { bootDen, field, isRecord, list, strings, text, type Member } from "./harness.js"

// Runs in the existing Den API security lane against a disposable SQL database.
// Real API mutations prove the grants; only the SCIM mapping is a SQL fixture.
const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", DEN_FEATURE_ADMINISTRATOR_RECOVERY: "" } })
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("administrator recovery test requires a SQL pool")
const pool = client
const restoredKeys = [
  "organization.update", "branding.update", "web_origins.manage", "members.update",
  "teams.manage_admin", "permissions.manage", "sso.manage", "scim.manage", "api_keys.manage",
  "egress_diagnostics.manage", "desktop_policies.manage", "billing_portal.use",
  "connections.update", "connections.delete",
]
const org = await den.createOrg(await den.signUp("Recovery owner"), "Recovery workspace")
const direct = await den.newMember(org.owner, org.orgId, "Selected administrator", "admin")
const inherited = await den.newMember(org.owner, org.orgId, "Team administrator")
const late = await den.newMember(org.owner, org.orgId, "Later team member")
const outside = await den.newMember(org.owner, org.orgId, "Outside administrator", "admin")
const historical = await den.newMember(org.owner, org.orgId, "Historical administrator", "admin")
const target = await den.newMember(org.owner, org.orgId, "Mutation target")
const teamId = await den.createTeam(org.owner, org.orgId, "Selected Admin team", [org.owner.memberId, direct.memberId, inherited.memberId], { grantsOrganizationAdmin: true })
const ordinaryId = await den.createTeam(outside, org.orgId, "Ordinary team", [outside.memberId])
const scratchTeam = await den.createTeam(org.owner, org.orgId, "Scratch team", [])
const scratch = await den.as(org.owner, org.orgId)("POST", "/v1/permissions/sets", { teamId: scratchTeam, permissions: [{ key: "permissions.view", status: "allow" }] })
assert.equal(scratch.status, 201)
const scratchId = text(field(scratch.body, "set", "id"), "scratch set")
const other = await den.createOrg(await den.signUp("Other owner"), "Other workspace")
const otherAdmin = await den.newMember(other.owner, other.orgId, "Other administrator", "admin")
const otherTeam = await den.createTeam(other.owner, other.orgId, "Other Admin team", [otherAdmin.memberId], { grantsOrganizationAdmin: true })

async function rows(statement: string, args: string[] = []) {
  const [result] = await pool.query(statement, args)
  assert.ok(Array.isArray(result))
  return result.filter(isRecord)
}
async function keys(person: Member, organizationId = org.orgId) {
  const result = await den.as(person, organizationId)("GET", "/v1/org")
  assert.equal(result.status, 200)
  return strings(field(result.body, "currentMember", "permissions"))
}
async function permissionInventory() {
  return {
    organizations: await rows("SELECT * FROM organization ORDER BY id"),
    collations: await rows("SELECT TABLE_NAME,COLUMN_NAME,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('organization','permission_set','permission_set_permission','permission_set_team','team','team_member','member') ORDER BY TABLE_NAME,COLUMN_NAME"),
    sets: await rows("SELECT * FROM permission_set ORDER BY id"),
    grants: await rows("SELECT * FROM permission_set_permission ORDER BY id"),
    links: await rows("SELECT * FROM permission_set_team ORDER BY id"),
    roster: await rows("SELECT * FROM team_member ORDER BY id"),
    featureOverrides: await rows("SELECT * FROM organization_feature ORDER BY organization_id,feature_key"),
  }
}
function configure(teams: Record<string, string>) {
  process.env.DEN_ADMINISTRATOR_RECOVERY_MODE = "apply"
  process.env.DEN_ADMINISTRATOR_RECOVERY_TEAM = ""
  process.env.DEN_ADMINISTRATOR_RECOVERY_ORGANIZATION = ""
  process.env.DEN_ADMINISTRATOR_RECOVERY_TEAMS = JSON.stringify(teams)
}
async function refused(team: string, message: RegExp) {
  configure({ [org.orgId]: team })
  const before = await permissionInventory()
  await assert.rejects(recoverAdministratorsFromEnv(), message)
  assert.deepEqual(await permissionInventory(), before)
}

// A surviving invitation is not authority to restore a person automatically.
await pool.execute("UPDATE invitation i JOIN member m ON m.invite_id=i.id SET i.role='super-admin' WHERE m.id=?", [historical.memberId])
for (const person of [direct, inherited, outside, historical]) assert.equal((await keys(person)).length, permissionDefaultKeys("admin").length)
await keys(otherAdmin, other.orgId)

let recoverySet = ""
test("the encoding fixture inherits database defaults without converting recovery tables", async () => {
  const [metadata] = await rows("SELECT VERSION() AS version,@@character_set_server AS serverCharset,@@collation_server AS serverCollation,@@collation_connection AS connectionCollation,@@collation_database AS databaseCollation")
  assert.ok(metadata)
  const columns = await rows("SELECT TABLE_NAME,COLUMN_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('permission_set','permission_set_permission','permission_set_team') AND COLUMN_NAME IN ('id','organization_id','permission_set_id','permission_key') ORDER BY TABLE_NAME,COLUMN_NAME")
  assert.ok(columns.length > 0)
  assert.ok(columns.every((column) => column.COLLATION_NAME === metadata.databaseCollation))
  if (process.env.DEN_API_TEST_DATABASE_COLLATION) assert.equal(metadata.databaseCollation, process.env.DEN_API_TEST_DATABASE_COLLATION)
  if (process.env.DEN_API_TEST_DATABASE_DEFAULTS === "server" && !process.env.DEN_API_TEST_DATABASE_COLLATION) assert.equal(metadata.databaseCollation, metadata.serverCollation)
  console.log("Encoding fixture:", JSON.stringify(metadata))
})

test("the built bootstrap package includes the same standalone grant SQL", async () => {
  const source = await readFile(new URL("../../../../packages/den-db/scripts/administrator-recovery.sql", import.meta.url), "utf8")
  const packaged = await readFile(new URL("../../../../packages/den-db/dist/scripts/administrator-recovery.sql", import.meta.url), "utf8")
  assert.equal(packaged, source)
})

test("recovery is off by default and does not require a target until enabled", async () => {
  configure({})
  const before = await permissionInventory()
  assert.equal(await recoverAdministratorsFromEnv(), 0)
  assert.deepEqual(await permissionInventory(), before)
  assert.equal((await den.as(direct, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "admin" })).status, 403)
  assert.equal((await den.as(inherited, org.orgId)("PUT", `/v1/permissions/sets/${scratchId}/permissions`, { changes: [{ key: "permissions.view", status: "deny" }] })).status, 403)
})

test("enabled recovery requires an explicit target; kill and operator-off override an organization enable", async () => {
  assert.equal((await den.setFeature(org.orgId, "administratorRecovery", true)).status, 200)
  configure({})
  const before = await permissionInventory()
  await assert.rejects(recoverAdministratorsFromEnv(), /requires an explicit team ID or name/)
  assert.deepEqual(await permissionInventory(), before)
  process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = "false"
  assert.equal(await recoverAdministratorsFromEnv(), 0)
  process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = ""
  const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
  const token = text(field(signedIn.body, "token"), "platform admin session")
  assert.equal((await den.request(token, "PUT", "/v1/admin/features/administratorRecovery", { body: { killed: true } })).status, 200)
  process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = "true"
  assert.equal(await recoverAdministratorsFromEnv(), 0)
  assert.equal((await den.request(token, "PUT", "/v1/admin/features/administratorRecovery", { body: { killed: false } })).status, 200)
  process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = ""
  assert.deepEqual(await permissionInventory(), before)
})

test("an explicit organization denial wins over a Helm flag enable in apply mode", async () => {
  process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = "true"
  assert.equal((await den.setFeature(org.orgId, "administratorRecovery", false)).status, 200)
  configure({ [org.orgId]: "not-a-team" })
  const before = await permissionInventory()
  assert.equal(await recoverAdministratorsFromEnv(), 0)
  assert.deepEqual(await permissionInventory(), before)
  process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = ""
  assert.equal((await den.setFeature(org.orgId, "administratorRecovery", true)).status, 200)
})

test("ordinary, other-organization and SCIM-mapped teams are refused without a partial permission repair", async () => {
  await refused(ordinaryId, /must be a designated Admin team/)
  await refused(otherTeam, /No recovery team/)
  const group = createDenTypeId("scimGroup")
  await pool.execute("INSERT INTO scim_group(id,organization_id,provider_id,scim_group_id,display_name,team_id) VALUES(?,?,?,?,?,?)", [group, org.orgId, "recovery-test-provider", "recovery-test-group", "Recovery group", teamId])
  try { await refused(teamId, /SCIM-managed recovery team is not supported/) }
  finally { await pool.execute("DELETE FROM scim_group WHERE id=?", [group]) }
  const roster = [org.owner.memberId, direct.memberId, inherited.memberId]
  assert.equal((await den.as(outside, org.orgId)("PATCH", `/v1/teams/${ordinaryId}`, { grantsOrganizationAdmin: true })).status, 403)
  assert.equal((await den.as(outside, org.orgId)("PATCH", `/v1/teams/${teamId}`, { memberIds: [...roster, outside.memberId] })).status, 403)
})

test("a database failure after grant insertion rolls back the set, grants, link and revision; Den remains usable", async () => {
  configure({ [org.orgId]: teamId })
  const before = await permissionInventory()
  // Fail the final link, after both the recovery set and its 14 grants have
  // been inserted. A guard refusal before any writes cannot prove rollback.
  await pool.query("CREATE TRIGGER recovery_link_failure BEFORE INSERT ON permission_set_team FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='exp-col injected link failure'")
  try {
    await assert.rejects(recoverAdministratorsFromEnv(), /exp-col injected link failure/)
    assert.deepEqual(await permissionInventory(), before)
    assert.ok(!(await keys(direct)).includes("members.update"))
    assert.equal((await den.as(direct, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "admin" })).status, 403)
    assert.equal((await den.as(org.owner, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "member" })).status, 200)
    assert.equal((await rows("SELECT role FROM member WHERE id=?", [target.memberId]))[0]?.role, "member")
  } finally {
    await pool.query("DROP TRIGGER recovery_link_failure")
  }
})

test("only the selected designated team's current members regain the fourteen keys and perform real API mutations", async () => {
  configure({ [org.orgId]: teamId })
  // Targeting is by stable ID; rename does not confer designation or new members.
  assert.equal((await den.as(outside, org.orgId)("PATCH", `/v1/teams/${teamId}`, { name: "Renamed Admin team" })).status, 200)
  // No roster fingerprint yet: an authorized addition before deploy is included.
  assert.equal((await den.as(org.owner, org.orgId)("PATCH", `/v1/teams/${teamId}`, { memberIds: [org.owner.memberId, direct.memberId, inherited.memberId, late.memberId] })).status, 200)
  const rolesBefore = await rows("SELECT id,role FROM member ORDER BY id")
  const defaultsBefore = await rows("SELECT h.* FROM permission_set_permission h JOIN permission_set p ON p.id=h.permission_set_id WHERE p.default_key IS NOT NULL ORDER BY h.id")
  const before = await permissionInventory()
  try {
    assert.equal(await recoverAdministratorsFromEnv(), 1)
  } catch (error) {
    // The original latin1 collation regression fails here after inserting the
    // set. Keep its RED run accountable for rollback and API availability too.
    assert.deepEqual(await permissionInventory(), before)
    assert.ok(!(await keys(direct)).includes("members.update"))
    assert.ok((await keys(org.owner)).includes("members.update"))
    throw error
  }
  assert.deepEqual((await permissionInventory()).collations, before.collations)
  assert.deepEqual(await rows("SELECT id,role FROM member ORDER BY id"), rolesBefore)
  assert.deepEqual(await rows("SELECT h.* FROM permission_set_permission h JOIN permission_set p ON p.id=h.permission_set_id WHERE p.default_key IS NOT NULL ORDER BY h.id"), defaultsBefore)
  const response = await den.as(org.owner, org.orgId)("GET", "/v1/permissions/sets")
  const recovered = list(field(response.body, "sets")).find((set) => set.name === "Restored administrator permissions")
  assert.ok(recovered)
  recoverySet = text(recovered.id, "recovery set")
  const stored = await rows("SELECT id,permission_key,status,source,changed_by_org_membership_id FROM permission_set_permission WHERE permission_set_id=?", [recoverySet])
  assert.equal(recoverySet, `pms_0${createHash("sha256").update(`admin-recovery-0155:${org.orgId}`).digest("hex").slice(0, 25)}`)
  for (const grant of stored) assert.equal(grant.id, `psp_0${createHash("sha256").update(`admin-recovery-0155:${recoverySet}:${grant.permission_key}`).digest("hex").slice(0, 25)}`)
  assert.deepEqual(stored.map((row) => row.permission_key).sort(), [...restoredKeys].sort())
  assert.ok(stored.every((row) => row.status === "allow" && row.source === "migration" && row.changed_by_org_membership_id === null))
  for (const person of [direct, inherited, late]) {
    const held = await keys(person)
    assert.deepEqual(held.filter((key) => restoredKeys.includes(key)).sort(), [...restoredKeys].sort())
    assert.ok(!held.includes("agent_permissions.manage"))
    assert.ok(!held.includes("deployments.manage"))
    const call = den.as(person, org.orgId)
    assert.equal((await call("POST", `/v1/members/${target.memberId}/role`, { role: "admin" })).status, 200)
    assert.equal((await rows("SELECT role FROM member WHERE id=?", [target.memberId]))[0]?.role, "admin")
    assert.equal((await call("POST", `/v1/members/${target.memberId}/role`, { role: "member" })).status, 200)
    assert.equal((await rows("SELECT role FROM member WHERE id=?", [target.memberId]))[0]?.role, "member")
    assert.equal((await call("PUT", `/v1/permissions/sets/${scratchId}/permissions`, { changes: [{ key: "permissions.view", status: "deny" }] })).status, 200)
    assert.equal((await rows("SELECT status FROM permission_set_permission WHERE permission_set_id=? AND permission_key='permissions.view' ORDER BY created_at DESC,id DESC LIMIT 1", [scratchId]))[0]?.status, "deny")
    assert.equal((await den.as(org.owner, org.orgId)("PUT", `/v1/permissions/sets/${scratchId}/permissions`, { changes: [{ key: "permissions.view", status: "allow" }] })).status, 200)
  }
  for (const person of [outside, historical]) {
    assert.ok(!(await keys(person)).includes("members.update"))
    assert.equal((await den.as(person, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "admin" })).status, 403)
  }
  assert.ok(!(await keys(otherAdmin, other.orgId)).includes("members.update"))
  assert.equal((await keys(org.owner)).includes("deployments.manage"), true)
  assert.equal((await den.as(outside, org.orgId)("PATCH", `/v1/teams/${teamId}`, { memberIds: [org.owner.memberId, direct.memberId, inherited.memberId, late.memberId, outside.memberId] })).status, 403)
})

test("grant comparisons preserve Admin user decisions on the database's original charset", async () => {
  const defaults = (await rows("SELECT id FROM permission_set WHERE organization_id=? AND default_key='admin'", [other.orgId]))[0]
  assert.ok(defaults && typeof defaults.id === "string")
  const call = den.as(other.owner, other.orgId)
  assert.equal((await call("PUT", `/v1/permissions/sets/${defaults.id}/permissions`, { changes: [{ key: "branding.update", status: "allow" }, { key: "members.update", status: "allow" }] })).status, 200)
  assert.equal((await call("PUT", `/v1/permissions/sets/${defaults.id}/permissions`, { changes: [{ key: "branding.update", status: "deny" }] })).status, 200)
  const decisions = await rows("SELECT * FROM permission_set_permission WHERE permission_set_id=? ORDER BY id", [defaults.id])
  assert.ok(decisions.some((decision) => decision.permission_key === "branding.update" && decision.status === "deny" && decision.source === "user"))
  assert.ok(decisions.some((decision) => decision.permission_key === "members.update" && decision.status === "allow" && decision.source === "user"))
  assert.equal((await den.setFeature(other.orgId, "administratorRecovery", true)).status, 200)
  configure({ [other.orgId]: otherTeam })
  assert.equal(await recoverAdministratorsFromEnv(), 1)
  assert.deepEqual(await rows("SELECT * FROM permission_set_permission WHERE permission_set_id=? ORDER BY id", [defaults.id]), decisions)
  const restored = await rows("SELECT g.permission_key,g.status FROM permission_set_permission g JOIN permission_set p ON p.id=g.permission_set_id WHERE p.organization_id=? AND p.default_key IS NULL", [other.orgId])
  assert.equal(restored.length, 14)
  assert.equal(restored.find((grant) => grant.permission_key === "branding.update")?.status, "deny")
  assert.equal(restored.find((grant) => grant.permission_key === "members.update")?.status, "deny")
  assert.ok((await keys(otherAdmin, other.orgId)).includes("connections.update"))
  assert.ok(!(await keys(outside)).includes("connections.update"))
  configure({ [org.orgId]: teamId })
})

test("replay does not undo owner permission revocation, roster removal or role deletion", async () => {
  const before = await permissionInventory()
  assert.equal(await recoverAdministratorsFromEnv(), 0)
  assert.deepEqual(await permissionInventory(), before)
  assert.equal((await den.as(org.owner, org.orgId)("PUT", `/v1/permissions/sets/${recoverySet}/permissions`, { changes: [{ key: "members.update", status: "deny" }] })).status, 200)
  assert.equal(await recoverAdministratorsFromEnv(), 0)
  assert.equal((await den.as(inherited, org.orgId)("POST", `/v1/members/${target.memberId}/role`, { role: "admin" })).status, 403)
  assert.equal((await den.as(org.owner, org.orgId)("PATCH", `/v1/teams/${teamId}`, { memberIds: [org.owner.memberId, inherited.memberId, late.memberId] })).status, 200)
  assert.equal(await recoverAdministratorsFromEnv(), 0)
  assert.ok(!(await keys(direct)).includes("branding.update"))
  assert.equal((await den.as(org.owner, org.orgId)("DELETE", `/v1/permissions/sets/${recoverySet}`)).status, 204)
  assert.equal(await recoverAdministratorsFromEnv(), 0)
  assert.ok(!(await keys(inherited)).includes("permissions.manage"))
  assert.equal((await rows("SELECT archived_at FROM permission_set WHERE id=?", [recoverySet]))[0]?.archived_at === null, false)
})
