import assert from "node:assert/strict"
import { test } from "node:test"
import { HEADLESS_SESSION_HEADER, parseHeadlessSessionHeader, workbotUsageSurfaceOfSession } from "@openwork/types/den/workbot-usage"
import type { GatewayRequestLogRow } from "../src/request-log.js"
import { runRollups, type RollupRepository, type RollupStore } from "../src/rollups.js"
import { buildWorkbotUsageDayRows, type WorkbotUsageAggregate } from "@openwork-ee/den-db"

// request-log.ts loads the gateway environment; nothing here reaches a database.
process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { createRequestLogRecorder } = await import("../src/request-log.js")

const org = "org_01aaaaaaaaaaaaaaaaaaaaaaaa"
const alice = "om_01aaaaaaaaaaaaaaaaaaaaaaaa"
const blair = "om_01bbbbbbbbbbbbbbbbbbbbbbbb"
const day = new Date("2026-11-08T00:00:00.000Z")
const chat = `hs_wb_${"a".repeat(40)}`
const sideChat = `hs_wbs_${"b".repeat(40)}`
const cell = `hs_c_${"c".repeat(32)}`
const agent = `hs_agent_${"d".repeat(40)}`
const slack = "hs_5f0c1c1e9d5b4c0f8a11"

function group(input: Partial<WorkbotUsageAggregate> & Pick<WorkbotUsageAggregate, "session">): WorkbotUsageAggregate {
  return {
    organization_id: org, org_membership_id: alice, model: "gpt-6-luna",
    request_count: 1, unpriced_request_count: 0, input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cost_micro_usd: 1_000,
    ...input,
  }
}

test("only a runner conversation id tags a request, and the header is OpenWork's own", () => {
  assert.equal(HEADLESS_SESSION_HEADER, "x-openwork-headless-session")
  assert.equal(parseHeadlessSessionHeader(chat), chat)
  assert.equal(parseHeadlessSessionHeader(slack), slack)
  for (const value of [undefined, null, "", "workbot", "hs_short", `hs_${"a".repeat(97)}`, "hs_bad id here", `x${chat}`]) {
    assert.equal(parseHeadlessSessionHeader(value), null)
  }
})

test("the request log keeps the runner's conversation from the first write to the last, and only when one was sent", async () => {
  const written: GatewayRequestLogRow[] = []
  const record = async (headlessSession?: string | null) => {
    const recorder = createRequestLogRecorder({
      insertRequestLog: async (row) => { written.push(row) },
      updateRequestLog: async (row) => { written.push(row); return true },
      reporter: { request: () => undefined, handledError: () => undefined },
    })
    recorder.start({
      identity: { kind: "models", organizationId: org, orgMembershipId: alice, inferenceKeyId: "ik_01aaaaaaaaaaaaaaaaaaaaaaaa" },
      openworkRequestId: `req_${written.length}`, route: "openwork_openrouter", protocol: "openai_chat", upstreamProviderId: "openrouter",
      upstreamHost: "openrouter.example", upstreamPath: "/chat/completions", method: "POST",
      requestedModel: "auto", upstreamModel: "gpt-6-luna", stream: false, headlessSession,
    })
    await recorder.whenStarted?.()
    recorder.setUsage({ usageSource: "json", inputTokens: 10, outputTokens: 2, costUsd: 0.001 })
    await recorder.finish({ status: 200, outcome: "ok" })
  }
  await record(chat)
  await record(null)
  assert.deepEqual(written.map((row) => [row.completed_at !== null, row.metadata?.headless_session]), [[false, chat], [true, chat], [false, undefined], [true, undefined]])
  assert.equal(written[1]?.cost_micro_usd, 1_000)
})

test("a conversation's id says where Workbot ran", () => {
  assert.equal(workbotUsageSurfaceOfSession(chat), "chat")
  assert.equal(workbotUsageSurfaceOfSession(sideChat), "chat")
  assert.equal(workbotUsageSurfaceOfSession(cell), "chat")
  assert.equal(workbotUsageSurfaceOfSession(agent), "agent")
  assert.equal(workbotUsageSurfaceOfSession(slack), "other")
})

