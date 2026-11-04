import assert from "node:assert/strict"
import { after, test } from "node:test"
import { DEFAULT_AGENT_BRIEF } from "@openwork/types/den/workbot-proactive"
import { bootDen, field, list, summary, text, type Den } from "./harness.js"

// Your agent's brief and rhythm (workbotAgentBrief, on top of workbotProactive): the admin's settings, carried over from
// the responsibilities until saved; each member's own lines and rhythm from chat (Connect) or the page, enforced on the
// server. Off, every route answers as before. No runner, Slack or Google is contacted.
const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://localhost:3020" } })
after(() => den.close())
const proactive = "/v1/org/workbot-settings/proactive"

async function workspace(name: string, brief: boolean) {
  const created = await den.createOrg(await den.signUp(`${name} Owner`), name)
  assert.equal((await den.setFeature(created.orgId, "workbotProactive", true)).status, 200)
  if (brief) assert.equal((await den.setFeature(created.orgId, "workbotAgentBrief", true)).status, 200)
  const owner = den.as(created.owner, created.orgId)
  assert.equal((await owner("PUT", proactive, { enabled: true })).status, 200)
  const member = await den.newMember(created.owner, created.orgId, `${name} member`)
  return { ...created, owner, member, call: den.as(member, created.orgId) }
}

async function mcp(target: Den, token: string, method: string, params: Record<string, unknown>) {
  const response = await target.request(token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method, params },
  })
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  return line ? JSON.parse(line.slice(5)) : response.body
}

test("off: today's settings and member view, and the brief's fields are refused", async () => {
  const space = await workspace("Brief off", false)
  const view = await space.owner("GET", proactive)
  assert.equal(view.status, 200, summary(view))
  assert.equal(field(view.body, "brief"), undefined)
  assert.equal(field(view.body, "settings", "brief"), undefined)
  const refused = await space.owner("PUT", proactive, { brief: { checkEveryHours: 3 } })
  assert.equal(refused.status, 400, summary(refused))
  const health = await space.owner("GET", `${proactive}/health`)
  assert.equal(field(health.body, "rhythm"), undefined)
  const mine = await space.call("GET", "/v1/me/agent")
  assert.equal(field(mine.body, "brief"), undefined)
  assert.equal(field(mine.body, "nextChecks"), undefined)
  assert.equal(list(field(mine.body, "responsibilities")).length, 4, "the four switches, as today")
  const rhythm = await space.call("PUT", "/v1/me/agent", { checkEveryHours: 3 })
  assert.deepEqual([rhythm.status, field(rhythm.body, "error")], [400, "brief_unavailable"])
  const lines = await space.call("PUT", "/v1/me/agent", { brief: { add: ["Also watch our Render bill."] } })
  assert.deepEqual([lines.status, field(lines.body, "error")], [400, "brief_unavailable"])
})

test("on: the admin's brief is carried over from the responsibilities and instructions until saved, then saved field by field", async () => {
  const space = await workspace("Brief admin", false)
  // Before the brief: meeting prep off, organization instructions, the old default limit.
  assert.equal((await space.owner("PUT", proactive, { responsibilities: { meeting_prep: false }, instructions: "Ignore build bot alerts." })).status, 200)
  assert.equal((await den.setFeature(space.orgId, "workbotAgentBrief", true)).status, 200)
  const carried = await space.owner("GET", proactive)
  assert.equal(carried.status, 200, summary(carried))
  assert.deepEqual(field(carried.body, "brief"), {
    checkEveryHours: 2,
    dailyCap: 4,
    extraChecksPerDay: 3,
    text: `${DEFAULT_AGENT_BRIEF}\n\nDon't send meeting prep.\n\nIgnore build bot alerts.`,
    defaultText: DEFAULT_AGENT_BRIEF,
    carriedOver: ["checkEveryHours", "dailyCap", "extraChecksPerDay", "text"],
  })

  const saved = await space.owner("PUT", proactive, { brief: { checkEveryHours: 3, dailyCap: 5, text: "Tell me about anything blocking a customer." } })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "brief", "carriedOver"), ["extraChecksPerDay"])
  assert.equal(field(saved.body, "brief", "text"), "Tell me about anything blocking a customer.")
  assert.equal(field(saved.body, "settings", "dailyCap"), 3, "today's limit is kept for the agent without the brief")
  assert.equal((await space.owner("PUT", proactive, { brief: { checkEveryHours: 5 } })).status, 400)
  assert.equal((await space.owner("PUT", proactive, { brief: { text: "x".repeat(2_001) } })).status, 400)
  const health = await space.owner("GET", `${proactive}/health`)
  assert.deepEqual(field(health.body, "rhythm"), { checks: 0, quiet: 0, sent: 0 })

  // A plain member never reads the organization's settings; their own view says what their agent follows.
  assert.equal((await space.call("GET", proactive)).status, 403)
  const mine = await space.call("GET", "/v1/me/agent")
  assert.equal(field(mine.body, "brief", "organization"), "Tell me about anything blocking a customer.")
  assert.deepEqual(field(mine.body, "responsibilities"), [])
  assert.deepEqual([field(mine.body, "limits", "checkEveryHours"), field(mine.body, "limits", "admin", "checkEveryHours"), field(mine.body, "limits", "dailyCap")], [3, 3, 5])
  const next = list(field(mine.body, "nextChecks"))
  assert.equal(next[0]?.kind, "scheduled")
})

