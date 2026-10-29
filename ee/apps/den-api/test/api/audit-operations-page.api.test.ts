/**
 * One page of audit history loads in a fixed number of database queries,
 * however many operations it shows, and each summary still describes the
 * operation's first event.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { bootDen, field, list, summary, type Member } from "./harness.js"

const den = await bootDen({ env: { DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())

let orgId = ""
let owner: Member

before(async () => {
  const created = await den.createOrg(await den.signUp("Audit Page Owner"), "Audit page org")
  orgId = created.orgId
  owner = created.owner
  // Every audit read is recorded as its own operation, so this builds history.
  for (let index = 0; index < 30; index += 1) {
    const read = await den.as(owner, orgId)("GET", "/v1/audit/event-types")
    assert.equal(read.status, 200, summary(read))
  }
  for (let index = 0; index < 3; index += 1) await den.createTeam(owner, orgId, `Audit page team ${index}`, [])
})

async function queriesFor(limit: number) {
  const [{ countDbQueries }, { db }, { listAuditOperations, auditOperationsQuerySchema }, { env }] = await Promise.all([
    import("../../src/observability/db-query-count.js"), import("../../src/db.js"), import("../../src/audit/queries.js"), import("../../src/env.js"),
  ])
  const count = { count: 0 }
  const page = await countDbQueries(count, () => listAuditOperations({ database: db, organizationId: orgId, secret: env.betterAuthSecret }, auditOperationsQuerySchema.parse({ limit: String(limit) })))
  return { queries: count.count, operations: page.operations.length }
}

test("a page of operations takes the same number of queries for 2 rows as for 30", async () => {
  const small = await queriesFor(2)
  const large = await queriesFor(30)
  assert.equal(small.operations, 2)
  assert.equal(large.operations, 30)
  assert.equal(large.queries, small.queries, `2 rows: ${small.queries} queries, 30 rows: ${large.queries} queries`)
})

test("each summary shows its first event's action and resources, across pages", async () => {
  const first = await den.as(owner, orgId)("GET", "/v1/audit/operations?limit=20")
  assert.equal(first.status, 200, summary(first))
  const cursor = field(first.body, "nextCursor")
  assert.equal(typeof cursor, "string", summary(first))
  const second = await den.as(owner, orgId)("GET", `/v1/audit/operations?limit=20&cursor=${encodeURIComponent(String(cursor))}`)
  assert.equal(second.status, 200, summary(second))
  const operations = [...list(field(first.body, "operations")), ...list(field(second.body, "operations"))]
  assert.equal(new Set(operations.map((operation) => operation.id)).size, operations.length, "pages overlap")
  // Capture is asynchronous: wait for the team operations, whose first event names the team.
  const deadline = Date.now() + 15_000
  let teams: Record<string, unknown>[] = []
  while (teams.length < 3 && Date.now() < deadline) {
    const listed = await den.as(owner, orgId)("GET", "/v1/audit/operations?limit=50&action=team.create.succeeded")
    teams = list(field(listed.body, "operations"))
    if (teams.length < 3) await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.equal(teams.length, 3, "team operations are listed")
  assert.ok(teams.every((operation) => list(operation.resources).some((resource) => resource.type === "team")), JSON.stringify(teams))

  for (const operation of [...operations, ...teams]) {
    const events = await den.as(owner, orgId)("GET", `/v1/audit/operations/${String(operation.id)}/events?limit=1`)
    assert.equal(events.status, 200, summary(events))
    const firstEvent = list(field(events.body, "events"))[0]
    assert.equal(operation.action, firstEvent?.action, `operation ${String(operation.id)}`)
    assert.deepEqual(operation.resources, field(firstEvent, "resources"), `operation ${String(operation.id)}`)
  }
})
