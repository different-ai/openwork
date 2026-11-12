import assert from "node:assert/strict"
import { describe, mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { agentLedgerKey, AGENT_WAKE_MARKER, parseAgentReply, parseAgentState } from "@openwork/automations/proactive"
import {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_WORKBOT_PROACTIVE_SETTINGS,
  agentSourcesPolicyInputSchema,
  mergeAgentTemplate,
  mergeWorkbotProactiveSettings,
  readWorkbotProactiveSettings,
  withWorkbotProactiveSettings,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import type { HeadlessRunnerDeps } from "../src/headless-runner/client.js"
import type { AgentDestinationBlock } from "@openwork/types/den/workbot-proactive"
import type { DeliveryDeps } from "../src/workbot-proactive/deliver.js"
import type { WorkbotDirectMessageDeps } from "../src/slack-assistant/direct-message.js"
import type { AgentInstanceRow, AgentSettle } from "../src/workbot-proactive/repository.js"
import type { AgentTurnResult } from "../src/workbot-proactive/turn.js"
import type { AgentWakeDeps } from "../src/workbot-proactive/wake.js"
import type { AgentCheckRecord } from "../src/workbot-proactive/checks.js"
import type { MemberConnection } from "../src/workbot-proactive/sources.js"

// No database, runner, Google or Connect is contacted: every boundary is injected or faked below.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/workbot_proactive_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-workbot-proactive-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-workbot-proactive-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { wakeAgent } = await import("../src/workbot-proactive/wake.js")
const { runAgentTurn, agentSessionId } = await import("../src/workbot-proactive/turn.js")
const { deliverAgentMessage, destinationBlock } = await import("../src/workbot-proactive/deliver.js")
const { sendWorkbotDirectMessage } = await import("../src/slack-assistant/direct-message.js")
const { SlackApiError } = await import("../src/slack-assistant/protocol.js")
const { createHeadlessRunnerClient } = await import("../src/headless-runner/client.js")
const { renderAgentTemplate } = await import("../src/workbot-proactive/template.js")
const policy = await import("../src/workbot-proactive/policy.js")
const agentRead = await import("../src/mcp/agent-read-sources.js")
const { resolveMemberSources, groupSourceConnections, checkSourcesChange } = await import("../src/workbot-proactive/sources.js")
// The repository's modules load Better Auth, which seeds its resource registry on import: load it first with a
// synthetic registry row (as test/feature-outcomes.test.ts does), so no database is contacted.
const { db } = await import("../src/db.js")
const bootstrapSelect = mock.method(db.$primary, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { countConnectedMembers, listOrganizationSourceConnections } = await import("../src/workbot-proactive/sources-repository.js")
const preferences = await import("../src/workbot-proactive/preferences.js")
const { checkHeadline, describeAgentCheck, memberAgentCheck } = await import("../src/workbot-proactive/checks.js")

const TZ = "America/New_York"
// Tuesday 2026-10-20, 13:45 in New York.
const NOW = Date.parse("2026-10-20T17:45:00Z")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const slackConnectionId = createDenTypeId("externalMcpConnection")

type RawEvent = Record<string, unknown>
function meeting(overrides: RawEvent = {}): RawEvent {
  return {
    id: "evt1",
    status: "confirmed",
    summary: "Quarterly review",
    created: "2026-10-01T12:00:00Z",
    updated: "2026-10-01T12:00:00.000Z",
    start: { dateTime: "2026-10-21T14:00:00-04:00" },
    end: { dateTime: "2026-10-21T14:30:00-04:00" },
    organizer: { email: "lead@northwind.example", displayName: "Northwind lead" },
    attendees: [
      { email: "me@contoso.example", self: true, responseStatus: "accepted" },
      { email: "lead@northwind.example", displayName: "Northwind lead" },
    ],
    ...overrides,
  }
}

function agentRow(overrides: Partial<AgentInstanceRow> = {}): AgentInstanceRow {
  return {
    memberId,
    organizationId,
    templateVersionId: null,
    status: null,
    overrides: null,
    snoozedUntil: null,
    state: null,
    timeZone: null,
    nextWakeAt: new Date(NOW),
    failures: 0,
    leaseOwner: "lease-1",
    leaseUntil: new Date(NOW + 600_000),
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    preferences: null,
    ...overrides,
  }
}

const message = (text: string, items: ({ responsibility: string; ref: string } | { source: string; id: string; preset?: string })[]) => JSON.stringify({ message: text, items })

/** The member's connections: Google Workspace and Slack, both connected, unless a test says otherwise. */
const GOOGLE: MemberConnection = { id: "google-workspace", name: "Google Workspace", url: "https://google.com", native: "google-workspace", state: "connected" }
const SLACK: MemberConnection = { id: "emc_01k8z5wq0s0000000000000001", name: "Slack", url: "https://mcp.slack.com/mcp", native: null, state: "connected" }
const NOTES: MemberConnection = { id: "emc_01k8z5wq0s0000000000000002", name: "Meeting notes", url: "https://mcp.granola.ai/mcp", native: null, state: "connected" }
/**
 * Agents on, the calendar on for everyone (the default) and Slack on for everyone too. Mail and chat are not sources of
 * their own: chat is read through the Slack connection, under that connection's policy.
 */
const settingsOn: WorkbotProactiveSettings = { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true, sources: { calendar: "everyone", connections: { [SLACK.id]: "everyone" } } }
/** "Someone is waiting on you", found in Slack: an item names the connection it came from. */
const waiting = (id: string) => ({ source: SLACK.id, id, preset: "waiting_on_you" })

type HarnessState = {
  records: AgentCheckRecord[]
  checks: { day: string; counts: { responsibility: string; checks: number; quiet: number; sent: number }[] }[]
  destinations: string[]
  clock: number
  events: RawEvent[]
  row: AgentInstanceRow
  ledger: Map<string, string>
  delivered: string[]
  turns: { prompt: string; sessionId: string; instructions: string; scopes: readonly string[] }[]
  calendarReads: number
  /** The connection each calendar read went through. */
  calendarVia: string[]
  settles: AgentSettle[]
}

/** An in-memory agent, ledger and destination; `events`, `clock` and the reply change between runs. */
function harness(input: { settings?: Partial<WorkbotProactiveSettings>; row?: Partial<AgentInstanceRow>; replies?: (string | AgentTurnResult)[]; sentToday?: number; allowed?: boolean[]; blocked?: AgentDestinationBlock; google?: "ok" | "needs_connection" | Partial<Record<string, "ok" | "needs_connection" | "missing_scope">>; sendFails?: boolean; connections?: MemberConnection[] }) {
  const state: HarnessState = { records: [], checks: [], destinations: [], clock: NOW, events: [meeting()], row: agentRow(input.row), ledger: new Map(), delivered: [], turns: [], calendarReads: 0, calendarVia: [], settles: [] }
  const replies = [...(input.replies ?? ["NO_REPLY"])]
  let allowedCalls = 0
  const deps: AgentWakeDeps = {
    now: () => state.clock,
    allowed: async () => input.allowed?.[allowedCalls++] ?? true,
    settings: async () => ({ ...settingsOn, ...input.settings }),
    template: async () => ({ ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 }),
    user: async () => userId,
    calendar: async (call) => {
      state.calendarReads += 1
      state.calendarVia.push(call.connectionId)
      const answer = typeof input.google === "object" ? input.google[call.connectionId] ?? "ok" : input.google ?? "ok"
      if (answer !== "ok") return { kind: answer }
      return { kind: "ok", json: { timeZone: TZ, items: state.events } }
    },
    recordChecks: async (call) => {
      state.checks.push({ day: call.day, counts: [...call.counts] })
    },
    model: async () => "openai/gpt-6-luna",
    turn: async (call) => {
      state.turns.push({ prompt: call.prompt, sessionId: call.sessionId, instructions: call.instructions, scopes: call.scopes })
      const reply = replies.shift() ?? "NO_REPLY"
      return typeof reply === "string" ? parseAgentReply(reply) : reply
    },
    sessionId: agentSessionId,
    messageId: (member, at) => `wa_${member}_${at}`,
    told: async (_member, items) => new Set(items.map(agentLedgerKey).filter((key) => state.ledger.has(key))),
    reserve: async (entry) => {
      const key = agentLedgerKey(entry.item)
      if (state.ledger.has(key)) return null
      state.ledger.set(key, entry.outcome ?? "pending")
      return key
    },
    finish: async (id, outcome) => {
      state.ledger.set(id, outcome)
    },
    sentSince: async () => (input.sentToday ?? 0) + [...state.ledger.values()].filter((outcome) => outcome === "sent").length,
    holdsLease: async () => true,
    settle: async (_row, changes) => {
      state.settles.push(changes)
      state.row = { ...state.row, ...changes, leaseOwner: "lease-1" }
      return true
    },
    destinationBlock: async () => input.blocked ?? null,
    deliver: async (call) => {
      if (input.sendFails) return { ok: false, code: "send_failed" }
      state.delivered.push(call.text)
      state.destinations.push("workbot_dm")
      return { ok: true, message: { channelId: "D0DM", messageTs: "1700000000.0001", permalink: "https://example.slack.com/archives/D0DM/p17000000000001" } }
    },
    connections: async () => input.connections ?? [GOOGLE, SLACK],
    connectLink: (connectionId) => `https://den.example/dashboard/library/connectors/${connectionId}`,
    recordCheck: async (record) => {
      const index = state.records.findIndex((entry) => entry.key === record.key)
      if (index >= 0) state.records[index] = record
      else state.records.push(record)
    },
  }
  return { state, deps, run: () => wakeAgent(state.row, deps) }
}

describe("waking a member's agent", () => {
  test("with no events at all, the scheduled pass still runs, in the agent's own session; NO_REPLY sends nothing", async () => {
    const h = harness({})
    const outcome = await h.run()
    assert.deepEqual(outcome, { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null })
    assert.equal(h.state.turns.length, 1)
    assert.equal(h.state.turns[0]?.sessionId, agentSessionId(organizationId, memberId))
    assert.match(h.state.turns[0]?.sessionId ?? "", /^hs_agent_[a-f0-9]{40}$/)
    assert.ok(h.state.turns[0]?.prompt.startsWith(`${AGENT_WAKE_MARKER} Scheduled check: the morning pass.`), "the first pass of the day is the morning pass")
    assert.match(h.state.turns[0]?.prompt ?? "", /- calendar: Calendar through Google Calendar: their meetings today and tomorrow\. never read yet\./)
    assert.match(h.state.turns[0]?.prompt ?? "", new RegExp(`- ${SLACK.id}: Slack: DMs to them, mentions of them and threads they're in\\. never read yet\\.`))
    assert.doesNotMatch(h.state.turns[0]?.prompt ?? "", /- (email|chat): /, "mail and chat are not sources of their own")
    assert.deepEqual(h.state.delivered, [])
    const saved = parseAgentState(h.state.row.state)
    assert.equal(saved.lastPassAt, NOW)
    assert.equal(saved.nextPassAt, NOW + 3 * 3_600_000, "the next check is in about three hours")
    assert.deepEqual(saved.lastLook, { calendar: NOW, [SLACK.id]: NOW }, "every source it read, by id")
    assert.equal(h.state.row.nextWakeAt.getTime(), NOW + 5 * 60_000, "the calendar is looked at again in five minutes")
  })

  test("a team with its own policy decides for its members: woken while Everyone's is off, not woken while the team's is off", async () => {
    const template = { ...DEFAULT_AGENT_TEMPLATE, instructions: "Research only.", versionId: createDenTypeId("configObjectVersion"), version: 2 }
    const never = async (): Promise<never> => { throw new Error("Everyone's must not be read") }
    // Everyone's is off, the member's team turned agents on: the pass runs on the team's policy and template alone.
    const on = harness({ settings: { enabled: false } })
    const asked: string[] = []
    const teamOn = { ...on.deps, settings: never, template: never, teamPolicy: async (member: { memberId: string }) => { asked.push(member.memberId); return { settings: { ...settingsOn, leadMinutes: 30 }, template } } }
    assert.deepEqual(await wakeAgent(on.state.row, teamOn), { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null })
    assert.deepEqual(asked, [memberId], "asked for this member only")
    assert.match(on.state.turns[0]?.prompt ?? "", /Research only\./, "the team's instructions")
    assert.equal(on.state.settles.at(-1)?.templateVersionId, template.versionId, "the team's template version is recorded")
    // Everyone's is on, the member's team turned agents off: no wake, no turn, no message.
    const off = harness({})
    assert.deepEqual(await wakeAgent(off.state.row, { ...off.deps, teamPolicy: async () => ({ settings: { ...settingsOn, enabled: false }, template }) }), { status: "skipped", reason: "off" })
    assert.equal(off.state.turns.length, 0)
    // No team policy for the member (the feature off, no team with its own, or teams that differ): Everyone's, as before.
    const everyone = harness({})
    assert.deepEqual(await wakeAgent(everyone.state.row, { ...everyone.deps, teamPolicy: async () => null }), { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null })
  })

  test("a message is delivered once; the same item is never delivered again", async () => {
    const reply = message("Northwind is waiting on the renewal proposal (since 9:10 AM).", [waiting("thread-abc")])
    const h = harness({ replies: [reply, reply] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "sent" })
    assert.deepEqual(h.state.delivered, ["Northwind is waiting on the renewal proposal (since 9:10 AM)."])
    assert.deepEqual(h.state.destinations, ["workbot_dm"], "the organization's default is a DM from Workbot")
    h.state.clock = NOW + 3 * 3_600_000
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" })
    assert.equal(h.state.delivered.length, 1)
  })

  test("between scheduled passes, a calendar change made by someone else wakes it early", async () => {
    const h = harness({ replies: ["NO_REPLY", message("Quarterly review moved to 3 PM tomorrow.", [{ responsibility: "calendar_changes", ref: "evt1:2026-10-20T17:47:00Z" }])] })
    await h.run()
    h.state.clock = NOW + 5 * 60_000
    h.state.events = [meeting({ updated: "2026-10-20T17:47:00Z", start: { dateTime: "2026-10-21T15:00:00-04:00" }, end: { dateTime: "2026-10-21T15:30:00-04:00" } })]
    const outcome = await h.run()
    assert.deepEqual(outcome, { status: "ran", reasons: ["calendar"], reply: "message", delivered: "sent" })
    assert.match(h.state.turns[1]?.prompt ?? "", /Woken early by the calendar/)
    assert.match(h.state.turns[1]?.prompt ?? "", /A meeting \(calendar event evt1\) moved to tomorrow at 3:00 PM .*\(source calendar, id evt1:2026-10-20T17:47:00Z, preset calendar_changes\)/)
    assert.doesNotMatch(h.state.turns[1]?.prompt ?? "", /Quarterly review|Northwind/, "invite text never reaches the prompt")
    h.state.clock = NOW + 10 * 60_000
    assert.deepEqual(await h.run(), { status: "skipped", reason: "nothing_due" }, "one event wakes it once")
  })

  test("each completed pass adds to the health counters: what it asked about, what stayed quiet, what it sent", async () => {
    const h = harness({ replies: [message("A thread is waiting.", [waiting("t1")])] })
    await h.run()
    assert.deepEqual(h.state.checks, [{
      day: "2026-10-20",
      counts: [
        { responsibility: "morning_brief", checks: 1, quiet: 1, sent: 0 },
        { responsibility: "meeting_prep", checks: 1, quiet: 1, sent: 0 },
        { responsibility: "calendar_changes", checks: 1, quiet: 1, sent: 0 },
        { responsibility: "waiting_on_you", checks: 1, quiet: 0, sent: 1 },
      ],
    }])
    const outage = harness({ replies: [{ kind: "unavailable", code: "runner_unreachable" }] })
    await outage.run()
    assert.deepEqual(outage.state.checks, [], "a pass that didn't run counts nothing")
  })

  test("past the daily limit nothing is sent, and the items are not retried later", async () => {
    const h = harness({ sentToday: 3, replies: [message("Two threads are waiting on you.", [waiting("t1")])] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "daily_limit" })
    assert.deepEqual(h.state.delivered, [])
    assert.equal(h.state.ledger.get(`${SLACK.id}:t1`), "capped")
  })

  test("a muted responsibility is neither asked about nor delivered", async () => {
    const h = harness({ row: { overrides: { muted: ["waiting_on_you"] } }, replies: [message("A thread is waiting.", [waiting("t1")])] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" })
    assert.doesNotMatch(h.state.turns[0]?.prompt ?? "", /- waiting_on_you:/)
  })

  test("outside working hours it reads nothing and runs nothing", async () => {
    const h = harness({ row: { timeZone: TZ } })
    h.state.clock = Date.parse("2026-10-21T01:00:00Z")
    assert.deepEqual(await h.run(), { status: "skipped", reason: "outside_hours" })
    assert.equal(h.state.calendarReads, 0)
    assert.equal(h.state.turns.length, 0)
    assert.equal(h.state.row.nextWakeAt.toISOString(), "2026-10-21T12:00:00.000Z")
  })

  test("members who turned it off or snoozed it, an organization switch off, or no destination: nothing runs", async () => {
    for (const [overrides, settings, reason] of [
      [{ status: "off" }, {}, "opted_out"],
      [{ snoozedUntil: new Date(NOW + 3_600_000) }, {}, "snoozed"],
      [{}, { enabled: false }, "off"],
      [{}, { membersStart: "opted_out" as const }, "opted_out"],
      [{}, { destination: null }, "no_destination"],
    ] as const) {
      const h = harness({ row: overrides, settings })
      assert.deepEqual(await h.run(), { status: "skipped", reason })
      assert.equal(h.state.turns.length, 0, reason)
    }
  })

  test("without the Slack app or a linked Slack account, no turn runs and the reason is recorded", async () => {
    for (const blocked of ["slack_app_not_installed", "member_not_linked"] as const) {
      const h = harness({ blocked })
      assert.deepEqual(await h.run(), { status: "skipped", reason: blocked })
      assert.equal(h.state.turns.length, 0, blocked)
      assert.equal(h.state.row.nextWakeAt.getTime(), NOW + 3_600_000)
    }
  })

  test("a kill switch between deciding and delivering wins", async () => {
    const h = harness({ allowed: [true, false], replies: [message("A thread is waiting.", [waiting("t1")])] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "failed" })
    assert.deepEqual(h.state.delivered, [])
  })

  test("a runner outage retries in 15 minutes and keeps the calendar where it was", async () => {
    const h = harness({ replies: [{ kind: "unavailable", code: "runner_unreachable" }] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "unavailable", delivered: null })
    assert.equal(h.state.row.nextWakeAt.getTime(), NOW + 15 * 60_000)
    assert.equal(h.state.row.state, null, "nothing was recorded, so the pass and any event run on the retry")
    assert.equal(h.state.row.failures, 1)
  })
})

describe("the turn on the runner", () => {
  function fakeRunner(answer: string) {
    const calls: { method: string; path: string; body: unknown }[] = []
    const minted: { readOnly?: boolean }[] = []
    const deps: HeadlessRunnerDeps = {
      config: { url: "http://127.0.0.1:9", token: "t".repeat(40) },
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        calls.push({ method: init?.method ?? "GET", path: url.pathname, body })
        const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
        if (init?.method === "PUT") return json(201, { id: url.pathname.split("/").at(-1) })
        if (init?.method === "POST" && url.pathname.endsWith("/turns")) return json(202, { state: "accepted" })
        const messageId = url.searchParams.get("messageId") ?? ""
        return json(200, {
          turns: [{ messageId, status: "completed", error: null }],
          messages: [
            { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "write_file", input: { path: "memory/notes.md" } }] },
            { role: "tool", callId: "c1", name: "write_file", isError: false },
            { role: "assistant", text: answer, toolCalls: [] },
          ],
          finalAssistantText: answer,
        })
      },
      mintToken: async (request) => {
        minted.push({ readOnly: request.readOnly })
        return { token: "mcp-token" }
      },
      maxTokenTtlMs: 3_600_000,
    }
    return { calls, minted, turnDeps: { client: createHeadlessRunnerClient(deps), sleep: async () => {}, now: Date.now, pollMs: 0, deadlineMs: 5_000 } }
  }

  const input = { actor: { userId: "user_test", organizationId }, sessionId: agentSessionId(organizationId, memberId), instructions: "Silence is the default.", model: "openai/gpt-6-luna", prompt: `${AGENT_WAKE_MARKER} Scheduled check.`, messageId: "wa_1" }

  test("its own durable session, no owner or shared memory, a read-scoped token, its own file tools kept, never deleted", async () => {
    const runner = fakeRunner("NO_REPLY")
    assert.deepEqual(await runAgentTurn(input, runner.turnDeps), { kind: "quiet" })
    const session = runner.calls.find((call) => call.method === "PUT")
    assert.equal(session?.path, `/v1/sessions/${input.sessionId}`)
    assert.ok(session && typeof session.body === "object" && session.body !== null)
    for (const key of ["owner", "memoryOf", "memoryScope", "files", "computer", "tasks"]) assert.equal(key in session.body, false, key)
    const turn = runner.calls.find((call) => call.path.endsWith("/turns"))
    assert.doesNotMatch(JSON.stringify(turn?.body), /"readOnly":true/, "credentials.readOnly would take away memory/ writes")
    assert.deepEqual(runner.minted, [{ readOnly: true }], "the MCP token is mcp:read")
    assert.equal(runner.calls.some((call) => call.method === "DELETE"), false, "its notes outlive the pass")
  })

  test("a JSON answer after tool steps is the message", async () => {
    const runner = fakeRunner(message("Quarterly review moved.", [{ responsibility: "calendar_changes", ref: "evt1:1" }]))
    assert.equal((await runAgentTurn(input, runner.turnDeps)).kind, "message")
  })
})

describe("delivery", () => {
  function deps(dm: Awaited<ReturnType<DeliveryDeps["send"]>> = { ok: true, channelId: "D1", messageTs: "1.1" }) {
    const sent: string[] = []
    const value: DeliveryDeps = {
      target: async () => (dm.ok ? { ok: true, connectionId: slackConnectionId, slackUserId: "U1" } : { ok: false, reason: dm.reason === "slack_error" ? "member_not_linked" : dm.reason }),
      send: async (call) => {
        sent.push(call.text)
        return dm
      },
    }
    return { value, sent }
  }
  const base = { organizationId, userId, text: "Quarterly review moved." }

  test("always a DM from the Workbot app, only to the member; where it landed comes back for My agent", async () => {
    const dm = deps({ ok: true, channelId: "D1", messageTs: "1.1", permalink: "https://example.slack.com/archives/D1/p11" })
    assert.deepEqual(await deliverAgentMessage(base, dm.value), { ok: true, message: { channelId: "D1", messageTs: "1.1", permalink: "https://example.slack.com/archives/D1/p11" } })
    assert.deepEqual(dm.sent, ["Quarterly review moved."])
    assert.deepEqual(await deliverAgentMessage(base, deps().value), { ok: true, message: { channelId: "D1", messageTs: "1.1", permalink: null } }, "no link from Slack, no link shown")
  })

  test("no Slack app or no linked account: nothing is sent, and the reason says which", async () => {
    assert.deepEqual(await deliverAgentMessage(base, deps({ ok: false, reason: "slack_app_not_installed" }).value), { ok: false, code: "slack_app_not_installed" })
    assert.equal(await destinationBlock({ organizationId, userId }, deps({ ok: false, reason: "member_not_linked" }).value), "member_not_linked")
    assert.deepEqual(await deliverAgentMessage(base, deps({ ok: false, reason: "slack_error", code: "ratelimited" }).value), { ok: false, code: "send_failed" })
  })
})

describe("sendWorkbotDirectMessage", () => {
  function slackDeps(input: { installed?: boolean; linked?: boolean; fail?: string } = {}) {
    const calls: { token: string; method: string; body: Record<string, unknown> }[] = []
    const deps: WorkbotDirectMessageDeps = {
      installations: async () => (input.installed === false ? [] : [{ connectionId: slackConnectionId, teamId: "T1" }]),
      linkedSlackUser: async () => (input.linked === false ? null : "U0MEMBER"),
      botToken: async () => "xoxb-bot",
      slack: (token) => async (method, body) => {
        calls.push({ token, method, body })
        if (input.fail && method === "chat.postMessage") throw new SlackApiError(input.fail)
        return method === "conversations.open" ? { ok: true, channel: { id: "D0DM" } } : { ok: true, ts: "1700000000.0001" }
      },
    }
    return { deps, calls }
  }
  const message = { organizationId, userId, text: "Quarterly review moved to 3 PM." }

  test("opens the DM with the member as the app's bot and posts there, even if they never wrote to it", async () => {
    const slack = slackDeps()
    assert.deepEqual(await sendWorkbotDirectMessage(message, slack.deps), { ok: true, channelId: "D0DM", messageTs: "1700000000.0001" })
    assert.deepEqual(slack.calls.map((call) => [call.token, call.method]), [["xoxb-bot", "conversations.open"], ["xoxb-bot", "chat.postMessage"]])
    assert.deepEqual(slack.calls[0]?.body, { users: "U0MEMBER" })
    assert.deepEqual(slack.calls[1]?.body, { channel: "D0DM", text: "Quarterly review moved to 3 PM.", unfurl_links: false, unfurl_media: false })
  })

  test("asked for, it also reads the message's Slack link; a link outside Slack or a failure there never fails the send", async () => {
    function linkDeps(permalink: unknown) {
      const calls: string[] = []
      const deps: WorkbotDirectMessageDeps = {
        installations: async () => [{ connectionId: slackConnectionId, teamId: "T1" }],
        linkedSlackUser: async () => "U0MEMBER",
        botToken: async () => "xoxb-bot",
        slack: () => async (method, body) => {
          calls.push(method)
          if (method === "chat.getPermalink") {
            assert.deepEqual(body, { channel: "D0DM", message_ts: "1700000000.0001" })
            if (permalink instanceof Error) throw permalink
            return { ok: true, permalink }
          }
          return method === "conversations.open" ? { ok: true, channel: { id: "D0DM" } } : { ok: true, ts: "1700000000.0001" }
        },
      }
      return { deps, calls }
    }
    const linked = linkDeps("https://example.slack.com/archives/D0DM/p17000000000001")
    assert.deepEqual(await sendWorkbotDirectMessage({ ...message, permalink: true }, linked.deps), { ok: true, channelId: "D0DM", messageTs: "1700000000.0001", permalink: "https://example.slack.com/archives/D0DM/p17000000000001" })
    assert.deepEqual(linked.calls, ["conversations.open", "chat.postMessage", "chat.getPermalink"])
    const permalinkOf = (result: Awaited<ReturnType<typeof sendWorkbotDirectMessage>>) => (result.ok ? result.permalink : undefined)
    assert.equal(permalinkOf(await sendWorkbotDirectMessage({ ...message, permalink: true }, linkDeps("https://evil.example/x").deps)), null)
    assert.equal(permalinkOf(await sendWorkbotDirectMessage({ ...message, permalink: true }, linkDeps(new SlackApiError("ratelimited")).deps)), null)
  })

  test("answers with a reason instead of throwing", async () => {
    assert.deepEqual(await sendWorkbotDirectMessage(message, slackDeps({ installed: false }).deps), { ok: false, reason: "slack_app_not_installed" })
    assert.deepEqual(await sendWorkbotDirectMessage(message, slackDeps({ linked: false }).deps), { ok: false, reason: "member_not_linked" })
    assert.deepEqual(await sendWorkbotDirectMessage(message, slackDeps({ fail: "messages_tab_disabled" }).deps), { ok: false, reason: "slack_error", code: "messages_tab_disabled" })
    assert.deepEqual(await sendWorkbotDirectMessage({ ...message, userId: "not-a-user" }, slackDeps().deps), { ok: false, reason: "member_not_linked" })
  })
})

describe("members' plain-language controls and the template", () => {
  test("snooze until tomorrow lasts until the next working morning; mute and unmute", () => {
    const change = policy.memberChoiceChange({ snooze: "tomorrow", mute: ["calendar_changes", "waiting_on_you"], unmute: ["waiting_on_you"] }, null, settingsOn, NOW, TZ)
    assert.equal(change.snoozedUntil?.toISOString(), "2026-10-21T12:00:00.000Z")
    assert.deepEqual(change.overrides?.muted, ["calendar_changes"])
    const unmuted = policy.memberChoiceChange({ unmute: ["morning_brief"] }, { overrides: { muted: ["morning_brief", "meeting_prep"] } }, settingsOn, NOW, TZ)
    assert.deepEqual(unmuted.overrides, { muted: ["meeting_prep"] })
    assert.deepEqual(policy.memberChoiceChange({ on: false }, null, settingsOn, NOW, TZ), { status: "off" })
  })

  test("the member's own choice wins over the organization's starting choice", () => {
    assert.equal(policy.memberAgentOn(null, settingsOn), true)
    assert.equal(policy.memberAgentOn({ status: "off" }, settingsOn), false)
    assert.equal(policy.memberAgentOn({ status: "on" }, { ...settingsOn, membersStart: "opted_out" }), true)
  })

  test("the template is an agent definition: frontmatter, then the agent's instructions", () => {
    const text = renderAgentTemplate({ responsibilities: { ...DEFAULT_AGENT_TEMPLATE.responsibilities, waiting_on_you: false }, instructions: "Ignore newsletters." })
    assert.match(text, /^---\nname: your-agent\n/)
    assert.match(text, /\nmode: primary\n/)
    assert.match(text, /\nresponsibilities: morning_brief, meeting_prep, calendar_changes\n/)
    assert.match(text, /\n---\nYou are this person's own agent/)
    assert.match(text, /## Organization instructions\nIgnore newsletters\.\n$/)
    assert.equal(mergeAgentTemplate(DEFAULT_AGENT_TEMPLATE, { dailyCap: 5 }), null, "a policy-only change saves no template version")
    assert.deepEqual(mergeAgentTemplate(DEFAULT_AGENT_TEMPLATE, { responsibilities: { morning_brief: false } })?.responsibilities.morning_brief, false)
  })
})

describe("organization policy", () => {
  test("missing or broken fields read as defaults, field by field, and invalid hours are refused", () => {
    assert.deepEqual(readWorkbotProactiveSettings(null), DEFAULT_WORKBOT_PROACTIVE_SETTINGS)
    const stored = readWorkbotProactiveSettings({ workbot: { model: "m", proactive: { enabled: true, dailyCap: 99, startHour: 20, endHour: 9, destination: { connectionId: "emc_x", channel: "C0SHARED" } } } })
    assert.equal(stored.enabled, true)
    assert.equal(stored.dailyCap, DEFAULT_WORKBOT_PROACTIVE_SETTINGS.dailyCap)
    assert.deepEqual([stored.startHour, stored.endHour], [8, 19])
    assert.equal(stored.destination, "workbot_dm", "a stored channel default reads as the Workbot DM default")
    assert.equal(mergeWorkbotProactiveSettings(DEFAULT_WORKBOT_PROACTIVE_SETTINGS, { startHour: 18, endHour: 9 }), null)
    const merged = mergeWorkbotProactiveSettings(DEFAULT_WORKBOT_PROACTIVE_SETTINGS, { enabled: true, instructions: "kept out of policy" })
    assert.ok(merged && !("instructions" in merged))
    assert.deepEqual(withWorkbotProactiveSettings({ workbot: { model: "m" } }, DEFAULT_WORKBOT_PROACTIVE_SETTINGS), { workbot: { model: "m", proactive: DEFAULT_WORKBOT_PROACTIVE_SETTINGS } })
  })

  test("a policy saved with email, team chat and per-app picks reads without them; a change can't bring them back", () => {
    assert.deepEqual(DEFAULT_WORKBOT_PROACTIVE_SETTINGS.sources, { calendar: "everyone", connections: {} }, "the calendar, and each connection by id: nothing else")
    const before = { calendar: "members", email: "everyone", chat: "off", coreConnections: { calendar: ["gws_work"], email: ["gws_work"] }, coreDefaults: { calendar: "gws_work" }, connections: { emc_notes: "everyone" } }
    const read = readWorkbotProactiveSettings({ workbot: { proactive: { enabled: true, sources: before } } })
    assert.equal(read.enabled, true, "the rest of the policy is kept")
    assert.deepEqual(read.sources, { calendar: "members", connections: { emc_notes: "everyone" } }, "email, chat, the picked apps and the defaults are dropped")
    const changed = mergeWorkbotProactiveSettings(read, { sources: { calendar: "off" } })
    assert.deepEqual(changed?.sources, { calendar: "off", connections: { emc_notes: "everyone" } })
    assert.equal(agentSourcesPolicyInputSchema.safeParse({ email: "off" }).success, false, "no email setting to change")
    assert.equal(agentSourcesPolicyInputSchema.safeParse({ coreConnections: { calendar: ["gws_work"] } }).success, false, "no calendar app to pick")
    assert.equal(agentSourcesPolicyInputSchema.safeParse({ calendar: "members", connections: { emc_notes: null } }).success, true)
  })
})

describe("My agent: every check is recorded for the member (workbotProactive)", () => {
  // A waiting ask was found in Slack; a calendar change in the calendar.
  const reply = (responsibility: string, ref: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ message: "A thread is waiting.", items: [{ source: responsibility === "waiting_on_you" ? SLACK.id : "calendar", id: ref, preset: responsibility }], ...extra })
  const only = (h: { state: HarnessState }) => {
    assert.equal(h.state.records.length, 1, JSON.stringify(h.state.records))
    const [record] = h.state.records
    assert.ok(record)
    return { outcome: record.outcome, reason: record.reason, summary: record.summary, kind: record.kind, responsibilities: record.responsibilities }
  }

  test("the parent rollout being off prevents turns and member check records", async () => {
    const h = harness({ allowed: [false], row: { preferences: JSON.stringify({ v: 1, words: { always: "Payroll", never: "", when: "", how: "" }, log: [] }) } })
    assert.deepEqual(await h.run(), { status: "skipped", reason: "not_allowed" })
    assert.deepEqual(h.state.records, [])
    assert.deepEqual(h.state.turns, [])
  })

  test("stayed quiet, sent, held by the daily limit: each check says what happened and why", async () => {
    const quiet = harness({})
    await quiet.run()
    assert.deepEqual(only(quiet), { outcome: "quiet", reason: "nothing_new", summary: "Stayed quiet: nothing new.", kind: "morning", responsibilities: [] })

    const sent = harness({ replies: [reply("waiting_on_you", "t1")] })
    await sent.run()
    assert.deepEqual(only(sent), { outcome: "sent", reason: "sent", summary: "Sent you a message about waiting on you.", kind: "morning", responsibilities: ["waiting_on_you"] })
    assert.deepEqual(sent.state.records[0]?.message, { channelId: "D0DM", messageTs: "1700000000.0001", permalink: "https://example.slack.com/archives/D0DM/p17000000000001" }, "a reference to the DM, never its text")
    sent.state.clock = NOW + 3 * 3_600_000
    await sent.run()
    assert.equal(sent.state.records.length, 2, "each check that ran is its own record")
    assert.deepEqual([sent.state.records[1]?.reason, sent.state.records[1]?.kind], ["nothing_new", "scheduled"])

    const capped = harness({ sentToday: 3, replies: [reply("waiting_on_you", "t2")] })
    await capped.run()
    assert.deepEqual(only(capped), { outcome: "quiet", reason: "daily_limit", summary: "Stayed quiet: daily limit reached (3 a day). Held a message about waiting on you.", kind: "morning", responsibilities: ["waiting_on_you"] })

    const told = harness({ row: { overrides: { muted: ["waiting_on_you"] } }, replies: [reply("waiting_on_you", "t3")] })
    await told.run()
    assert.equal(only(told).reason, "already_told")
  })

  test("outside the member's hours, inside their quiet window, or snoozed, it waited", async () => {
    const narrowed = harness({ row: { timeZone: TZ, overrides: { hours: { startHour: 9, endHour: 13 } } } })
    assert.deepEqual(await narrowed.run(), { status: "skipped", reason: "outside_hours" }, "13:45 is after their own 1 PM")
    assert.deepEqual(only(narrowed), { outcome: "waited", reason: "outside_hours", summary: "Waited: outside your hours (9 AM–1 PM).", kind: "scheduled", responsibilities: [] })
    assert.equal(narrowed.state.row.nextWakeAt.toISOString(), "2026-10-21T13:00:00.000Z", "next look at their 9 AM")
    assert.equal(narrowed.state.turns.length, 0)

    const quietWindow = harness({ row: { overrides: { quietWindow: { startHour: 12, endHour: 14 } } }, replies: [reply("calendar_changes", "c1")] })
    assert.deepEqual(await quietWindow.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "quiet_window" })
    assert.deepEqual(quietWindow.state.delivered, [])
    assert.deepEqual(only(quietWindow), { outcome: "waited", reason: "quiet_window", summary: "Waited: only urgent messages 12 PM–2 PM. Held a message about calendar changes.", kind: "morning", responsibilities: ["calendar_changes"] })
    assert.equal(quietWindow.state.ledger.size, 0, "nothing is recorded as told, so it can come up after 2 PM")
    assert.match(quietWindow.state.turns[0]?.prompt ?? "", /Between 12 PM and 2 PM only urgent messages reach them/)

    const urgent = harness({ row: { overrides: { quietWindow: { startHour: 12, endHour: 14 } } }, replies: [reply("calendar_changes", "c2", { urgent: true })] })
    assert.deepEqual(await urgent.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "sent" }, "urgent goes out inside the window")

    const snoozed = harness({ row: { snoozedUntil: new Date(NOW + 3_600_000) } })
    await snoozed.run()
    assert.deepEqual(only(snoozed), { outcome: "waited", reason: "snoozed", summary: "Waited: snoozed.", kind: "scheduled", responsibilities: [] })
  })

  test("couldn't read Google, couldn't reach Slack, couldn't send, couldn't run: failed, with what to do", async () => {
    const google = harness({ google: "needs_connection" })
    await google.run()
    const notice = google.state.records.find((record) => record.reason === "source_disconnected")
    assert.deepEqual([notice?.outcome, notice?.summary, notice?.sources.map((source) => source.name)], ["failed", "Couldn't read Google Calendar: connect your account again.", ["Google Calendar"]])
    assert.equal(google.state.records.find((record) => record.key.startsWith("ran:"))?.reason, "nothing_new", "it still read Slack")

    const unlinked = harness({ blocked: "member_not_linked" })
    await unlinked.run()
    assert.deepEqual(only(unlinked).summary, "Couldn't reach you: link your Slack account to Workbot.")

    const failed = harness({ sendFails: true, replies: [reply("waiting_on_you", "t9")] })
    await failed.run()
    assert.deepEqual(only(failed), { outcome: "failed", reason: "send_failed", summary: "Couldn't send the message in Slack.", kind: "morning", responsibilities: ["waiting_on_you"] })

    const outage = harness({ replies: [{ kind: "unavailable", code: "runner_unreachable" }] })
    await outage.run()
    assert.equal(only(outage).reason, "agent_unavailable")

    const killed = harness({ allowed: [true, false], replies: [reply("waiting_on_you", "t10")] })
    await killed.run()
    assert.deepEqual(killed.state.records, [], "a kill switch right before sending is not the member's failure")
  })

  test("the member's own words reach the prompt as data they wrote", async () => {
    const words = { always: "Anything from payroll", never: "Newsletters", when: "", how: "One line each" }
    const h = harness({ row: { preferences: JSON.stringify({ v: 1, words, log: [] }) } })
    await h.run()
    const prompt = h.state.turns[0]?.prompt ?? ""
    assert.match(prompt, /in their own words in OpenWork \(data they wrote/)
    assert.match(prompt, /- Always tell me about: """Anything from payroll"""/)
    assert.match(prompt, /- Never tell me about: """Newsletters"""/)
    assert.doesNotMatch(prompt, /- When:/, "an empty field is left out")
  })

  test("a stored record reads back with a headline, a Slack link and what to do", () => {
    const view = memberAgentCheck({ id: "c1", checkedAt: new Date(NOW), kind: "scheduled", outcome: "failed", reason: "google_disconnected", summary: "Couldn't read Gmail: reconnect Google.", responsibilities: ["waiting_on_you", "send_email"], sources: null, message: null })
    assert.deepEqual(view, { id: "c1", at: new Date(NOW).toISOString(), kind: "scheduled", outcome: "failed", reason: "google_disconnected", headline: "Couldn't read Gmail", summary: "Couldn't read Gmail: reconnect Google.", responsibilities: ["waiting_on_you"], sources: [], slackUrl: null, fix: "reconnect_google" })
    assert.equal(memberAgentCheck({ id: "c2", checkedAt: new Date(NOW), kind: "scheduled", outcome: "exploded", reason: "nothing_new", summary: "x", responsibilities: null, sources: null, message: null }), null, "a row this version can't read is left out")
    assert.equal(checkHeadline("Sent you a message about calendar changes."), "Sent you a message about calendar changes")
    const limits = { startHour: 8, endHour: 19, dailyCap: 3, quietWindow: null }
    assert.equal(describeAgentCheck({ reason: "sent", responsibilities: ["meeting_prep", "calendar_changes", "waiting_on_you"], limits }).summary, "Sent you a message about meeting prep, calendar changes and waiting on you.")
  })
})

describe("My agent: the member's words, narrower limits and undo", () => {
  const admin = { ...settingsOn, startHour: 8, endHour: 19, dailyCap: 3 }
  let next = 0
  const newId = () => `chg_${++next}`
  const change = (request: Parameters<typeof preferences.applyMemberAgentChange>[0]["request"], current: { overrides?: AgentInstanceRow["overrides"]; stored?: ReturnType<typeof preferences.emptyStoredPreferences> } = {}, source: "chat" | "page" = "chat", now = NOW) =>
    preferences.applyMemberAgentChange({ request, overrides: current.overrides ?? null, stored: current.stored ?? preferences.emptyStoredPreferences(), settings: admin, source, now, newId })

  test("a member can only narrow the admin's limits, never widen them", () => {
    assert.deepEqual(change({ hours: { startHour: 7, endHour: 17 } }), { ok: false, status: 400, error: "limit_wider_than_admin", message: "Your admin allows 8 AM–7 PM. Choose hours inside that." })
    assert.deepEqual(change({ hours: { startHour: 9, endHour: 20 } }).ok, false)
    assert.deepEqual(change({ dailyCap: 5 }), { ok: false, status: 400, error: "limit_wider_than_admin", message: "Your admin allows 3 a day. Choose 3 or fewer." })
    const narrowed = change({ hours: { startHour: 9, endHour: 17 }, dailyCap: 1 })
    assert.ok(narrowed.ok)
    assert.deepEqual([narrowed.overrides.hours, narrowed.overrides.dailyCap], [{ startHour: 9, endHour: 17 }, 1])
    const limits = preferences.memberLimits(admin, narrowed.overrides)
    assert.deepEqual([limits.startHour, limits.endHour, limits.dailyCap, limits.narrowed], [9, 17, 1, { hours: true, dailyCap: true }])
  })

  test("an admin who narrows later always wins over what the member stored", () => {
    const stored = { hours: { startHour: 9, endHour: 17 }, dailyCap: 2 }
    const later = preferences.memberLimits({ ...admin, startHour: 10, endHour: 16, dailyCap: 1 }, stored)
    assert.deepEqual([later.startHour, later.endHour, later.dailyCap], [10, 16, 1])
    const apart = preferences.memberLimits({ ...admin, startHour: 18, endHour: 22 }, stored)
    assert.deepEqual([apart.startHour, apart.endHour, apart.narrowed.hours], [18, 22, false], "hours that no longer overlap fall back to the admin's")
    assert.deepEqual(preferences.memberLimits(admin, { hours: { startHour: 12, endHour: 9 }, dailyCap: 99 }).dailyCap, 3, "unreadable stored values are ignored")
  })

  test("one chat message saves several fields as one save, says exactly what was saved, and undo reverts it", () => {
    const saved = change({ preferences: { when: "Between 12 and 2, only urgent things" }, quietWindow: { startHour: 12, endHour: 14 }, mute: ["calendar_changes"] })
    assert.ok(saved.ok)
    assert.deepEqual(saved.lines, ["When: “Between 12 and 2, only urgent things”", "Stopped: Calendar changes", "Only urgent messages 12 PM–2 PM"])
    assert.equal(saved.wake, true, "a new quiet window makes the agent look again")
    assert.equal(preferences.savedReply({ lines: saved.lines, undid: false, undoable: true }, "https://den.example/dashboard/my-bot"),
      "Saved:\n- When: “Between 12 and 2, only urgent things”\n- Stopped: Calendar changes\n- Only urgent messages 12 PM–2 PM\nReply \"undo\" to revert. My bot: https://den.example/dashboard/my-bot")
    assert.deepEqual(saved.overrides, { muted: ["calendar_changes"], quietWindow: { startHour: 12, endHour: 14 } })
    assert.deepEqual(new Set(saved.stored.log.map((entry) => entry.save)).size, 1)
    assert.ok(saved.stored.log.every((entry) => entry.source === "chat"))

    const page = change({ preferences: { how: "Bullets" } }, { overrides: saved.overrides, stored: saved.stored }, "page", NOW + 60_000)
    assert.ok(page.ok)
    const changes = preferences.memberAgentChanges(page.stored, admin)
    assert.deepEqual(changes.map((entry) => [entry.field, entry.source]), [["how", "page"], ["quietWindow", "chat"], ["calendar_changes", "chat"], ["when", "chat"]])

    const undone = change({ undo: "last" }, { overrides: page.overrides, stored: page.stored }, "chat", NOW + 120_000)
    assert.ok(undone.ok && undone.undid)
    assert.equal(undone.stored.words.how, "", "undo reverts the last save, whichever side made it")
    assert.equal(undone.stored.words.when, "Between 12 and 2, only urgent things")

    const again = change({ undo: "last" }, { overrides: undone.overrides, stored: undone.stored }, "chat", NOW + 180_000)
    assert.ok(again.ok)
    assert.deepEqual(again.stored.words, { always: "", never: "", when: "", how: "" })
    assert.deepEqual(again.overrides, { muted: [] }, "the whole chat save is reverted")
    assert.deepEqual(change({ undo: "last" }, { overrides: again.overrides, stored: again.stored }), { ok: false, status: 409, error: "nothing_to_undo", message: "There is nothing to undo." })
  })

  test("undo of one change on the page, but only the latest for its field", () => {
    const first = change({ preferences: { never: "Newsletters" } }, {}, "page")
    assert.ok(first.ok)
    const second = change({ preferences: { never: "Newsletters and alerts" } }, { stored: first.stored }, "chat", NOW + 1)
    assert.ok(second.ok)
    const older = first.stored.log[0]?.id ?? ""
    assert.deepEqual(change({ undo: older }, { stored: second.stored }), { ok: false, status: 409, error: "undo_superseded", message: "That was changed again since. Undo the newer change first." })
    const newer = second.stored.log.at(-1)?.id ?? ""
    const reverted = change({ undo: newer }, { stored: second.stored })
    assert.ok(reverted.ok)
    assert.equal(reverted.stored.words.never, "Newsletters")
    assert.deepEqual(change({ undo: newer, preferences: { how: "x" } }), { ok: false, status: 400, error: "undo_alone", message: "Undo on its own, then make the next change." })
  })

  test("asking for the admin's own hours or limit is no narrowing; the same value twice changes nothing", () => {
    const same = change({ hours: { startHour: 8, endHour: 19 }, dailyCap: 3 })
    assert.ok(same.ok)
    assert.deepEqual(same.lines, [], "nothing to log")
    const set = change({ preferences: { always: "Payroll" } })
    assert.ok(set.ok)
    const twice = change({ preferences: { always: "Payroll" } }, { stored: set.stored })
    assert.ok(twice.ok)
    assert.deepEqual(twice.lines, [])
    assert.equal(preferences.savedReply({ lines: [], undid: false, undoable: false }, "L"), "Nothing changed. My bot: L")
    assert.deepEqual(preferences.choiceLines({ on: false, snooze: "tomorrow" }), ["Turned off", "Snoozed until your next working morning"])
  })
})

describe("sources, not categories", () => {
  const SLACK_LINK = "https://example.slack.com/archives/C0SALES/p1792500000000100"
  const withChoices = (sources: Record<string, { on?: boolean; instruction?: string }>) => JSON.stringify({ v: 1, words: { always: "", never: "", when: "", how: "" }, sources, log: [] })
  const scopeFor = (id: string) => `openwork:agent-connection:${id}`

  test("a Slack-only ask is delivered once, with its Slack link kept, and never again", async () => {
    const reply = message(`Worth catching: a pricing question came in on Slack before your 2 PM call. I haven't checked the email thread yet. <${SLACK_LINK}|Slack message>`, [{ source: SLACK.id, id: SLACK_LINK }])
    const h = harness({ replies: [reply, reply] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "sent" })
    assert.match(h.state.delivered[0] ?? "", new RegExp(`<${SLACK_LINK.replaceAll(".", "\\.")}\\|Slack message>`), "a link to the Slack message it read stays")
    assert.equal(h.state.ledger.get(`${SLACK.id}:${SLACK_LINK}`), "sent")
    h.state.clock = NOW + 3 * 3_600_000
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" })
    assert.equal(h.state.delivered.length, 1)
    assert.ok(h.state.turns[0]?.scopes.includes(scopeFor(SLACK.id)), "the turn's token may read Slack")
    assert.deepEqual(h.state.turns[0]?.scopes.filter((scope) => scope.startsWith("openwork:agent-source:")), ["openwork:agent-source:calendar"], "the calendar is the only source that isn't a connection")
  })

  test("an item naming its source the way people do (\"slack\") is the same source; one from a source it didn't read is dropped", async () => {
    const h = harness({ replies: [message("Worth catching: x.", [{ source: "slack", id: "C1:1" }, { source: "emc_unknown", id: "X-1" }])] })
    await h.run()
    assert.deepEqual([...h.state.ledger.keys()], [`${SLACK.id}:C1:1`])
    // An agent with an older habit still says "chat" and "email": chat is the Slack connection it read; mail has no
    // connection here (Google Workspace is only the calendar without Your agent's brief), so its item is dropped.
    const old = harness({ replies: [message("Worth catching: x.", [{ source: "chat", id: "C1:1" }, { source: "email", id: "t1" }])] })
    assert.deepEqual(await old.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "sent" })
    assert.deepEqual([...old.state.ledger.keys()], [`${SLACK.id}:C1:1`])
    const noSlack = harness({ connections: [GOOGLE], replies: [message("Worth catching: x.", [{ source: "chat", id: "C1:1" }, { source: "email", id: "t1" }])] })
    assert.deepEqual(await noSlack.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" }, "with no connection that reads them, email and chat name no source")
  })

  test("the member's source switches and instructions change the allowlist and the prompt; the admin's \"not allowed\" wins", async () => {
    // Slack is up to each member here (the default for a connection), and this member left it off.
    const settings = { sources: { calendar: "everyone" as const, connections: {} } }
    const h = harness({
      settings,
      connections: [GOOGLE, SLACK, NOTES],
      row: { preferences: withChoices({ [SLACK.id]: { on: false }, [NOTES.id]: { on: true, instruction: "Use my meeting notes for context and action items." } }) },
      replies: [message("Worth catching: x.", [{ source: SLACK.id, id: "C1:2" }])],
    })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" }, "Slack is off for them, so its item is dropped")
    const turn = h.state.turns[0]
    assert.ok(turn)
    assert.ok(!turn.scopes.includes(scopeFor(SLACK.id)), "no Slack on the token")
    assert.ok(turn.scopes.includes(scopeFor(NOTES.id)), "the connection they turned on is")
    assert.doesNotMatch(turn.prompt, new RegExp(`- ${SLACK.id}:`))
    assert.match(turn.prompt, new RegExp(`- ${NOTES.id}: Meeting notes\\. never read yet\\. .*The person's instruction for it, in their own words: """Use my meeting notes for context and action items\\."""`))

    const blocked = harness({ connections: [GOOGLE, SLACK, NOTES], settings: { sources: { calendar: "everyone", connections: { [NOTES.id]: "off" } } }, row: { preferences: withChoices({ [NOTES.id]: { on: true } }) } })
    await blocked.run()
    assert.ok(!blocked.state.turns[0]?.scopes.includes(scopeFor(NOTES.id)), "not allowed by the admin, whatever the member chose")
    const off = harness({ connections: [GOOGLE, SLACK, NOTES] })
    await off.run()
    assert.ok(!off.state.turns[0]?.scopes.includes(scopeFor(NOTES.id)), "without a member choice, other connections stay off")
  })

  test("the feature off: a connector nobody reviewed is never a source, and the token carries no per-tool list", async () => {
    // A custom MCP (fictional) the member switched on: with workbotAgentBrief off, today's reviewed lists decide.
    const DESK: MemberConnection = { id: "emc_01k8z5wq0s0000000000000009", name: "Lumen Support Desk", url: "https://mcp.lumen-desk.test/mcp", native: null, state: "connected" }
    const h = harness({ connections: [GOOGLE, SLACK, NOTES, DESK], row: { preferences: withChoices({ [DESK.id]: { on: true }, [NOTES.id]: { on: true } }) } })
    await h.run()
    const scopes = h.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes(scopeFor(NOTES.id)), "a reviewed service still reads")
    assert.ok(!scopes.includes(scopeFor(DESK.id)), "a connector nobody reviewed isn't a source")
    assert.ok(!scopes.some((scope) => scope.startsWith("openwork:agent-tool")), "no per-tool list: the reviewed lists decide at the gateway")
    assert.doesNotMatch(h.state.turns[0]?.prompt ?? "", /Lumen Support Desk/)
  })

  test("mutes still apply: a muted preset's item is dropped, anything else still goes out", async () => {
    const muted = { overrides: { muted: ["waiting_on_you"] } }
    const presetOnly = harness({ row: muted, replies: [message("Worth catching: x.", [waiting("t1")])] })
    assert.deepEqual(await presetOnly.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" })
    const other = harness({ row: muted, replies: [message("Quick check: a security notice.", [{ source: SLACK.id, id: "t2" }])] })
    await other.run()
    assert.equal(other.state.delivered.length, 1)
  })

  test("a source that can't be read gets one message with the action that fixes it, is paused, and is told again only after it worked", async () => {
    const broken: MemberConnection = { ...GOOGLE, state: "reconnect" }
    const h = harness({ connections: [broken, SLACK] })
    await h.run()
    assert.deepEqual(h.state.delivered, ["Quick check: I can't read your Google Calendar, so I've paused checking it and kept reading the rest. <https://den.example/dashboard/library/connectors/google-workspace|Reconnect Google Workspace>"])
    assert.ok(!h.state.turns[0]?.scopes.includes(scopeFor(GOOGLE.id)), "the paused source isn't on the token")
    assert.match(h.state.turns[0]?.prompt ?? "", /Turned on but not readable now, so don't try: Calendar \(needs reconnecting\)\./)
    h.state.clock = NOW + 3 * 3_600_000
    await h.run()
    assert.equal(h.state.delivered.length, 1, "not repeated every run")
    const fixed = harness({ row: { state: JSON.stringify({ ...parseAgentState(h.state.row.state), nextPassAt: null }) } })
    await fixed.run()
    assert.deepEqual(parseAgentState(fixed.state.row.state).notices, {}, "working again: forgotten, so a later failure is told again")
  })

  test("with nothing readable, no turn: one message, a record, and checks pause", async () => {
    const h = harness({ connections: [{ ...GOOGLE, state: "needs_connection" }] })
    assert.deepEqual(await h.run(), { status: "skipped", reason: "no_sources" })
    assert.equal(h.state.turns.length, 0)
    assert.match(h.state.delivered[0] ?? "", /so I've paused your checks until it's fixed\. <https:\/\/den\.example\/dashboard\/library\/connectors\/google-workspace\|Connect Google Workspace>$/)
    assert.equal(h.state.records[0]?.reason, "source_disconnected")
    h.state.clock = NOW + 60 * 60_000
    await h.run()
    assert.equal(h.state.delivered.length, 1)
  })

  test("two Google accounts and no pick to make: the one the member connected is read, and the other is never asked for", async () => {
    const work: MemberConnection = { ...GOOGLE, id: "gws_work", name: "Acme Google" }
    const personal: MemberConnection = { ...GOOGLE, id: "gws_personal", name: "Personal Google", state: "needs_connection" }
    const h = harness({ connections: [work, personal, SLACK] })
    await h.run()
    assert.deepEqual(h.state.calendarVia, [work.id], "every calendar app serves the calendar, and the connected one is read")
    assert.deepEqual(h.state.delivered, [], "one connected account is enough; the other isn't asked for")
    const scopes = h.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes("openwork:agent-core:calendar:gws_work"))
    assert.ok(!scopes.some((scope) => scope.includes(personal.id)), "nothing of the other account on the token")
    assert.ok(!scopes.some((scope) => scope.startsWith("openwork:agent-core:email:") || scope.startsWith("openwork:agent-native:")), "its mail is not read: Google Workspace is only the calendar here")
  })

  test("Google refusing the calendar it reads holds up only that, never falling back to another account", async () => {
    const work: MemberConnection = { ...GOOGLE, id: "gws_work", name: "Acme Google" }
    const personal: MemberConnection = { ...GOOGLE, id: "gws_personal", name: "Personal Google" }
    const scope = harness({ connections: [work, personal, SLACK], google: { [work.id]: "missing_scope" } })
    await scope.run()
    assert.deepEqual(scope.state.calendarVia, [work.id], "only the one connection the calendar reads is tried")
    assert.deepEqual(scope.state.delivered, ["Quick check: I can't read your Google Calendar, so I've paused checking it and kept reading the rest. <https://den.example/dashboard/library/connectors/gws_work|Reconnect Google Workspace>"])
    const scopes = scope.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes(scopeFor(SLACK.id)), "Slack still reads")
    assert.ok(!scopes.some((entry) => entry.includes("gws_")), "no calendar, and nothing of either Google account")

    const only = harness({ connections: [work, SLACK], google: { [work.id]: "missing_scope" } })
    await only.run()
    assert.deepEqual(only.state.delivered, ["Quick check: I can't read your Google Calendar, so I've paused checking it and kept reading the rest. <https://den.example/dashboard/library/connectors/gws_work|Reconnect Google Workspace>"])
  })

  test("the calendar turned off by the admin is neither read by Den nor offered to the agent", async () => {
    const h = harness({ settings: { sources: { calendar: "off", connections: { [SLACK.id]: "everyone" } } } })
    await h.run()
    assert.equal(h.state.calendarReads, 0)
    assert.doesNotMatch(h.state.turns[0]?.prompt ?? "", /- calendar:/)
    assert.ok(!h.state.turns[0]?.scopes.includes("openwork:agent-source:calendar"))
  })
})

describe("Connect's read allowlist for an agent's token", () => {
  test("only Den adds it; a plain read token keeps its rules", () => {
    assert.equal(agentRead.agentReadAllowlist(new Set(["mcp:read"])), null)
    const allowlist = agentRead.agentReadAllowlist(new Set(["mcp:read", ...agentRead.agentReadScopes({ kinds: ["calendar"], connectionIds: ["google-workspace", SLACK.id], pairs: [{ kind: "calendar", connectionId: "google-workspace" }] })]))
    assert.deepEqual(allowlist && [[...allowlist.kinds], [...allowlist.connectionIds], [...allowlist.pairs]], [["calendar"], ["google-workspace", SLACK.id], ["calendar:google-workspace"]])
    const stale = agentRead.agentReadAllowlist(new Set(["mcp:read", "openwork:agent-read", "openwork:agent-source:email", "openwork:agent-source:chat", "openwork:agent-core:email:google-workspace"]))
    assert.deepEqual(stale && [[...stale.kinds], [...stale.pairs]], [[], []], "a token minted before: email and chat name no source, so they open nothing")
  })

  test("native reads: GETs of the calendar while it is on, through its connection; nothing else", () => {
    const allowlist = { kinds: new Set(["calendar" as const]), connectionIds: new Set(["google-workspace"]), pairs: new Set(["calendar:google-workspace"]) }
    const get = (path: string) => ({ method: "GET", path })
    assert.equal(agentRead.agentMayUseNative(allowlist, "google-workspace", get("/v1/capabilities/google-workspace/calendar-events")), true)
    assert.equal(agentRead.agentMayUseNative(allowlist, "google-workspace", get("/v1/capabilities/google-workspace/gmail-messages")), false, "mail is not the calendar")
    assert.equal(agentRead.agentMayUseNative(allowlist, "google-workspace", get("/v1/capabilities/google-workspace/drive-files")), false, "files are not a source")
    assert.equal(agentRead.agentMayUseNative(allowlist, "google-workspace", { method: "POST", path: "/v1/capabilities/google-workspace/calendar-events" }), false)
    assert.equal(agentRead.agentMayUseNative(allowlist, "other-google", get("/v1/capabilities/google-workspace/calendar-events")), false)
    assert.equal(agentRead.agentMayUseNative({ ...allowlist, kinds: new Set() }, "google-workspace", get("/v1/capabilities/google-workspace/calendar-events")), false, "the calendar is off")
    assert.equal(agentRead.nativeSourceKind("/v1/capabilities/google-workspace/calendar-events/:eventId"), "calendar")
    for (const path of ["/v1/capabilities/google-workspace/gmail-messages", "/v1/capabilities/microsoft-365/mail-messages", "/v1/capabilities/microsoft-365/teams-chats/:chatId/messages", "/v1/capabilities/google-workspace/drive-files"]) {
      assert.equal(agentRead.nativeSourceKind(path), null, `${path}: read through the connection, not a source of its own`)
    }
  })

  test("the calendar is read through one connection: a second account on the token never opens through it", () => {
    const allowlist = agentRead.agentReadAllowlist(new Set(["mcp:read", ...agentRead.agentReadScopes({
      kinds: ["calendar"],
      connectionIds: ["gws_work", "gws_personal"],
      pairs: [{ kind: "calendar", connectionId: "gws_personal" }],
    })]))
    assert.ok(allowlist)
    const get = (path: string) => ({ method: "GET", path })
    assert.equal(agentRead.agentMayUseNative(allowlist, "gws_personal", get("/v1/capabilities/google-workspace/calendar-events")), true)
    assert.equal(agentRead.agentMayUseNative(allowlist, "gws_work", get("/v1/capabilities/google-workspace/calendar-events")), false)
  })

  test("mail is read through the Google Workspace connection when it is a source, never through the calendar alone", () => {
    const get = (path: string, name?: string) => ({ method: "GET", path, ...(name ? { name } : {}) })
    const mail = "/v1/capabilities/google-workspace/gmail-messages"
    // The calendar only: the connection is on the token for its calendar, and that opens no mail.
    const calendarOnly = agentRead.agentReadAllowlist(new Set(["mcp:read", ...agentRead.agentReadScopes({ kinds: ["calendar"], connectionIds: ["gws_work"], pairs: [{ kind: "calendar", connectionId: "gws_work" }] })]))
    assert.ok(calendarOnly)
    assert.equal(agentRead.agentMayUseNative(calendarOnly, "gws_work", get(mail)), false)
    // Without Your agent's brief the token never carries a provider's other reads, so mail stays closed.
    const perTool = agentRead.agentReadAllowlist(new Set(["mcp:read", ...agentRead.agentReadScopes({ kinds: ["calendar"], connectionIds: ["gws_work"], pairs: [{ kind: "calendar", connectionId: "gws_work" }], tools: [] })]))
    assert.ok(perTool)
    assert.equal(agentRead.agentMayUseNative(perTool, "gws_work", get(mail)), false, "the connection isn't one of the check's sources")
    // Google Workspace as a connection of its own (workbotAgentBrief): its mail, and its other reads, open.
    const asSource = agentRead.agentReadAllowlist(new Set(["mcp:read", ...agentRead.agentReadScopes({ kinds: [], connectionIds: ["gws_work"], tools: [], nativeReads: [{ connectionId: "gws_work", denied: ["listGmailMessages"] }] })]))
    assert.ok(asSource)
    assert.equal(agentRead.agentMayUseNative(asSource, "gws_work", get(mail, "getGmailMessage")), true)
    assert.equal(agentRead.agentMayUseNative(asSource, "gws_work", get(mail, "listGmailMessages")), false, "a read an admin turned off")
    assert.equal(agentRead.agentMayUseNative(asSource, "gws_work", { method: "POST", path: "/v1/capabilities/google-workspace/gmail-drafts" }), false, "never a write")
    assert.equal(agentRead.agentMayUseNative(asSource, "gws_work", get("/v1/capabilities/google-workspace/calendar-events")), false, "the calendar is its own setting, and it is off here")
    assert.equal(agentRead.agentMayUseNative(asSource, "gws_personal", get(mail)), false, "another account isn't on the token")
  })

  test("a connection's tools: only its service's reviewed reads; provider hints and read-shaped names never are enough", () => {
    const allowlist = { kinds: new Set<"calendar">(), connectionIds: new Set([SLACK.id, NOTES.id, "emc_crm"]), pairs: new Set<string>() }
    const slack = { id: SLACK.id, url: SLACK.url }
    assert.equal(agentRead.agentMayUseExternalTool(allowlist, slack, { name: "slack_read_thread" }), true, "reviewed")
    assert.equal(agentRead.agentMayUseExternalTool(allowlist, slack, { name: "slack_send_message" }), false)
    assert.equal(agentRead.agentMayUseExternalTool(allowlist, slack, { name: "slack_add_reaction" }), false)
    assert.equal(agentRead.agentMayUseExternalTool(allowlist, { id: NOTES.id, url: NOTES.url }, { name: "get_meeting_transcript" }), true)
    const crm = { id: "emc_crm", url: "https://mcp.crm.example/mcp" }
    assert.equal(agentRead.agentMayUseExternalTool(allowlist, crm, { name: "search_contacts" }), false, "a service without a reviewed list: nothing")
    assert.equal(agentRead.agentReadableConnection(crm.url), false)
    assert.equal(agentRead.agentMayUseExternalTool(allowlist, { id: "emc_other", url: SLACK.url }, { name: "slack_read_thread" }), false, "not one of its sources")
  })

  test("links: only the service's own site from a fixed list, never a domain derived from a hostname", () => {
    assert.deepEqual(agentRead.serviceLinkDomains(SLACK.url), ["slack.com"])
    assert.deepEqual(agentRead.serviceLinkDomains("https://mcp.vendor.co.uk/mcp"), [])
  })
})

describe("a member's sources, in chat or on the page", () => {
  const admin = { ...settingsOn }
  let next = 0
  const newId = () => `chg_s${++next}`
  const connections = [GOOGLE, SLACK, NOTES, { id: "emc_01k8z5wq0s0000000000000003", name: "Issue tracker", url: "https://mcp.linear.app/mcp", native: null, state: "needs_connection" as const }]
  const resolved = (policy = admin.sources, stored = preferences.emptyStoredPreferences()) => resolveMemberSources({ connections, policy, choices: stored.sources, lastLook: {} })
  const change = (request: Parameters<typeof preferences.applyMemberAgentChange>[0]["request"], stored = preferences.emptyStoredPreferences(), policy = admin.sources) =>
    preferences.applyMemberAgentChange({ request, overrides: null, stored, settings: { ...admin, sources: policy }, source: "chat", now: NOW, newId, sources: resolved(policy, stored) })

  test("only services agents can read are sources of their own", () => {
    const listed = resolveMemberSources({ connections: [...connections, { id: "emc_crm", name: "CRM", url: "https://mcp.crm.example/mcp", native: null, state: "connected" }], policy: admin.sources, choices: {}, lastLook: {} })
    assert.deepEqual(listed.map((source) => source.id), ["calendar", SLACK.id, NOTES.id, "emc_01k8z5wq0s0000000000000003"], "the calendar, then each connection with reviewed reads: no email or chat, and Google Workspace is only the calendar")
  })

  test("\"also look at my meeting notes for action items, and skip the issue tracker\": saved by name, one line per source, Connect where needed", () => {
    const saved = change({ sources: [{ source: "Meeting notes", on: true, instruction: "Use for meeting context and action items after meetings." }, { source: "issue tracker", on: false }, { source: "Wiki", on: true }] })
    assert.ok(saved.ok)
    assert.deepEqual(saved.lines, ["Meeting notes on, for “Use for meeting context and action items after meetings.”", "Issue tracker off"])
    assert.deepEqual(saved.connect, [{ name: "Wiki", connectionId: null }], "a source nobody has connected is one Connect line")
    assert.deepEqual(saved.stored.sources[NOTES.id], { on: true, instruction: "Use for meeting context and action items after meetings.", changedFrom: "chat", changedAt: NOW })
    assert.equal(preferences.savedReply({ lines: saved.lines, undid: false, undoable: true, connect: [{ name: "Wiki", href: "https://den.example/dashboard/library/connectors/new" }] }, "https://den.example/dashboard/my-bot"),
      "Saved:\n- Meeting notes on, for “Use for meeting context and action items after meetings.”\n- Issue tracker off\nConnect Wiki: https://den.example/dashboard/library/connectors/new\nReply \"undo\" to revert. My bot: https://den.example/dashboard/my-bot")
    const tracker = change({ sources: [{ source: "Issue tracker", on: true }] })
    assert.ok(tracker.ok)
    assert.deepEqual(tracker.connect, [{ name: "Issue tracker", connectionId: "emc_01k8z5wq0s0000000000000003" }], "on, but their account isn't connected yet")
  })

  test("the admin's policy is enforced on the server: no widening, no turning off what is on for everyone", () => {
    assert.deepEqual(change({ sources: [{ source: "Meeting notes", on: true }] }, preferences.emptyStoredPreferences(), { ...admin.sources, connections: { [NOTES.id]: "off" } }),
      { ok: false, status: 400, error: "source_not_allowed", message: "Meeting notes isn't allowed for agents in your organization. An admin can change it in Workbot's settings." })
    assert.deepEqual(change({ sources: [{ source: "Slack", on: false }] }),
      { ok: false, status: 400, error: "source_locked", message: "Slack is on for everyone in your organization. An admin can change it in Workbot's settings." })
    const steer = change({ sources: [{ source: "slack", instruction: "Skip #random." }] })
    assert.ok(steer.ok, "an instruction on a source that is on for everyone is fine")
    assert.deepEqual(steer.lines, ["Slack: “Skip #random.”"])
    const gone = change({ sources: [{ source: "email", on: false }] })
    assert.ok(gone.ok)
    assert.deepEqual([gone.lines, gone.connect], [[], [{ name: "email", connectionId: null }]], "email is no source: nothing is saved for it")
  })

  test("undo reverts a source change like any other", () => {
    const saved = change({ sources: [{ source: "Meeting notes", on: true }] })
    assert.ok(saved.ok)
    const undone = change({ undo: "last" }, saved.stored)
    assert.ok(undone.ok && undone.undid)
    assert.equal(undone.stored.sources[NOTES.id]?.on, undefined, "back to the default")
    assert.deepEqual(undone.lines, ["Meeting notes: back to your organization's default"])
    const changes = preferences.memberAgentChanges(saved.stored, admin, new Map([[NOTES.id, "Meeting notes"]]))
    assert.deepEqual(changes.map((entry) => [entry.field, entry.sourceId, entry.summary]), [["source", NOTES.id, "Meeting notes on"]])
  })
})

describe("connections as sources", () => {
  /** An MCP connection whose service has no reviewed read tools: never a source. */
  const CRM: MemberConnection = { id: "emc_01k8z5wq0s0000000000000009", name: "Acme CRM", url: "https://mcp.crm.example/mcp", native: null, state: "connected" }
  const TRACKER: MemberConnection = { id: "emc_01k8z5wq0s0000000000000003", name: "Issue tracker", url: "https://mcp.linear.app/mcp", native: null, state: "connected" }
  const org = [GOOGLE, { ...GOOGLE, id: "gws_personal", name: "Google Workspace - Personal" }, SLACK, NOTES, TRACKER, CRM]

  test("a Google Workspace set up before connections had rows is listed for the admin next to the newer one", async () => {
    const listed = await listOrganizationSourceConnections(organizationId, {
      rows: async () => [{ id: "gws_personal", name: "Google Workspace - Personal", url: "https://workspace.google.com", kind: "native_provider", nativeProviderKey: "google-workspace" }],
      hasLegacyClient: async (_org, providerId) => providerId === "google-workspace",
    })
    assert.deepEqual(listed.map((connection) => [connection.id, connection.native]), [["google-workspace", "google-workspace"], ["gws_personal", "google-workspace"]])
    const groups = groupSourceConnections(listed)
    assert.deepEqual(groups.calendar.map((connection) => connection.id), ["google-workspace", "gws_personal"], "both serve the calendar; nobody picks one")
    assert.deepEqual(groups.all.map((option) => [option.id, option.native, option.slots.join(",")]), [
      ["google-workspace", true, "calendar"],
      ["gws_personal", true, "calendar"],
    ])
    assert.deepEqual(Object.keys(groups).sort(), ["all", "calendar", "other"], "no email, chat or defaults")
    const none = await listOrganizationSourceConnections(organizationId, { rows: async () => [], hasLegacyClient: async () => false })
    assert.deepEqual(none, [])
  })

  test("only MCPs with reviewed read tools can be added, as connections of their own; any other MCP isn't offered", () => {
    const groups = groupSourceConnections([SLACK, NOTES, CRM])
    assert.deepEqual(groups.all.map((option) => [option.id, option.slots.join(",")]), [[SLACK.id, "other"], [NOTES.id, "other"]], "the CRM isn't offered at all; nothing can be added to the calendar")
    assert.deepEqual(groups.other.map((connection) => connection.id), [SLACK.id, NOTES.id], "Slack is a connection like any other")
    assert.deepEqual(groups.calendar, [])
  })

  test("the connections agents read are what the admin added; the last one removed reads nothing; an unreviewed MCP is never read", async () => {
    const sources = { ...settingsOn.sources, otherConnections: [TRACKER.id], connections: { [TRACKER.id]: "everyone" as const } }
    const listed = resolveMemberSources({ connections: org, policy: sources, choices: {}, lastLook: {} })
    assert.deepEqual(listed.map((source) => source.id), ["calendar", TRACKER.id], "Slack and Granola were not added: no longer sources")
    const calendar = listed.find((source) => source.id === "calendar")
    assert.deepEqual(calendar?.options.map((connection) => connection.id), [GOOGLE.id, "gws_personal"], "every calendar app, with no admin pick")
    assert.deepEqual(calendar?.connections.map((connection) => connection.id), [GOOGLE.id], "one read")
    const h = harness({ connections: [GOOGLE, SLACK, NOTES, TRACKER, CRM], settings: { sources } })
    await h.run()
    const scopes = h.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes(`openwork:agent-connection:${TRACKER.id}`) && scopes.includes(`openwork:agent-core:calendar:${GOOGLE.id}`))
    assert.ok(!scopes.some((scope) => scope.includes(SLACK.id) || scope.includes(NOTES.id)), "connections the admin didn't add are not on the token")
    assert.ok(!scopes.some((scope) => scope.includes(CRM.id)), "an MCP without reviewed reads is never on the token")
    assert.deepEqual(h.state.calendarVia, [GOOGLE.id], "only Google's calendar wakes the agent early")
    const empty = resolveMemberSources({ connections: org, policy: { ...sources, otherConnections: [] }, choices: {}, lastLook: {} })
    assert.deepEqual(empty.map((source) => source.id), ["calendar"], "the last one removed: only the calendar is read")
    const sneaked = resolveMemberSources({ connections: org, policy: { ...sources, otherConnections: [CRM.id, GOOGLE.id] }, choices: {}, lastLook: {} })
    assert.deepEqual(sneaked.map((source) => source.id), ["calendar"], "even if saved, an unreviewed MCP or Den's own provider isn't read as a connection")
  })

  test("a policy saved with email, chat and picked apps reads as the calendar and its connections; null resets the list", () => {
    const old = { calendar: "everyone", email: "members", chat: "off", coreConnections: { email: ["google-workspace"], calendar: ["gws_personal"] }, coreDefaults: { calendar: "gws_personal" }, connections: { [NOTES.id]: "everyone" } }
    const read = readWorkbotProactiveSettings({ workbot: { proactive: { sources: old } } }).sources
    assert.deepEqual(read, { calendar: "everyone", connections: { [NOTES.id]: "everyone" } })
    const resolvedOld = resolveMemberSources({ connections: org, policy: read, choices: {}, lastLook: {} })
    assert.deepEqual(resolvedOld.map((source) => [source.id, source.on, source.connections.map((connection) => connection.id).join(",")]), [
      ["calendar", true, "google-workspace"], [SLACK.id, false, SLACK.id], [NOTES.id, true, NOTES.id], [TRACKER.id, false, TRACKER.id],
    ], "the saved pick of a calendar app is gone: automatic; chat \"off\" no longer holds Slack back, it is up to each member like any connection")
    assert.deepEqual(resolvedOld.find((source) => source.id === "calendar")?.options.map((connection) => connection.id), ["google-workspace", "gws_personal"])
    const added = mergeWorkbotProactiveSettings({ ...settingsOn, sources: read }, { sources: { otherConnections: [TRACKER.id, TRACKER.id] } })
    assert.deepEqual(added?.sources.otherConnections, [TRACKER.id])
    const reset = added && mergeWorkbotProactiveSettings(added, { sources: { otherConnections: null } })
    assert.deepEqual(reset?.sources, read)
  })

  test("an admin's change is checked: the organization's connections, and only reviewed MCPs", () => {
    const connections = org.map(({ id, name, url, native }) => ({ id, name, url, native }))
    const check = (change: Parameters<typeof checkSourcesChange>[0]["change"]) => checkSourcesChange({ change, connections })
    assert.equal(check({ calendar: "members", otherConnections: [TRACKER.id, SLACK.id], connections: { [SLACK.id]: "everyone" } }), null)
    assert.equal(check({ otherConnections: [CRM.id] }), "Agents can't read Acme CRM yet.")
    assert.equal(check({ connections: { [CRM.id]: "everyone" } }), "Agents can't read Acme CRM yet.")
    assert.equal(check({ connections: { [CRM.id]: null } }), null)
    assert.equal(check({ otherConnections: [GOOGLE.id] }), "Google Workspace can't be other context.")
    assert.equal(check({ connections: { [GOOGLE.id]: "everyone" } }), "Agents can't read Google Workspace yet.", "without Your agent's brief, Den's own provider is only the calendar")
    assert.equal(check({ otherConnections: ["emc_nope"] }), "No connection emc_nope in this organization.")
    assert.equal(check({ toolOverrides: { [SLACK.id]: { slack_read_thread: "deny" } } }), "Choosing tools for agents isn't on for this organization.")
    const withBrief = (change: Parameters<typeof checkSourcesChange>[0]["change"]) => checkSourcesChange({ change, connections, mode: "any" })
    assert.equal(withBrief({ connections: { [GOOGLE.id]: "everyone", [CRM.id]: "members" } }), null, "with the brief, any connection: Google Workspace for its mail and files")
  })
})

