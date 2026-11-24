import assert from "node:assert/strict"
import { test } from "node:test"
import { agentLedgerKey, parseAgentState } from "@openwork/automations/proactive"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { DEFAULT_AGENT_TEMPLATE, DEFAULT_WORKBOT_PROACTIVE_SETTINGS } from "@openwork/types/den/workbot-proactive"
import type { AgentInstanceRow } from "../src/workbot-proactive/repository.js"
import type { AgentBriefWakeDeps } from "../src/workbot-proactive/wake-brief.js"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/agent_wake_brief_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-agent-wake-brief-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-agent-wake-brief-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"

const { wakeAgentBrief } = await import("../src/workbot-proactive/wake-brief.js")

const NOW = Date.UTC(2026, 10, 18, 9)
const userId = createDenTypeId("user")
const lastReport = { at: NOW - 3_600_000, text: "P0: Dana needs the old review." }
const row: AgentInstanceRow = {
  organizationId: createDenTypeId("organization"), memberId: createDenTypeId("member"), templateVersionId: null,
  status: "on", overrides: null, snoozedUntil: null, preferences: null, timeZone: "UTC",
  state: JSON.stringify({ ...parseAgentState(null), lastReport }), nextWakeAt: new Date(NOW), failures: 0,
  leaseOwner: null, leaseUntil: null, createdAt: new Date(NOW), updatedAt: new Date(NOW),
}

function reply(...messages: { text: string; about: string[]; update?: boolean }[]) {
  return JSON.stringify({ messages })
}

const review = { text: "Dana moved the review to *2 PM*.", about: ["calendar:review"] }

function harness(input: { checks: string[]; briefOn?: AgentBriefWakeDeps["briefOn"]; sentToday?: number; told?: string[]; sendCheck?: AgentBriefWakeDeps["sendCheck"]; connections?: Awaited<ReturnType<AgentBriefWakeDeps["connections"]>> }) {
  const calls: string[] = []
  const checks: Parameters<AgentBriefWakeDeps["check"]>[0][] = []
  const delivered: string[] = []
  const records: Parameters<AgentBriefWakeDeps["recordCheck"]>[0][] = []
  const reserves: { id: string; outcome: string | undefined }[] = []
  const finishes: [string, string][] = []
  const ledger = new Set(input.told)
  let settled = row.state
  const deps: AgentBriefWakeDeps = {
    now: () => NOW,
    allowed: async () => true,
    settings: async () => ({
      ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS,
      enabled: true,
      brief: { dailyCap: 4 },
      sendCheck: Boolean(input.sendCheck),
      sources: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS.sources, connections: { emc_mail: "everyone", emc_chat: "everyone" } },
    }),
    template: async () => ({ ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 }),
    user: async () => userId,
    calendar: async () => ({ kind: "ok", json: { timeZone: "UTC" } }),
    model: async () => "model",
    turn: async () => { throw new Error("Unexpected legacy wake turn") },
    connections: async () => input.connections ?? [{ id: "emc_calendar", name: "Calendar", url: "https://calendar.google.com", native: "google-workspace", state: "connected" }],
    connectLink: (id) => `https://den.example/connect/${id}`,
    sessionId: () => "check-session",
    messageId: (key, wakeAt) => `${key}:${wakeAt}`,
    told: async (_member, items) => new Set(items.map(agentLedgerKey).filter((key) => ledger.has(key))),
    reserve: async ({ item, outcome }) => {
      const id = agentLedgerKey(item)
      if (ledger.has(id)) return null
      ledger.add(id)
      reserves.push({ id, outcome })
      return id
    },
    finish: async (id, outcome) => { finishes.push([id, outcome]) },
    sentSince: async () => {
      calls.push("count")
      return input.sentToday ?? 0
    },
    holdsLease: async () => true,
    settle: async (_row, changes) => {
      settled = changes.state ?? settled
      return true
    },
    destinationBlock: async () => null,
    deliver: async ({ text }) => {
      delivered.push(text)
      return { ok: true }
    },
    recordChecks: async () => undefined,
    recordCheck: async (record) => { records.push(record) },
    briefOn: input.briefOn ?? (async () => true),
    person: async () => "Lee",
    check: async (turn) => {
      calls.push("check")
      checks.push(turn)
      return { kind: "answered", text: input.checks[checks.length - 1] ?? "NO_REPLY", usage: null }
    },
    conversation: async () => {
      calls.push("conversation")
      return [{ at: NOW - 60_000, from: "member", text: "Tell me if Dana moves the review." }]
    },
    requestedChecks: async () => [],
    readTools: async () => [],
    sendCheck: input.sendCheck,
  }
  return { calls, checks, records, reserves, finishes, delivered, ledger, state: () => parseAgentState(settled), run: () => wakeAgentBrief(row, deps) }
}

