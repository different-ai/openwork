import assert from "node:assert/strict"
import { after, test } from "node:test"
import { DEFAULT_AGENT_BRIEF } from "@openwork/types/den/workbot-proactive"
import { bootDen, field, list, summary, text, type Den } from "./harness.js"

// Your agent's brief and rhythm (workbotAgentBrief, on top of workbotProactive): the admin's settings, carried over from
// the responsibilities until saved; each member's own lines and rhythm from chat (Connect) or the page, enforced on the
// server; request_check for the agent's own check token only. Off, every route answers as before. No runner, Slack or
// Google is contacted.
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

// Leave room for the duplicate (+5 minutes) and capped (+20 minutes) requests, all on the same working day.
function extraCheckTime(now: number): number {
  const hour = 3_600_000
  let first = Math.ceil(now / hour) * hour + hour / 2
  if (new Date(first).getUTCHours() % 2 === 0) first += hour
  if (new Date(first).getUTCHours() === 23) first += 2 * hour
  return first
}

test("request_check fixture stays inside member hours at every UTC minute, including rollover", () => {
  assert.equal(new Date(extraCheckTime(Date.parse("2026-11-04T22:47:00Z"))).toISOString(), "2026-11-05T01:30:00.000Z")
  for (const day of ["2026-11-04", "2026-12-31"]) {
    for (let minute = 0; minute < 24 * 60; minute++) {
      const now = Date.parse(`${day}T00:00:00Z`) + minute * 60_000
      const first = extraCheckTime(now)
      const capped = first + 20 * 60_000
      const label = new Date(now).toISOString()
      assert.ok(first >= now + 5 * 60_000 && capped <= now + 24 * 3_600_000, label)
      assert.equal(new Date(first).getUTCHours() % 2, 1, label)
      assert.equal(new Date(first).getUTCMinutes(), 30, label)
      assert.ok(new Date(capped).getUTCHours() < 23, label)
      assert.equal(new Date(first).toISOString().slice(0, 10), new Date(capped).toISOString().slice(0, 10), label)
    }
  }
})

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

test("request_check: only the agent's own check token sees it; capped, idempotent and shown in My bot", async () => {
  const space = await workspace("Brief requests", true)
  // Every day, all day for the organization; the member narrows this to midnight–11 PM (UTC), one extra check a day.
  assert.equal((await space.owner("PUT", proactive, { workingDays: "everyday", startHour: 0, endHour: 24, brief: { extraChecksPerDay: 1 } })).status, 200)
  // The member's agent row exists once they change anything.
  assert.equal((await space.call("PUT", "/v1/me/agent", { hours: { startHour: 0, endHour: 23 } })).status, 200)
  const { mintHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
  const { agentReadScopes } = await import("../../src/mcp/agent-read-sources.js")
  const userId = space.member.userId
  const check = (await mintHeadlessRunMcpToken({ userId, organizationId: space.orgId, readOnly: true, scopes: agentReadScopes({ kinds: ["email"], connectionIds: ["google-workspace"] }) })).token
  const messenger = (await mintHeadlessRunMcpToken({ userId, organizationId: space.orgId, readOnly: true, scopes: agentReadScopes({ kinds: [], connectionIds: [] }) })).token
  const chat = await den.mintMcpToken(space.member, space.orgId)
  const tools = async (token: string) => list(field(await mcp(den, token, "tools/list", {}), "result", "tools")).map((tool) => String(tool.name))
  assert.ok((await tools(check)).includes("request_check"))
  assert.ok(!(await tools(messenger)).includes("request_check"), "the messenger reads nothing and asks for nothing")
  assert.ok(!(await tools(chat)).includes("request_check"), "chat never sees it")

  // Half past an odd hour (UTC), before 11 PM: never right after a check on the 2-hour rhythm (0, 2, 4…).
  const first = extraCheckTime(Date.now())
  const atIso = new Date(first).toISOString().replace(/\.\d+Z$/, "Z")
  const set = await den.callMcpTool(check, "request_check", { at: atIso, why: "before the 2 PM with Northwind" })
  assert.equal(set.isError, false, set.text)
  assert.match(set.text, /^Extra check set for .+ \(1 of 1 that day\)\.$/)
  const again = await den.callMcpTool(check, "request_check", { at: new Date(first + 5 * 60_000).toISOString(), why: "same" })
  assert.match(again.text, /^Already set for /, "idempotent")
  // Another time the same day (20 minutes later: not the same request, and still not right after a check).
  const capped = await den.callMcpTool(check, "request_check", { at: new Date(first + 20 * 60_000).toISOString(), why: "another" })
  assert.equal(capped.isError, true)
  assert.match(capped.text, /No extra checks left for that day \(1 a day\)/)
  const bad = await den.callMcpTool(check, "request_check", { at: "after lunch", why: "x" })
  assert.equal(bad.isError, true)

  const mine = await space.call("GET", "/v1/me/agent")
  const requested = list(field(mine.body, "nextChecks")).find((entry) => entry.kind === "requested")
  assert.deepEqual([requested?.why, requested?.at], ["before the 2 PM with Northwind", new Date(Math.floor(first / 1000) * 1000).toISOString()])

  // The kill switch takes it away at once.
  assert.equal((await den.setFeature(space.orgId, "workbotAgentBrief", false)).status, 200)
  assert.ok(!(await tools(check)).includes("request_check"))
})
