import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { AgentCheckRecord } from "../../src/workbot-proactive/checks.js"
import { bootDen, field, list, summary, text, type Den } from "./harness.js"

// My agent (workbotProactive): each member reads what their agent did and why, and changes it in their own words
// from chat (Connect) or the Library page. The server only lets them narrow the admin's limits. No runner, Slack or
// Google is contacted; check records are written the way the wake writes them.
const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://localhost:3020" } })
after(() => den.close())
const proactive = "/v1/org/workbot-settings/proactive"

async function workspace(name: string) {
  const created = await den.createOrg(await den.signUp(`${name} Owner`), name)
  assert.equal((await den.setFeature(created.orgId, "workbotProactive", true)).status, 200)
  const owner = den.as(created.owner, created.orgId)
  assert.equal((await owner("PUT", proactive, { enabled: true })).status, 200)
  const member = await den.newMember(created.owner, created.orgId, `${name} member`)
  return { ...created, owner, member, call: den.as(member, created.orgId) }
}

/** What Workbot's chat does after reading the member's message: one Connect capability call as the member. */
async function sayInChat(target: Den, token: string, name: string, body?: unknown) {
  const result = await target.callMcpTool(token, "execute_capability", { name, ...(body === undefined ? {} : { body }) })
  assert.equal(result.isError, false, `${name}: ${result.text.slice(0, 400)}`)
  return result.body
}

test("the parent rollout controls the whole agent: fields, checks and chat guidance", async () => {
  const space = await workspace("Agent parent rollout")
  const before = await space.call("GET", "/v1/me/agent")
  assert.equal(before.status, 200, summary(before))
  for (const key of ["lastCheck", "todayChecks", "preferences", "limits", "changes"]) assert.notEqual(field(before.body, key), undefined, key)
  assert.equal((await space.call("GET", "/v1/me/agent/checks")).status, 200)
  const token = await den.mintMcpToken(space.member, space.orgId)
  assert.match(await initializeInstructions(token), /putMeAgent/)

  assert.equal((await den.setFeature(space.orgId, "workbotProactive", false)).status, 200)
  const refusedRequests = await Promise.all([
    space.call("GET", "/v1/me/agent"),
    space.call("GET", "/v1/me/agent/checks"),
    space.call("PUT", "/v1/me/agent", { preferences: { when: "Mornings only" } }),
    space.call("PUT", "/v1/me/agent", { mute: ["calendar_changes"] }),
    space.call("PUT", "/v1/me/agent", { undo: "last" }),
  ])
  for (const refused of refusedRequests) {
    assert.equal(refused.status, 404, summary(refused))
    assert.equal(field(refused.body, "feature"), "workbotProactive")
  }
  assert.doesNotMatch(await initializeInstructions(token), /putMeAgent/)

  assert.equal((await den.setFeature(space.orgId, "workbotProactive", true)).status, 200)
  const restored = await space.call("PUT", "/v1/me/agent", { preferences: { when: "Mornings only" } })
  assert.equal(restored.status, 200, summary(restored))
  assert.equal(field(restored.body, "preferences", "when"), "Mornings only")
})