test("a brief check combines unreadable-source notices into one DM", async () => {
  const h = harness({
    checks: [],
    connections: [
      { id: "emc_mail", name: "Mail", url: "https://mail.example/mcp", native: null, state: "reconnect" },
      { id: "emc_chat", name: "Chat", url: "https://chat.example/mcp", native: null, state: "needs_connection" },
    ],
  })
  assert.deepEqual(await h.run(), { status: "skipped", reason: "no_sources" })
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.delivered, ["I can't read Mail or Chat right now, so your checks are paused until they're connected again. <https://den.example/connect/emc_mail|Reconnect Mail> · <https://den.example/connect/emc_chat|Connect Chat>"])
  assert.deepEqual(h.state().notices, { emc_mail: NOW, emc_chat: NOW })
  assert.deepEqual(h.records.map((record) => record.reason), ["source_disconnected", "source_disconnected"])
})

test("a brief message does not send when the rollout permission is lost", async () => {
  const h = harness({ checks: [reply(review)], briefOn: async () => false })
  await h.run()
  assert.deepEqual(h.delivered, [])
  assert.deepEqual(h.finishes, [[review.about[0], "failed"]])
  assert.deepEqual(h.records, [])
})

test("one-message check reads context first and sends one combined DM with fresh lead and folded ids", async () => {
  const old = { text: "Update to yesterday's note: the budget is still open.", about: ["calendar:budget"], update: true }
  const approval = { text: "Dana added a noon sign-off.", about: ["calendar:review", ...Array.from({ length: 8 }, (_, i) => `calendar:approval-${i}`)] }
  const h = harness({ checks: [reply(old, review, approval)], sentToday: 1, told: old.about })
  assert.equal((await h.run()).status, "ran")
  assert.deepEqual(h.calls, ["count", "conversation", "check"])
  assert.match(h.checks[0]?.instructions ?? "", /One message per check/)
  assert.match(h.checks[0]?.prompt ?? "", /You've sent 1 of 4 messages today\./)
  assert.match(h.checks[0]?.prompt ?? "", /Lee: Tell me if Dana moves the review\./)
  assert.doesNotMatch(h.checks[0]?.prompt ?? "", /Your last report to the messenger/)
  assert.deepEqual(h.delivered, [[old.text, review.text, approval.text].join("\n\n")])
  const fresh = approval.about
  const all = [...old.about, ...fresh]
  assert.deepEqual(h.reserves, fresh.map((id, index) => ({ id, outcome: index ? "folded" : "pending" })))
  assert.deepEqual(h.finishes, [[review.about[0], "sent"]])
  assert.deepEqual(h.ledger, new Set(all))
  assert.deepEqual(h.state().sent?.[0]?.about, all)
  assert.deepEqual(h.state().lastReport, lastReport)
  assert.equal(h.records[0]?.reason, "sent")
})

test("one-message NO_REPLY records no findings and does not send", async () => {
  const h = harness({ checks: ["NO_REPLY"] })
  assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null })
  assert.deepEqual(h.calls, ["count", "conversation", "check"])
  assert.deepEqual(h.delivered, [])
  assert.equal(h.records[0]?.reason, "no_findings")
})

test("an invalid one-message reply retries once in the same check session with a different message id", async () => {
  const h = harness({ checks: ["not JSON", reply(review)] })
  await h.run()
  assert.deepEqual(h.calls, ["count", "conversation", "check", "check"])
  assert.equal(h.checks[1]?.sessionId, h.checks[0]?.sessionId)
  assert.equal(h.checks[1]?.instructions, h.checks[0]?.instructions)
  assert.notEqual(h.checks[1]?.messageId, h.checks[0]?.messageId)
  assert.match(h.checks[1]?.prompt ?? "", /That answer wasn't in the required shape/)
  assert.deepEqual(h.delivered, [review.text])
})

test("a one-message check cannot deliver when it has used its daily cap", async () => {
  const h = harness({ checks: [reply(review)], sentToday: 4 })
  assert.deepEqual(await h.run(), { status: "ran", reasons: ["scheduled"], reply: "message", delivered: "daily_limit" })
  assert.deepEqual(h.calls, ["count", "conversation", "check"])
  assert.match(h.checks[0]?.prompt ?? "", /You've sent 4 of 4 messages today\./)
  assert.deepEqual(h.delivered, [])
  assert.deepEqual(h.reserves, [])
  assert.equal(h.records[0]?.reason, "daily_limit")
})

test("the existing send check can hold the single merged message", async () => {
  const signOff = { text: "Dana added a noon sign-off.", about: ["calendar:sign-off"] }
  const texts: string[] = []
  const h = harness({
    checks: [reply(review, signOff)],
    sendCheck: async () => async ({ message }) => {
      texts.push(message)
      return { status: "answered", verdict: { kind: "hold", reason: "brief" }, durationMs: 0, inputTokens: 0 }
    },
  })
  await h.run()
  assert.deepEqual(texts, [`${review.text}\n\n${signOff.text}`])
  assert.deepEqual(h.delivered, [])
  assert.deepEqual(h.reserves, [])
  assert.equal(h.records[0]?.reason, "findings_held")
})

test("one-message delivery truncates to 3,000 characters after parsing", async () => {
  const h = harness({ checks: [reply({ ...review, text: "x".repeat(3_100) })] })
  await h.run()
  assert.deepEqual(h.delivered, [`${"x".repeat(2_999)}…`])
})
