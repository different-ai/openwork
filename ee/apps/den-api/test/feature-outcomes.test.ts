import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { FEATURE_KEYS, featureDefinition, OUTCOME_FEATURE_KEYS, type FeatureKey } from "@openwork/features"
import type { AgentInstanceRow } from "../src/workbot-proactive/repository.js"
import type { AgentWakeOutcome } from "../src/workbot-proactive/wake.js"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/feature_outcomes_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-feature-outcomes-unit-test-secret-not-for-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-feature-outcomes-unit-test-key"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
// No database: the readers' modules load Better Auth, which seeds its resource registry on import. Return a
// synthetic registry row while they initialize (as test/slack-send-as-bot.test.ts does).
const { db } = await import("../src/db.js")
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { FEATURE_OUTCOME_READERS, featureOutcomeReader } = await import("../src/feature-outcomes/readers.js")
const { featureHealth, featureOutcomeRange, summarizeFeatureOutcomes } = await import("../src/feature-outcomes/outcomes.js")
const { organizationsWithFeatureOn } = await import("../src/feature-outcomes/report.js")
const { createFeatureUsageMarker } = await import("../src/feature-usage.js")
const { wakeAndMarkUse } = await import("../src/workbot-proactive/worker.js")
type Reading = Parameters<typeof summarizeFeatureOutcomes>[0]

const NOW = new Date("2026-10-28T15:00:00.000Z")

test("every feature that declares outcomes has exactly one reader, and no reader names another feature", () => {
  const declared = FEATURE_KEYS.filter((key) => featureDefinition(key).outcomes === true)
  assert.deepEqual([...OUTCOME_FEATURE_KEYS].sort(), [...declared].sort())
  assert.deepEqual(Object.keys(FEATURE_OUTCOME_READERS).sort(), [...declared].sort())
  for (const key of FEATURE_KEYS) assert.equal(featureOutcomeReader(key) !== null, declared.includes(key), key)
  assert.ok(declared.length >= 1, "Your agent reports rollout outcomes; the schedule-feature outcomes are retired and GA")
})

