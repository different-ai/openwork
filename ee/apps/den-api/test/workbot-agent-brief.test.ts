import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, mock, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { AGENT_INSTRUCTIONS, agentLedgerKey, agentWakePrompt, parseAgentReply, parseAgentState, type AgentState } from "@openwork/automations/proactive"
import { agentSendCheckRequest, type AgentCheckGateRequest, type AgentCheckGateVerdict, type AgentCheckRequest, type AgentConversationTurn, type AgentSendCheckVerdict } from "@openwork/automations/proactive-brief"
import type { AgentReadToolInput } from "@openwork/automations/agent-read-tools"
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
import type { MemberMailArrivals } from "../src/routes/org/google-workspace.js"
import type { AgentSendCheckInput } from "../src/workbot-proactive/send-check.js"
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
const { createCheckGateModel } = await import("../src/workbot-proactive/check-gate.js")
const { createEvaluationModel } = await import("../src/workbot-proactive/evaluation-model.js")
const { createAgentSendCheck } = await import("../src/workbot-proactive/send-check.js")
const { agentSessionId, agentMessageSessionId } = await import("../src/workbot-proactive/turn.js")
const preferences = await import("../src/workbot-proactive/preferences.js")
const { memberNextChecks, memberRhythm, memberBriefLines } = await import("../src/workbot-proactive/brief.js")
const { agentCheckRequestsAvailable, describeCheckRequest } = await import("../src/mcp/agent-check-request.js")
const { agentMayUseExternalTool, agentReadAllowlist, agentReadScopes } = await import("../src/mcp/agent-read-sources.js")
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
/** What Slack's MCP lists for the member: reviewed reads, and writes the check must never get. */
const SLACK_TOOLS: AgentReadToolInput[] = [
  { name: "slack_search_public", annotations: { readOnlyHint: true } },
  { name: "slack_read_thread", annotations: { readOnlyHint: true } },
  { name: "slack_send_message", annotations: { readOnlyHint: false } },
  { name: "slack_schedule_message" },
]

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
  /** Connections whose tools the wake listed. */
  listed: string[]
  /** The check gate: each look at the member's mail, and each question put to the evaluation model. */
  gate: { looks: { connectionId: string; since: number }[]; asked: AgentCheckGateRequest[] }
  /** What the send check was asked, one entry per message. */
  sendChecks: AgentSendCheckInput[]
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
  /** The member's usable connections; Google Workspace and Slack by default. */
  connections?: MemberConnection[]
  /** What each MCP connection lists, by connection id (null: its server didn't answer). Slack's by default. */
  tools?: Record<string, readonly AgentReadToolInput[] | null>
  /**
   * The check gate: what its look at Gmail returns (nothing new by default) and the evaluation model's verdict (no
   * model by default); null: the feature is off for the member. Left out: Den has no gate at all.
   */
  checkGate?: { mail?: MemberMailArrivals | (() => MemberMailArrivals); model?: (request: AgentCheckGateRequest) => AgentCheckGateVerdict } | null
  /** What Google Calendar returns for the check's own read and the gate's look. */
  calendarItems?: unknown[]
  /** The send check's verdict per message; null: the feature is off for the member or the deployment has no key. */
  sendCheck?: ((call: AgentSendCheckInput) => AgentSendCheckVerdict) | null
}) {
  const h: Harness = { clock: MORNING, row: agentRow(input.row), checks: [], messageTurns: [], ended: [], delivered: [], ledger: new Map(), records: [], counters: [], settles: [], requests: [], briefOn: input.briefOn ?? [], gate: { looks: [], asked: [] }, sendChecks: [], listed: [] }
  const checks = [...(input.checks ?? ["NO_FINDINGS"])]
  const replies = [...(input.replies ?? ["NO_REPLY"])]
  let briefCalls = 0
  const deps: AgentBriefWakeDeps = {
    now: () => h.clock,
    allowed: async () => true,
    settings: async () => ({ ...settingsOn, ...input.settings }),
    template: async () => ({ ...(input.template ?? DEFAULT_AGENT_TEMPLATE), versionId: null, version: 1 }),
    user: async () => userId,
    calendar: async () => ({ kind: "ok", json: { timeZone: TZ, items: input.calendarItems ?? [] } }),
    model: async () => "openai/gpt-6-luna",
    turn: async () => parseAgentReply("NO_REPLY"),
    connections: async () => input.connections ?? [GOOGLE, SLACK],
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
    readTools: async ({ connection }) => {
      h.listed.push(connection.id)
      const tools = { [SLACK.id]: SLACK_TOOLS, ...input.tools }
      return connection.id in tools ? tools[connection.id] ?? null : null
    },
    sendCheck: async () => {
      const verdict = input.sendCheck
      if (!verdict) return null
      return async (call) => {
        h.sendChecks.push(call)
        return { verdict: verdict(call), status: "answered", durationMs: 40, inputTokens: 300 }
      }
    },
    ...(input.checkGate === undefined ? {} : {
      checkGate: async () => {
        const gate = input.checkGate
        if (!gate) return null
        const { model } = gate
        return {
          mail: async (look) => {
            h.gate.looks.push({ connectionId: look.connectionId, since: look.since })
            return typeof gate.mail === "function" ? gate.mail() : gate.mail ?? { kind: "ok", messages: [], more: false }
          },
          model: model ? async (request) => {
            h.gate.asked.push(request)
            return { verdict: model(request), durationMs: 35, inputTokens: 240 }
          } : null,
        }
      },
    }),
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

  test("a team with its own policy decides for its members: its brief and limits while Everyone's is off, nothing while the team's is off", async () => {
    const never = async (): Promise<never> => { throw new Error("Everyone's must not be read") }
    const template = { ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 }
    const team = { settings: { ...settingsOn, brief: { text: "Only tell me about research deadlines.", checkEveryHours: 4 as const } }, template }
    // Everyone's is off; the member's team has its own policy: the check runs on the team's brief alone.
    const on = harness({ settings: { enabled: false } })
    assert.deepEqual(await wakeAgentBrief(on.h.row, { ...on.deps, settings: never, template: never, teamPolicy: async () => team }), { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null })
    assert.match(on.h.checks[0]?.instructions ?? "", /Only tell me about research deadlines\./)
    assert.equal(on.h.settles.at(-1)?.nextWakeAt.getTime(), MORNING + 4 * 3_600_000, "the team's rhythm sets the next check")
    // Everyone's is on; the member's team turned agents off: no check and no message.
    const off = harness({})
    assert.deepEqual(await wakeAgentBrief(off.h.row, { ...off.deps, teamPolicy: async () => ({ ...team, settings: { ...settingsOn, enabled: false } }) }), { status: "skipped", reason: "off" })
    assert.equal(off.h.checks.length, 0)
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

describe("the send check: each message is read once more before it is sent (workbotAgentSendCheck)", () => {
  const NEWSLETTER = { text: "The Fabrikam newsletter has a pricing webinar on Thursday.", about: ["email:news"] }
  const SOW = { text: "The SOW is due by noon and Dana is waiting on it.", about: ["email:thr_sow"] }
  const twoFindings = ["P1 — a newsletter. ids: email:news\n\nP0 — SOW due at noon. ids: email:thr_sow"]
  const holdNewsletter = (call: AgentSendCheckInput): AgentSendCheckVerdict => (call.message.includes("newsletter") ? { kind: "hold", reason: "brief" } : { kind: "send" })

  test("off until the policy turns it on: the check model is never asked and every message is sent", async () => {
    const { h, run } = harness({ checks: twoFindings, replies: [messages(NEWSLETTER, SOW)], sendCheck: holdNewsletter })
    await run()
    assert.equal(h.sendChecks.length, 0)
    assert.equal(h.delivered.length, 2)
  })

  test("on: a message the brief says to leave out is held, the other is sent, and the model sees the brief and what was told today", async () => {
    const conversation: AgentConversationTurn[] = [
      { at: at("2026-10-19T16:00:00"), from: "agent", text: "Yesterday: the invoice from Fabrikam is due Friday." },
      { at: at("2026-10-20T07:30:00"), from: "agent", text: "Before 9 AM: Lee needs the launch date." },
      { at: at("2026-10-20T07:40:00"), from: "member", text: "On it." },
    ]
    const { h, run } = harness({ settings: { sendCheck: true }, checks: twoFindings, replies: [messages(NEWSLETTER, SOW)], conversation, sendCheck: holdNewsletter })
    assert.deepEqual(await run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "sent" })
    assert.deepEqual(h.delivered, [SOW.text])
    assert.equal(h.ledger.has("email:news"), false, "a held message is not recorded as told")
    assert.deepEqual(h.sendChecks.map((call) => [call.message, call.update]), [[NEWSLETTER.text, false], [SOW.text, false]])
    assert.match(h.sendChecks[0]?.brief ?? "", /^Tell me about things that need me soon:/)
    assert.deepEqual(h.sendChecks[0]?.toldToday, ["Before 9 AM: Lee needs the launch date."], "only the agent's own messages since the start of the member's day")
    assert.deepEqual(h.records.map((record) => record.reason), ["sent"])
  })

  test("everything held because the brief says so is a quiet check; everything held as a repeat is already told", async () => {
    const brief = harness({ settings: { sendCheck: true }, checks: twoFindings, replies: [messages(NEWSLETTER)], sendCheck: () => ({ kind: "hold", reason: "brief" }) })
    assert.deepEqual(await brief.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" })
    assert.equal(brief.h.delivered.length, 0)
    assert.deepEqual(brief.h.records.map((record) => [record.reason, record.outcome]), [["findings_held", "quiet"]])
    const repeat = harness({ settings: { sendCheck: true }, checks: twoFindings, replies: [messages(SOW)], sendCheck: () => ({ kind: "hold", reason: "repeat" }) })
    await repeat.run()
    assert.deepEqual(repeat.h.records.map((record) => record.reason), ["already_told"])
  })

  test("with the feature off for the member, or no key on the deployment, messages are sent as before", async () => {
    const { h, run } = harness({ settings: { sendCheck: true }, checks: twoFindings, replies: [messages(NEWSLETTER, SOW)], sendCheck: null })
    await run()
    assert.equal(h.delivered.length, 2)
  })

  test("the request: one POST to the evaluation model with the two questions, no retention, and no redirects", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const check = createAgentSendCheck(createEvaluationModel({
      apiKey: "synthetic-gateway-key",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return Response.json({ answers: { skip: { type: "boolean", probability: 0.93 }, repeat: { type: "boolean", probability: 0.1 } }, usage: { inputTokens: 412 } })
      },
    }))
    const result = await check({ brief: "Never tell me about newsletters.", message: NEWSLETTER.text, update: false, toldToday: [] })
    assert.deepEqual([result.verdict, result.status, result.inputTokens], [{ kind: "hold", reason: "brief" }, "answered", 412])
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
    assert.equal(calls[0]?.init?.redirect, "error")
    const headers = new Headers(calls[0]?.init?.headers)
    assert.deepEqual([headers.get("authorization"), headers.get("ai-model-id")], ["Bearer synthetic-gateway-key", "typesafe-ai/jev"])
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      ...agentSendCheckRequest({ brief: "Never tell me about newsletters.", message: NEWSLETTER.text, toldToday: [] }),
      providerOptions: { gateway: { zeroDataRetention: true } },
    })
  })

  test("no usable answer sends the message: a refused request, an unreadable body, a failed connection", async () => {
    const input = { brief: "Never tell me about newsletters.", message: NEWSLETTER.text, update: false, toldToday: [] }
    const refused = createAgentSendCheck(createEvaluationModel({ apiKey: "synthetic-gateway-key", fetch: async () => new Response("quota exceeded for key synthetic-gateway-key", { status: 402 }) }))
    const unreadable = createAgentSendCheck(createEvaluationModel({ apiKey: "synthetic-gateway-key", fetch: async () => new Response("<html>", { status: 200 }) }))
    const down = createAgentSendCheck(createEvaluationModel({ apiKey: "synthetic-gateway-key", fetch: async () => { throw new Error("connect ECONNREFUSED") } }))
    for (const check of [refused, unreadable, down]) {
      const result = await check(input)
      assert.deepEqual([result.verdict, result.status, result.inputTokens], [{ kind: "send" }, "unavailable", null])
    }
  })
})

