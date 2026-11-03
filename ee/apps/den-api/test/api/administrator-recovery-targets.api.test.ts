import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { administratorRecoveryModeFromEnv, administratorRecoveryRequestedFromEnv, recoverAdministratorsFromEnv } from "../../../../packages/den-db/scripts/administrator-recovery.ts"
import { bootDen, isRecord, strings, field, list, type Member } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "self_hosted", DEN_FEATURE_ADMINISTRATOR_RECOVERY: "" } })
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("recovery target tests require SQL")
const pool = client
const org = await den.createOrg(await den.signUp("Target owner"), "Target workspace")
const direct = await den.newMember(org.owner, org.orgId, "Target administrator", "admin")
const inherited = await den.newMember(org.owner, org.orgId, "Target teammate")
const outside = await den.newMember(org.owner, org.orgId, "Unselected administrator", "admin")
const member = await den.newMember(org.owner, org.orgId, "Role mutation target")
const teamId = await den.createTeam(org.owner, org.orgId, "admins", [org.owner.memberId, direct.memberId, inherited.memberId], { grantsOrganizationAdmin: true })
await den.createTeam(outside, org.orgId, "ordinary", [outside.memberId])

async function rows(statement: string, args: Array<string | number> = []) {
  const [result] = await pool.query(statement, args)
  assert.ok(Array.isArray(result))
  return result.filter(isRecord)
}
async function inventory(ledger = false) {
  const result = {
    organizations: await rows("SELECT * FROM organization ORDER BY id"),
    sets: await rows("SELECT * FROM permission_set ORDER BY id"),
    permissions: await rows("SELECT * FROM permission_set_permission ORDER BY id"),
    links: await rows("SELECT * FROM permission_set_team ORDER BY id"),
    teams: await rows("SELECT * FROM team ORDER BY id"),
    roster: await rows("SELECT * FROM team_member ORDER BY id"),
    roles: await rows("SELECT id,role FROM member ORDER BY id"),
    users: await rows("SELECT id,name FROM user ORDER BY id"),
    featureOverrides: await rows("SELECT * FROM organization_feature ORDER BY organization_id,feature_key"),
    ledger: ledger ? await rows("SELECT * FROM __drizzle_migrations ORDER BY id") : [],
  }
  return result
}
function configure(mode = "check", team = "admins", organization = "", teams: Record<string, string> = {}, expected?: number) {
  process.env.DEN_ADMINISTRATOR_RECOVERY_MODE = mode
  process.env.DEN_ADMINISTRATOR_RECOVERY_TEAM = team
  process.env.DEN_ADMINISTRATOR_RECOVERY_ORGANIZATION = organization
  process.env.DEN_ADMINISTRATOR_RECOVERY_TEAMS = JSON.stringify(teams)
  process.env.DEN_ADMINISTRATOR_RECOVERY_EXPECTED_MEMBERS = expected === undefined ? "" : String(expected)
}
async function captureLines(action: () => Promise<unknown>) {
  const original = console.log
  const lines: string[] = []
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(" ")) }
  try { await action() } finally { console.log = original }
  return lines
}
async function capture(action: () => Promise<unknown>) {
  const lines = await captureLines(action)
  const events: Record<string, unknown>[] = []
  for (const line of lines.filter((value) => value.startsWith("{"))) {
    const value: unknown = JSON.parse(line)
    if (isRecord(value)) events.push(value)
  }
  return events
}
async function keys(person: Member, organizationId = org.orgId) {
  const result = await den.as(person, organizationId)("GET", "/v1/org")
  assert.equal(result.status, 200)
  return strings(field(result.body, "currentMember", "permissions"))
}
await keys(direct)
await keys(inherited)
await keys(outside)

