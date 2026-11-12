import assert from "node:assert/strict"
import { test } from "node:test"
import { workbotUsageResponseSchema } from "@openwork/types/den/workbot-usage"
import { mergeWorkbotUsageMembers, summarizeWorkbotUsage, workbotUsageWindowStart, type WorkbotUsageSlice } from "../src/workbot/usage-rows.js"

const now = new Date("2026-11-10T15:30:00.000Z")

function sums(costMicroUsd: number, requests: number, extra: { unpricedRequests?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } = {}) {
  return { costMicroUsd, requests, unpricedRequests: 0, inputTokens: requests * 100, outputTokens: requests * 10, cacheReadTokens: 0, ...extra }
}

function slice(day: string, surface: WorkbotUsageSlice["surface"], model: string, costMicroUsd: number, requests: number, extra = {}): WorkbotUsageSlice {
  return { day, surface, model, ...sums(costMicroUsd, requests, extra) }
}

test("the window is whole UTC days ending today", () => {
  assert.equal(workbotUsageWindowStart(now, 30).toISOString(), "2026-10-12T00:00:00.000Z")
  assert.equal(workbotUsageWindowStart(now, 1).toISOString(), "2026-11-10T00:00:00.000Z")
})

test("a member's folded days and unfolded requests add up, most expensive first", () => {
  assert.deepEqual(mergeWorkbotUsageMembers([
    { memberId: "om_b", ...sums(200, 2) },
    { memberId: "om_a", ...sums(500, 1) },
    { memberId: "om_b", ...sums(900, 3) },
    { memberId: "om_idle", ...sums(0, 0) },
  ]).map((member) => [member.memberId, member.costMicroUsd, member.requests]), [["om_b", 1_100, 5], ["om_a", 500, 1]])
})

test("usage is summed per day, surface, model and person", () => {
  const members = mergeWorkbotUsageMembers([
    { memberId: "om_a", ...sums(4_000_000, 40) },
    { memberId: "om_gone", ...sums(1_500_000, 12, { unpricedRequests: 2 }) },
  ])
  const report = summarizeWorkbotUsage({
    now, days: 30, since: "2026-11-08", members,
    names: new Map([["om_a", { name: "Ada", email: "ada@example.com" }]]),
    slices: [
      slice("2026-11-08", "chat", "gpt-6-luna", 2_000_000, 20),
      slice("2026-11-10", "chat", "claude-opus-5-5", 2_000_000, 20),
      // The same day and model from the request logs that are not folded yet.
      slice("2026-11-10", "agent", "gpt-6-luna", 1_000_000, 8),
      slice("2026-11-10", "other", "", 500_000, 4, { unpricedRequests: 2 }),
      // Outside the window, and an empty slice: neither counts.
      slice("2026-10-01", "chat", "gpt-6-luna", 9_000_000, 9),
      slice("2026-11-09", "chat", "gpt-6-luna", 0, 0),
    ],
  })
  assert.doesNotThrow(() => workbotUsageResponseSchema.parse(report))
  assert.deepEqual(report.totals, { costMicroUsd: 5_500_000, requests: 52, unpricedRequests: 2, inputTokens: 5_200, outputTokens: 520, cacheReadTokens: 0, members: 2 })
  assert.equal(report.daily.length, 30)
  assert.equal(report.daily[0]?.day, "2026-10-12")
  assert.deepEqual(report.daily.filter((day) => day.requests > 0).map((day) => [day.day, day.costMicroUsd, day.requests]), [["2026-11-08", 2_000_000, 20], ["2026-11-10", 3_500_000, 32]])
  assert.deepEqual(report.surfaces.map((row) => [row.surface, row.costMicroUsd]), [["chat", 4_000_000], ["agent", 1_000_000], ["other", 500_000]])
  assert.deepEqual(report.models.map((row) => [row.model, row.costMicroUsd, row.requests]), [["gpt-6-luna", 3_000_000, 28], ["claude-opus-5-5", 2_000_000, 20], ["", 500_000, 4]])
  assert.deepEqual(report.members.map((row) => [row.memberId, row.name, row.email, row.costMicroUsd]), [["om_a", "Ada", "ada@example.com", 4_000_000], ["om_gone", null, null, 1_500_000]])
  assert.equal(report.since, "2026-11-08")
})

test("an organization with no Workbot usage reads as thirty empty days", () => {
  const report = summarizeWorkbotUsage({ now, days: 30, since: null, slices: [], members: [], names: new Map() })
  assert.equal(report.totals.requests, 0)
  assert.equal(report.totals.members, 0)
  assert.equal(report.daily.length, 30)
  assert.deepEqual([report.surfaces, report.models, report.members], [[], [], []])
})
