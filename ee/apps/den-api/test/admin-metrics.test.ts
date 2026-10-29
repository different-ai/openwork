import assert from "node:assert/strict"
import { test } from "node:test"
import type { ControlCenterRevenue } from "@openwork/types/den/admin-control-center"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/admin_metrics_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-admin-metrics-unit-test-secret-not-for-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-admin-metrics-unit-test-key"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
const {
  activationFunnel, addDays, buildRetentionCohorts, classifyWeeks, dayTime, isReactivated, isSharedSkill, reuseRate, taskOutcomes, weekStart,
} = await import("../src/admin-metrics/definitions.js")
const { METRICS, readControlCenter, refreshMetric } = await import("../src/admin-metrics/snapshots.js")
type Store = import("../src/admin-metrics/snapshots.js").SnapshotStore
type Row = import("../src/admin-metrics/snapshots.js").SnapshotRow

const user = (signupDay: string, days: string[]) => ({ signupDay, days: new Set(days) })

test("weeks start on Monday in UTC", () => {
  assert.equal(weekStart("2026-10-25"), "2026-10-19") // Sunday
  assert.equal(weekStart("2026-10-19"), "2026-10-19") // Monday
  assert.equal(weekStart("2026-10-28"), "2026-10-26")
})

test("lifecycle puts everyone active in a week in exactly one group and counts the lost", () => {
  const week = "2026-10-19"
  const [row] = classifyWeeks([
    user("2026-10-20", ["2026-10-20"]), // new: signed up this week
    user("2026-10-01", ["2026-10-13", "2026-10-21"]), // still active
    user("2026-10-01", ["2026-10-06", "2026-10-22"]), // back after a skipped week
    user("2026-10-14", ["2026-10-23"]), // signed up last week, first active this week: back, not new
    user("2026-10-01", ["2026-10-14"]), // lost
    user("2026-10-01", ["2026-10-02"]), // inactive both weeks: not counted
  ], [week])
  assert.deepEqual(row, { week, new: 1, stillActive: 1, returned: 2, lost: 1, gainsVsLosses: 3 })
})

test("gains vs losses is unknown when nobody was lost", () => {
  const [row] = classifyWeeks([user("2026-10-19", ["2026-10-19"])], ["2026-10-19"])
  assert.equal(row?.gainsVsLosses, null)
})

test("reactivation needs 14 quiet days and an account at least 14 days old", () => {
  const week = "2026-10-19"
  assert.equal(isReactivated(user("2026-09-01", ["2026-09-20", "2026-10-21"]), week), true)
  assert.equal(isReactivated(user("2026-09-01", ["2026-10-05", "2026-10-21"]), week), false, "active 14 days before the week")
  assert.equal(isReactivated(user("2026-09-01", ["2026-10-04", "2026-10-21"]), week), true, "the quiet window is exactly 14 days")
  assert.equal(isReactivated(user("2026-10-10", ["2026-10-21"]), week), false, "account too new")
  assert.equal(isReactivated(user("2026-09-01", ["2026-09-20"]), week), false, "not active this week")
})

test("activation funnel steps are nested", () => {
  const funnel = activationFunnel([
    user("2026-10-01", ["2026-10-01", "2026-10-03", "2026-10-09"]), // every step
    user("2026-10-01", ["2026-10-02", "2026-10-05"]), // back but not active in week 1
    user("2026-10-01", ["2026-10-01"]), // ran a task only on day 0
    user("2026-10-01", ["2026-10-05", "2026-10-09"]), // first task after 3 days: stops at step 1
    user("2026-10-01", []),
    user("2026-09-01", ["2026-09-01"]), // outside the cohort
  ], "2026-10-01", "2026-10-14")
  assert.deepEqual(funnel, { signedUp: 5, ranTaskWithin3Days: 3, backAfterDay1: 2, activeInWeek1: 1 })
})

test("retention cohorts count each person once per week offset", () => {
  const signupTime = dayTime("2026-10-13")
  const cohorts = buildRetentionCohorts(
    [{ userId: "a", cohort: "2026-10-12", signupTime }, { userId: "b", cohort: "2026-10-12", signupTime }],
    [
      { userId: "a", dayTime: signupTime }, { userId: "a", dayTime: dayTime("2026-10-14") },
      { userId: "a", dayTime: dayTime("2026-10-21") }, { userId: "b", dayTime: dayTime("2026-10-22") },
      { userId: "c", dayTime: signupTime }, { userId: "b", dayTime: dayTime("2026-10-01") },
    ],
  )
  assert.equal(cohorts.length, 1)
  assert.equal(cohorts[0]?.signups, 2)
  assert.deepEqual([...(cohorts[0]?.retained ?? [])], [[0, 1], [1, 2]])
})

