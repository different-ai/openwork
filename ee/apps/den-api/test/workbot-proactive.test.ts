import assert from "node:assert/strict"
import { describe, mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { agentLedgerKey, AGENT_WAKE_MARKER, parseAgentReply, parseAgentState } from "@openwork/automations/proactive"
import {
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_WORKBOT_PROACTIVE_SETTINGS,
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
const bootstrapSelect = mock.method(db, "select", () => ({
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
const settingsOn: WorkbotProactiveSettings = { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true }

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
function harness(input: { settings?: Partial<WorkbotProactiveSettings>; row?: Partial<AgentInstanceRow>; replies?: (string | AgentTurnResult)[]; sentToday?: number; allowed?: boolean[]; blocked?: AgentDestinationBlock; library?: boolean; google?: "ok" | "needs_connection" | Partial<Record<string, "ok" | "needs_connection" | "missing_scope">>; sendFails?: boolean; connections?: MemberConnection[] }) {
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
    library: async () => input.library ?? false,
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
    assert.match(h.state.turns[0]?.prompt ?? "", /- email: Email through Gmail: their inbox\. never read yet\./)
    assert.deepEqual(h.state.delivered, [])
    const saved = parseAgentState(h.state.row.state)
    assert.equal(saved.lastPassAt, NOW)
    assert.equal(saved.nextPassAt, NOW + 3 * 3_600_000, "the next check is in about three hours")
    assert.deepEqual(saved.lastLook, { calendar: NOW, email: NOW, chat: NOW }, "every source it read, by id")
    assert.equal(h.state.row.nextWakeAt.getTime(), NOW + 5 * 60_000, "the calendar is looked at again in five minutes")
  })

  test("a message is delivered once; the same item is never delivered again", async () => {
    const reply = message("Northwind is waiting on the renewal proposal (since 9:10 AM).", [{ responsibility: "waiting_on_you", ref: "thread-abc" }])
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
    const h = harness({ replies: [message("A thread is waiting.", [{ responsibility: "waiting_on_you", ref: "t1" }])] })
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
    const h = harness({ sentToday: 3, replies: [message("Two threads are waiting on you.", [{ responsibility: "waiting_on_you", ref: "t1" }])] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "daily_limit" })
    assert.deepEqual(h.state.delivered, [])
    assert.equal(h.state.ledger.get("email:t1"), "capped")
  })

  test("a muted responsibility is neither asked about nor delivered", async () => {
    const h = harness({ row: { overrides: { muted: ["waiting_on_you"] } }, replies: [message("A thread is waiting.", [{ responsibility: "waiting_on_you", ref: "t1" }])] })
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
    const h = harness({ allowed: [true, false], replies: [message("A thread is waiting.", [{ responsibility: "waiting_on_you", ref: "t1" }])] })
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

  test("the connections behind calendar, email and chat: picked per source, kept across other changes, null goes back to all", () => {
    assert.equal(DEFAULT_WORKBOT_PROACTIVE_SETTINGS.sources.coreConnections, undefined, "unpicked: every connection that serves it")
    const picked = mergeWorkbotProactiveSettings(DEFAULT_WORKBOT_PROACTIVE_SETTINGS, { sources: { coreConnections: { email: ["gws_work", "gws_work"], calendar: ["gws_work"] } } })
    assert.deepEqual(picked?.sources.coreConnections, { calendar: ["gws_work"], email: ["gws_work"] })
    const kept = picked && mergeWorkbotProactiveSettings(picked, { sources: { chat: "off" } })
    assert.deepEqual(kept?.sources.coreConnections, { calendar: ["gws_work"], email: ["gws_work"] })
    const reset = kept && mergeWorkbotProactiveSettings(kept, { sources: { coreConnections: { email: null, calendar: null } } })
    assert.equal(reset?.sources.coreConnections, undefined)
    assert.equal(readWorkbotProactiveSettings({ workbot: { proactive: { sources: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS.sources } } } }).sources.coreConnections, undefined, "policies saved before picks read as before")
  })
})

describe("My agent: every check is recorded for the member (workbotAgentLibrary)", () => {
  const reply = (responsibility: string, ref: string, extra: Record<string, unknown> = {}) => JSON.stringify({ message: "A thread is waiting.", items: [{ responsibility, ref }], ...extra })
  const only = (h: { state: HarnessState }) => {
    assert.equal(h.state.records.length, 1, JSON.stringify(h.state.records))
    const [record] = h.state.records
    assert.ok(record)
    return { outcome: record.outcome, reason: record.reason, summary: record.summary, kind: record.kind, responsibilities: record.responsibilities }
  }

  test("off, nothing is recorded and the agent follows the organization's limits, without the member's words", async () => {
    const h = harness({ row: { overrides: { hours: { startHour: 9, endHour: 12 } }, preferences: JSON.stringify({ v: 1, words: { always: "Payroll", never: "", when: "", how: "" }, log: [] }) } })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null }, "13:45 is inside the organization's 8–7")
    assert.deepEqual(h.state.records, [])
    assert.doesNotMatch(h.state.turns[0]?.prompt ?? "", /own words|Payroll/)
  })

  test("stayed quiet, sent, held by the daily limit: each check says what happened and why", async () => {
    const quiet = harness({ library: true })
    await quiet.run()
    assert.deepEqual(only(quiet), { outcome: "quiet", reason: "nothing_new", summary: "Stayed quiet: nothing new.", kind: "morning", responsibilities: [] })

    const sent = harness({ library: true, replies: [reply("waiting_on_you", "t1")] })
    await sent.run()
    assert.deepEqual(only(sent), { outcome: "sent", reason: "sent", summary: "Sent you a message about waiting on you.", kind: "morning", responsibilities: ["waiting_on_you"] })
    assert.deepEqual(sent.state.records[0]?.message, { channelId: "D0DM", messageTs: "1700000000.0001", permalink: "https://example.slack.com/archives/D0DM/p17000000000001" }, "a reference to the DM, never its text")
    sent.state.clock = NOW + 3 * 3_600_000
    await sent.run()
    assert.equal(sent.state.records.length, 2, "each check that ran is its own record")
    assert.deepEqual([sent.state.records[1]?.reason, sent.state.records[1]?.kind], ["nothing_new", "scheduled"])

    const capped = harness({ library: true, sentToday: 3, replies: [reply("waiting_on_you", "t2")] })
    await capped.run()
    assert.deepEqual(only(capped), { outcome: "quiet", reason: "daily_limit", summary: "Stayed quiet: daily limit reached (3 a day). Held a message about waiting on you.", kind: "morning", responsibilities: ["waiting_on_you"] })

    const told = harness({ library: true, row: { overrides: { muted: ["waiting_on_you"] } }, replies: [reply("waiting_on_you", "t3")] })
    await told.run()
    assert.equal(only(told).reason, "already_told")
  })

  test("outside the member's hours, inside their quiet window, or snoozed, it waited", async () => {
    const narrowed = harness({ library: true, row: { timeZone: TZ, overrides: { hours: { startHour: 9, endHour: 13 } } } })
    assert.deepEqual(await narrowed.run(), { status: "skipped", reason: "outside_hours" }, "13:45 is after their own 1 PM")
    assert.deepEqual(only(narrowed), { outcome: "waited", reason: "outside_hours", summary: "Waited: outside your hours (9 AM–1 PM).", kind: "scheduled", responsibilities: [] })
    assert.equal(narrowed.state.row.nextWakeAt.toISOString(), "2026-10-21T13:00:00.000Z", "next look at their 9 AM")
    assert.equal(narrowed.state.turns.length, 0)

    const quietWindow = harness({ library: true, row: { overrides: { quietWindow: { startHour: 12, endHour: 14 } } }, replies: [reply("calendar_changes", "c1")] })
    assert.deepEqual(await quietWindow.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "quiet_window" })
    assert.deepEqual(quietWindow.state.delivered, [])
    assert.deepEqual(only(quietWindow), { outcome: "waited", reason: "quiet_window", summary: "Waited: only urgent messages 12 PM–2 PM. Held a message about calendar changes.", kind: "morning", responsibilities: ["calendar_changes"] })
    assert.equal(quietWindow.state.ledger.size, 0, "nothing is recorded as told, so it can come up after 2 PM")
    assert.match(quietWindow.state.turns[0]?.prompt ?? "", /Between 12 PM and 2 PM only urgent messages reach them/)

    const urgent = harness({ library: true, row: { overrides: { quietWindow: { startHour: 12, endHour: 14 } } }, replies: [reply("calendar_changes", "c2", { urgent: true })] })
    assert.deepEqual(await urgent.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "sent" }, "urgent goes out inside the window")

    const snoozed = harness({ library: true, row: { snoozedUntil: new Date(NOW + 3_600_000) } })
    await snoozed.run()
    assert.deepEqual(only(snoozed), { outcome: "waited", reason: "snoozed", summary: "Waited: snoozed.", kind: "scheduled", responsibilities: [] })
  })

  test("couldn't read Google, couldn't reach Slack, couldn't send, couldn't run: failed, with what to do", async () => {
    const google = harness({ library: true, google: "needs_connection" })
    await google.run()
    const notice = google.state.records.find((record) => record.reason === "source_disconnected")
    assert.deepEqual([notice?.outcome, notice?.summary, notice?.sources.map((source) => source.name)], ["failed", "Couldn't read Google Calendar and Gmail: connect your account again.", ["Google Calendar", "Gmail"]])
    assert.equal(google.state.records.find((record) => record.key.startsWith("ran:"))?.reason, "nothing_new", "it still read Slack")

    const unlinked = harness({ library: true, blocked: "member_not_linked" })
    await unlinked.run()
    assert.deepEqual(only(unlinked).summary, "Couldn't reach you: link your Slack account to Workbot.")

    const failed = harness({ library: true, sendFails: true, replies: [reply("waiting_on_you", "t9")] })
    await failed.run()
    assert.deepEqual(only(failed), { outcome: "failed", reason: "send_failed", summary: "Couldn't send the message in Slack.", kind: "morning", responsibilities: ["waiting_on_you"] })

    const outage = harness({ library: true, replies: [{ kind: "unavailable", code: "runner_unreachable" }] })
    await outage.run()
    assert.equal(only(outage).reason, "agent_unavailable")

    const killed = harness({ library: true, allowed: [true, false], replies: [reply("waiting_on_you", "t10")] })
    await killed.run()
    assert.deepEqual(killed.state.records, [], "a kill switch right before sending is not the member's failure")
  })

  test("the member's own words reach the prompt as data they wrote", async () => {
    const words = { always: "Anything from payroll", never: "Newsletters", when: "", how: "One line each" }
    const h = harness({ library: true, row: { preferences: JSON.stringify({ v: 1, words, log: [] }) } })
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
    const reply = message(`Worth catching: a pricing question came in on Slack before your 2 PM call. I haven't checked the email thread yet. <${SLACK_LINK}|Slack message>`, [{ source: "chat", id: SLACK_LINK }])
    const h = harness({ replies: [reply, reply] })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "sent" })
    assert.match(h.state.delivered[0] ?? "", new RegExp(`<${SLACK_LINK.replaceAll(".", "\\.")}\\|Slack message>`), "a link to the Slack message it read stays")
    assert.equal(h.state.ledger.get(`chat:${SLACK_LINK}`), "sent")
    h.state.clock = NOW + 3 * 3_600_000
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" })
    assert.equal(h.state.delivered.length, 1)
    assert.ok(h.state.turns[0]?.scopes.includes(scopeFor(SLACK.id)) && h.state.turns[0]?.scopes.includes("openwork:agent-source:chat"), "the turn's token may read Slack")
  })

  test("an item naming its source the way people do (\"slack\") is the same source; one from a source it didn't read is dropped", async () => {
    const h = harness({ replies: [message("Worth catching: x.", [{ source: "slack", id: "C1:1" }, { source: "emc_unknown", id: "X-1" }])] })
    await h.run()
    assert.deepEqual([...h.state.ledger.keys()], ["chat:C1:1"])
  })

  test("the member's source switches and instructions change the allowlist and the prompt; the admin's \"not allowed\" wins", async () => {
    const settings = { sources: { calendar: "everyone" as const, email: "everyone" as const, chat: "members" as const, connections: {} } }
    const h = harness({
      library: true,
      settings,
      connections: [GOOGLE, SLACK, NOTES],
      row: { preferences: withChoices({ chat: { on: false }, [NOTES.id]: { on: true, instruction: "Use my meeting notes for context and action items." } }) },
      replies: [message("Worth catching: x.", [{ source: "chat", id: "C1:2" }])],
    })
    assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" }, "chat is off for them, so its item is dropped")
    const turn = h.state.turns[0]
    assert.ok(turn)
    assert.ok(!turn.scopes.includes(scopeFor(SLACK.id)) && !turn.scopes.includes("openwork:agent-source:chat"), "no Slack on the token")
    assert.ok(turn.scopes.includes(scopeFor(NOTES.id)), "the connection they turned on is")
    assert.doesNotMatch(turn.prompt, /- chat:/)
    assert.match(turn.prompt, new RegExp(`- ${NOTES.id}: Meeting notes\\. never read yet\\. .*The person's instruction for it, in their own words: """Use my meeting notes for context and action items\\."""`))

    const blocked = harness({ library: true, connections: [GOOGLE, SLACK, NOTES], settings: { sources: { calendar: "everyone", email: "everyone", chat: "everyone", connections: { [NOTES.id]: "off" } } }, row: { preferences: withChoices({ [NOTES.id]: { on: true } }) } })
    await blocked.run()
    assert.ok(!blocked.state.turns[0]?.scopes.includes(scopeFor(NOTES.id)), "not allowed by the admin, whatever the member chose")
    const off = harness({ library: false, connections: [GOOGLE, SLACK, NOTES], row: { preferences: withChoices({ [NOTES.id]: { on: true } }) } })
    await off.run()
    assert.ok(!off.state.turns[0]?.scopes.includes(scopeFor(NOTES.id)), "without My agent, other connections stay off")
  })

  test("mutes still apply: a muted preset's item is dropped, anything else still goes out", async () => {
    const muted = { overrides: { muted: ["waiting_on_you"] } }
    const presetOnly = harness({ row: muted, replies: [message("Worth catching: x.", [{ source: "email", id: "t1", preset: "waiting_on_you" }])] })
    assert.deepEqual(await presetOnly.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "nothing_new" })
    const other = harness({ row: muted, replies: [message("Quick check: a security notice.", [{ source: "email", id: "t2" }])] })
    await other.run()
    assert.equal(other.state.delivered.length, 1)
  })

  test("a source that can't be read gets one message with the action that fixes it, is paused, and is told again only after it worked", async () => {
    const broken: MemberConnection = { ...GOOGLE, state: "reconnect" }
    const h = harness({ library: true, connections: [broken, SLACK] })
    await h.run()
    assert.deepEqual(h.state.delivered, ["Quick check: I can't read your Google Calendar and Gmail, so I've paused checking them and kept reading the rest. <https://den.example/dashboard/library/connectors/google-workspace|Reconnect Google Workspace>"])
    assert.ok(!h.state.turns[0]?.scopes.includes(scopeFor(GOOGLE.id)), "the paused source isn't on the token")
    assert.match(h.state.turns[0]?.prompt ?? "", /Turned on but not readable now, so don't try: Calendar \(needs reconnecting\), Email \(needs reconnecting\)\./)
    h.state.clock = NOW + 3 * 3_600_000
    await h.run()
    assert.equal(h.state.delivered.length, 1, "not repeated every run")
    const fixed = harness({ library: true, row: { state: JSON.stringify({ ...parseAgentState(h.state.row.state), nextPassAt: null }) } })
    await fixed.run()
    assert.deepEqual(parseAgentState(fixed.state.row.state).notices, {}, "working again: forgotten, so a later failure is told again")
  })

  test("with nothing readable, no turn: one message, a record, and checks pause", async () => {
    const h = harness({ library: true, connections: [{ ...GOOGLE, state: "needs_connection" }] })
    assert.deepEqual(await h.run(), { status: "skipped", reason: "no_sources" })
    assert.equal(h.state.turns.length, 0)
    assert.match(h.state.delivered[0] ?? "", /so I've paused your checks until it's fixed\. <https:\/\/den\.example\/dashboard\/library\/connectors\/google-workspace\|Connect Google Workspace>$/)
    assert.equal(h.state.records[0]?.reason, "source_disconnected")
    h.state.clock = NOW + 60 * 60_000
    await h.run()
    assert.equal(h.state.delivered.length, 1)
  })

  test("two Google accounts, the admin picked the work one: only it is read, and the other is never asked for", async () => {
    const work: MemberConnection = { ...GOOGLE, id: "gws_work", name: "Acme Google" }
    const personal: MemberConnection = { ...GOOGLE, id: "gws_personal", name: "Personal Google", state: "needs_connection" }
    const picked = { ...settingsOn.sources, coreConnections: { calendar: [work.id], email: [work.id] } }
    const h = harness({ library: true, connections: [work, personal, SLACK], settings: { sources: picked } })
    await h.run()
    assert.deepEqual(h.state.calendarVia, [work.id], "the calendar is read through the picked connection, not a default")
    assert.deepEqual(h.state.delivered, [], "no Connect message for the account the admin didn't pick")
    const scopes = h.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes("openwork:agent-core:email:gws_work") && scopes.includes("openwork:agent-core:calendar:gws_work"))
    assert.ok(!scopes.some((scope) => scope.includes(personal.id)), "nothing of the other account on the token")

    const unpicked = harness({ library: true, connections: [work, personal, SLACK] })
    await unpicked.run()
    assert.deepEqual(unpicked.state.calendarVia, [work.id], "unpicked: every connection serves it, and the connected one is read")
    assert.deepEqual(unpicked.state.delivered, [], "one connected account is enough; the other isn't asked for")
  })

  test("Google refusing the calendar it reads holds up only that, never falling back to another account", async () => {
    const work: MemberConnection = { ...GOOGLE, id: "gws_work", name: "Acme Google" }
    const personal: MemberConnection = { ...GOOGLE, id: "gws_personal", name: "Personal Google" }
    const scope = harness({ library: true, connections: [work, personal, SLACK], google: { [work.id]: "missing_scope" } })
    await scope.run()
    assert.deepEqual(scope.state.calendarVia, [work.id], "only the one connection the calendar reads is tried")
    assert.deepEqual(scope.state.delivered, ["Quick check: I can't read your Google Calendar, so I've paused checking it and kept reading the rest. <https://den.example/dashboard/library/connectors/gws_work|Reconnect Google Workspace>"])
    const scopes = scope.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes("openwork:agent-core:email:gws_work"), "the work account's email still reads")
    assert.ok(!scopes.some((entry) => entry.includes("calendar:gws_") || entry.includes(personal.id)), "no calendar, and nothing of the other account")

    const only = harness({ library: true, connections: [work, SLACK], google: { [work.id]: "missing_scope" } })
    await only.run()
    assert.deepEqual(only.state.delivered, ["Quick check: I can't read your Google Calendar, so I've paused checking it and kept reading the rest. <https://den.example/dashboard/library/connectors/gws_work|Reconnect Google Workspace>"])
  })

  test("the calendar turned off by the admin is neither read by Den nor offered to the agent", async () => {
    const h = harness({ settings: { sources: { calendar: "off", email: "everyone", chat: "everyone", connections: {} } } })
    await h.run()
    assert.equal(h.state.calendarReads, 0)
    assert.doesNotMatch(h.state.turns[0]?.prompt ?? "", /- calendar:/)
    assert.ok(!h.state.turns[0]?.scopes.includes("openwork:agent-source:calendar"))
  })
})

