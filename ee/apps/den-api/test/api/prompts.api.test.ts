import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("Prompt fixtures require the disposable MySQL harness")

const owner = await den.signUp("Prompt Owner")
const org = await den.createOrg(owner, "Prompted workspace")
const person = await den.newMember(owner, org.orgId, "Prompt Member")
const admin = await den.newMember(owner, org.orgId, "Prompt Admin", "admin")
const sales = await den.createTeam(owner, org.orgId, "Sales", [person.memberId])
const design = await den.createTeam(owner, org.orgId, "Design", [person.memberId])

test("members receive an empty prompt list before any prompts are saved", async () => {
  const mine = await den.request(person.token, "GET", "/v1/me/prompts", { orgId: org.orgId })
  assert.equal(mine.status, 200, summary(mine))
  assert.deepEqual(field(mine.body, "prompts"), [])
})

test("admins set prompts for everyone and teams; members get them in order", async () => {
  const empty = await den.request(owner.token, "GET", "/v1/org/prompts", { orgId: org.orgId })
  assert.equal(empty.status, 200, summary(empty))
  assert.equal(field(empty.body, "everyone"), null)
  assert.deepEqual(list(field(empty.body, "teams")).map((team) => [team.name, team.prompt]), [["Design", null], ["Sales", null]])
  assert.equal(field(empty.body, "canEdit"), true)

  for (const [path, content] of [
    [`/v1/org/prompts/teams/${sales}`, "Sales prompt"],
    ["/v1/org/prompts/everyone", "Everyone prompt"],
    [`/v1/org/prompts/teams/${design}`, "Design prompt"],
  ] as const) {
    const saved = await den.request(owner.token, "PUT", path, { orgId: org.orgId, body: { content } })
    assert.equal(saved.status, 200, summary(saved))
  }
  // Saving again updates the scope's prompt rather than adding another.
  const updated = await den.request(owner.token, "PUT", `/v1/org/prompts/teams/${sales}`, { orgId: org.orgId, body: { content: "Sales prompt, revised" } })
  assert.equal(updated.status, 200, summary(updated))
  const salesPrompt = list(field(updated.body, "teams")).find((team) => team.teamId === sales)
  assert.equal(field(salesPrompt, "prompt", "content"), "Sales prompt, revised")
  assert.deepEqual(field(salesPrompt, "prompt", "assignment"), { everyone: false, teamIds: [sales], memberIds: [] })
  assert.deepEqual(field(updated.body, "everyone", "assignment"), { everyone: true, teamIds: [], memberIds: [] })

  const mine = await den.request(person.token, "GET", "/v1/me/prompts", { orgId: org.orgId })
  assert.equal(mine.status, 200, summary(mine))
  assert.deepEqual(list(field(mine.body, "prompts")).map((entry) => [entry.source, entry.teamName ?? null, entry.content]), [
    ["organization", null, "Everyone prompt"],
    ["team", "Design", "Design prompt"],
    ["team", "Sales", "Sales prompt, revised"],
  ])
})

test("prompt text is encrypted at rest", async () => {
  const [rows] = await client.execute("SELECT content FROM org_prompt WHERE organization_id = ?", [org.orgId])
  const stored = Array.isArray(rows) ? rows.map((row) => String(Object(row).content)) : []
  assert.equal(stored.length, 3)
  for (const value of stored) {
    assert.doesNotMatch(value, /prompt/i)
  }
})

test("admins can manage prompts by default", async () => {
  const listed = await den.request(admin.token, "GET", "/v1/org/prompts", { orgId: org.orgId })
  assert.equal(listed.status, 200, summary(listed))
  assert.equal(field(listed.body, "canEdit"), true)
  const saved = await den.request(admin.token, "PUT", "/v1/org/prompts/everyone", { orgId: org.orgId, body: { content: "Everyone prompt" } })
  assert.equal(saved.status, 200, summary(saved))
})

test("members cannot see or change prompts, and empty prompts are refused", async () => {
  assert.equal((await den.request(person.token, "GET", "/v1/org/prompts", { orgId: org.orgId })).status, 403)
  assert.equal((await den.request(person.token, "PUT", "/v1/org/prompts/everyone", { orgId: org.orgId, body: { content: "Mine now" } })).status, 403)
  assert.equal((await den.request(owner.token, "PUT", "/v1/org/prompts/everyone", { orgId: org.orgId, body: { content: "   " } })).status, 400)
})

test("removing a team's prompt or deleting the team stops it applying", async () => {
  const removed = await den.request(owner.token, "DELETE", `/v1/org/prompts/teams/${design}`, { orgId: org.orgId })
  assert.equal(removed.status, 200, summary(removed))
  const deleted = await den.request(owner.token, "DELETE", `/v1/teams/${sales}`, { orgId: org.orgId })
  assert.ok(deleted.status < 300, summary(deleted))

  const mine = await den.request(person.token, "GET", "/v1/me/prompts", { orgId: org.orgId })
  assert.deepEqual(list(field(mine.body, "prompts")).map((entry) => entry.content), ["Everyone prompt"])
})