test("a member narrows the admin's limits but can't widen them; a later admin change still wins", async () => {
  const space = await workspace("Agent library limits")
  const wider = await space.call("PUT", "/v1/me/agent", { hours: { startHour: 7, endHour: 17 } })
  assert.equal(wider.status, 400, summary(wider))
  assert.deepEqual(wider.body, { error: "limit_wider_than_admin", message: "Your admin allows 8 AM–7 PM. Choose hours inside that." })
  const more = await space.call("PUT", "/v1/me/agent", { dailyCap: 5 })
  assert.equal(more.status, 400, summary(more))
  assert.equal(field(more.body, "error"), "limit_wider_than_admin")
  assert.equal((await space.call("PUT", "/v1/me/agent", { dailyCap: 11 })).status, 400, "outside any limit")

  const narrowed = await space.call("PUT", "/v1/me/agent", { hours: { startHour: 9, endHour: 17 }, dailyCap: 1 })
  assert.equal(narrowed.status, 200, summary(narrowed))
  assert.deepEqual(field(narrowed.body, "limits"), { workingDays: "weekdays", startHour: 9, endHour: 17, dailyCap: 1, quietWindow: null, admin: { startHour: 8, endHour: 19, dailyCap: 3 }, narrowed: { hours: true, dailyCap: true } })
  assert.deepEqual(field(narrowed.body, "saved", "changes"), ["Hours: 9 AM–5 PM", "Daily limit: 1 a day"])

  assert.equal((await space.owner("PUT", proactive, { startHour: 10, endHour: 16 })).status, 200)
  const later = await space.call("GET", "/v1/me/agent")
  assert.deepEqual([field(later.body, "limits", "startHour"), field(later.body, "limits", "endHour")], [10, 16], "the admin's narrower hours win over the member's")
  assert.equal(field((await space.owner("GET", "/v1/me/agent")).body, "limits", "narrowed", "hours"), false, "another member is untouched")
})