describe("Connect's read allowlist for an agent's token", () => {
  test("only Den adds it; a plain read token keeps its rules", () => {
    assert.equal(agentRead.agentReadAllowlist(new Set(["mcp:read"])), null)
    const allowlist = agentRead.agentReadAllowlist(new Set(["mcp:read", ...agentRead.agentReadScopes({ kinds: ["email", "chat"], connectionIds: ["google-workspace", SLACK.id], pairs: [{ kind: "email", connectionId: "google-workspace" }] })]))
    assert.deepEqual(allowlist && [[...allowlist.kinds], [...allowlist.connectionIds], [...allowlist.pairs]], [["email", "chat"], ["google-workspace", SLACK.id], ["email:google-workspace"]])
  })

  test("native reads: GETs of a core source that is on, through its connection; nothing else", () => {
    const allowlist = { kinds: new Set(["email" as const]), connectionIds: new Set(["google-workspace"]), pairs: new Set(["email:google-workspace"]) }
    const get = (path: string) => ({ method: "GET", path })
    assert.equal(agentRead.agentMayUseNative(allowlist, "google-workspace", get("/v1/capabilities/google-workspace/gmail-messages")), true)
    assert.equal(agentRead.agentMayUseNative(allowlist, "google-workspace", get("/v1/capabilities/google-workspace/calendar-events")), false, "calendar is off")
    assert.equal(agentRead.agentMayUseNative(allowlist, "google-workspace", get("/v1/capabilities/google-workspace/drive-files")), false, "files are not a source")
    assert.equal(agentRead.agentMayUseNative(allowlist, "google-workspace", { method: "POST", path: "/v1/capabilities/google-workspace/gmail-drafts" }), false)
    assert.equal(agentRead.agentMayUseNative(allowlist, "other-google", get("/v1/capabilities/google-workspace/gmail-messages")), false)
    assert.equal(agentRead.nativeSourceKind("/v1/capabilities/microsoft-365/teams-chats/:chatId/messages"), "chat")
  })

  test("native reads are per source and connection: email through one account never opens calendar through it", () => {
    const allowlist = agentRead.agentReadAllowlist(new Set(["mcp:read", ...agentRead.agentReadScopes({
      kinds: ["email", "calendar"],
      connectionIds: ["gws_work", "gws_personal"],
      pairs: [{ kind: "email", connectionId: "gws_work" }, { kind: "calendar", connectionId: "gws_personal" }],
    })]))
    assert.ok(allowlist)
    const get = (path: string) => ({ method: "GET", path })
    assert.equal(agentRead.agentMayUseNative(allowlist, "gws_work", get("/v1/capabilities/google-workspace/gmail-messages")), true)
    assert.equal(agentRead.agentMayUseNative(allowlist, "gws_work", get("/v1/capabilities/google-workspace/calendar-events")), false)
    assert.equal(agentRead.agentMayUseNative(allowlist, "gws_personal", get("/v1/capabilities/google-workspace/calendar-events")), true)
    assert.equal(agentRead.agentMayUseNative(allowlist, "gws_personal", get("/v1/capabilities/google-workspace/gmail-messages")), false)
  })

  test("a connection's tools: only its service's reviewed reads; provider hints and read-shaped names never are enough", () => {
    const allowlist = { kinds: new Set(["chat" as const]), connectionIds: new Set([SLACK.id, NOTES.id, "emc_crm"]) }
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
    assert.deepEqual(listed.map((source) => source.id), ["calendar", "email", "chat", NOTES.id, "emc_01k8z5wq0s0000000000000003"])
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
      { ok: false, status: 400, error: "source_not_allowed", message: "Meeting notes isn't allowed for agents in your organization. An admin can change it in Manage › Workbot." })
    assert.deepEqual(change({ sources: [{ source: "Slack", on: false }] }),
      { ok: false, status: 400, error: "source_locked", message: "Team chat is on for everyone in your organization. An admin can change it in Manage › Workbot." })
    const steer = change({ sources: [{ source: "email", instruction: "Skip newsletters." }] })
    assert.ok(steer.ok, "an instruction on a source that is on for everyone is fine")
    assert.deepEqual(steer.lines, ["Email: “Skip newsletters.”"])
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

describe("connections as sources, picked per category", () => {
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
    assert.deepEqual(groups.calendar.map((connection) => connection.id), ["google-workspace", "gws_personal"], "both read the calendar until the admin picks")
    assert.deepEqual(groups.all.map((option) => [option.id, option.native, option.slots.join(",")]), [
      ["google-workspace", true, "calendar,email"],
      ["gws_personal", true, "calendar,email"],
    ])
    const none = await listOrganizationSourceConnections(organizationId, { rows: async () => [], hasLegacyClient: async () => false })
    assert.deepEqual(none, [])
  })

  test("only MCPs with reviewed read tools can be added, anywhere; any other MCP isn't offered", () => {
    const all = groupSourceConnections([NOTES, CRM]).all
    assert.deepEqual(all.map((option) => [option.id, option.slots.join(",")]), [[NOTES.id, "calendar,email,chat,other"]], "the CRM isn't offered at all")
  })

  test("a reviewed MCP added to Email is read; Other context is what the admin added; the last one removed reads nothing", async () => {
    const sources = { ...settingsOn.sources, coreConnections: { email: [GOOGLE.id, NOTES.id] }, otherConnections: [TRACKER.id], connections: { [TRACKER.id]: "everyone" as const } }
    const listed = resolveMemberSources({ connections: org, policy: sources, choices: {}, lastLook: {} })
    assert.deepEqual(listed.map((source) => source.id), ["calendar", "email", "chat", TRACKER.id], "Granola left Other context: no longer its own source")
    const email = listed.find((source) => source.id === "email")
    assert.deepEqual(email?.options.map((connection) => connection.id), [GOOGLE.id, NOTES.id], "both allowed for email")
    assert.deepEqual(email?.connections.map((connection) => connection.id), [GOOGLE.id], "one read: Den's own provider by default")
    const h = harness({ library: true, connections: [GOOGLE, SLACK, NOTES, TRACKER, CRM], settings: { sources }, row: { preferences: JSON.stringify({ v: 1, words: { always: "", never: "", when: "", how: "" }, sources: { email: { connectionId: NOTES.id } }, log: [] }) } })
    await h.run()
    const scopes = h.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes(`openwork:agent-connection:${NOTES.id}`) && scopes.includes(`openwork:agent-connection:${TRACKER.id}`), "the member read email from Granola")
    assert.ok(!scopes.includes(`openwork:agent-core:email:${GOOGLE.id}`), "and not from Google as well")
    assert.ok(!scopes.some((scope) => scope.includes(CRM.id)), "an MCP without reviewed reads is never on the token")
    assert.deepEqual(h.state.calendarVia, [GOOGLE.id], "only Google's calendar wakes the agent early")
    const empty = resolveMemberSources({ connections: org, policy: { ...sources, otherConnections: [] }, choices: {}, lastLook: {} })
    assert.deepEqual(empty.map((source) => source.id), ["calendar", "email", "chat"], "the last one removed: Other context reads nothing")
    const noEmail = resolveMemberSources({ connections: org, policy: { ...sources, coreConnections: { email: [] } }, choices: {}, lastLook: {} })
    assert.deepEqual(noEmail.find((source) => source.id === "email")?.connections, [], "a category's last source removed: it reads nothing")
    const sneaked = resolveMemberSources({ connections: org, policy: { ...sources, coreConnections: { email: [CRM.id] }, otherConnections: [CRM.id] }, choices: {}, lastLook: {} })
    assert.ok(!sneaked.some((source) => source.connections.some((connection) => connection.id === CRM.id)), "even if saved, an unreviewed MCP isn't read")
  })

  test("policies saved before this read and behave exactly as before; null resets the new fields", () => {
    const old = { calendar: "everyone", email: "members", chat: "off", coreConnections: { email: ["google-workspace"] }, connections: { [NOTES.id]: "everyone" } }
    const read = readWorkbotProactiveSettings({ workbot: { proactive: { sources: old } } }).sources
    assert.deepEqual(read, old)
    const resolvedOld = resolveMemberSources({ connections: org, policy: read, choices: {}, lastLook: {} })
    assert.deepEqual(resolvedOld.map((source) => [source.id, source.connections.map((connection) => connection.id).join(",")]), [
      ["calendar", "google-workspace"], ["email", "google-workspace"], ["chat", SLACK.id], [NOTES.id, NOTES.id], [TRACKER.id, TRACKER.id],
    ], "reviewed services only in Other context; the CRM isn't read; one connection per category")
    assert.deepEqual(resolvedOld.find((source) => source.id === "calendar")?.options.map((connection) => connection.id), ["google-workspace", "gws_personal"], "still both allowed, as before")
    assert.equal(read.coreDefaults, undefined, "no default saved: automatic")
    const added = mergeWorkbotProactiveSettings({ ...settingsOn, sources: read }, { sources: { otherConnections: [TRACKER.id, TRACKER.id] } })
    assert.deepEqual(added?.sources.otherConnections, [TRACKER.id])
    const reset = added && mergeWorkbotProactiveSettings(added, { sources: { otherConnections: null } })
    assert.deepEqual(reset?.sources, read)
  })

  test("an admin's change is checked: the organization's connections, where they can go, and only reviewed MCPs", () => {
    const connections = org.map(({ id, name, url, native }) => ({ id, name, url, native }))
    const check = (change: Parameters<typeof checkSourcesChange>[0]["change"]) => checkSourcesChange({ change, connections })
    assert.equal(check({ coreConnections: { email: [GOOGLE.id, NOTES.id] }, otherConnections: [TRACKER.id] }), null)
    assert.equal(check({ coreConnections: { email: [CRM.id] } }), "Acme CRM can't serve email.")
    assert.equal(check({ otherConnections: [CRM.id] }), "Agents can't read Acme CRM yet.")
    assert.equal(check({ connections: { [CRM.id]: "everyone" } }), "Agents can't read Acme CRM yet.")
    assert.equal(check({ connections: { [CRM.id]: null } }), null)
    assert.equal(check({ coreConnections: { chat: [GOOGLE.id] } }), "Google Workspace can't serve team chat.")
    assert.equal(check({ coreConnections: { chat: [NOTES.id, SLACK.id] } }), null, "a reviewed MCP can serve any category")
    assert.equal(check({ otherConnections: [GOOGLE.id] }), "Google Workspace can't be other context.")
    assert.equal(check({ otherConnections: ["emc_nope"] }), "No connection emc_nope in this organization.")
  })
})

