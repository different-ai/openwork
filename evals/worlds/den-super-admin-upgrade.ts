import assert from "node:assert/strict"
import { UpgradeLab, buildCohort, images, preservedKeys } from "../support/den-super-admin-upgrade.ts"

export { field, preservedKeys } from "../support/den-super-admin-upgrade.ts"

/** Operator-owned upgrade setup. SQL guards validate the disposable fixture;
 * the proof observes authorization, membership and permissions through HTTP. */
export async function superAdminUpgrade() {
  const engine = process.env.EXP_O2_ENGINE === "mariadb" ? "mariadb" : "mysql"
  const lab = new UpgradeLab(engine)
  await lab.start()
  let closed = false
  const close = async () => { if (!closed) { closed = true; await lab.close() } }
  try {
    const version = lab.rows("SELECT VERSION() AS version")[0].version
    assert.ok(version.startsWith(engine === "mysql" ? "8.4." : "11.4."))
    lab.publishedMigrate(images.before)
    await lab.serve(images.before)
    const cohort = await buildCohort(lab)
    const before = lab.snapshot() // private, in-memory restore data; never evidence
    const existingTeam = lab.rows("SELECT id,name,member_count,grants_organization_admin FROM team ORDER BY id")
    const existingMembers = lab.rows("SELECT * FROM team_member ORDER BY id")
    lab.stopApi()
    lab.branchMigrate()
    await lab.serve(images.after)
    const teams = lab.rows("SELECT * FROM team WHERE name LIKE 'Super Admins (%)'")
    assert.equal(teams.length, 1)
    const team = teams[0]
    const expected = ["promoted", "invited", "superteam", "multi"]
    const roster = lab.rows(`SELECT org_membership_id FROM team_member WHERE team_id='${team.id}' ORDER BY org_membership_id`).map(row => row.org_membership_id)
    assert.deepEqual(roster, expected.map(label => cohort.ids[label]).sort())
    assert.equal(Number(team.member_count), expected.length)
    assert.equal(team.organization_id, cohort.orgId)
    assert.equal(team.grants_organization_admin, "0")
    assert.deepEqual(lab.rows(`SELECT id,name,member_count,grants_organization_admin FROM team WHERE id<>'${team.id}' ORDER BY id`), existingTeam)
    assert.deepEqual(lab.rows(`SELECT * FROM team_member WHERE team_id<>'${team.id}' ORDER BY id`), existingMembers)
    const sets = lab.rows("SELECT * FROM permission_set WHERE default_key IS NULL")
    assert.equal(sets.length, 1)
    assert.deepEqual(lab.rows(`SELECT permission_key,status,source FROM permission_set_permission WHERE permission_set_id='${sets[0].id}' ORDER BY permission_key`), preservedKeys.map(permission_key => ({ permission_key, status: "allow", source: "migration" })))
    assert.deepEqual(lab.rows(`SELECT role,status FROM invitation WHERE organization_id='${cohort.orgId}' AND email='exp-o2-pending@example.test'`), [{ role: "admin", status: "pending" }])
    return {
      version, cohort, expected,
      call: lab.call.bind(lab), login: lab.login.bind(lab),
      // These are installation/operator transitions, not a product backdoor in
      // the proof. Each replay also checks all five storage tables exactly.
      replay() {
        const stable = lab.preservationState()
        lab.branchMigrate()
        lab.replay0138()
        assert.deepEqual(lab.preservationState(), stable)
      },
      async alreadyDeprecated() {
        lab.stopApi()
        lab.restore(before)
        lab.publishedMigrate(images.after)
        const stable = lab.preservationState()
        lab.branchMigrate()
        assert.deepEqual(lab.preservationState(), stable)
        await lab.serve(images.after)
      },
      async fresh() {
        lab.stopApi()
        lab.restore("")
        lab.branchMigrate()
        for (const table of ["team", "team_member", "permission_set", "permission_set_permission", "permission_set_team"])
          assert.equal(lab.rows(`SELECT * FROM ${table}`).length, 0)
        const stable = lab.preservationState()
        lab.branchMigrate()
        assert.deepEqual(lab.preservationState(), stable)
        await lab.serve(images.after)
        const owner = await lab.signup("fresh-owner")
        const created = await lab.call(owner, "/v1/org", "POST", { name: "exp-o2-fresh" })
        assert.equal(created.status, 201)
        return owner
      },
      async capture(teamId: string, setId: string) {
        if (process.env.EXP_O2_SCREENSHOTS === "1") {
          const { capturePreservedTeam } = await import("../support/den-super-admin-upgrade-shots.ts")
          await capturePreservedTeam(lab, teamId, setId)
        }
      },
      async [Symbol.asyncDispose]() { await close() },
    }
  } catch (error) {
    await close()
    throw error
  }
}
