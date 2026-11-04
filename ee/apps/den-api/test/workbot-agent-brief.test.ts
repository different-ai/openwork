import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, mock, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { AGENT_INSTRUCTIONS, agentLedgerKey, agentWakePrompt, parseAgentReply, parseAgentState, type AgentState } from "@openwork/automations/proactive"
import type { AgentCheckRequest, AgentConversationTurn } from "@openwork/automations/proactive-brief"
import {
  AGENT_BRIEF_OFF_LINES,
  AGENT_RESPONSIBILITIES,
  DEFAULT_AGENT_BRIEF,
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_WORKBOT_PROACTIVE_SETTINGS,
  EMPTY_AGENT_PREFERENCES,
  carriedOverAgentBrief,
  carriedOverMemberBrief,
  mergeWorkbotProactiveSettings,
  readWorkbotProactiveSettings,
  resolveAgentBrief,
  type AgentResponsibility,
  type AgentTemplateContent,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import type { AgentCheckRecord } from "../src/workbot-proactive/checks.js"
import type { AgentInstanceRow, AgentSettle } from "../src/workbot-proactive/repository.js"
import type { MemberConnection } from "../src/workbot-proactive/sources.js"
import type { AgentRawTurnResult } from "../src/workbot-proactive/turn.js"
import type { AgentBriefWakeDeps } from "../src/workbot-proactive/wake-brief.js"

// No database, runner, Google, Slack or Connect is contacted: every boundary is injected or faked below.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/workbot_agent_brief_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-workbot-agent-brief-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-workbot-agent-brief-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
const bootstrapSelect = mock.method(db.$primary, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { wakeAgentBrief, AGENT_MESSAGE_SCOPES } = await import("../src/workbot-proactive/wake-brief.js")
const { wakeMemberAgent } = await import("../src/workbot-proactive/worker.js")
const { agentSessionId, agentMessageSessionId } = await import("../src/workbot-proactive/turn.js")
const preferences = await import("../src/workbot-proactive/preferences.js")
const { memberNextChecks, memberRhythm, memberBriefLines } = await import("../src/workbot-proactive/brief.js")
const { agentCheckRequestsAvailable, describeCheckRequest } = await import("../src/mcp/agent-check-request.js")
const { agentReadAllowlist, agentReadScopes } = await import("../src/mcp/agent-read-sources.js")
const { createAgentMcpServer, MY_AGENT_BRIEF_INSTRUCTIONS, MY_AGENT_INSTRUCTIONS } = await import("../src/mcp/agent-server.js")

const TZ = "America/New_York"
const at = (local: string) => Date.parse(`${local}-04:00`)
// Tuesday 2026-10-20, 8:00 AM in New York: the first check of the day.
const MORNING = at("2026-10-20T08:00:00")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const settingsOn: WorkbotProactiveSettings = { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true }
const GOOGLE: MemberConnection = { id: "google-workspace", name: "Google Workspace", url: "https://google.com", native: "google-workspace", state: "connected" }
const SLACK: MemberConnection = { id: "emc_01k8z5wq0s0000000000000001", name: "Slack", url: "https://mcp.slack.com/mcp", native: null, state: "connected" }
const SLACK_ASK = "https://acme.slack.com/archives/C0NORTH/p1792502520000100"

function agentRow(overrides: Partial<AgentInstanceRow> = {}): AgentInstanceRow {
  return {
    memberId, organizationId, templateVersionId: null, status: null, overrides: null, snoozedUntil: null, state: null, timeZone: TZ,
    nextWakeAt: new Date(MORNING), failures: 0, leaseOwner: "lease-1", leaseUntil: new Date(MORNING + 600_000), createdAt: new Date(MORNING),
    updatedAt: new Date(MORNING), preferences: null, ...overrides,
  }
}

const findings = (...lines: string[]) => lines.join("\n\n")
const messages = (...entries: { text: string; about: string[]; update?: boolean }[]) => JSON.stringify({ messages: entries })
const answered = (text: string): AgentRawTurnResult => ({ kind: "answered", text, usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 90 } })

type Harness = {
  clock: number
  row: AgentInstanceRow
  checks: { instructions: string; prompt: string; scopes: readonly string[]; sessionId: string }[]
  messageTurns: { prompt: string; instructions: string; sessionId: string }[]
  ended: string[]
  delivered: string[]
  ledger: Map<string, string>
  records: AgentCheckRecord[]
  counters: { responsibility: string; checks: number; quiet: number; sent: number }[]
  settles: AgentSettle[]
  requests: AgentCheckRequest[]
  briefOn: boolean[]
}

function harness(input: {
  settings?: Partial<WorkbotProactiveSettings>
  template?: AgentTemplateContent
  row?: Partial<AgentInstanceRow>
  checks?: (string | AgentRawTurnResult)[]
  replies?: (string | AgentRawTurnResult)[]
  sentToday?: number
  conversation?: AgentConversationTurn[] | null
  requestsDuringTurn?: AgentCheckRequest[]
  briefOn?: boolean[]
}) {
  const h: Harness = { clock: MORNING, row: agentRow(input.row), checks: [], messageTurns: [], ended: [], delivered: [], ledger: new Map(), records: [], counters: [], settles: [], requests: [], briefOn: input.briefOn ?? [] }
  const checks = [...(input.checks ?? ["NO_FINDINGS"])]
  const replies = [...(input.replies ?? ["NO_REPLY"])]
  let briefCalls = 0
  const deps: AgentBriefWakeDeps = {
    now: () => h.clock,
    allowed: async () => true,
    settings: async () => ({ ...settingsOn, ...input.settings }),
    template: async () => ({ ...(input.template ?? DEFAULT_AGENT_TEMPLATE), versionId: null, version: 1 }),
    user: async () => userId,
    calendar: async () => ({ kind: "ok", json: { timeZone: TZ, items: [] } }),
    model: async () => "openai/gpt-6-luna",
    turn: async () => parseAgentReply("NO_REPLY"),
    connections: async () => [GOOGLE, SLACK],
    connectLink: (connectionId) => `https://den.example/dashboard/library/connectors/${connectionId}`,
    sessionId: agentSessionId,
    messageId: (member, wakeAt) => `wa_${member}_${wakeAt}`,
    told: async (_member, items) => new Set(items.map(agentLedgerKey).filter((key) => h.ledger.has(key))),
    reserve: async (entry) => {
      const key = agentLedgerKey(entry.item)
      if (h.ledger.has(key)) return null
      h.ledger.set(key, entry.outcome ?? "pending")
      return key
    },
    finish: async (id, outcome) => {
      h.ledger.set(id, outcome)
    },
    sentSince: async () => (input.sentToday ?? 0) + [...h.ledger.values()].filter((outcome) => outcome === "sent").length,
    holdsLease: async () => true,
    settle: async (_row, changes) => {
      h.settles.push(changes)
      h.row = { ...h.row, ...changes, leaseOwner: "lease-1" }
      return true
    },
    destinationBlock: async () => null,
    deliver: async (call) => {
      h.delivered.push(call.text)
      return { ok: true, message: { channelId: "D0DM", messageTs: `1700000000.000${h.delivered.length}`, permalink: `https://acme.slack.com/archives/D0DM/p${h.delivered.length}` } }
    },
    recordChecks: async (call) => {
      h.counters.push(...call.counts)
    },
    recordCheck: async (record) => {
      const index = h.records.findIndex((entry) => entry.key === record.key)
      if (index >= 0) h.records[index] = record
      else h.records.push(record)
    },
    briefOn: async () => h.briefOn[briefCalls++] ?? true,
    person: async () => "Sam",
    check: async (call) => {
      h.checks.push({ instructions: call.instructions, prompt: call.prompt, scopes: call.scopes, sessionId: call.sessionId })
      for (const request of input.requestsDuringTurn ?? []) h.requests.push(request)
      const answer = checks.shift() ?? "NO_FINDINGS"
      return typeof answer === "string" ? answered(answer) : answer
    },
    message: async (call) => {
      h.messageTurns.push({ prompt: call.prompt, instructions: call.instructions, sessionId: call.sessionId })
      const answer = replies.shift() ?? "NO_REPLY"
      return typeof answer === "string" ? answered(answer) : answer
    },
    messageSessionId: agentMessageSessionId,
    endMessageSession: async (sessionId) => {
      h.ended.push(sessionId)
    },
    conversation: async () => (input.conversation === undefined ? [] : input.conversation),
    requestedChecks: async () => [...(parseAgentState(h.row.state).requests ?? []), ...h.requests],
  }
  return { h, deps, run: () => wakeAgentBrief(h.row, deps) }
}

const state = (h: Harness): AgentState => parseAgentState(h.row.state)

describe("Your agent's brief: a check, then maybe a message (workbotAgentBrief)", () => {
  test("NO_FINDINGS ends the check without a message turn; the first check of the day; next slot on the rhythm", async () => {
    const { h, run } = harness({})
    assert.deepEqual(await run(), { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null })
    assert.equal(h.checks.length, 1)
    assert.equal(h.messageTurns.length, 0, "no step 2")
    assert.equal(h.checks[0]?.sessionId, agentSessionId(organizationId, memberId), "the agent's own session, as today")
    assert.match(h.checks[0]?.prompt ?? "", /^\[check\] Scheduled check, the first of the day\. It is Tue, Oct 20, 8:00 AM \(America\/New_York\)\./)
    assert.match(h.checks[0]?.prompt ?? "", /Your next scheduled check: today at 10:00 AM\. Extra checks you can still ask for today: 3\./)
    assert.match(h.checks[0]?.instructions ?? "", /^You are Sam's agent in OpenWork, running a scheduled check in the background\./)
    assert.match(h.checks[0]?.instructions ?? "", /Sam's brief:\n"""\nTell me about things that need me soon:/)
    assert.deepEqual(agentReadAllowlist(new Set(h.checks[0]?.scopes ?? []))?.kinds, new Set(["calendar", "email", "chat"]), "the read allowlist, as today")
    assert.deepEqual(h.records.map((record) => [record.kind, record.reason, record.outcome, record.summary]), [["morning", "no_findings", "quiet", "Stayed quiet: nothing needed you."]])
    assert.deepEqual(h.counters, [{ responsibility: "rhythm", checks: 1, quiet: 1, sent: 0 }])
    assert.equal(state(h).lastPassAt, MORNING)
    assert.equal(h.row.nextWakeAt.getTime(), at("2026-10-20T10:00:00"))
  })

  test("a P0 finding: one message, cleaned and sent as a Workbot DM; the check records it with its source", async () => {
    const reply = messages({ text: `Before your 11 AM with Northwind: Dana asked for pricing on 60 seats and is waiting. @channel I checked your sent mail. <${SLACK_ASK}|Slack message> <https://evil.example/x|click>`, about: [`slack:${SLACK_ASK}`] })
    const { h, run } = harness({ checks: [findings(`P0 — Dana (northwind.example) asked in Slack for pricing before the 11 AM call. ${SLACK_ASK} ids: chat:${SLACK_ASK}`)], replies: [reply] })
    assert.deepEqual(await run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "sent" })
    assert.equal(h.delivered.length, 1)
    assert.doesNotMatch(h.delivered[0] ?? "", /@channel|evil\.example/, "mentions neutralized, outside links dropped")
    assert.match(h.delivered[0] ?? "", new RegExp(`<${SLACK_ASK}\\|Slack message>`))
    assert.equal(h.ledger.get(`chat:${SLACK_ASK}`), "sent", "\"slack\" is the chat source it read")
    assert.deepEqual(h.records.map((record) => [record.reason, record.summary, record.sources.map((source) => source.name)]), [["sent", "Sent you a message from Slack.", ["Slack"]]])
    assert.deepEqual(h.counters, [{ responsibility: "rhythm", checks: 1, quiet: 0, sent: 1 }])
    assert.deepEqual(h.ended, [agentMessageSessionId(organizationId, memberId, MORNING)], "the messenger's fresh session is deleted")
    assert.match(h.messageTurns[0]?.instructions ?? "", /You have no tools in this step/)
  })

  test("step 2 gets what it decides with: first check, sent today of the limit, the next check, the conversation and the report", async () => {
    const conversation: AgentConversationTurn[] = [{ at: at("2026-10-19T15:00:00"), from: "member", text: "I'll handle the Northwind pricing after lunch" }]
    const { h, run } = harness({ checks: ["P1 — the invoice from Fabrikam is due Friday."], replies: ["NO_REPLY"], sentToday: 1, conversation })
    await run()
    const prompt = h.messageTurns[0]?.prompt ?? ""
    assert.match(prompt, /what you already sent today \(1 of 4\), the local time \(Tue, Oct 20, 8:00 AM\), when the next check runs \(today at 10:00 AM\) and whether this is the first check of the day \(yes\)\./)
    assert.match(prompt, /\[Mon 3:00 PM\] Sam: I'll handle the Northwind pricing after lunch/)
    assert.match(prompt, /Findings:\n"""\nP1 — the invoice from Fabrikam is due Friday\.\n"""$/)
    assert.deepEqual(h.records.map((record) => record.reason), ["findings_held"], "NO_REPLY: found something that can wait")
    assert.equal(h.delivered.length, 0)
  })

  test("a finding the messenger held is handed to the next check, so it isn't lost", async () => {
    const { h, run } = harness({ checks: ["P1 — the deck for Northwind is due today.", "NO_FINDINGS"], replies: ["NO_REPLY"] })
    await run()
    assert.deepEqual(state(h).lastReport, { at: MORNING, text: "P1 — the deck for Northwind is due today." })
    h.clock = at("2026-10-20T10:00:00")
    await run()
    assert.match(h.checks[1]?.prompt ?? "", /Your last report to the messenger \(today at 8:00 AM\)[^\n]*\n"""\nP1 — the deck for Northwind is due today\.\n"""/)
    assert.equal(state(h).lastReport?.at, MORNING, "a quiet check keeps it")
  })

  test("today's limit reached: no message turn at all, and the check says so", async () => {
    const { h, run } = harness({ checks: ["P0 — the build is broken."], sentToday: 4 })
    assert.equal((await run()).status, "ran")
    assert.equal(h.messageTurns.length, 0)
    assert.deepEqual(h.records.map((record) => [record.reason, record.summary]), [["daily_limit", "Stayed quiet: daily limit reached (4 a day)."]])
  })

  test("a malformed answer is retried once; a second malformed one is dropped and nothing is sent", async () => {
    const good = messages({ text: "Still unresolved: the exposed key. <https://acme.slack.com/archives/C9/p9|Slack message>", about: ["chat:https://acme.slack.com/archives/C9/p9"] })
    const retried = harness({ checks: ["P0 — key exposed."], replies: ["Here is my message: it's important", good] })
    await retried.run()
    assert.equal(retried.h.messageTurns.length, 2)
    assert.match(retried.h.messageTurns[1]?.prompt ?? "", /^That answer wasn't in the required shape \(no JSON object\)\. Answer again with only the JSON object, or exactly NO_REPLY\./)
    assert.equal(retried.h.messageTurns[0]?.sessionId, retried.h.messageTurns[1]?.sessionId, "the retry sees its first answer")
    assert.equal(retried.h.delivered.length, 1)
    const dropped = harness({ checks: ["P0 — key exposed."], replies: ['{"message": "old shape"}', '{"messages": [{"text": "x"}]}'] })
    await dropped.run()
    assert.equal(dropped.h.messageTurns.length, 2, "once, never twice")
    assert.equal(dropped.h.delivered.length, 0)
    assert.deepEqual(dropped.h.records.map((record) => record.reason), ["unreadable_reply"])
    assert.equal(dropped.h.ended.length, 1)
  })

  test("told once per item; update: true passes exactly once a day; a new reply's id is new", async () => {
    const about = ["chat:https://acme.slack.com/archives/C9/p9"]
    const { h, run } = harness({
      checks: ["P0 — key exposed.", "P0 — still exposed.", "P0 — still exposed.", "P0 — Lee replied."],
      replies: [
        messages({ text: "A security check: an API key is exposed.", about }),
        messages({ text: "The key is still exposed.", about }),
        messages({ text: "Still unresolved: the key.", about, update: true }),
        messages({ text: "Lee answered about the key.", about: [...about, "chat:https://acme.slack.com/archives/C9/p10"] }),
      ],
    })
    await run()
    h.clock = at("2026-10-20T10:00:00")
    assert.equal((await run()).delivered, "nothing_new", "the same item without update: told once")
    h.clock = at("2026-10-20T12:00:00")
    assert.equal((await run()).delivered, "sent", "update: true gets past told-once")
    h.clock = at("2026-10-20T14:00:00")
    assert.equal((await run()).delivered, "sent", "a new id (the new reply) is new")
    assert.deepEqual(h.delivered, ["A security check: an API key is exposed.", "Still unresolved: the key.", "Lee answered about the key."])
    assert.deepEqual(h.records.map((record) => record.reason), ["sent", "already_told", "sent", "sent"])
    assert.equal([...h.ledger.keys()].filter((key) => key.startsWith("update:")).length, 1)
  })

  test("the first check may send a few, most important first; Den stops at today's limit and keeps the order", async () => {
    const { h, run } = harness({
      checks: ["P0 — a. P1 — b. P1 — c."],
      sentToday: 2,
      replies: [messages({ text: "First: a.", about: ["email:a"] }, { text: "Second: b.", about: ["email:b"] }, { text: "Third: c.", about: ["email:c"] })],
    })
    assert.equal((await run()).delivered, "sent")
    assert.deepEqual(h.delivered, ["First: a.", "Second: b."])
    assert.deepEqual(h.records.map((record) => record.summary), ["Sent you 2 messages from Gmail."])
    assert.equal(h.ledger.has("email:c"), false, "past the limit nothing is recorded: tomorrow's first check can raise it")
  })

  test("the next check is told what reached the member; a message naming only sources it didn't read is nothing it could send", async () => {
    const { h, run } = harness({ checks: ["P0 — SOW due at noon. ids: email:thr_sow", "NO_FINDINGS"], replies: [messages({ text: "The SOW is due by noon. I checked your sent mail. <https://mail.google.com/x|Email thread>", about: ["email:thr_sow"] })] })
    await run()
    assert.deepEqual(state(h).sent, [{ at: MORNING, about: ["email:thr_sow"], lead: "The SOW is due by noon." }])
    h.clock = at("2026-10-20T10:00:00")
    await run()
    assert.match(h.checks[1]?.prompt ?? "", /What you sent since yesterday \(OpenWork's record of what reached them\):\n- Tue 8:00 AM \[email:thr_sow\] The SOW is due by noon\./)
    const unknown = harness({ checks: ["P0 — x."], replies: [messages({ text: "x", about: ["monitoring alert:thr_errors"] })] })
    await unknown.run()
    assert.deepEqual(unknown.h.records.map((record) => record.reason), ["unreadable_reply"])
    assert.equal(unknown.h.delivered.length, 0)
  })

  test("a kill switch between writing and sending wins", async () => {
    const { h, run } = harness({ checks: ["P0 — x."], replies: [messages({ text: "x", about: ["email:t1"] })], briefOn: [false] })
    await run()
    assert.equal(h.delivered.length, 0)
    assert.equal(h.ledger.get("email:t1"), "failed")
    assert.deepEqual(h.records, [], "losing the feature isn't the member's failure to read about")
  })

  test("no calendar wakes: between slots nothing runs, whatever the calendar does; the next wake is the next slot", async () => {
    const { h, run } = harness({})
    await run()
    h.clock = at("2026-10-20T10:05:00")
    h.row = { ...h.row, state: JSON.stringify({ ...state(h), lastPassAt: at("2026-10-20T10:00:00") }) }
    assert.deepEqual(await run(), { status: "skipped", reason: "nothing_due" })
    assert.equal(h.row.nextWakeAt.getTime(), at("2026-10-20T12:00:00"))
    assert.equal(h.checks.length, 1)
  })

  test("request_check: a request made during the check sets the next wake, runs as an extra check with its why, then is done", async () => {
    const request: AgentCheckRequest = { at: at("2026-10-20T08:45:00"), why: "before your 9 AM with Northwind", requestedAt: MORNING }
    const { h, run, deps } = harness({ requestsDuringTurn: [request] })
    await run()
    assert.equal(h.row.nextWakeAt.getTime(), request.at, "sooner than the 10 AM slot")
    assert.deepEqual(state(h).requests, [request])
    const extra = harness({ row: h.row })
    extra.h.clock = request.at
    await extra.run()
    assert.match(extra.h.checks[0]?.prompt ?? "", /^\[check\] The extra check you asked for at 8:45 AM: before your 9 AM with Northwind\./)
    assert.match(extra.h.checks[0]?.prompt ?? "", /Extra checks you can still ask for today: 2\./)
    assert.deepEqual(extra.h.records.map((record) => record.kind), ["requested"])
    assert.deepEqual(state(extra.h).requests?.map((entry) => entry.done), [true])
    assert.equal(extra.h.row.nextWakeAt.getTime(), at("2026-10-20T10:00:00"))
    assert.equal(typeof deps.requestedChecks, "function")
  })

  test("outside hours and in quiet hours nothing runs; quiet hours are recorded as such", async () => {
    const night = harness({ row: { nextWakeAt: new Date(at("2026-10-20T20:00:00")) } })
    night.h.clock = at("2026-10-20T20:00:00")
    assert.deepEqual(await night.run(), { status: "skipped", reason: "outside_hours" })
    assert.equal(night.h.row.nextWakeAt.getTime(), at("2026-10-21T08:00:00"))
    const quiet = harness({ row: { overrides: { quietWindow: { startHour: 12, endHour: 14 } } } })
    quiet.h.clock = at("2026-10-20T12:30:00")
    assert.deepEqual(await quiet.run(), { status: "skipped", reason: "outside_hours" })
    assert.deepEqual(quiet.h.records.map((record) => record.reason), ["quiet_window"])
    assert.equal(quiet.h.row.nextWakeAt.getTime(), at("2026-10-20T14:00:00"))
    assert.equal(quiet.h.checks.length + night.h.checks.length, 0)
  })

  test("the member's own lines reach the check after the organization's, and their earlier mutes are carried over", async () => {
    const carried = harness({ row: { overrides: { muted: ["meeting_prep"] }, preferences: JSON.stringify({ v: 1, words: { ...EMPTY_AGENT_PREFERENCES, never: "newsletters" }, sources: {}, log: [] }) } })
    await carried.run()
    assert.match(carried.h.checks[0]?.instructions ?? "", /Sam's own lines:\nDon't send meeting prep\.\nNever tell me about: newsletters\n"""$/)
    const written = harness({ row: { preferences: JSON.stringify({ v: 1, words: EMPTY_AGENT_PREFERENCES, sources: {}, log: [], brief: "Also watch our Render bill." }) } })
    await written.run()
    assert.match(written.h.checks[0]?.instructions ?? "", /Sam's own lines:\nAlso watch our Render bill\.\n"""$/)
  })

  test("with the feature off for the member, today's agent wakes, unchanged", async () => {
    const legacyTurns: string[] = []
    const { deps } = harness({})
    const outcome = await wakeMemberAgent(agentRow(), { ...deps, briefOn: async () => false, turn: async (call) => { legacyTurns.push(call.instructions, call.prompt); return parseAgentReply("NO_REPLY") } })
    assert.equal(outcome.status, "ran")
    assert.equal(legacyTurns[0], AGENT_INSTRUCTIONS)
    assert.match(legacyTurns[1] ?? "", /^\[wake\] Scheduled check: the morning pass\./)
  })

  test("the messenger's token reads nothing; the check's token carries its sources", () => {
    const messenger = agentReadAllowlist(new Set(AGENT_MESSAGE_SCOPES))
    assert.deepEqual([messenger?.kinds.size, messenger?.connectionIds.size], [0, 0])
  })
})

describe("today's prompts, byte for byte (the feature off)", () => {
  // Hashes of origin/dev's AGENT_INSTRUCTIONS and of agentWakePrompt for one fixed input, taken before this change.
  const sha = (text: string) => createHash("sha256").update(text).digest("hex")
  test("the session instructions and the wake prompt are exactly what dev sends", () => {
    assert.equal(sha(AGENT_INSTRUCTIONS), "d4777650735210e39279f1d72f8899c46f4fae1e127cc4389e786dfe0522c450")
    const prompt = agentWakePrompt({
      reasons: [{ kind: "scheduled", morning: true }],
      sources: [{ id: "calendar", name: "Calendar", via: ["Google Calendar"], instruction: "", lastReadAt: null }, { id: "email", name: "Email", via: ["Gmail"], instruction: "Skip receipts.", lastReadAt: Date.parse("2026-10-20T12:05:00Z") }],
      responsibilities: [...AGENT_RESPONSIBILITIES],
      instructions: "Ignore newsletters.",
      now: Date.parse("2026-10-20T13:40:00Z"),
      timeZone: TZ,
      wishes: { preferences: { always: "finance", never: "", when: "", how: "" }, quietWindow: { startHour: 12, endHour: 14 } },
    })
    assert.equal(sha(prompt), "97295156731c4ac75f468a6a1e39467164c3204a804f4a2e1fbe5c75fa61b626")
  })
})

describe("carrying the earlier settings over to the brief", () => {
  const combos = <T extends string>(values: readonly T[]): T[][] => values.reduce<T[][]>((all, value) => [...all, ...all.map((set) => [...set, value])], [[]])

  test("every combination of the four responsibilities and instructions: the default brief, a line per one turned off, then the instructions", () => {
    for (const off of combos(AGENT_RESPONSIBILITIES)) {
      for (const instructions of ["", "Ignore automated alerts from the build bot."]) {
        const template: AgentTemplateContent = { responsibilities: { morning_brief: !off.includes("morning_brief"), meeting_prep: !off.includes("meeting_prep"), calendar_changes: !off.includes("calendar_changes"), waiting_on_you: !off.includes("waiting_on_you") }, instructions }
        const text = carriedOverAgentBrief(template)
        assert.ok(text.startsWith(DEFAULT_AGENT_BRIEF), "the default brief first")
        const lines = AGENT_RESPONSIBILITIES.filter((responsibility) => off.includes(responsibility)).map((responsibility) => AGENT_BRIEF_OFF_LINES[responsibility])
        const expected = [DEFAULT_AGENT_BRIEF, lines.join("\n"), instructions].filter(Boolean).join("\n\n")
        assert.equal(text, expected, `off: ${off.join(",") || "none"}; instructions: ${instructions ? "yes" : "no"}`)
        assert.equal(resolveAgentBrief({ dailyCap: 3 }, template).text, expected)
      }
    }
    assert.equal(carriedOverAgentBrief(DEFAULT_AGENT_TEMPLATE), DEFAULT_AGENT_BRIEF, "an untouched template is exactly the default")
    assert.equal(AGENT_BRIEF_OFF_LINES.meeting_prep, "Don't send meeting prep.")
  })

  test("every combination of a member's mutes, with and without their words: a line per mute, then their words, labeled", () => {
    for (const muted of combos<AgentResponsibility>(AGENT_RESPONSIBILITIES)) {
      for (const words of [EMPTY_AGENT_PREFERENCES, { always: "anything from finance", never: "newsletters", when: "between 12 and 2 only urgent things", how: "short" }]) {
        const lines = carriedOverMemberBrief({ muted, words }).split("\n").filter(Boolean)
        const expectedMutes = AGENT_RESPONSIBILITIES.filter((responsibility) => muted.includes(responsibility)).map((responsibility) => AGENT_BRIEF_OFF_LINES[responsibility])
        const expectedWords = words.always ? ["Always tell me about: anything from finance", "Never tell me about: newsletters", "When: between 12 and 2 only urgent things", "How: short"] : []
        assert.deepEqual(lines, [...expectedMutes, ...expectedWords])
      }
    }
  })

  test("the daily limit: the old default 3 becomes the new 4; one an admin chose is kept; saved fields win; carriedOver says which", () => {
    assert.deepEqual(resolveAgentBrief({ dailyCap: 3 }, DEFAULT_AGENT_TEMPLATE), { checkEveryHours: 2, dailyCap: 4, extraChecksPerDay: 3, text: DEFAULT_AGENT_BRIEF, carriedOver: ["checkEveryHours", "dailyCap", "extraChecksPerDay", "text"] })
    assert.equal(resolveAgentBrief({ dailyCap: 2 }, DEFAULT_AGENT_TEMPLATE).dailyCap, 2)
    assert.equal(resolveAgentBrief({ dailyCap: 10 }, DEFAULT_AGENT_TEMPLATE).dailyCap, 10)
    const saved = resolveAgentBrief({ dailyCap: 3, brief: { checkEveryHours: 3, text: "Only P0." } }, DEFAULT_AGENT_TEMPLATE)
    assert.deepEqual([saved.checkEveryHours, saved.text, saved.carriedOver], [3, "Only P0.", ["dailyCap", "extraChecksPerDay"]])
  })

  test("stored field by field, kept by today's saves, and merged by the brief's", () => {
    const metadata = { workbot: { proactive: { ...settingsOn, brief: { checkEveryHours: 3, dailyCap: 99, text: "Hi" } } } }
    const read = readWorkbotProactiveSettings(metadata)
    assert.deepEqual(read.brief, { checkEveryHours: 3, text: "Hi" }, "an unreadable field is simply not saved")
    const legacySave = mergeWorkbotProactiveSettings(read, { leadMinutes: 30 })
    assert.deepEqual(legacySave?.brief, { checkEveryHours: 3, text: "Hi" }, "today's settings page never drops the brief")
    const briefSave = mergeWorkbotProactiveSettings(read, { brief: { dailyCap: 5 } })
    assert.deepEqual(briefSave?.brief, { checkEveryHours: 3, text: "Hi", dailyCap: 5 })
    assert.equal(readWorkbotProactiveSettings({}).brief, undefined)
  })
})

describe("a member's brief, rhythm and limits", () => {
  const brief = { checkEveryHours: 2 as const, dailyCap: 4, extraChecksPerDay: 3, text: DEFAULT_AGENT_BRIEF }
  const stored = preferences.emptyStoredPreferences()
  const change = (request: Parameters<typeof preferences.applyMemberAgentChange>[0]["request"], extra: Partial<Parameters<typeof preferences.applyMemberAgentChange>[0]> = {}) => {
    let id = 0
    return preferences.applyMemberAgentChange({ request, overrides: null, stored, settings: settingsOn, source: "chat", now: MORNING, newId: () => `chg_${++id}`, brief: { policy: brief, carried: "" }, ...extra })
  }

  test("\"check every 3 hours\" is saved; more often than the admin's is refused on the server; the admin's own goes back to theirs", () => {
    const slower = change({ checkEveryHours: 3 })
    assert.ok(slower.ok)
    assert.deepEqual([slower.ok && slower.overrides.checkEveryHours, slower.ok && slower.lines, slower.ok && slower.wake], [3, ["Checks every 3 hours"], true])
    const faster = change({ checkEveryHours: 1 })
    assert.deepEqual(faster, { ok: false, status: 400, error: "limit_wider_than_admin", message: "Your admin's agents check at most every 2 hours. Choose 2, 3, 4 hours." })
    const same = change({ checkEveryHours: 2 })
    assert.ok(same.ok && same.overrides.checkEveryHours === undefined && same.lines.length === 0)
    const more = change({ dailyCap: 5 })
    assert.equal(!more.ok && more.error, "limit_wider_than_admin", "the brief's limit is the one a member narrows")
  })

  test("\"also watch our Render bill\" and \"never tell me about newsletters\" add lines; remove matches without case; undo restores the text", () => {
    const added = change({ brief: { add: ["Also watch our Render bill.", "Never tell me about newsletters."] } })
    assert.ok(added.ok)
    if (!added.ok) return
    assert.equal(added.stored.brief, "Also watch our Render bill.\nNever tell me about newsletters.")
    assert.deepEqual(added.lines, ["Your brief: added “Also watch our Render bill.”", "Your brief: added “Never tell me about newsletters.”"])
    const removed = change({ brief: { remove: ["render bill"] } }, { stored: added.stored })
    assert.ok(removed.ok && removed.stored.brief === "Never tell me about newsletters.")
    const missing = change({ brief: { remove: ["calendar"] } }, { stored: added.stored })
    assert.equal(!missing.ok && missing.error, "brief_line_not_found")
    const undone = change({ undo: "last" }, { stored: removed.ok ? removed.stored : stored })
    assert.ok(undone.ok && undone.stored.brief === "Also watch our Render bill.\nNever tell me about newsletters." && undone.undid)
    const tooLong = change({ brief: { set: "x".repeat(999) } }, { stored: added.stored })
    assert.ok(tooLong.ok, "set replaces")
    const overflow = change({ brief: { add: ["y".repeat(300)] } }, { stored: tooLong.ok ? tooLong.stored : stored })
    assert.equal(!overflow.ok && overflow.error, "brief_too_long")
  })

  test("a first edit starts from the carried-over lines; undo goes back to carrying them over", () => {
    const first = change({ brief: { add: ["Also watch our Render bill."] } }, { brief: { policy: brief, carried: "Don't send meeting prep." } })
    assert.ok(first.ok && first.stored.brief === "Don't send meeting prep.\nAlso watch our Render bill.")
    const back = change({ undo: "last" }, { stored: first.ok ? first.stored : stored })
    assert.ok(back.ok && back.stored.brief === undefined)
    assert.deepEqual(memberBriefLines(back.ok ? back.stored : stored, { muted: ["meeting_prep"] }), { lines: "Don't send meeting prep.", carriedOver: true })
  })

  test("with the feature off, brief and rhythm changes are refused and nothing else changes", () => {
    const off = change({ brief: { add: ["x"] } }, { brief: null })
    assert.deepEqual(off, { ok: false, status: 400, error: "brief_unavailable", message: "Your agent's brief and check rhythm aren't on for your organization yet." })
    assert.equal(!change({ checkEveryHours: 3 }, { brief: null }).ok, true)
  })

  test("limits: the brief's daily limit and rhythm, never more often than the admin's; quiet hours carry over", () => {
    const limits = preferences.memberLimits(settingsOn, { checkEveryHours: 1, quietWindow: { startHour: 12, endHour: 13 } }, brief)
    assert.deepEqual([limits.dailyCap, limits.checkEveryHours, limits.admin.checkEveryHours, limits.extraChecksPerDay, limits.narrowed.checkEveryHours], [4, 2, 2, 3, false])
    const legacy = preferences.memberLimits(settingsOn, null)
    assert.deepEqual([legacy.dailyCap, legacy.checkEveryHours], [3, undefined], "today's limits without the brief")
    const rhythm = memberRhythm(preferences.memberLimits(settingsOn, { checkEveryHours: 4 }, brief), brief)
    assert.equal(rhythm.everyHours, 4)
  })

  test("next checks for My bot: the next slot and the extra checks the agent asked for, with why", () => {
    const rhythm = memberRhythm(preferences.memberLimits(settingsOn, null, brief), brief)
    const next = memberNextChecks({ rhythm, lastCheckAt: at("2026-10-20T12:00:00"), requests: [{ at: at("2026-10-20T13:45:00"), why: "before your 2 PM with Northwind", requestedAt: MORNING }, { at: at("2026-10-20T09:00:00"), why: "done", requestedAt: MORNING, done: true }], now: at("2026-10-20T12:30:00"), timeZone: TZ, snoozedUntil: null })
    assert.deepEqual(next, [
      { at: new Date(at("2026-10-20T13:45:00")).toISOString(), kind: "requested", why: "before your 2 PM with Northwind" },
      { at: new Date(at("2026-10-20T14:00:00")).toISOString(), kind: "scheduled", why: null },
    ])
  })
})

describe("request_check is only for the agent's own check", () => {
  const check = agentReadScopes({ kinds: ["email"], connectionIds: ["google-workspace"] })
  test("the check's token with both features on sees it; the messenger, a plain token, or a feature off doesn't", () => {
    assert.equal(agentCheckRequestsAvailable({ scopes: new Set(check), member: true, workbotProactive: true, workbotAgentBrief: true }), true)
    assert.equal(agentCheckRequestsAvailable({ scopes: new Set(AGENT_MESSAGE_SCOPES), member: true, workbotProactive: true, workbotAgentBrief: true }), false)
    assert.equal(agentCheckRequestsAvailable({ scopes: new Set(["mcp:read", "mcp:write"]), member: true, workbotProactive: true, workbotAgentBrief: true }), false)
    assert.equal(agentCheckRequestsAvailable({ scopes: new Set(check), member: true, workbotProactive: true, workbotAgentBrief: false }), false)
    assert.equal(agentCheckRequestsAvailable({ scopes: new Set(check), member: false, workbotProactive: true, workbotAgentBrief: true }), false)
  })

  test("its answers are one sentence the agent can act on", () => {
    assert.deepEqual(describeCheckRequest({ kind: "accepted", request: { at: at("2026-10-20T13:45:00"), why: "x", requestedAt: MORNING }, requests: [], usedThatDay: 2 }, TZ, 3), { ok: true, text: "Extra check set for 1:45 PM (2 of 3 that day)." })
    assert.deepEqual(describeCheckRequest({ kind: "covered", slot: at("2026-10-20T14:00:00") }, TZ, 3), { ok: true, text: "Your scheduled check at 2:00 PM already covers that." })
    assert.deepEqual(describeCheckRequest({ kind: "refused", reason: "limit_reached", message: "No extra checks left." }, TZ, 3), { ok: false, text: "No extra checks left." })
  })

  test("Connect tells chat how to change the brief and rhythm only when the feature is on", async () => {
    const instructions = async (options: Parameters<typeof createAgentMcpServer>[0]) => {
      const server = createAgentMcpServer(options)
      const client = new Client({ name: "workbot-agent-brief-unit-test", version: "1" })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      try {
        await client.connect(clientTransport)
        return client.getInstructions() ?? ""
      } finally {
        await client.close()
        await server.close()
      }
    }
    const on = await instructions({ myAgent: true, myAgentBrief: true })
    const off = await instructions({ myAgent: true })
    assert.match(MY_AGENT_BRIEF_INSTRUCTIONS, /also watch our Render bill/)
    assert.ok(on.includes(MY_AGENT_BRIEF_INSTRUCTIONS) && !on.includes(MY_AGENT_INSTRUCTIONS))
    assert.ok(off.includes(MY_AGENT_INSTRUCTIONS) && !off.includes(MY_AGENT_BRIEF_INSTRUCTIONS))
  })
})