describe("guardrails: the admin allows and sets a default, each member's agent reads one connection per category", () => {
  const WORK: MemberConnection = { ...GOOGLE, id: "gws_work", name: "Acme Google" }
  const PERSONAL: MemberConnection = { ...GOOGLE, id: "gws_personal", name: "Personal Google", state: "needs_connection" }
  const MICROSOFT: MemberConnection = { id: "m365_main", name: "Microsoft 365", url: "https://microsoft.com", native: "microsoft-365", state: "needs_connection" }
  const base = settingsOn.sources
  const calendarOf = (input: { connections: MemberConnection[]; policy?: WorkbotProactiveSettings["sources"]; choice?: string; counts?: Map<string, number> }) => {
    const source = resolveMemberSources({
      connections: input.connections,
      policy: input.policy ?? base,
      choices: input.choice ? { calendar: { connectionId: input.choice } } : {},
      lastLook: {},
      connectedMembers: input.counts,
    }).find((entry) => entry.id === "calendar")
    return { id: source?.connections[0]?.id ?? null, state: source?.connections[0]?.state ?? null, chosenBy: source?.chosenBy ?? null, options: source?.options.map((connection) => connection.id) ?? [], count: source?.connections.length ?? 0 }
  }
  const withDefault = (id: string) => ({ ...base, coreDefaults: { calendar: id } })

  test("the member's pick wins, even before they connect it; a pick that is no longer allowed is ignored", () => {
    assert.deepEqual(calendarOf({ connections: [WORK, PERSONAL], choice: PERSONAL.id }), { id: PERSONAL.id, state: "needs_connection", chosenBy: "member", options: [WORK.id, PERSONAL.id], count: 1 })
    const notAllowed = { ...base, coreConnections: { calendar: [WORK.id] } }
    assert.deepEqual(calendarOf({ connections: [WORK, PERSONAL], policy: notAllowed, choice: PERSONAL.id }).id, WORK.id, "the admin took it away: back to the default")
  })

  test("else the admin's default when the member's account is ready; else one they already connected; else the default to connect", () => {
    const connectedPersonal = { ...PERSONAL, state: "connected" as const }
    assert.deepEqual(calendarOf({ connections: [WORK, connectedPersonal], policy: withDefault(PERSONAL.id) }).chosenBy, "admin")
    assert.deepEqual(calendarOf({ connections: [WORK, connectedPersonal], policy: withDefault(PERSONAL.id) }).id, PERSONAL.id)
    assert.deepEqual(calendarOf({ connections: [WORK, PERSONAL], policy: withDefault(PERSONAL.id) }), { id: WORK.id, state: "connected", chosenBy: "auto", options: [WORK.id, PERSONAL.id], count: 1 }, "never asked to connect the default when another allowed one is ready")
    const nothing = calendarOf({ connections: [{ ...WORK, state: "needs_connection" }, PERSONAL], policy: withDefault(PERSONAL.id) })
    assert.deepEqual([nothing.id, nothing.state, nothing.chosenBy], [PERSONAL.id, "needs_connection", "admin"], "nothing connected: the default, to connect")
    const stale = calendarOf({ connections: [WORK, PERSONAL], policy: { ...withDefault("gws_gone"), coreConnections: { calendar: [WORK.id, PERSONAL.id] } } })
    assert.deepEqual([stale.id, stale.chosenBy], [WORK.id, "auto"], "a default that is no longer there falls back to automatic")
  })

  test("the automatic default is the allowed connection most members connected; unknown counts go to the first", () => {
    const counts = new Map([[WORK.id, 2], [MICROSOFT.id, 5]])
    const notConnected = [{ ...WORK, state: "needs_connection" as const }, MICROSOFT]
    assert.deepEqual(calendarOf({ connections: notConnected, counts }).id, MICROSOFT.id)
    assert.deepEqual(calendarOf({ connections: notConnected, counts }).chosenBy, "auto")
    assert.deepEqual(calendarOf({ connections: notConnected }).id, WORK.id, "without counts: the first allowed")
    assert.deepEqual(calendarOf({ connections: [MICROSOFT, { ...WORK, state: "needs_connection" }], counts: new Map([[WORK.id, 1]]) }).id, WORK.id)
  })

  test("only the chosen connection is on the token and in connect notices: an unused personal account is never asked for", async () => {
    const h = harness({ library: true, connections: [WORK, PERSONAL, SLACK], settings: { sources: withDefault(PERSONAL.id) } })
    await h.run()
    assert.deepEqual(h.state.delivered, [], "no Connect message for the personal account")
    assert.deepEqual(h.state.calendarVia, [WORK.id])
    const scopes = h.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes(`openwork:agent-core:calendar:${WORK.id}`) && scopes.includes(`openwork:agent-core:email:${WORK.id}`))
    assert.ok(!scopes.some((scope) => scope.includes(PERSONAL.id)), "nothing of the personal account on the token")
  })

  test("the calendar wake reads the Google connection the member picked, and only it", async () => {
    const both = [WORK, { ...PERSONAL, state: "connected" as const }, SLACK]
    const picked = JSON.stringify({ v: 1, words: { always: "", never: "", when: "", how: "" }, sources: { calendar: { connectionId: PERSONAL.id } }, log: [] })
    const h = harness({ library: true, connections: both, row: { preferences: picked } })
    await h.run()
    assert.deepEqual(h.state.calendarVia, [PERSONAL.id])
    const scopes = h.state.turns[0]?.scopes ?? []
    assert.ok(scopes.includes(`openwork:agent-core:calendar:${PERSONAL.id}`) && !scopes.includes(`openwork:agent-core:calendar:${WORK.id}`))
    assert.ok(scopes.includes(`openwork:agent-core:email:${WORK.id}`), "email still reads the default")
    const notConnected = harness({ library: true, connections: [WORK, PERSONAL, SLACK], row: { preferences: picked } })
    await notConnected.run()
    assert.deepEqual(notConnected.state.calendarVia, [], "picked but not connected: no calendar read through another account")
    assert.deepEqual(notConnected.state.delivered, ["Quick check: I can't read your Google Calendar, so I've paused checking it and kept reading the rest. <https://den.example/dashboard/library/connectors/gws_personal|Connect Google Workspace>"])
  })

  test("a member picks where calendar reads from, only among the allowed connections; it is logged and undone like any change", () => {
    let next = 0
    const newId = () => `chg_g${++next}`
    const connections = [WORK, PERSONAL, SLACK, NOTES]
    const change = (request: Parameters<typeof preferences.applyMemberAgentChange>[0]["request"], stored = preferences.emptyStoredPreferences(), policy = base) =>
      preferences.applyMemberAgentChange({ request, overrides: null, stored, settings: { ...settingsOn, sources: policy }, source: "chat", now: NOW, newId, sources: resolveMemberSources({ connections, policy, choices: stored.sources, lastLook: {} }) })
    assert.deepEqual(change({ sources: [{ source: "calendar", connectionId: SLACK.id }] }), { ok: false, status: 400, error: "connection_not_allowed", message: "Calendar can't read from that connection in your organization. An admin chooses the allowed apps in Manage › Workbot." })
    assert.deepEqual(change({ sources: [{ source: "Meeting notes", connectionId: NOTES.id }] }), { ok: false, status: 400, error: "connection_not_allowed", message: "Meeting notes always reads its own connection. Only calendar, email and team chat read from a connection you pick." })
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

  test("preferences and choices saved before this read as before", () => {
    const old = preferences.parseStoredPreferences(JSON.stringify({ v: 1, words: { always: "", never: "", when: "", how: "" }, sources: { chat: { on: false, changedFrom: "page", changedAt: 1 } }, log: [] }))
    assert.deepEqual(old.sources, { chat: { on: false, changedFrom: "page", changedAt: 1 } })
    const resolved = resolveMemberSources({ connections: [GOOGLE, SLACK], policy: base, choices: old.sources, lastLook: {} })
    assert.deepEqual(resolved.map((source) => [source.id, source.on, source.connections.map((connection) => connection.name).join(","), source.chosenBy]), [
      ["calendar", true, "Google Calendar", "auto"], ["email", true, "Gmail", "auto"], ["chat", true, "Slack", "auto"],
    ])
  })

  test("the admin's view: each connection's member count and the default each category uses now", async () => {
    const org = [
      { id: "gws_work", name: "Acme Google", url: "https://google.com", native: "google-workspace" },
      { id: "m365_main", name: "Microsoft 365", url: "https://microsoft.com", native: "microsoft-365" },
      { id: SLACK.id, name: "Slack", url: SLACK.url, native: null },
    ]
    const counts = new Map([["gws_work", 3], ["m365_main", 7]])
    const automatic = groupSourceConnections(org, { connectedMembers: counts })
    assert.deepEqual(automatic.calendar.map((entry) => [entry.id, entry.connectedMembers]), [["gws_work", 3], ["m365_main", 7]])
    assert.deepEqual(automatic.chat.map((entry) => [entry.id, entry.connectedMembers]), [["m365_main", 7], [SLACK.id, null]], "a shared Slack: unknown")
    assert.deepEqual(automatic.defaults, { calendar: "m365_main", email: "m365_main", chat: "m365_main" })
    const chosen = groupSourceConnections(org, { connectedMembers: counts, policy: { ...base, coreDefaults: { calendar: "gws_work", chat: "gws_work" } } })
    assert.deepEqual(chosen.defaults, { calendar: "gws_work", email: "m365_main", chat: "m365_main" }, "the admin's default while allowed; Google can't serve chat")
    assert.deepEqual(groupSourceConnections(org, { policy: { ...base, coreConnections: { calendar: [] } } }).defaults.calendar, null, "nothing allowed: no default")

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

  test("an admin's default is checked: one that can serve the category, allowed after the change, and never removed without another", () => {
    const org = [
      { id: "gws_work", name: "Acme Google", url: "https://google.com", native: "google-workspace" },
      { id: "gws_personal", name: "Personal Google", url: "https://google.com", native: "google-workspace" },
      { id: SLACK.id, name: "Slack", url: SLACK.url, native: null },
      { id: NOTES.id, name: "Meeting notes", url: NOTES.url, native: null },
    ]
    const check = (change: Parameters<typeof checkSourcesChange>[0]["change"], current = base) => checkSourcesChange({ change, connections: org, current })
    assert.equal(check({ coreDefaults: { calendar: "gws_work" } }), null)
    assert.equal(check({ coreDefaults: { chat: "gws_work" } }), "Acme Google can't serve team chat.")
    assert.equal(check({ coreDefaults: { email: "emc_nope" } }), "No connection emc_nope in this organization.")
    assert.equal(check({ coreDefaults: { email: NOTES.id } }), "Meeting notes isn't allowed for email. Allow it first.", "a reviewed MCP has to be allowed first")
    assert.equal(check({ coreConnections: { email: ["gws_work", NOTES.id] }, coreDefaults: { email: NOTES.id } }), null, "allowed and made default in one change")
    assert.equal(check({ coreConnections: { calendar: ["gws_personal"] }, coreDefaults: { calendar: "gws_work" } }), "Acme Google isn't allowed for calendar. Allow it first.")
    const withWorkDefault = { ...base, coreDefaults: { calendar: "gws_work" } }
    assert.equal(check({ coreConnections: { calendar: ["gws_personal"] } }, withWorkDefault), "Acme Google is the default for calendar. Choose another default first.")
    assert.equal(check({ coreConnections: { calendar: ["gws_personal"] }, coreDefaults: { calendar: "gws_personal" } }, withWorkDefault), null)
    assert.equal(check({ coreConnections: { calendar: ["gws_personal"] }, coreDefaults: { calendar: null } }, withWorkDefault), null, "back to automatic with it")
    assert.equal(check({ coreConnections: { calendar: null } }, { ...base, coreConnections: { calendar: ["gws_work", NOTES.id] }, coreDefaults: { calendar: NOTES.id } }), "Meeting notes is the default for calendar. Choose another default first.")
    assert.equal(check({ calendar: "members" }, { ...base, coreDefaults: { calendar: "gws_gone" } }), null, "a default whose connection is gone doesn't block other changes")

    const merged = mergeWorkbotProactiveSettings(settingsOn, { sources: { coreDefaults: { calendar: "gws_work", email: "gws_work" } } })
    assert.deepEqual(merged?.sources.coreDefaults, { calendar: "gws_work", email: "gws_work" })
    const kept = merged && mergeWorkbotProactiveSettings(merged, { sources: { chat: "off", coreDefaults: { email: null } } })
    assert.deepEqual(kept?.sources.coreDefaults, { calendar: "gws_work" }, "null goes back to automatic; the rest is kept")
    const reset = kept && mergeWorkbotProactiveSettings(kept, { sources: { coreDefaults: { calendar: null } } })
    assert.equal(reset?.sources.coreDefaults, undefined)
    assert.equal(readWorkbotProactiveSettings({ workbot: { proactive: { sources: { ...base, coreDefaults: { calendar: "gws_work" } } } } }).sources.coreDefaults?.calendar, "gws_work")
  })
})