describe("the check gate: a scheduled check runs only when something that could matter arrived (workbotAgentCheckGate)", () => {
  const TEN = at("2026-10-20T10:00:00")
  const NOON = at("2026-10-20T12:00:00")
  const TWO = at("2026-10-20T14:00:00")
  const gateOn = { settings: { checkGate: true }, connections: [GOOGLE] }
  const mail = (...messages: { from: string; subject: string; snippet?: string; labels?: string[] }[]): MemberMailArrivals => ({
    kind: "ok", more: false, messages: messages.map((message) => ({ snippet: "", labels: ["INBOX"], ...message })),
  })
  const NEWSLETTER = { from: "Fabrikam News <news@fabrikam.example>", subject: "October product update", labels: ["INBOX", "CATEGORY_PROMOTIONS"] }
  const ASK = { from: "Dana <dana@northwind.example>", subject: "Pricing for 60 seats?", snippet: "Can you send numbers before 11?" }
  /** The first check of the day at 8 AM always runs; the gate's turn comes at 10. */
  async function afterMorning(input: Parameters<typeof harness>[0]) {
    const made = harness(input)
    await made.run()
    assert.equal(made.h.checks.length, 1, "the first check of the day ran")
    assert.equal(made.h.gate.looks.length, 0, "and Den did not look first")
    made.h.clock = TEN
    return made
  }

  test("nothing arrived: no agent turn and no model; nothing is marked as read; after two skips the check runs again", async () => {
    const { h, run } = await afterMorning({ ...gateOn, checkGate: {} })
    assert.deepEqual(await run(), { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null })
    assert.equal(h.checks.length, 1, "no step 1 at 10")
    assert.deepEqual(h.gate.looks, [{ connectionId: GOOGLE.id, since: MORNING }])
    assert.deepEqual([state(h).skips, state(h).lastPassAt, state(h).lastLook], [1, TEN, { calendar: MORNING, email: MORNING }])
    assert.equal(h.row.nextWakeAt.getTime(), NOON)
    assert.deepEqual(h.records.at(-1) && [h.records.at(-1)?.kind, h.records.at(-1)?.reason, h.records.at(-1)?.summary], ["scheduled", "nothing_new", "Stayed quiet: nothing new."])
    assert.deepEqual(h.counters.at(-1), { responsibility: "rhythm", checks: 1, quiet: 1, sent: 0 })

    h.clock = NOON
    await run()
    assert.equal(h.checks.length, 1, "no step 1 at noon either")
    assert.deepEqual(h.gate.looks.at(-1), { connectionId: GOOGLE.id, since: MORNING }, "the same window again: a skip marks nothing as read")
    assert.equal(state(h).skips, 2)

    h.clock = TWO
    await run()
    assert.equal(h.checks.length, 2, "two skipped in a row: the agent looks for itself")
    assert.equal(h.gate.looks.length, 2, "without Den looking first")
    assert.match(h.checks[1]?.prompt ?? "", /8:00 AM/, "and it reads from where it last looked, at 8")
    assert.deepEqual([state(h).skips, state(h).lastLook], [0, { calendar: TWO, email: TWO }])
  })

  test("only routine mail arrived and the model is confident: skipped; the model sees senders and subjects, never more", async () => {
    const { h, run } = await afterMorning({ ...gateOn, checkGate: { mail: mail(NEWSLETTER), model: () => ({ kind: "skip", why: "routine" }) } })
    await run()
    assert.equal(h.checks.length, 1)
    assert.equal(state(h).skips, 1)
    assert.deepEqual(h.gate.asked.map((request) => request.state.arrivals), [[{ source: "email", from: NEWSLETTER.from, subject: NEWSLETTER.subject, firstWords: "", category: "promotions" }]])
    assert.match(h.gate.asked[0]?.state.brief ?? "", /^Tell me about things that need me soon:/)
  })

  test("mail that may matter, no answer from the model, or no model on the deployment: the check runs", async () => {
    for (const checkGate of [
      { mail: mail(NEWSLETTER, ASK), model: (): AgentCheckGateVerdict => ({ kind: "run", why: "may_matter" }) },
      { mail: mail(NEWSLETTER), model: (): AgentCheckGateVerdict => ({ kind: "run", why: "no_answer" }) },
      { mail: mail(NEWSLETTER) },
    ]) {
      const { h, run } = await afterMorning({ ...gateOn, checkGate })
      await run()
      assert.equal(h.checks.length, 2)
      assert.equal(state(h).skips, 0)
    }
  })

  test("a meeting that changed since the last look is an arrival too", async () => {
    const changed = {
      id: "evt_review", status: "confirmed", summary: "Northwind review", created: "2026-10-01T13:00:00Z", updated: "2026-10-20T13:30:00Z",
      start: { dateTime: "2026-10-20T15:00:00-04:00" }, end: { dateTime: "2026-10-20T15:30:00-04:00" },
      attendees: [{ email: "sam@acme.example", self: true, responseStatus: "accepted" }, { email: "dana@northwind.example", responseStatus: "accepted" }],
    }
    const { h, run } = await afterMorning({ ...gateOn, calendarItems: [changed], checkGate: { model: () => ({ kind: "run", why: "may_matter" }) } })
    await run()
    assert.deepEqual(h.gate.asked[0]?.state.arrivals, [{ source: "calendar", change: "\"Northwind review\", today at 3:00 PM, 1 other person, 1 from outside the company: changed" }])
    assert.equal(h.checks.length, 2)
  })

  test("a source Den can't look at itself, a failed look, or a full inbox: the check runs", async () => {
    const chat = await afterMorning({ settings: { checkGate: true }, checkGate: {} })
    await chat.run()
    assert.equal(chat.h.checks.length, 2, "team chat is readable, and Den can't look at it")
    assert.equal(chat.h.gate.looks.length, 0)
    for (const arrivals of [{ kind: "google_api_error" as const }, { ...mail(NEWSLETTER), more: true }]) {
      const { h, run } = await afterMorning({ ...gateOn, checkGate: { mail: arrivals, model: () => ({ kind: "skip", why: "routine" }) } })
      await run()
      assert.equal(h.checks.length, 2)
      assert.equal(h.gate.asked.length, 0)
    }
    const thrown = await afterMorning({ ...gateOn, checkGate: { mail: () => { throw new Error("timeout") } } })
    await thrown.run()
    assert.equal(thrown.h.checks.length, 2)
  })

  test("off until the policy turns it on, and with the feature off for the member: every check runs and Den never looks", async () => {
    const policyOff = await afterMorning({ connections: [GOOGLE], checkGate: {} })
    await policyOff.run()
    const featureOff = await afterMorning({ ...gateOn, checkGate: null })
    await featureOff.run()
    for (const { h } of [policyOff, featureOff]) {
      assert.equal(h.checks.length, 2)
      assert.equal(h.gate.looks.length, 0)
    }
  })

  test("a check the agent asked for always runs", async () => {
    const { h, run } = await afterMorning({ ...gateOn, checkGate: {} })
    const request: AgentCheckRequest = { at: at("2026-10-20T09:15:00"), why: "before the 9:30 with Northwind", requestedAt: MORNING }
    h.row = { ...h.row, state: JSON.stringify({ ...state(h), requests: [request] }) }
    h.clock = request.at
    await run()
    assert.equal(h.checks.length, 2)
    assert.equal(h.gate.looks.length, 0)
  })

  test("the model request: one POST with the question, no retention, no redirects; no usable answer runs the check", async () => {
    const request: AgentCheckGateRequest = {
      state: { brief: "Never tell me about newsletters.", arrivals: [{ source: "email", from: NEWSLETTER.from, subject: NEWSLETTER.subject, firstWords: "", category: "promotions" }] },
      questions: { needed: { type: "boolean", instructions: "Could any arrival matter?" } },
    }
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const model = createCheckGateModel(createEvaluationModel({
      apiKey: "synthetic-gateway-key",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return Response.json({ answers: { needed: { type: "boolean", probability: 0.04 } }, usage: { inputTokens: 212 } })
      },
    }))
    const answer = await model(request)
    assert.deepEqual([answer.verdict, answer.inputTokens], [{ kind: "skip", why: "routine" }, 212])
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
    assert.equal(calls[0]?.init?.redirect, "error")
    const headers = new Headers(calls[0]?.init?.headers)
    assert.deepEqual([headers.get("authorization"), headers.get("ai-model-id")], ["Bearer synthetic-gateway-key", "typesafe-ai/jev"])
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { ...request, providerOptions: { gateway: { zeroDataRetention: true } } })

    const refused = createCheckGateModel(createEvaluationModel({ apiKey: "synthetic-gateway-key", fetch: async () => new Response("quota exceeded for key synthetic-gateway-key", { status: 402 }) }))
    const unreadable = createCheckGateModel(createEvaluationModel({ apiKey: "synthetic-gateway-key", fetch: async () => new Response("<html>", { status: 200 }) }))
    const down = createCheckGateModel(createEvaluationModel({ apiKey: "synthetic-gateway-key", fetch: async () => { throw new Error("connect ECONNREFUSED") } }))
    for (const failing of [refused, unreadable, down]) {
      const failed = await failing(request)
      assert.deepEqual([failed.verdict, failed.inputTokens], [{ kind: "run", why: "no_answer" }, null])
    }
  })
})

