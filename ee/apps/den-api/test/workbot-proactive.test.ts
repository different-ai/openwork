import assert from "node:assert/strict"
import { describe, test } from "node:test"
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
    ...overrides,
  }
}

const message = (text: string, items: { responsibility: string; ref: string }[]) => JSON.stringify({ message: text, items })

type HarnessState = {
  checks: { day: string; counts: { responsibility: string; checks: number; quiet: number; sent: number }[] }[]
  destinations: string[]
  clock: number
  events: RawEvent[]
  row: AgentInstanceRow
  ledger: Map<string, string>
  delivered: string[]
  turns: { prompt: string; sessionId: string; instructions: string }[]
  calendarReads: number
  settles: AgentSettle[]
}

/** An in-memory agent, ledger and destination; `events`, `clock` and the reply change between runs. */
function harness(input: { settings?: Partial<WorkbotProactiveSettings>; row?: Partial<AgentInstanceRow>; replies?: (string | AgentTurnResult)[]; sentToday?: number; allowed?: boolean[]; blocked?: AgentDestinationBlock }) {
  const state: HarnessState = { checks: [], destinations: [], clock: NOW, events: [meeting()], row: agentRow(input.row), ledger: new Map(), delivered: [], turns: [], calendarReads: 0, settles: [] }
  const replies = [...(input.replies ?? ["NO_REPLY"])]
  let allowedCalls = 0
  const deps: AgentWakeDeps = {
    now: () => state.clock,
    allowed: async () => input.allowed?.[allowedCalls++] ?? true,
    settings: async () => ({ ...settingsOn, ...input.settings }),
    template: async () => ({ ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 }),
    user: async () => userId,
    calendar: async () => {
      state.calendarReads += 1
      return { kind: "ok", json: { timeZone: TZ, items: state.events } }
    },
    recordChecks: async (call) => {
      state.checks.push({ day: call.day, counts: [...call.counts] })
    },
    model: async () => "openai/gpt-6-luna",
    turn: async (call) => {
      state.turns.push({ prompt: call.prompt, sessionId: call.sessionId, instructions: call.instructions })
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
      state.delivered.push(call.text)
      state.destinations.push("workbot_dm")
      return { ok: true }
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
    assert.match(h.state.turns[0]?.prompt ?? "", /Gmail: never/)
    assert.deepEqual(h.state.delivered, [])
    const saved = parseAgentState(h.state.row.state)
    assert.equal(saved.lastPassAt, NOW)
    assert.equal(saved.nextPassAt, NOW + 3 * 3_600_000, "the next check is in about three hours")
    assert.equal(saved.lastLook.gmail, NOW)
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
    assert.match(h.state.turns[1]?.prompt ?? "", /A meeting \(calendar event evt1\) moved to tomorrow at 3:00 PM .*ref evt1:2026-10-20T17:47:00Z/)
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
    assert.equal(h.state.ledger.get("waiting_on_you:t1"), "capped")
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

  test("always a DM from the Workbot app, only to the member", async () => {
    const dm = deps()
    assert.deepEqual(await deliverAgentMessage(base, dm.value), { ok: true })
    assert.deepEqual(dm.sent, ["Quarterly review moved."])
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
})