test("chat and the page change the member's brief and rhythm; the server refuses more than the admin allows; undo reverts", async () => {
  const space = await workspace("Brief member", true)
  assert.equal((await space.owner("PUT", proactive, { brief: { checkEveryHours: 2 } })).status, 200)
  const token = await den.mintMcpToken(space.member, space.orgId)
  const instructions = text(field(await mcp(den, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "brief-api-test", version: "1" } }), "result", "instructions"), "initialize")
  assert.match(instructions, /lines added to their brief/, "chat knows how to change the brief")

  // "check every hour": more often than the admin's.
  const faster = await den.callMcpTool(token, "execute_capability", { name: "putMeAgent", body: { checkEveryHours: 1 } })
  assert.equal(faster.isError, true, faster.text)
  assert.match(faster.text, /check at most every 2 hours/)
  // "check every 3 hours" and "also watch our Render bill", in one message.
  const said = await den.callMcpTool(token, "execute_capability", { name: "putMeAgent", body: { checkEveryHours: 3, brief: { add: ["Also watch our Render bill."] } } })
  assert.equal(said.isError, false, said.text)
  assert.match(text(field(said.body, "saved", "reply"), "reply"), /Checks every 3 hours[\s\S]*Your brief: added “Also watch our Render bill\.”[\s\S]*Reply "undo" to revert\./)

  const page = await space.call("GET", "/v1/me/agent")
  assert.deepEqual(field(page.body, "brief", "lines"), "Also watch our Render bill.")
  assert.equal(field(page.body, "limits", "checkEveryHours"), 3)
  const changes = list(field(page.body, "changes"))
  assert.deepEqual(changes.map((entry) => [entry.field, entry.source]), [["brief", "chat"], ["checkEveryHours", "chat"]])

  // "never tell me about newsletters", then the page edits the whole text.
  const never = await space.call("PUT", "/v1/me/agent", { brief: { add: ["Never tell me about newsletters."] } })
  assert.equal(field(never.body, "brief", "lines"), "Also watch our Render bill.\nNever tell me about newsletters.")
  const missing = await space.call("PUT", "/v1/me/agent", { brief: { remove: ["calendar invites"] } })
  assert.deepEqual([missing.status, field(missing.body, "error")], [400, "brief_line_not_found"])
  const undone = await space.call("PUT", "/v1/me/agent", { undo: "last" })
  assert.equal(field(undone.body, "brief", "lines"), "Also watch our Render bill.")
  const set = await space.call("PUT", "/v1/me/agent", { brief: { set: "Only customer escalations." } })
  assert.equal(field(set.body, "brief", "lines"), "Only customer escalations.")

  // An admin who later slows everyone down wins over what the member saved.
  assert.equal((await space.owner("PUT", proactive, { brief: { checkEveryHours: 4 } })).status, 200)
  assert.equal(field((await space.call("GET", "/v1/me/agent")).body, "limits", "checkEveryHours"), 4)
})