test("chat and the Library page change the same agent: each change says where it came from, and undo reverts it", async () => {
  const space = await workspace("Agent library chat")
  const token = await den.mintMcpToken(space.member, space.orgId)
  assert.match(await initializeInstructions(token), /To change what Your agent tells the user, use putMeAgent; to explain why it was quiet, read the user's agent checks\./)

  // "between 12 and 2 only urgent stuff, stop telling me about calendar changes"
  const said = await sayInChat(den, token, "putMeAgent", { preferences: { when: "Between 12 and 2, only urgent things" }, quietWindow: { startHour: 12, endHour: 14 }, mute: ["calendar_changes"] })
  const reply = text(field(said, "saved", "reply"), "the chat reply")
  assert.match(reply, /^Saved:\n- When: “Between 12 and 2, only urgent things”\n- Stopped: Calendar changes\n- Only urgent messages 12 PM–2 PM\nReply "undo" to revert\. My bot: http.+\/dashboard\/my-bot$/)
  assert.doesNotMatch(reply, /<|\[|button/i, "text only, no Slack buttons or markup")

  const page = await space.call("GET", "/v1/me/agent")
  assert.equal(field(page.body, "preferences", "when"), "Between 12 and 2, only urgent things", "the page shows what chat saved")
  assert.deepEqual(field(page.body, "limits", "quietWindow"), { startHour: 12, endHour: 14 })
  const changes = list(field(page.body, "changes"))
  assert.deepEqual(changes.map((entry) => [entry.field, entry.source, entry.undone]), [["quietWindow", "chat", false], ["calendar_changes", "chat", false], ["when", "chat", false]])
  const responsibility = list(field(page.body, "responsibilities")).find((entry) => entry.id === "calendar_changes")
  assert.equal(responsibility?.muted, true)

  const howOnPage = await space.call("PUT", "/v1/me/agent", { preferences: { how: "One line per item" } })
  assert.equal(howOnPage.status, 200, summary(howOnPage))
  assert.equal(field(list(field(howOnPage.body, "changes"))[0], "source"), "page", "a change from Den's page is saved as from the page")
  const seenInChat = await sayInChat(den, token, "getMeAgent")
  assert.equal(field(seenInChat, "preferences", "how"), "One line per item", "chat reads what the page saved")

  // Undo one change on the page: the quiet window from chat.
  const windowChange = changes.find((entry) => entry.field === "quietWindow")
  const pageUndo = await space.call("PUT", "/v1/me/agent", { undo: windowChange?.id })
  assert.equal(pageUndo.status, 200, summary(pageUndo))
  assert.equal(field(pageUndo.body, "limits", "quietWindow"), null)
  assert.equal((await space.call("PUT", "/v1/me/agent", { undo: windowChange?.id })).status, 409, "an undone change can't be undone twice")

  // "undo" in chat: the last save (the page's How), then the rest of the chat save.
  const firstUndo = await sayInChat(den, token, "putMeAgent", { undo: "last" })
  assert.equal(field(firstUndo, "preferences", "how"), "")
  assert.match(text(field(firstUndo, "saved", "reply"), "undo reply"), /^Undone\. Now:\n- How: cleared\nMy bot: /)
  const secondUndo = await sayInChat(den, token, "putMeAgent", { undo: "last" })
  assert.equal(field(secondUndo, "preferences", "when"), "")
  assert.equal(list(field(secondUndo, "responsibilities")).find((entry) => entry.id === "calendar_changes")?.muted, false)
  const nothing = await space.call("PUT", "/v1/me/agent", { undo: "last" })
  assert.equal(nothing.status, 409, summary(nothing))
  assert.equal(field(nothing.body, "error"), "nothing_to_undo")
  assert.equal((await space.call("PUT", "/v1/me/agent", { undo: "last", on: false })).status, 400, "undo on its own")
  assert.equal((await space.call("PUT", "/v1/me/agent", { preferences: { always: "x".repeat(401) } })).status, 400, "length-limited")
})

test("each member reads only their own checks: today's, the last one, and the week; old records are pruned", async () => {
  const space = await workspace("Agent library checks")
  const repository = await import("../../src/workbot-proactive/repository.js")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  const organizationId = normalizeDenTypeId("organization", space.orgId)
  const memberId = normalizeDenTypeId("member", space.member.memberId)
  const now = Date.now()
  const base: Pick<AgentCheckRecord, "organizationId" | "memberId" | "kind" | "responsibilities" | "sources" | "message"> = { organizationId, memberId, kind: "scheduled", responsibilities: [], sources: [], message: null }
  await repository.recordMemberCheck({ ...base, key: "old", at: now - 20 * 86_400_000, reason: "nothing_new", outcome: "quiet", summary: "Stayed quiet: nothing new." })
  await repository.recordMemberCheck({ ...base, key: "earlier", at: now - 3 * 86_400_000, reason: "google_disconnected", outcome: "failed", summary: "Couldn't read Gmail: reconnect Google." })
  await repository.recordMemberCheck({ ...base, key: "today", at: now - 1_000, reason: "sent", outcome: "sent", summary: "Sent you a message about waiting on you.", responsibilities: ["waiting_on_you"], message: { channelId: "D0DM", messageTs: "1.1", permalink: "https://example.slack.com/archives/D0DM/p11" } })

  const view = await space.call("GET", "/v1/me/agent")
  assert.equal(view.status, 200, summary(view))
  assert.equal(field(view.body, "lastCheck", "headline"), "Sent you a message about waiting on you")
  assert.equal(field(view.body, "lastCheck", "slackUrl"), "https://example.slack.com/archives/D0DM/p11")
  assert.deepEqual(list(field(view.body, "todayChecks")).map((entry) => entry.reason), ["sent"])
  assert.equal(field(view.body, "sentToday"), 0, "the count comes from the delivery ledger, not the records")
  const week = await space.call("GET", "/v1/me/agent/checks?days=7")
  assert.equal(week.status, 200, summary(week))
  assert.deepEqual(list(field(week.body, "checks")).map((entry) => [entry.outcome, entry.fix]), [["sent", null], ["failed", "reconnect_google"]])
  assert.equal((await space.call("GET", "/v1/me/agent/checks?days=30")).status, 400)

  assert.equal(field((await space.owner("GET", "/v1/me/agent")).body, "lastCheck"), null, "another member sees none of them")
  await repository.pruneMemberChecks(new Date(now - 14 * 86_400_000))
  assert.equal((await repository.readMemberChecks(memberId, new Date(0))).length, 2, "older than two weeks is gone")
})

/** The instructions OpenWork Connect gives a client at initialize, for this member. */
async function initializeInstructions(token: string) {
  const response = await den.request(token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "my-agent-api-test", version: "1" } } },
  })
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : response.body
  return text(field(envelope, "result", "instructions"), `initialize (${response.status})`)
}
