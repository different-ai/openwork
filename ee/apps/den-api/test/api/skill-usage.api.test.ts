/**
 * Library usage counts a skill when an agent loads it to follow it (get_skill),
 * not when a host fetches its SKILL.md ahead of time (a skill:// resource read,
 * which OpenWork does for every listed skill in the background).
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Json } from "./harness.js"

const den = await bootDen()
after(() => den.close())

async function skillUses(orgId: string): Promise<number> {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("skillUses needs MySQL mode")
  const [rows] = await client.query("SELECT COUNT(*) AS uses FROM capability_usage_event WHERE organization_id = ? AND kind = 'skill'", [orgId])
  return Number((rows as Array<{ uses: number | string }>)[0]?.uses ?? 0)
}

/** Uses are recorded without delaying the response, so give the write a moment. */
async function settledSkillUses(orgId: string, expected: number): Promise<number> {
  let uses = await skillUses(orgId)
  for (let attempt = 0; attempt < 40 && uses !== expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    uses = await skillUses(orgId)
  }
  return uses
}

async function rpc(token: string, body: Record<string, unknown>) {
  const response = await den.request(token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", ...body },
  })
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  return { status: response.status, envelope: line ? JSON.parse(line.slice(5)) as Json : response.body }
}

test("reading a skill:// SKILL.md records no Library use; get_skill records one", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Uma Usage"), "Skill usage org")
  const skillName = `usage-proof-${den.stamp}`
  const rawSourceText = `---\nname: ${skillName}\ndescription: Proves which skill reads count as uses.\n---\n\nSay the usage proof phrase.`
  const created = await den.as(owner, orgId)("POST", "/v1/plugins", { name: skillName, components: [{ type: "skill", input: { rawSourceText } }] })
  assert.equal(created.status, 201, summary(created))
  const pluginId = text(field(created.body, "item", "id"), "plugin id")
  const token = await den.mintMcpToken(owner, orgId)

  const listed = list(field((await den.callMcpTool(token, "list_skills", { query: skillName })).structured, "skills"))
    .find((entry) => String(entry.capability).startsWith(`plugin:${pluginId}:`))
  assert.ok(listed, "the creator's skill is listed")
  const location = text(listed.location, "skill location")

  // The stateless transport acknowledges this without building the member's surface.
  const initialized = await den.request(token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  })
  assert.equal(initialized.status, 202, summary(initialized))

  for (const id of [1, 2]) {
    const read = await rpc(token, { id, method: "resources/read", params: { uri: location } })
    assert.equal(read.status, 200)
    const contents = list(field(read.envelope, "result", "contents"))
    assert.match(String(contents[0]?.text), /Say the usage proof phrase\./)
  }
  assert.equal(await settledSkillUses(orgId, 1), 0, "prefetching the SKILL.md is not a use")

  const loaded = await den.callMcpTool(token, "get_skill", { name: String(listed.capability) })
  assert.equal(loaded.isError, false, loaded.raw.slice(0, 400))
  assert.equal(await settledSkillUses(orgId, 1), 1, "loading it with get_skill is one use")
})