describe("any connected connector as a source; the check only ever gets read tools (workbotAgentBrief)", () => {
  // A custom MCP nobody reviewed (fictional), the member switched on.
  const DESK: MemberConnection = { id: "emc_01k8z5wq0s0000000000000009", name: "Lumen Support Desk", url: "https://mcp.lumen-desk.test/mcp", native: null, state: "connected" }
  const DESK_TOOLS: AgentReadToolInput[] = [
    { name: "list_tickets", description: "List open tickets", annotations: { readOnlyHint: true } },
    { name: "get_ticket", description: "Read one ticket" },
    { name: "close_ticket", description: "Close a ticket", annotations: { readOnlyHint: true } },
    { name: "purge_queue", annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: "reply_to_customer", annotations: { readOnlyHint: false } },
    { name: "get_or_create_customer" },
    { name: "run_query" },
    { name: "send_digest" },
  ]
  const deskOn = JSON.stringify({ v: 1, words: EMPTY_AGENT_PREFERENCES, sources: { [DESK.id]: { on: true } }, log: [] })
  const toolsOf = (scopes: readonly string[], connectionId: string) => [...(agentReadAllowlist(new Set(scopes))?.tools?.get(connectionId) ?? [])].sort()

  test("the check's token carries only the custom connector's read tools, and Slack's reviewed reads", async () => {
    const { h, run } = harness({ connections: [GOOGLE, SLACK, DESK], tools: { [DESK.id]: DESK_TOOLS }, row: { preferences: deskOn } })
    await run()
    const scopes = h.checks[0]?.scopes ?? []
    assert.deepEqual(toolsOf(scopes, DESK.id), ["get_ticket", "list_tickets"])
    assert.deepEqual(toolsOf(scopes, SLACK.id), ["slack_read_thread", "slack_search_public"])
    const allowlist = agentReadAllowlist(new Set(scopes))
    assert.ok(allowlist)
    for (const tool of [...DESK_TOOLS, ...SLACK_TOOLS]) {
      const connection = DESK_TOOLS.includes(tool) ? DESK : SLACK
      const write = /close|purge|reply|create|run|send|schedule/.test(tool.name)
      if (write) assert.equal(agentMayUseExternalTool(allowlist, connection, tool), false, `${tool.name} never reaches the check`)
    }
    assert.match(h.checks[0]?.prompt ?? "", /Lumen Support Desk/, "the source is in the check's prompt")
    assert.deepEqual(h.listed.sort(), [DESK.id, SLACK.id].sort(), "tools are listed for MCP connections only")
  })

  test("an admin's tool choices win, and a provider's destructive mark beats even an admin", async () => {
    const settings = mergeWorkbotProactiveSettings(settingsOn, { sources: { toolOverrides: { [DESK.id]: { get_ticket: "deny", run_query: "allow", purge_queue: "allow" } } } })
    assert.ok(settings)
    const { h, run } = harness({ settings, connections: [GOOGLE, SLACK, DESK], tools: { [DESK.id]: DESK_TOOLS }, row: { preferences: deskOn } })
    await run()
    assert.deepEqual(toolsOf(h.checks[0]?.scopes ?? [], DESK.id), ["list_tickets", "run_query"])
  })

  test("a connector with no read tools, or one whose tools can't be listed, sits the check out and the check is told why", async () => {
    const none = harness({ connections: [GOOGLE, SLACK, DESK], tools: { [DESK.id]: [{ name: "close_ticket" }, { name: "send_digest" }] }, row: { preferences: deskOn } })
    await none.run()
    assert.match(none.h.checks[0]?.prompt ?? "", /Lumen Support Desk[^\n]*no read-only tools/)
    assert.ok(!(agentReadAllowlist(new Set(none.h.checks[0]?.scopes ?? []))?.connectionIds.has(DESK.id)), "not on the token")
    const down = harness({ connections: [GOOGLE, SLACK, DESK], tools: { [DESK.id]: null }, row: { preferences: deskOn } })
    await down.run()
    assert.match(down.h.checks[0]?.prompt ?? "", /Lumen Support Desk[^\n]*its tools couldn't be listed/)
  })

  test("a connector the admin doesn't allow is never read, whatever the member chose", async () => {
    const settings = mergeWorkbotProactiveSettings(settingsOn, { sources: { connections: { [DESK.id]: "off" } } })
    assert.ok(settings)
    const { h, run } = harness({ settings, connections: [GOOGLE, SLACK, DESK], tools: { [DESK.id]: DESK_TOOLS }, row: { preferences: deskOn } })
    await run()
    assert.ok(!h.listed.includes(DESK.id))
    assert.ok(!(agentReadAllowlist(new Set(h.checks[0]?.scopes ?? []))?.connectionIds.has(DESK.id)))
    assert.doesNotMatch(h.checks[0]?.prompt ?? "", /Lumen Support Desk/)
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