describe("the calendar: no admin pick, each member's agent reads one calendar app", () => {
  const WORK: MemberConnection = { ...GOOGLE, id: "gws_work", name: "Acme Google" }
  const PERSONAL: MemberConnection = { ...GOOGLE, id: "gws_personal", name: "Personal Google", state: "needs_connection" }
  const MICROSOFT: MemberConnection = { id: "m365_main", name: "Microsoft 365", url: "https://microsoft.com", native: "microsoft-365", state: "needs_connection" }
  const base = settingsOn.sources
  const calendarOf = (input: { connections: MemberConnection[]; choice?: string; counts?: Map<string, number> }) => {
    const source = resolveMemberSources({
      connections: input.connections,
      policy: base,
      choices: input.choice ? { calendar: { connectionId: input.choice } } : {},
      lastLook: {},
      connectedMembers: input.counts,
    }).find((entry) => entry.id === "calendar")
    return { id: source?.connections[0]?.id ?? null, state: source?.connections[0]?.state ?? null, chosenBy: source?.chosenBy ?? null, options: source?.options.map((connection) => connection.id) ?? [], count: source?.connections.length ?? 0 }
  }

  test("the member's pick wins, even before they connect it; a pick that is no longer a calendar app is ignored", () => {
    assert.deepEqual(calendarOf({ connections: [WORK, PERSONAL], choice: PERSONAL.id }), { id: PERSONAL.id, state: "needs_connection", chosenBy: "member", options: [WORK.id, PERSONAL.id], count: 1 })
    assert.deepEqual(calendarOf({ connections: [WORK], choice: PERSONAL.id }), { id: WORK.id, state: "connected", chosenBy: "auto", options: [WORK.id], count: 1 }, "the organization removed it: back to automatic")
    assert.deepEqual(calendarOf({ connections: [WORK, SLACK], choice: SLACK.id }).id, WORK.id, "only a calendar app can be picked")
  })

  test("else the one most members connected when the member's account is ready; else one they already connected; else that one to connect", () => {
    const connectedPersonal = { ...PERSONAL, state: "connected" as const }
    const counts = new Map([[WORK.id, 1], [PERSONAL.id, 6]])
    assert.deepEqual(calendarOf({ connections: [WORK, connectedPersonal], counts }), { id: PERSONAL.id, state: "connected", chosenBy: "auto", options: [WORK.id, PERSONAL.id], count: 1 })
    assert.deepEqual(calendarOf({ connections: [WORK, PERSONAL], counts }), { id: WORK.id, state: "connected", chosenBy: "auto", options: [WORK.id, PERSONAL.id], count: 1 }, "never asked to connect the popular one when another is ready")
    const nothing = calendarOf({ connections: [{ ...WORK, state: "needs_connection" }, PERSONAL], counts })
    assert.deepEqual([nothing.id, nothing.state, nothing.chosenBy], [PERSONAL.id, "needs_connection", "auto"], "nothing connected: the popular one, to connect")
    assert.deepEqual(calendarOf({ connections: [SLACK, NOTES] }), { id: null, state: null, chosenBy: null, options: [], count: 0 }, "no calendar app at all: nothing to read")
  })

  test("the automatic choice is the calendar app most members connected; unknown counts go to the first", () => {
    const counts = new Map([[WORK.id, 2], [MICROSOFT.id, 5]])
    const notConnected = [{ ...WORK, state: "needs_connection" as const }, MICROSOFT]
    assert.deepEqual(calendarOf({ connections: notConnected, counts }).id, MICROSOFT.id)
    assert.deepEqual(calendarOf({ connections: notConnected, counts }).chosenBy, "auto")
    assert.deepEqual(calendarOf({ connections: notConnected }).id, WORK.id, "without counts: the first")
    assert.deepEqual(calendarOf({ connections: [MICROSOFT, { ...WORK, state: "needs_connection" }], counts: new Map([[WORK.id, 1]]) }).id, WORK.id)
  })

  test("only the chosen connection is on the token and in connect notices: an unused personal account is never asked for", async () => {
    const h = harness({ connections: [WORK, PERSONAL, SLACK] })
    await h.run()
    assert.deepEqual(h.state.delivered, [], "no Connect message for the personal account")
    assert.deepEqual(h.state.calendarVia, [WORK.id])
    const scopes = h.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes(`openwork:agent-core:calendar:${WORK.id}`))
    assert.ok(!scopes.some((scope) => scope.includes(PERSONAL.id)), "nothing of the personal account on the token")
  })

  test("the calendar wake reads the Google connection the member picked, and only it", async () => {
    const both = [WORK, { ...PERSONAL, state: "connected" as const }, SLACK]
    const picked = JSON.stringify({ v: 1, words: { always: "", never: "", when: "", how: "" }, sources: { calendar: { connectionId: PERSONAL.id } }, log: [] })
    const h = harness({ connections: both, row: { preferences: picked } })
    await h.run()
    assert.deepEqual(h.state.calendarVia, [PERSONAL.id])
    const scopes = h.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes(`openwork:agent-core:calendar:${PERSONAL.id}`) && !scopes.includes(`openwork:agent-core:calendar:${WORK.id}`))
    assert.ok(!scopes.some((scope) => scope.includes(WORK.id)), "the account they didn't pick is not on the token at all")
    const notConnected = harness({ connections: [WORK, PERSONAL, SLACK], row: { preferences: picked } })
    await notConnected.run()
    assert.deepEqual(notConnected.state.calendarVia, [], "picked but not connected: no calendar read through another account")
    assert.deepEqual(notConnected.state.delivered, ["Quick check: I can't read your Google Calendar, so I've paused checking it and kept reading the rest. <https://den.example/dashboard/library/connectors/gws_personal|Connect Google Workspace>"])
  })

  test("a member picks where the calendar reads from, only among the calendar apps; it is logged and undone like any change", () => {
    let next = 0
    const newId = () => `chg_g${++next}`
    const connections = [WORK, PERSONAL, SLACK, NOTES]
    const change = (request: Parameters<typeof preferences.applyMemberAgentChange>[0]["request"], stored = preferences.emptyStoredPreferences(), policy = base) =>
      preferences.applyMemberAgentChange({ request, overrides: null, stored, settings: { ...settingsOn, sources: policy }, source: "chat", now: NOW, newId, sources: resolveMemberSources({ connections, policy, choices: stored.sources, lastLook: {} }) })
    assert.deepEqual(change({ sources: [{ source: "calendar", connectionId: SLACK.id }] }), { ok: false, status: 400, error: "connection_not_allowed", message: "Calendar can't read from that connection. Choose one of your organization's calendar apps." })
    assert.deepEqual(change({ sources: [{ source: "Meeting notes", connectionId: NOTES.id }] }), { ok: false, status: 400, error: "connection_not_allowed", message: "Meeting notes always reads its own connection. Only the calendar reads from a connection you pick." })
    assert.equal(change({ sources: [{ source: "calendar", connectionId: WORK.id }] }, preferences.emptyStoredPreferences(), { ...base, calendar: "off" }).ok, false, "not allowed at all")

    const saved = change({ sources: [{ source: "my calendar", connectionId: PERSONAL.id }] })
    assert.ok(saved.ok)
    assert.deepEqual(saved.lines, ["Calendar: reads Personal Google"])
    assert.equal(saved.wake, true)
    assert.equal(saved.stored.sources.calendar?.connectionId, PERSONAL.id)
    assert.deepEqual(saved.connect, [{ name: "Personal Google", connectionId: PERSONAL.id }], "it needs connecting: one Connect line")
    assert.equal(preferences.savedReply({ lines: saved.lines, undid: false, undoable: true, connect: [{ name: "Personal Google", href: "https://den.example/c" }] }, "L"),
      "Saved:\n- Calendar: reads Personal Google\nConnect Personal Google: https://den.example/c\nReply \"undo\" to revert. My bot: L")
    const names = preferences.sourceConnectionNames(resolveMemberSources({ connections, policy: base, choices: saved.stored.sources, lastLook: {} }))
    assert.deepEqual(preferences.memberAgentChanges(saved.stored, settingsOn, new Map([["calendar", "Calendar"]]), 20, names).map((entry) => [entry.field, entry.sourceId, entry.summary]), [["sourceConnection", "calendar", "Calendar: reads Personal Google"]])

    const undone = change({ undo: "last" }, saved.stored)
    assert.ok(undone.ok && undone.undid)
    assert.equal(undone.stored.sources.calendar?.connectionId, undefined, "back to the previous choice: none")
    assert.deepEqual(undone.lines, ["Calendar: back to your organization's default"])
    const again = change({ sources: [{ source: "calendar", connectionId: WORK.id }] }, saved.stored)
    assert.ok(again.ok)
    const reverted = change({ undo: "last" }, again.stored)
    assert.ok(reverted.ok)
    assert.equal(reverted.stored.sources.calendar?.connectionId, PERSONAL.id, "undo restores the previous pick")
  })

  test("choices a member saved for email or team chat are kept as stored and read nothing", () => {
    const old = preferences.parseStoredPreferences(JSON.stringify({ v: 1, words: { always: "", never: "", when: "", how: "" }, sources: { chat: { on: false, changedFrom: "page", changedAt: 1 }, email: { connectionId: "gws_work" } }, log: [] }))
    assert.deepEqual(old.sources, { chat: { on: false, changedFrom: "page", changedAt: 1 }, email: { connectionId: "gws_work" } }, "still parsed: nothing is lost on read")
    const resolved = resolveMemberSources({ connections: [GOOGLE, SLACK], policy: base, choices: old.sources, lastLook: {} })
    assert.deepEqual(resolved.map((source) => [source.id, source.on, source.connections.map((connection) => connection.name).join(","), source.chosenBy]), [
      ["calendar", true, "Google Calendar", "auto"], [SLACK.id, true, "Slack", null],
    ], "no email or chat source for them to apply to; Slack follows its own policy")
  })

  test("the admin's view: the calendar apps with each one's member count, and every connection that is a source of its own", async () => {
    const org = [
      { id: "gws_work", name: "Acme Google", url: "https://google.com", native: "google-workspace" },
      { id: "m365_main", name: "Microsoft 365", url: "https://microsoft.com", native: "microsoft-365" },
      { id: SLACK.id, name: "Slack", url: SLACK.url, native: null },
    ]
    const counts = new Map([["gws_work", 3], ["m365_main", 7]])
    const reviewed = groupSourceConnections(org, { connectedMembers: counts })
    assert.deepEqual(reviewed.calendar.map((entry) => [entry.id, entry.connectedMembers]), [["gws_work", 3], ["m365_main", 7]])
    assert.deepEqual(reviewed.other, [{ id: SLACK.id, name: "Slack", url: SLACK.url }], "Slack is a connection of its own; Den's providers are only the calendar")
    assert.deepEqual(reviewed.all.map((entry) => [entry.id, entry.slots.join(","), entry.connectedMembers]), [["gws_work", "calendar", 3], ["m365_main", "calendar", 7], [SLACK.id, "other", null]], "a shared Slack: unknown")
    const any = groupSourceConnections(org, { connectedMembers: counts, mode: "any", policy: { ...base, connections: { gws_work: "everyone" } } })
    assert.deepEqual(any.other.map((entry) => [entry.id, entry.native, entry.policy]), [["gws_work", true, "everyone"], ["m365_main", true, "members"], [SLACK.id, false, "members"]], "with the brief, Den's providers are connections too: their mail, chats and files")
    assert.deepEqual(any.all.map((entry) => [entry.id, entry.slots.join(",")]), [["gws_work", "calendar,other"], ["m365_main", "calendar,other"], [SLACK.id, "other"]])

    const counted = await countConnectedMembers(organizationId, {
      rows: async () => [
        { id: "gws_work", kind: "native_provider", authType: "oauth", credentialMode: "per_member" },
        { id: "emc_personal_signin", kind: "external_mcp", authType: "oauth", credentialMode: "per_member" },
        { id: "emc_shared", kind: "external_mcp", authType: "oauth", credentialMode: "shared" },
        { id: "emc_open", kind: "external_mcp", authType: "none", credentialMode: "per_member" },
      ],
      accounts: async () => [{ providerId: "gws_work", members: 4 }, { providerId: "google-workspace", members: 1 }, { providerId: "emc_shared", members: 9 }],
    })
    assert.equal(counted.get("gws_work"), 4)
    assert.equal(counted.get("google-workspace"), 1, "a provider set up before connections had rows")
    assert.equal(counted.get("microsoft-365"), 0)
    assert.equal(counted.get("emc_personal_signin"), 0, "each member signs in: counted, none yet")
    assert.equal(counted.has("emc_shared") || counted.has("emc_open"), false, "a shared credential or no sign-in: unknown")
  })
})
