import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, test } from "node:test"
import { PRIVATE_VALUE_FILLS_ROUTE } from "@openwork/types/den/private-value-fills"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen({ env: { DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())

let orgId: string
let owner: Member
let member: Member

before(async () => {
  const org = await den.createOrg(await den.signUp("Fill Audit Owner"), "Fill audit workspace")
  orgId = org.orgId
  owner = org.owner
  member = await den.newMember(owner, orgId, "Fill Audit Member")
})

function fillReport() {
  return { id: randomUUID(), at: new Date().toISOString(), site: "https://login.example.test", field: "Password", source: "command", program: "example-cli", result: "filled" }
}

async function enableFeature(enabled: boolean) {
  const result = await den.setFeature(orgId, "privateValues", enabled)
  assert.equal(result.status, 200, summary(result))
}

async function eventsWith(action: string) {
  const call = den.as(owner, orgId)
  const listed = await call("GET", `/v1/audit/operations?limit=50&action=${encodeURIComponent(action)}`)
  assert.equal(listed.status, 200, summary(listed))
  const operations = list(field(listed.body, "operations"))
  const events = await Promise.all(operations.map(async ({ id }) => {
    const result = await call("GET", `/v1/audit/operations/${text(id, "operation id")}/events?limit=50`)
    assert.equal(result.status, 200, summary(result))
    return list(field(result.body, "events"))
  }))
  return events.flat().filter((event) => event.action === action)
}

test("the report is refused with the feature off", async () => {
  await enableFeature(false)
  const result = await den.as(member, orgId)("POST", PRIVATE_VALUE_FILLS_ROUTE, fillReport())
  assert.equal(result.status, 404, summary(result))
  assert.equal(field(result.body, "error"), "feature_disabled")
  assert.deepEqual(await eventsWith("private_value.filled"), [])
})

test("invalid fill reports return 400", async () => {
  await enableFeature(true)
  const result = await den.as(member, orgId)("POST", PRIVATE_VALUE_FILLS_ROUTE, { ...fillReport(), source: "unknown" })
  assert.equal(result.status, 400, summary(result))
})

test("a fill records the authenticated member and metadata, not a private value", async () => {
  await enableFeature(true)
  const report = fillReport()
  const result = await den.as(member, orgId)("POST", PRIVATE_VALUE_FILLS_ROUTE, report)
  assert.equal(result.status, 200, summary(result))
  assert.deepEqual(result.body, { recorded: true })

  const events = await eventsWith("private_value.filled")
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(event?.category, "access")
  assert.equal(event?.outcome, "succeeded")
  assert.deepEqual(event?.actor, { type: "user", id: member.userId, memberId: member.memberId })
  assert.ok(list(event?.resources).some((resource) => resource.type === "private_value_fill" && resource.id === report.id && resource.relationship === "target"))
  assert.ok(list(event?.resources).some((resource) => resource.type === "organization" && resource.id === orgId && resource.relationship === "parent"))
  assert.deepEqual(field(event, "changes", "after"), {
    site: report.site,
    fields: [{ field: report.field, source: report.source, program: report.program }],
  })
  assert.equal(JSON.stringify(event).includes('"value":'), false)
})

test("declined and refused fills are denied with distinct categories and reason codes", async () => {
  await enableFeature(true)
  for (const [result, action, category, reasonCode] of [
    ["declined", "private_value.fill_declined", "access", "member_declined"],
    ["refused", "private_value.fill_refused", "security", "organization_rule"],
  ]) {
    const response = await den.as(member, orgId)("POST", PRIVATE_VALUE_FILLS_ROUTE, { ...fillReport(), source: "paste", program: undefined, result })
    assert.equal(response.status, 200, summary(response))
    assert.deepEqual(response.body, { recorded: true })
    const events = await eventsWith(action)
    assert.equal(events.length, 1)
    const [event] = events
    assert.equal(event?.category, category)
    assert.equal(event?.outcome, "denied")
    assert.equal(event?.reasonCode, reasonCode)
  }
})

test("with organization capture off a valid report returns recorded false", async () => {
  await enableFeature(true)
  const call = den.as(owner, orgId)
  const usage = await call("GET", "/v1/audit/usage")
  assert.equal(usage.status, 200, summary(usage))
  const expectedRevision = field(usage.body, "policy", "revision")
  assert.equal(typeof expectedRevision, "number")
  const disabled = await call("PATCH", "/v1/audit/settings", { captureOn: false, expectedRevision })
  assert.equal(disabled.status, 200, summary(disabled))

  const result = await den.as(member, orgId)("POST", PRIVATE_VALUE_FILLS_ROUTE, fillReport())
  assert.equal(result.status, 200, summary(result))
  assert.deepEqual(result.body, { recorded: false })
})
