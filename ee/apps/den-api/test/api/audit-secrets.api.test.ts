/**
 * The audit log never stores a secret: a failed sign-in is recorded without the
 * password, an API key is named but its value never stored, and agent
 * permission patterns are withheld. Ported from
 * evals/core/audit-logs-actors.e2e.test.ts and evals/specs/audit-api-coverage.test.ts.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen({ env: { DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())

let orgId = ""
let owner: Member
let teammate: Member

before(async () => {
  const created = await den.createOrg(await den.signUp("Audit Owner"), "Audit org")
  orgId = created.orgId
  owner = created.owner
  teammate = await den.newMember(owner, orgId, "Audit Teammate")
})

/** Audit capture is asynchronous: poll the owner's history for one action. */
async function operationsWith(action: string, until: (operations: Record<string, unknown>[]) => boolean) {
  const deadline = Date.now() + 15_000
  for (;;) {
    const listed = await den.as(owner, orgId)("GET", `/v1/audit/operations?limit=50&action=${encodeURIComponent(action)}`)
    assert.equal(listed.status, 200, summary(listed))
    const operations = list(field(listed.body, "operations"))
    if (until(operations) || Date.now() > deadline) return { operations, text: listed.text }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function eventsOf(operationId: string) {
  const events = await den.as(owner, orgId)("GET", `/v1/audit/operations/${operationId}/events?limit=50`)
  assert.equal(events.status, 200, summary(events))
  return { events: list(field(events.body, "events")), text: events.text }
}

test("a wrong password is recorded as a denied sign-in, attributed to nobody, without the password", async () => {
  const wrongPassword = `wrong-guess-${randomBytes(8).toString("hex")}`
  const before = await operationsWith("session.sign_in_failed", () => true)
  const refused = await den.signIn(teammate.email, wrongPassword)
  assert.equal(refused.status, 401, summary(refused))

  const after = await operationsWith("session.sign_in_failed", (operations) => operations.length > before.operations.length)
  const fresh = after.operations.filter((operation) => !before.operations.some((old) => old.id === operation.id))
  assert.equal(fresh.length, 1, after.text.slice(0, 400))
  const { events, text: eventsText } = await eventsOf(String(fresh[0]?.id))
  const failed = events.find((event) => event.action === "session.sign_in_failed")
  assert.equal(field(failed, "category"), "security")
  assert.equal(field(failed, "outcome"), "denied")
  assert.equal(field(failed, "reasonCode"), "invalid_credentials")
  assert.deepEqual(field(failed, "actor"), { type: "unknown", id: null })
  assert.ok(list(field(failed, "resources")).some((resource) => resource.type === "user" && resource.id === teammate.userId && resource.relationship === "target"))

  assert.equal(after.text.includes(wrongPassword), false)
  assert.equal(eventsText.includes(wrongPassword), false)
  assert.equal((await den.auditStorageText()).includes(wrongPassword), false, "the password reached audit storage")
})

test("a script using an API key is attributed to the key by id; the key's value is never stored", async () => {
  const minted = await den.as(owner, orgId)("POST", "/v1/api-keys", { name: "Audit proof script key" })
  assert.equal(minted.status, 201, summary(minted))
  const apiKey = text(field(minted.body, "key"), "api key value")
  const apiKeyId = text(field(minted.body, "apiKey", "id"), "api key id")

  const scripted = await den.request(null, "POST", "/v1/teams", { headers: { "x-api-key": apiKey }, body: { name: "Audit scripted team", memberIds: [] } })
  assert.equal(scripted.status, 201, summary(scripted))
  const byKey = await operationsWith("team.create.succeeded", (operations) => operations.some((operation) => field(operation, "initiatingActor", "credentialId") === apiKeyId))
  const operation = byKey.operations.find((entry) => field(entry, "initiatingActor", "credentialId") === apiKeyId)
  assert.ok(operation, byKey.text.slice(0, 400))
  const { events, text: eventsText } = await eventsOf(String(operation.id))
  const succeeded = events.find((event) => event.action === "team.create.succeeded")
  assert.equal(field(succeeded, "actor", "type"), "user")
  assert.equal(field(succeeded, "actor", "credentialId"), apiKeyId)

  const keys = await operationsWith("api_key.create.succeeded", () => true)
  for (const seen of [byKey.text, eventsText, keys.text]) assert.equal(seen.includes(apiKey), false)
  assert.equal((await den.auditStorageText()).includes(apiKey), false, "the API key value reached audit storage")
})

test("changing agent permissions records how many patterns changed, never the patterns themselves", async () => {
  const secretHost = `internal-${randomBytes(6).toString("hex")}.example.test`
  const secretCommand = `deploy-${randomBytes(6).toString("hex")}`
  const saved = await den.as(owner, orgId)("PUT", "/v1/agent-permissions/everyone", {
    settings: { commands: { decision: "ask", allow: [`${secretCommand} *`] }, websites: { decision: "ask", block: [secretHost] } },
  })
  assert.equal(saved.status, 200, summary(saved))
  // The policy itself keeps the patterns: they are withheld only from the audit log.
  const read = await den.as(owner, orgId)("GET", "/v1/agent-permissions")
  assert.ok(read.text.includes(secretHost), summary(read))

  const updated = await operationsWith("agent_permission_policy.updated", (operations) => operations.length > 0)
  assert.equal(updated.operations.length, 1, updated.text.slice(0, 400))
  const { text: eventsText } = await eventsOf(String(updated.operations[0]?.id))
  assert.ok(eventsText.includes("[withheld]"), eventsText.slice(0, 600))
  for (const secret of [secretHost, secretCommand]) {
    assert.equal(updated.text.includes(secret), false)
    assert.equal(eventsText.includes(secret), false)
  }
  const stored = await den.auditStorageText()
  assert.equal(stored.includes(secretHost), false, "a website pattern reached audit storage")
  assert.equal(stored.includes(secretCommand), false, "a command pattern reached audit storage")
})
