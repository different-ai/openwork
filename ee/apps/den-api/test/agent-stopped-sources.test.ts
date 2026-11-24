import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { AgentSourcesPolicy } from "@openwork/types/den/workbot-proactive"
import { checkHeadline, describeAgentCheck } from "../src/workbot-proactive/checks.js"
import type { AgentInstanceRow } from "../src/workbot-proactive/repository.js"
import { resolveMemberSources, stoppedSources, type MemberConnection, type MemberSourceChoice } from "../src/workbot-proactive/sources.js"
import { noticeStoppedSources, type CheckRecordInput } from "../src/workbot-proactive/wake-shared.js"

/** A member's agent saying when it stops reading a source (`workbotAgentStoppedSources`): which sources count, and what is sent and recorded. */

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 18, 17)
const LINK = "https://den.example/dashboard/my-bot"

const slack: MemberConnection = { id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp", native: null, state: "connected" }
const notion: MemberConnection = { id: "emc_notion", name: "Notion", url: "https://mcp.notion.com/mcp", native: null, state: "connected" }
const linear: MemberConnection = { id: "emc_linear", name: "Linear", url: "https://mcp.linear.app/mcp", native: null, state: "connected" }

function sourcesOf(input: { policy?: Partial<AgentSourcesPolicy>; choices?: Record<string, MemberSourceChoice>; lastLook?: Record<string, number> }) {
  return resolveMemberSources({
    connections: [slack, notion, linear],
    policy: { calendar: "everyone", connections: {}, ...input.policy },
    choices: input.choices ?? {},
    lastLook: input.lastLook ?? {},
    mode: "any",
  })
}

function stoppedIds(input: Parameters<typeof sourcesOf>[0]) {
  return stoppedSources({ sources: sourcesOf(input), choices: input.choices ?? {}, now: NOW }).map((source) => source.id)
}

test("a source read lately that became the member's choice counts as stopped", () => {
  assert.deepEqual(stoppedIds({ lastLook: { emc_slack: NOW - 2 * HOUR } }), ["emc_slack"])
})

test("a source an admin turned off counts as stopped, even when the member had it on", () => {
  const input = { policy: { connections: { emc_slack: "off" as const } }, choices: { emc_slack: { on: true } }, lastLook: { emc_slack: NOW - 2 * HOUR } }
  assert.deepEqual(stoppedIds(input), ["emc_slack"])
})

test("a source the member turned off themselves is not told", () => {
  assert.deepEqual(stoppedIds({ choices: { emc_slack: { on: false } }, lastLook: { emc_slack: NOW - 2 * HOUR } }), [])
})

test("a source that is still on, was never read, or was last read over a week ago is not stopped", () => {
  assert.deepEqual(stoppedIds({ policy: { connections: { emc_slack: "everyone" } }, lastLook: { emc_slack: NOW - 2 * HOUR } }), [])
  assert.deepEqual(stoppedIds({ choices: { emc_slack: { on: true } }, lastLook: { emc_slack: NOW - 2 * HOUR } }), [])
  assert.deepEqual(stoppedIds({}), [])
  assert.deepEqual(stoppedIds({ lastLook: { emc_slack: NOW - 8 * DAY } }), [])
  assert.deepEqual(stoppedIds({ lastLook: { emc_slack: NOW - 6 * DAY } }), ["emc_slack"])
})

const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const row: AgentInstanceRow = {
  memberId: createDenTypeId("member"),
  organizationId,
  templateVersionId: null,
  status: null,
  overrides: null,
  snoozedUntil: null,
  state: null,
  preferences: null,
  timeZone: "America/Los_Angeles",
  nextWakeAt: new Date(NOW),
  failures: 0,
  leaseOwner: null,
  leaseUntil: null,
  createdAt: new Date(NOW - 30 * DAY),
  updatedAt: new Date(NOW),
}

function harness(options: { feature?: "on" | "off" | "absent"; delivers?: boolean } = {}) {
  const sent: string[] = []
  const records: CheckRecordInput[] = []
  let asked = 0
  const feature = options.feature ?? "on"
  return {
    sent,
    records,
    asked: () => asked,
    run: (input: { policy?: Partial<AgentSourcesPolicy>; choices?: Record<string, MemberSourceChoice>; lastLook?: Record<string, number>; told?: Record<string, number>; othersReadable?: boolean }) => noticeStoppedSources({
      row,
      organizationId,
      userId,
      sources: sourcesOf(input),
      choices: input.choices ?? {},
      othersReadable: input.othersReadable ?? true,
      told: input.told ?? {},
      now: NOW,
      slot: "slot-1",
      kind: "scheduled",
      deps: {
        holdsLease: async () => true,
        allowed: async () => true,
        deliver: async ({ text }) => {
          if (options.delivers === false) return { ok: false, code: "send_failed" }
          sent.push(text)
          return { ok: true }
        },
        ...(feature === "absent" ? {} : {
          stoppedSources: async () => {
            asked += 1
            return feature === "on" ? { link: LINK } : null
          },
        }),
      },
      record: async (record) => {
        records.push(record)
      },
    }),
  }
}

test("tells the member once, with where to turn the source back on, and records a check that names it", async () => {
  const h = harness()
  const lastLook = { emc_slack: NOW - 2 * HOUR, emc_notion: NOW - 2 * HOUR }
  const notices = await h.run({ policy: { connections: { emc_notion: "everyone" } }, lastLook })
  assert.deepEqual(h.sent, [`Quick check: I've stopped reading your Slack because it is no longer on for me. <${LINK}|Choose what I read>`])
  assert.deepEqual(notices, { "stopped:emc_slack": NOW })
  assert.equal(h.records.length, 1)
  assert.equal(h.records[0]?.reason, "source_stopped")
  assert.deepEqual(h.records[0]?.sources, [{ id: "emc_slack", name: "Slack", connectionId: "emc_slack" }])

  const again = await h.run({ policy: { connections: { emc_notion: "everyone" } }, lastLook, told: notices })
  assert.equal(h.sent.length, 1)
  assert.equal(h.records.length, 1)
  assert.deepEqual(again, notices)
})

test("says an admin turned a source off in its own message, with no link", async () => {
  const h = harness()
  const notices = await h.run({
    policy: { connections: { emc_linear: "off" } },
    lastLook: { emc_slack: NOW - HOUR, emc_notion: NOW - HOUR, emc_linear: NOW - HOUR },
    othersReadable: false,
  })
  assert.deepEqual(h.sent, [
    `Quick check: I've stopped reading your Slack and Notion because they are no longer on for me. I have nothing else to check until a source is on. <${LINK}|Choose what I read>`,
    "Quick check: I've stopped reading your Linear because your admin turned it off for agents. I have nothing else to check until a source is on.",
  ])
  assert.deepEqual(Object.keys(notices).sort(), ["stopped:emc_linear", "stopped:emc_notion", "stopped:emc_slack"])
  assert.deepEqual(h.records.map((record) => record.sources?.map((source) => source.name)), [["Slack", "Notion"], ["Linear"]])
})

test("forgets a notice once the source is on again", async () => {
  const h = harness()
  const notices = await h.run({ policy: { connections: { emc_slack: "everyone" } }, lastLook: { emc_slack: NOW - HOUR }, told: { "stopped:emc_slack": NOW - DAY } })
  assert.deepEqual(notices, {})
  assert.equal(h.asked(), 0)
})

test("with the feature off, or not wired, nothing is told, recorded or kept", async () => {
  for (const feature of ["off", "absent"] as const) {
    const h = harness({ feature })
    const notices = await h.run({ lastLook: { emc_slack: NOW - HOUR }, told: { "stopped:emc_slack": NOW - DAY } })
    assert.deepEqual(notices, {})
    assert.deepEqual(h.sent, [])
    assert.deepEqual(h.records, [])
  }
})

test("the feature is not asked when no source stopped", async () => {
  const h = harness()
  assert.deepEqual(await h.run({ policy: { connections: { emc_slack: "everyone" } }, lastLook: { emc_slack: NOW - HOUR } }), {})
  assert.equal(h.asked(), 0)
})

test("a message that could not be sent is recorded and tried again at the next check", async () => {
  const h = harness({ delivers: false })
  const notices = await h.run({ lastLook: { emc_slack: NOW - HOUR } })
  assert.deepEqual(notices, {})
  assert.equal(h.records.length, 1)
  assert.equal(h.records[0]?.message, null)
})

test("the check reads as a failed one that names the source", () => {
  const described = describeAgentCheck({
    reason: "source_stopped",
    sources: [{ id: "emc_slack", name: "Slack", connectionId: "emc_slack" }, { id: "emc_notion", name: "Notion", connectionId: "emc_notion" }],
    limits: { startHour: 8, endHour: 18, dailyCap: 5, quietWindow: null },
  })
  assert.deepEqual(described, { outcome: "failed", summary: "Stopped reading Slack and Notion: no longer on for your agent." })
  assert.equal(checkHeadline(described.summary), "Stopped reading Slack and Notion")
})