test("a range is whole UTC days ending today", () => {
  const range = featureOutcomeRange(7, NOW)
  assert.equal(range.from.toISOString(), "2026-10-22T00:00:00.000Z")
  assert.equal(range.to, NOW)
  assert.deepEqual(range.days, ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"])
  assert.equal(featureOutcomeRange(30, NOW).days.length, 30)
})

const at = (day: string) => new Date(`${day}T12:00:00.000Z`)

test("a reading becomes totals, reasons, a full day series and one row per organization", () => {
  const range = featureOutcomeRange(7, NOW)
  const reading: Reading = {
    unit: "meeting",
    limited: null,
    coverage: null,
    rows: [
      { organizationId: "org_a", day: "2026-10-27", status: "succeeded", reason: null, count: 2, delivered: null, lastAt: at("2026-10-27") },
      { organizationId: "org_a", day: "2026-10-28", status: "skipped", reason: "execution_runtime_unavailable", count: 3, delivered: null, lastAt: at("2026-10-28") },
      { organizationId: "org_b", day: "2026-10-28", status: "failed", reason: "execution_failed", count: 1, delivered: null, lastAt: at("2026-10-28") },
      { organizationId: "org_b", day: "2026-10-28", status: "skipped", reason: "execution_runtime_unavailable", count: 1, delivered: null, lastAt: at("2026-10-28") },
      { organizationId: "org_b", day: "2026-10-28", status: "running", reason: null, count: 1, delivered: null, lastAt: NOW },
      // Outside the range: ignored.
      { organizationId: "org_a", day: "2026-10-01", status: "failed", reason: "execution_failed", count: 9, delivered: null, lastAt: at("2026-10-01") },
    ],
  }
  const summary = summarizeFeatureOutcomes(reading, range)
  assert.deepEqual(
    { runs: summary.runs, succeeded: summary.succeeded, failed: summary.failed, skipped: summary.skipped, delivered: summary.delivered, limited: summary.limited },
    { runs: 8, succeeded: 2, failed: 1, skipped: 4, delivered: null, limited: null },
  )
  assert.equal(summary.lastRunAt?.toISOString(), NOW.toISOString())
  assert.deepEqual(summary.reasons, [
    { reason: "execution_runtime_unavailable", outcome: "skipped", count: 4 },
    { reason: "execution_failed", outcome: "failed", count: 1 },
  ])
  assert.equal(summary.days.length, 7)
  assert.deepEqual(summary.days.at(-1), { day: "2026-10-28", runs: 6, failed: 1 })
  assert.deepEqual(summary.days.at(-2), { day: "2026-10-27", runs: 2, failed: 0 })
  assert.deepEqual(summary.days[0], { day: "2026-10-22", runs: 0, failed: 0 })
  assert.equal(summary.byOrganization.get("org_a")?.runs, 5)
  assert.equal(summary.byOrganization.get("org_a")?.skipped, 3)
  assert.equal(summary.byOrganization.get("org_b")?.failed, 1)
  assert.equal(summary.byOrganization.get("org_b")?.runs, 3)
})

test("messages delivered and members at a limit add up per organization", () => {
  const range = featureOutcomeRange(7, NOW)
  const summary = summarizeFeatureOutcomes({
    unit: "message",
    limited: new Map([["org_a", 2], ["org_c", 1]]),
    coverage: { from: new Date(NOW.getTime() - 86_400_000), counts: "all" },
    rows: [
      { organizationId: "org_a", day: "2026-10-28", status: "succeeded", reason: null, count: 20, delivered: 20, lastAt: NOW },
      { organizationId: "org_a", day: "2026-10-28", status: "failed", reason: "slack_refused", count: 2, delivered: 0, lastAt: NOW },
    ],
  }, range)
  assert.equal(summary.delivered, 20)
  assert.equal(summary.limited, 3)
  assert.equal(summary.byOrganization.get("org_a")?.limited, 2)
  assert.equal(summary.byOrganization.get("org_c")?.limited, 1)
  assert.equal(summary.byOrganization.get("org_c")?.runs, 0)
  assert.equal(summary.coverage?.counts, "all")
})

const totals = (input: Partial<{ runs: number; succeeded: number; failed: number; skipped: number; limited: number | null }>) => ({
  runs: 0, succeeded: 0, failed: 0, skipped: 0, delivered: null, limited: null, lastRunAt: null, ...input,
})

test("one plain health state: not used, failing, limited, mostly skipped, healthy", () => {
  assert.deepEqual(featureHealth({ membersUsing: 0, outcomes: null }), { status: "not_used" })
  assert.deepEqual(featureHealth({ membersUsing: 3, outcomes: null }), { status: "in_use" })
  assert.deepEqual(featureHealth({ membersUsing: 0, outcomes: totals({}) }), { status: "not_used" })
  assert.deepEqual(featureHealth({ membersUsing: 2, outcomes: totals({}) }), { status: "in_use" })
  assert.deepEqual(featureHealth({ membersUsing: 1, outcomes: totals({ runs: 10, succeeded: 8, failed: 2 }) }), { status: "failing", count: 2 })
  assert.deepEqual(featureHealth({ membersUsing: 1, outcomes: totals({ runs: 10, succeeded: 9, failed: 1 }) }), { status: "healthy" })
  assert.deepEqual(featureHealth({ membersUsing: 1, outcomes: totals({ runs: 40, succeeded: 40, limited: 2 }) }), { status: "limited", count: 2 })
  assert.deepEqual(featureHealth({ membersUsing: 1, outcomes: totals({ runs: 10, succeeded: 3, skipped: 7 }) }), { status: "mostly_skipped" })
  assert.deepEqual(featureHealth({ membersUsing: 1, outcomes: totals({ runs: 10, succeeded: 5, skipped: 5 }) }), { status: "healthy" })
})

test("organizations with a feature on follow the deployment state and overrides without reading each one", () => {
  const key: FeatureKey = "workbotProactive"
  const count = (rollouts: Parameters<typeof organizationsWithFeatureOn>[0]["rollouts"], overrides = { on: 3, off: 2 }, locks = {}) =>
    organizationsWithFeatureOn({ key, environment: { deployment: "cloud", locks }, rollouts, overrides, organizations: 50 })
  assert.equal(count({}), 3, "off for everyone: the organizations turned on")
  assert.equal(count({ [key]: { enabled: true, killed: false } }), 48, "on for everyone: all but the organizations turned off")
  assert.equal(count({ [key]: { enabled: true, killed: true } }), 0, "the kill switch wins")
  assert.equal(count({}, undefined, { [key]: true }), 50, "an operator lock decides for everyone")
})

/** A marker with the real once-per-day dedupe, writing to an array; `setDay` moves its clock. */
function recordingMarker() {
  let now = new Date("2026-10-28T09:00:00.000Z")
  const writes: string[] = []
  const mark = createFeatureUsageMarker(async (input) => {
    writes.push(...input.keys.map((key) => `${input.at.toISOString().slice(0, 10)} ${input.memberId} ${key}`))
  }, () => now)
  return { mark, writes, setDay: (day: string) => { now = new Date(`${day}T10:00:00.000Z`) } }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")

function agentRow(): AgentInstanceRow {
  return {
    memberId, organizationId, templateVersionId: null, status: null, overrides: null, snoozedUntil: null, state: null, preferences: null,
    timeZone: null, nextWakeAt: NOW, failures: 0, leaseOwner: "lease-1", leaseUntil: NOW, createdAt: NOW, updatedAt: NOW,
  }
}

test("Your agent: a pass that ran marks the member's use once per day; skipped wakes do not", async () => {
  const { mark, writes, setDay } = recordingMarker()
  const ran = async (): Promise<AgentWakeOutcome> => ({ status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null })
  const skipped = async (): Promise<AgentWakeOutcome> => ({ status: "skipped", reason: "outside_hours" })
  await wakeAndMarkUse(agentRow(), skipped, mark)
  await wakeAndMarkUse(agentRow(), ran, mark)
  await wakeAndMarkUse(agentRow(), ran, mark)
  setDay("2026-10-29")
  await wakeAndMarkUse(agentRow(), ran, mark)
  await settle()
  assert.deepEqual(writes, [`2026-10-28 ${memberId} workbotProactive`, `2026-10-29 ${memberId} workbotProactive`])
})
