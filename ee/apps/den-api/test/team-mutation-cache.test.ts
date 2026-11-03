import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/team_mutation_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-team-mutation-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-team-mutation-unit-test-key"
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_REDIS_URL = ""
const { db } = await import("../src/db.js")
const bootstrap = mock.method(db.$primary, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://api.unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { withOrganizationTeamMutation } = await import("../src/organization-team-roles.js")
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrap.mock.restore()
const organizationId = createDenTypeId("organization")

afterEach(() => mock.restoreAll())

function transaction(events: string[], failCommit = false) {
  const revisions: string[] = []
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ for: async () => { events.push("lock"); return [{ id: organizationId }] } }) }) }),
    update: (table: typeof OrganizationTable) => {
      assert.equal(table, OrganizationTable)
      return { set: (fields: { teamMembershipRevision: string }) => {
        assert.match(fields.teamMembershipRevision, /^[0-9a-f-]{36}$/)
        return { where: async () => { revisions.push(fields.teamMembershipRevision); events.push("revision") } }
      } }
    },
  }
  mock.method(db, "transaction", async (callback: (database: typeof tx) => Promise<unknown>) => {
    const result = await callback(tx)
    if (failCommit) throw new Error("uncertain commit")
    events.push("commit")
    return result
  })
  return revisions
}

test("team mutation and revision update share one locked transaction", async () => {
  const events: string[] = []
  const revisions = transaction(events)
  const result = await withOrganizationTeamMutation(organizationId, async () => { events.push("mutate"); return "done" })
  assert.equal(result, "done")
  assert.deepEqual(events, ["lock", "mutate", "revision", "commit"])
  assert.equal(revisions.length, 1)
})

test("every successful mutation generates a different revision", async () => {
  const events: string[] = []
  const revisions = transaction(events)
  await withOrganizationTeamMutation(organizationId, async () => {})
  await withOrganizationTeamMutation(organizationId, async () => {})
  assert.equal(revisions.length, 2)
  assert.notEqual(revisions[0], revisions[1])
})

test("failed mutation does not write or commit a revision", async () => {
  const events: string[] = []
  transaction(events)
  await assert.rejects(withOrganizationTeamMutation(organizationId, async () => { throw new Error("mutation failed") }), /mutation failed/)
  assert.deepEqual(events, ["lock"])
})

test("uncertain commit propagates: the DB transaction owns both the revision and team writes", async () => {
  const events: string[] = []
  transaction(events, true)
  await assert.rejects(withOrganizationTeamMutation(organizationId, async () => { events.push("mutate") }), /uncertain commit/)
  assert.deepEqual(events, ["lock", "mutate", "revision"])
})