test("sharing and reuse rates", () => {
  assert.equal(isSharedSkill("m1", []), false)
  assert.equal(isSharedSkill("m1", [{ orgWide: false, teamId: null, memberId: "m1" }]), false, "a grant to the creator alone is private")
  assert.equal(isSharedSkill("m1", [{ orgWide: false, teamId: null, memberId: "m2" }]), true)
  assert.equal(isSharedSkill("m1", [{ orgWide: false, teamId: "team_1", memberId: null }]), true)
  assert.equal(isSharedSkill("m1", [{ orgWide: true, teamId: null, memberId: null }]), true)
  assert.deepEqual(reuseRate([
    { memberId: "m1", creatorId: "m1", uses: 6 },
    { memberId: "m2", creatorId: "m1", uses: 3 },
    { memberId: "m2", creatorId: null, uses: 1 },
  ]), { total: 10, byOthers: 3, rate: 0.3 })
  assert.equal(reuseRate([]).rate, null)
})

test("abandoned tasks are the started ones that neither completed nor failed", () => {
  assert.deepEqual(taskOutcomes(100, 80, 10), { started: 100, completed: 80, failed: 10, abandoned: 10, failureRate: 0.1, abandonedRate: 0.1 })
  assert.equal(taskOutcomes(0, 0, 0).failureRate, null)
})

// --- snapshot refresh and read ---

const revenue = (seats: number): ControlCenterRevenue => ({ activePaidSeats: seats, activePlans: 1, pastDue: 0, monthly: [], atRisk: [] })

function memoryStore() {
  const snapshots = new Map<string, Row & { attemptedAt: Date }>()
  const leases = new Map<string, { owner: string | null; until: Date | null }>()
  let requestedAt: Date | null = null
  const store: Store = {
    async claim(key, owner, until, now, force) {
      const lease = leases.get(key)
      const free = !lease || !lease.until || lease.until < now || (force && lease.owner === null)
      if (!free) return false
      leases.set(key, { owner, until })
      return true
    },
    async release(key, owner, nextDue) {
      if (leases.get(key)?.owner === owner) leases.set(key, { owner: null, until: nextDue })
    },
    async saveSuccess(key, payloads, durationMs, now) {
      for (const [rangeKey, payload] of Object.entries(payloads)) snapshots.set(`${key}:${rangeKey}`, { metricKey: key, rangeKey, payload, computedAt: now, durationMs, error: null, attemptedAt: now })
    },
    async saveFailure(key, ranges, error, durationMs, now) {
      for (const rangeKey of ranges) {
        const previous = snapshots.get(`${key}:${rangeKey}`)
        snapshots.set(`${key}:${rangeKey}`, { metricKey: key, rangeKey, payload: previous?.payload ?? null, computedAt: previous?.computedAt ?? null, durationMs, error, attemptedAt: now })
      }
    },
    async read(rangeKeys) {
      return [...snapshots.values()].filter((row) => rangeKeys.some((key) => key === row.rangeKey))
    },
    async requestRefresh(now, minIntervalMs) {
      if (requestedAt && now.getTime() - requestedAt.getTime() < minIntervalMs) return { accepted: false, retryAfterMs: requestedAt.getTime() + minIntervalMs - now.getTime() }
      requestedAt = now
      return { accepted: true }
    },
    async lastRequestedAt() {
      return requestedAt
    },
  }
  return { store, snapshots, leases }
}

const intervals = { fast: 5 * 60_000, heavy: 30 * 60_000 }
const context = (now: Date) => ({ now, rows: async () => [] })
const withRevenue = (compute: () => Promise<ControlCenterRevenue>) => ({ ...METRICS, revenue: { ...METRICS.revenue, compute: async () => ({ all: await compute() }) } })