test("conversations fold into one row per member, surface and model, without their ids", () => {
  const rows = buildWorkbotUsageDayRows(day, [
    group({ session: chat, request_count: 3, cost_micro_usd: 3_000, input_tokens: 300, output_tokens: 30 }),
    group({ session: sideChat, request_count: 2, cost_micro_usd: 500, unpriced_request_count: 1, cache_read_tokens: 40 }),
    group({ session: chat, model: "claude-opus-5-5", cost_micro_usd: 9_000 }),
    group({ session: agent, cost_micro_usd: 700 }),
    group({ session: slack, org_membership_id: blair, model: null, cost_micro_usd: 0, unpriced_request_count: 1 }),
    // Not a conversation id, and an empty group: neither is Workbot usage.
    group({ session: "desktop" }),
    group({ session: cell, request_count: 0, cost_micro_usd: 0, input_tokens: 0, output_tokens: 0 }),
  ])
  const summary = rows.map((row) => [row.org_membership_id, row.surface, row.model, row.request_count, row.unpriced_request_count, row.cost_micro_usd, row.input_tokens, row.output_tokens, row.cache_read_tokens])
  assert.deepEqual(summary, [
    [alice, "chat", "gpt-6-luna", 5, 1, 3_500, 400, 40, 40],
    [alice, "chat", "claude-opus-5-5", 1, 0, 9_000, 100, 10, 0],
    [alice, "agent", "gpt-6-luna", 1, 0, 700, 100, 10, 0],
    [blair, "other", "", 1, 1, 0, 100, 10, 0],
  ])
  for (const row of rows) {
    assert.equal(row.organization_id, org)
    assert.equal(row.day_start, day)
    assert.match(row.id ?? "", /^wud_/)
    assert.ok(!JSON.stringify(row).includes("hs_"))
  }
  assert.throws(() => buildWorkbotUsageDayRows(day, [group({ session: chat, cost_micro_usd: Number.MAX_SAFE_INTEGER + 2 })]), /out of range/)
})

test("the rollup folds a batch's Workbot usage after the hour rollups and before the logs are deleted", async () => {
  const calls: string[] = []
  const ids = ["irl_01aaaaaaaaaaaaaaaaaaaaaaaa", "irl_01bbbbbbbbbbbbbbbbbbbbbbbb"] as Awaited<ReturnType<RollupStore["aggregateRawHour"]>>["ids"]
  const folded: { dayStart: Date; ids: readonly string[] }[] = []
  const store: RollupStore = {
    async aggregateRawHour() { calls.push("aggregate"); return { ids, groups: [] } },
    async aggregateHourRollupsToDay() { return { ids: [], groups: [] } },
    async upsertRollups() { calls.push("upsert") },
    async foldWorkbotUsage(dayStart, claimed) { calls.push("workbot"); folded.push({ dayStart, ids: claimed }) },
    async deleteRawIds(claimed) { calls.push("delete"); return claimed.length },
    async deleteHourRollupIds() { return 0 },
  }
  const repository: RollupRepository = {
    async listCandidateHourBuckets() { return [new Date("2026-11-08T13:00:00.000Z")] },
    async listCandidateDayBuckets() { return [] },
    async deleteExpiredOauthStates() { return 0 },
    transaction: (run) => run(store),
  }
  const summary = await runRollups({
    repository, now: new Date("2026-11-11T00:00:00.000Z"),
    capabilityUsageRepository: { async listCandidateDayBuckets() { return [] }, transaction: () => { throw new Error("no capability usage to fold") } },
  })
  assert.deepEqual(calls, ["aggregate", "upsert", "workbot", "delete"])
  assert.deepEqual(folded, [{ dayStart: day, ids }])
  assert.equal(summary.rawRowsDeleted, 2)
})