test("default check with disabled recovery and no target is silent and does not need a database connection", async () => {
  delete process.env.DEN_ADMINISTRATOR_RECOVERY_MODE
  process.env.DEN_ADMINISTRATOR_RECOVERY_TEAM = ""
  process.env.DEN_ADMINISTRATOR_RECOVERY_ORGANIZATION = ""
  process.env.DEN_ADMINISTRATOR_RECOVERY_TEAMS = "{}"
  assert.equal(administratorRecoveryModeFromEnv(), "check")
  assert.equal(await administratorRecoveryRequestedFromEnv(), false)
  const schema: unknown = JSON.parse(await readFile(new URL("../../../../../packaging/helm/openwork-ee/values.schema.json", import.meta.url), "utf8"))
  assert.equal(field(schema, "properties", "config", "properties", "administratorRecovery", "properties", "mode", "default"), "check")
  const before = await inventory()
  const databaseUrl = process.env.DATABASE_URL
  const original = console.log
  const output: unknown[] = []
  console.log = (...values: unknown[]) => { output.push(...values) }
  delete process.env.DATABASE_URL
  try {
    assert.equal(await recoverAdministratorsFromEnv(), 0)
    process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = "false"
    configure("check", "not-a-team", "not-an-organization", {}, -1)
    assert.equal(await recoverAdministratorsFromEnv(), 0)
  } finally {
    console.log = original
    process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = ""
    if (databaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = databaseUrl
  }
  assert.deepEqual(output, [])
  assert.deepEqual(await inventory(), before)
})

test("enabled check infers the only organization, resolves the sole Admin team and prints its roster without writes", async () => {
  assert.equal((await rows("SELECT COUNT(*) AS count FROM organization"))[0]?.count, 1)
  process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = "true"
  configure()
  // A person's display name may itself be their email address. The complete
  // roster must remain reviewable by membership ID without leaking addresses.
  await pool.execute("UPDATE user SET name=? WHERE id=?", [direct.email, direct.userId])
  try {
    const before = await inventory()
    const events = await capture(async () => { assert.equal(await recoverAdministratorsFromEnv(), 0) })
    assert.deepEqual(await inventory(), before)
    const header = events.find((event) => event.event === "administrator_recovery_check")
    assert.ok(header)
    assert.equal(field(header, "organization", "id"), org.orgId)
    assert.equal(field(header, "team", "id"), teamId)
    assert.equal(field(header, "team", "name"), "admins")
    assert.equal(header.featureEnabled, true)
    assert.equal(header.action, "would_apply")
    assert.equal(header.peopleCount, 3)
    assert.equal(header.recoveryPermissionCount, 14)
    assert.deepEqual(header.existingRoles, [])
    const recipients = events.filter((event) => event.event === "administrator_recovery_recipient")
    assert.deepEqual(recipients.map((event) => event.memberId).sort(), [org.owner.memberId, direct.memberId, inherited.memberId].sort())
    assert.deepEqual(recipients.map((event) => event.name).sort(), [org.owner.name, "[email omitted]", inherited.name].sort())
    assert.ok(recipients.every((event) => !("email" in event) && event.viaTeam === true))
    for (const email of [org.owner.email, direct.email, inherited.email]) assert.ok(!JSON.stringify(events).includes(email), "check output contains no member email addresses")
    assert.equal(recipients.find((event) => event.memberId === org.owner.memberId)?.ownerUnchanged, true)
    assert.ok(!(await keys(direct)).includes("members.update"))
  } finally { await pool.execute("UPDATE user SET name=? WHERE id=?", [direct.name, direct.userId]) }
})

test("missing, ordinary, SCIM and ambiguous team names refuse clearly; an ID still disambiguates legacy duplicate names", async () => {
  const refusals: Array<[string, RegExp]> = [["missing", /No recovery team/], ["ordinary", /designated Admin team/]]
  for (const [name, message] of refusals) {
    configure("check", name)
    const before = await inventory()
    await assert.rejects(recoverAdministratorsFromEnv(), message)
    assert.deepEqual(await inventory(), before)
  }
  assert.equal((await den.setFeature(org.orgId, "administratorRecovery", true)).status, 200)
  for (const [name, message] of refusals) {
    configure("apply", name)
    const before = await inventory()
    await assert.rejects(recoverAdministratorsFromEnv(), message)
    assert.deepEqual(await inventory(), before)
  }
  configure("apply")
  const group = createDenTypeId("scimGroup")
  await pool.execute("INSERT INTO scim_group(id,organization_id,provider_id,scim_group_id,display_name,team_id) VALUES(?,?,?,?,?,?)", [group, org.orgId, "target-test-provider", "target-test-group", "Target group", teamId])
  try {
    const before = await inventory()
    await assert.rejects(recoverAdministratorsFromEnv(), /SCIM-managed/)
    assert.deepEqual(await inventory(), before)
  } finally { await pool.execute("DELETE FROM scim_group WHERE id=?", [group]) }
  // A broken/legacy uniqueness constraint must not turn a name into an
  // arbitrary first-match selector. This DDL affects only the throwaway DB.
  const duplicate = createDenTypeId("team")
  await pool.query("ALTER TABLE team DROP INDEX team_organization_name")
  try {
    await pool.execute("INSERT INTO team(id,organization_id,name,grants_organization_admin) VALUES(?,?,'admins',1)", [duplicate, org.orgId])
    const before = await inventory()
    await assert.rejects(recoverAdministratorsFromEnv(), /team name requires exactly one.*Admin team.*team ID/i)
    configure("check")
    await assert.rejects(recoverAdministratorsFromEnv(), /team name requires exactly one.*Admin team.*team ID/i)
    configure("check", teamId)
    const events = await capture(() => recoverAdministratorsFromEnv())
    assert.equal(field(events.find((event) => event.event === "administrator_recovery_check"), "team", "id"), teamId)
    assert.deepEqual(await inventory(), before)
  } finally {
    await pool.execute("DELETE FROM team WHERE id=?", [duplicate])
    await pool.query("CREATE UNIQUE INDEX team_organization_name ON team(organization_id,name)")
  }
})

test("the actual bootstrap check refuses pending migrations and never runs migration, repair or reconciliation writes", async () => {
  configure()
  const { bootstrapDenDb } = await import("../../../../packages/den-db/scripts/bootstrap.ts")
  const before = await inventory()
  await assert.rejects(bootstrapDenDb(), /requires a bootstrapped database/)
  assert.deepEqual(await inventory(), before)
  const folder = new URL("../../../../packages/den-db/drizzle/", import.meta.url)
  const journal: unknown = JSON.parse(await readFile(new URL("meta/_journal.json", folder), "utf8"))
  assert.ok(isRecord(journal) && Array.isArray(journal.entries))
  const migrations: Array<{ hash: string; folderMillis: number }> = []
  for (const entry of journal.entries) {
    assert.ok(isRecord(entry) && typeof entry.tag === "string" && typeof entry.when === "number")
    const sql = await readFile(new URL(`${entry.tag}.sql`, folder), "utf8")
    migrations.push({ hash: createHash("sha256").update(sql).digest("hex"), folderMillis: entry.when })
  }
  await pool.query("CREATE TABLE __drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)")
  for (const migration of migrations.slice(0, -1)) await pool.execute("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)", [migration.hash, migration.folderMillis])
  const pending = await inventory(true)
  await assert.rejects(bootstrapDenDb(), /refuses pending database migrations/)
  assert.deepEqual(await inventory(true), pending)
  const latest = migrations.at(-1)
  assert.ok(latest)
  await pool.execute("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)", [latest.hash, latest.folderMillis])
  const ready = await inventory(true)
  const events = await capture(bootstrapDenDb)
  assert.equal(field(events.find((event) => event.event === "administrator_recovery_check"), "team", "id"), teamId)
  assert.deepEqual(await inventory(true), ready)
  const bootstrap = fileURLToPath(new URL("../../../../packages/den-db/dist/scripts/bootstrap.js", import.meta.url))
  const { stdout } = await promisify(execFile)(process.execPath, [bootstrap], { env: process.env, timeout: 30_000 })
  assert.ok(stdout.includes('"event":"administrator_recovery_check"'))
  assert.ok(stdout.includes("no database changes"))
  assert.doesNotMatch(stdout, /running committed migrations|ensuring schema repairs|reconciling default permission sets/)
  assert.deepEqual(await inventory(true), ready)
  // Default check is not a configured recovery request: normal upgrades must
  // still succeed for everybody else, without recovery output or mutations.
  const previousFlag = process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY
  configure("", "")
  process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = "false"
  try {
    const normal = await promisify(execFile)(process.execPath, [bootstrap], { env: process.env, timeout: 30_000 })
    assert.ok(normal.stdout.includes("running committed migrations"))
    assert.doesNotMatch(normal.stdout, /administrator recovery|administrator_recovery_/i)
    assert.deepEqual(await inventory(true), ready)
  } finally {
    if (previousFlag === undefined) delete process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY
    else process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = previousFlag
  }
})

test("packaged bootstrap exits unsuccessfully on apply failure without partial recovery writes", async () => {
  configure("apply")
  const before = await inventory(true)
  await pool.query("CREATE TRIGGER recovery_link_failure BEFORE INSERT ON permission_set_team FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='exp-col injected bootstrap failure'")
  try {
    const bootstrap = fileURLToPath(new URL("../../../../packages/den-db/dist/scripts/bootstrap.js", import.meta.url))
    await assert.rejects(promisify(execFile)(process.execPath, [bootstrap], { env: process.env, timeout: 30_000 }), (error: unknown) => {
      assert.ok(isRecord(error))
      assert.equal(error.code, 1)
      assert.match(String(error.stderr), /exp-col injected bootstrap failure/)
      return true
    })
    assert.deepEqual(await inventory(true), before)
    assert.ok(!(await keys(direct)).includes("members.update"))
    assert.ok((await keys(org.owner)).includes("members.update"))
  } finally {
    await pool.query("DROP TRIGGER recovery_link_failure")
  }
})

test("normal bootstrap reconciles a missing default permission and its next rerun is unchanged", async () => {
  const [admin] = await rows("SELECT id FROM permission_set WHERE organization_id=? AND default_key='admin'", [org.orgId])
  assert.ok(admin && typeof admin.id === "string")
  const defaults = await rows("SELECT * FROM permission_set_permission WHERE permission_set_id=? AND permission_key<>'permissions.view' ORDER BY id", [admin.id])
  await pool.execute("DELETE FROM permission_set_permission WHERE permission_set_id=? AND permission_key='permissions.view'", [admin.id])
  process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = "false"
  try {
    const bootstrap = fileURLToPath(new URL("../../../../packages/den-db/dist/scripts/bootstrap.js", import.meta.url))
    const first = await promisify(execFile)(process.execPath, [bootstrap], { env: process.env, timeout: 30_000 })
    assert.match(first.stdout, /permission sets reconciled:.*1 changed, 1 rows added/)
    assert.doesNotMatch(first.stdout, /permission reconciliation failed|administrator_recovery_/)
    const added = await rows("SELECT source,status FROM permission_set_permission WHERE permission_set_id=? AND permission_key='permissions.view'", [admin.id])
    assert.deepEqual(added, [{ source: "reconcile", status: "allow" }])
    assert.deepEqual(await rows("SELECT * FROM permission_set_permission WHERE permission_set_id=? AND permission_key<>'permissions.view' ORDER BY id", [admin.id]), defaults)
    const committed = await inventory(true)
    const second = await promisify(execFile)(process.execPath, [bootstrap], { env: process.env, timeout: 30_000 })
    assert.match(second.stdout, /permission sets reconciled:.*0 changed, 0 rows added/)
    assert.deepEqual(await inventory(true), committed)
    assert.ok((await keys(direct)).includes("permissions.view"))
  } finally {
    process.env.DEN_FEATURE_ADMINISTRATOR_RECOVERY = "true"
  }
})

test("apply accepts a team name in the single organization and keeps stable ID support after a rename", async () => {
  assert.equal((await den.setFeature(org.orgId, "administratorRecovery", true)).status, 200)
  configure("apply")
  assert.equal(await recoverAdministratorsFromEnv(), 1)
  for (const person of [direct, inherited]) assert.ok((await keys(person)).includes("members.update"))
  const call = den.as(direct, org.orgId)
  assert.equal((await call("POST", `/v1/members/${member.memberId}/role`, { role: "admin" })).status, 200)
  assert.equal((await rows("SELECT role FROM member WHERE id=?", [member.memberId]))[0]?.role, "admin")
  assert.equal((await call("POST", `/v1/members/${member.memberId}/role`, { role: "member" })).status, 200)
  assert.equal((await den.as(outside, org.orgId)("PATCH", `/v1/teams/${teamId}`, { name: "Renamed admins" })).status, 200)
  configure("check", "admins")
  await assert.rejects(recoverAdministratorsFromEnv(), /No recovery team/)
  configure("apply", "admins")
  await assert.rejects(recoverAdministratorsFromEnv(), /No recovery team/)
  configure("check", "Renamed admins")
  const events = await capture(() => recoverAdministratorsFromEnv())
  const header = events.find((event) => event.event === "administrator_recovery_check")
  assert.equal(field(header, "team", "id"), teamId)
  assert.ok(list(field(header, "existingRoles")).some((role) => role.name === "Restored administrator permissions"))
  configure("apply", teamId)
  assert.equal(await recoverAdministratorsFromEnv(), 0)
  assert.ok(!(await keys(outside)).includes("members.update"))
})

test("multiple organizations require selection, accept slugs as well as IDs, and keep the batch map scoped", async () => {
  const other = await den.createOrg(await den.signUp("Second target owner"), "Second target workspace")
  const admin = await den.newMember(other.owner, other.orgId, "Second target administrator", "admin")
  const otherTeam = await den.createTeam(other.owner, other.orgId, "Secondary admins", [admin.memberId], { grantsOrganizationAdmin: true })
  const slug = "recovery-secondary"
  await pool.execute("UPDATE organization SET slug=? WHERE id=?", [slug, other.orgId])
  configure("check", "Secondary admins")
  const before = await inventory()
  await assert.rejects(recoverAdministratorsFromEnv(), /organization is required/)
  assert.deepEqual(await inventory(), before)
  configure("check", "Secondary admins", "unknown-slug")
  await assert.rejects(recoverAdministratorsFromEnv(), /organization.*was not found/)
  configure("check", "Secondary admins", slug)
  const events = await capture(() => recoverAdministratorsFromEnv())
  assert.equal(field(events.find((event) => event.event === "administrator_recovery_check"), "organization", "id"), other.orgId)
  assert.equal(field(events.find((event) => event.event === "administrator_recovery_check"), "team", "id"), otherTeam)
  assert.equal((await den.setFeature(other.orgId, "administratorRecovery", true)).status, 200)
  configure("apply", "Secondary admins", slug)
  assert.equal(await recoverAdministratorsFromEnv(), 1)
  assert.ok((await keys(admin, other.orgId)).includes("members.update"))
  configure("check", "", "", { [slug]: "Secondary admins" })
  const mapped = await capture(() => recoverAdministratorsFromEnv())
  assert.equal(field(mapped.find((event) => event.event === "administrator_recovery_check"), "organization", "id"), other.orgId)
  configure("check", "", "", { [slug]: "Secondary admins", [other.orgId]: otherTeam })
  await assert.rejects(recoverAdministratorsFromEnv(), /selected more than once/)
  configure("check", "Secondary admins", other.orgId, { [slug]: otherTeam })
  await assert.rejects(recoverAdministratorsFromEnv(), /not both/)
})

test("multiple Admin teams refuse name selection even after an ordinary admin swaps names; IDs remain stable", async () => {
  const workspace = await den.createOrg(await den.signUp("Rename example owner"), "Rename example workspace")
  const chosen = await den.newMember(workspace.owner, workspace.orgId, "Chosen example administrator", "admin")
  const attacker = await den.newMember(workspace.owner, workspace.orgId, "Other example administrator", "admin")
  const chosenTeam = await den.createTeam(workspace.owner, workspace.orgId, "reviewed", [chosen.memberId], { grantsOrganizationAdmin: true })
  const otherTeam = await den.createTeam(workspace.owner, workspace.orgId, "other", [attacker.memberId], { grantsOrganizationAdmin: true })
  configure("apply", "reviewed", workspace.orgId)
  const before = await inventory()
  const refused = await captureLines(async () => { await assert.rejects(recoverAdministratorsFromEnv(), /team name requires exactly one.*team ID/i) })
  assert.ok(refused.some((line) => line.includes(chosenTeam)))
  assert.ok(refused.some((line) => line.includes(otherTeam)))
  assert.deepEqual(await inventory(), before)
  const call = den.as(attacker, workspace.orgId)
  assert.equal((await call("PATCH", `/v1/teams/${chosenTeam}`, { name: "parked" })).status, 200)
  assert.equal((await call("PATCH", `/v1/teams/${otherTeam}`, { name: "reviewed" })).status, 200)
  await captureLines(async () => { await assert.rejects(recoverAdministratorsFromEnv(), /team name requires exactly one.*team ID/i) })
  configure("apply", chosenTeam, workspace.orgId)
  assert.equal(await recoverAdministratorsFromEnv(), 1)
  assert.ok((await keys(chosen, workspace.orgId)).includes("members.update"))
  assert.ok(!(await keys(attacker, workspace.orgId)).includes("members.update"))
})

test("expectedMembers mismatch refuses without writes; match commits then prints APPLIED and no-replay output", async () => {
  const workspace = await den.createOrg(await den.signUp("Count example owner"), "Count example workspace")
  const people: Member[] = []
  for (const name of ["First example person", "Second example person", "Third example person"]) people.push(await den.newMember(workspace.owner, workspace.orgId, name))
  const team = await den.createTeam(workspace.owner, workspace.orgId, "admins", [workspace.owner.memberId, ...people.map((person) => person.memberId)], { grantsOrganizationAdmin: true })
  configure("apply", team, workspace.orgId, {}, 3)
  const before = await inventory()
  const refused = await captureLines(async () => { await assert.rejects(recoverAdministratorsFromEnv(), /Expected 3 members.*found 4/) })
  assert.ok(refused[0]?.startsWith("ADMIN RECOVERY REFUSED — nothing was changed. Expected 3 members"))
  const recipients = refused.filter((line) => line.includes('"event":"administrator_recovery_recipient"')).map((line) => { const value: unknown = JSON.parse(line); assert.ok(isRecord(value)); return value })
  assert.equal(recipients.length, 4)
  assert.ok(recipients.every((person) => person.viaTeam === true && !("email" in person)))
  assert.ok(refused.some((line) => line.includes("set expectedMembers to 4")))
  assert.ok(refused.some((line) => line.includes("ask the owner to remove")))
  assert.deepEqual(await inventory(), before)
  configure("apply", team, workspace.orgId, {}, 4)
  const applied = await captureLines(async () => { assert.equal(await recoverAdministratorsFromEnv(), 1) })
  assert.equal(applied[0], "APPLIED — these 4 members now have the 14 permissions")
  assert.equal(applied.filter((line) => line.includes('"event":"administrator_recovery_recipient"')).length, 4)
  assert.ok(applied.some((line) => line.includes("Restored administrator permissions")))
  assert.ok(applied.some((line) => line.includes("Members > Roles: unlink or delete")))
  for (const person of people) assert.ok((await keys(person, workspace.orgId)).includes("members.update"))
  const committed = await inventory()
  const replay = await captureLines(async () => { assert.equal(await recoverAdministratorsFromEnv(), 0) })
  assert.ok(replay[0]?.startsWith("ALREADY APPLIED"))
  assert.deepEqual(await inventory(), committed)
})