test("a failed refresh keeps the last good snapshot and records the error", async () => {
  const { store } = memoryStore()
  const now = new Date("2026-10-28T12:00:00.000Z")
  assert.equal(await refreshMetric("revenue", { store, context: context(now), owner: "a", intervals, metrics: withRevenue(async () => revenue(12)) }), "refreshed")
  const failing = withRevenue(async () => { throw new Error("Query exceeded the time limit\nat line 2") })
  assert.equal(await refreshMetric("revenue", { store, context: context(now), owner: "a", intervals, force: true, metrics: failing }), "failed")
  const view = await readControlCenter("7d", { store, now, intervals })
  assert.equal(view.sections.revenue.data?.activePaidSeats, 12)
  assert.equal(view.sections.revenue.error, "Query exceeded the time limit")
  assert.equal(view.sections.revenue.stale, false)
  // Other sections are untouched and simply have no data yet.
  assert.equal(view.sections.pulse.data, null)
  assert.equal(view.sections.pulse.stale, true)
})

test("an invalid payload is a failure, not a snapshot", async () => {
  const { store } = memoryStore()
  const now = new Date("2026-10-28T12:00:00.000Z")
  const invalid = withRevenue(async () => ({ ...revenue(1), activePaidSeats: -1 }))
  assert.equal(await refreshMetric("revenue", { store, context: context(now), owner: "a", intervals, metrics: invalid }), "failed")
  const view = await readControlCenter("30d", { store, now, intervals })
  assert.equal(view.sections.revenue.data, null)
  assert.match(view.sections.revenue.error ?? "", /invalid all snapshot/)
})

test("a snapshot older than twice its interval is stale", async () => {
  const { store } = memoryStore()
  const computed = new Date("2026-10-28T12:00:00.000Z")
  await refreshMetric("revenue", { store, context: context(computed), owner: "a", intervals, metrics: withRevenue(async () => revenue(3)) })
  const later = (ms: number) => readControlCenter("90d", { store, now: new Date(computed.getTime() + ms), intervals })
  assert.equal((await later(2 * intervals.heavy - 1_000)).sections.revenue.stale, false)
  assert.equal((await later(2 * intervals.heavy + 60_000)).sections.revenue.stale, true)
})

test("the lease lets only one instance recompute a metric at a time", async () => {
  const { store, leases } = memoryStore()
  const now = new Date()
  let release: () => void = () => undefined
  let computes = 0
  const slow = withRevenue(async () => {
    computes += 1
    await new Promise<void>((resolve) => { release = resolve })
    return revenue(5)
  })
  const first = refreshMetric("revenue", { store, context: context(now), owner: "instance-a", intervals, metrics: slow })
  await new Promise((resolve) => setImmediate(resolve))
  // Even a forced refresh waits for a running one.
  assert.equal(await refreshMetric("revenue", { store, context: context(now), owner: "instance-b", intervals, force: true, metrics: slow }), "skipped")
  release()
  assert.equal(await first, "refreshed")
  assert.equal(computes, 1)
  assert.equal(leases.get("revenue")?.owner, null)
  // Until the next due time only a forced refresh runs.
  assert.equal(await refreshMetric("revenue", { store, context: context(new Date()), owner: "instance-b", intervals, metrics: withRevenue(async () => revenue(6)) }), "skipped")
  assert.equal(await refreshMetric("revenue", { store, context: context(new Date()), owner: "instance-b", intervals, force: true, metrics: withRevenue(async () => revenue(6)) }), "refreshed")
})

test("an expired lease from a crashed instance can be taken over", async () => {
  const { store, leases } = memoryStore()
  const now = new Date()
  leases.set("revenue", { owner: "crashed", until: new Date(now.getTime() - 1) })
  assert.equal(await refreshMetric("revenue", { store, context: context(now), owner: "instance-b", intervals, metrics: withRevenue(async () => revenue(1)) }), "refreshed")
})

test("range-independent sections read their single snapshot for every range", async () => {
  const { store } = memoryStore()
  const now = new Date("2026-10-28T12:00:00.000Z")
  await refreshMetric("revenue", { store, context: context(now), owner: "a", intervals, metrics: withRevenue(async () => revenue(9)) })
  for (const range of ["7d", "30d", "90d"] as const) {
    assert.equal((await readControlCenter(range, { store, now, intervals })).sections.revenue.data?.activePaidSeats, 9)
  }
  assert.equal(addDays("2026-10-31", 1), "2026-11-01")
})
