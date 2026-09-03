import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import type { InferenceRequestLogRow } from "../src/request-log.js"
import {
  DAY_MS,
  HOUR_MS,
  ROLLUP_SUM_COLUMNS,
  buildRollupRows,
  registerRollupRoutes,
  rollupDimensionKey,
  runRollups,
} from "../src/rollups.js"
import type { AggregatedRollup, RollupDimensions, RollupRepository, RollupRow, RollupStore, RollupSums } from "../src/rollups.js"

const org = createDenTypeId("organization")
const memberA = createDenTypeId("member")
const memberB = createDenTypeId("member")
const key = createDenTypeId("inferenceKey")
const provider = createDenTypeId("inferenceProvider")

const T0 = Date.UTC(2026, 0, 10, 0, 0, 0)

function rawRow(overrides: Partial<InferenceRequestLogRow>): InferenceRequestLogRow {
  const startedAt = overrides.started_at ?? new Date(T0)
  return {
    id: createDenTypeId("inferenceRequestLog"),
    organization_id: org,
    org_membership_id: memberA,
    inference_key_id: key,
    inference_provider_id: provider,
    inference_provider_credential_id: null,
    route: "org_provider",
    protocol: "anthropic_messages",
    upstream_provider_id: "anthropic",
    upstream_host: "api.anthropic.com",
    upstream_path: "/v1/messages",
    method: "POST",
    requested_model: "claude-a",
    upstream_model: "claude-a",
    stream: false,
    status: 200,
    outcome: "ok",
    error_code: null,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    usage_source: "json",
    cost_micro_usd: 1000,
    upstream_request_id: null,
    openwork_request_id: createDenTypeId("inferenceRequestLog").slice(-20),
    started_at: startedAt,
    first_byte_at: new Date(startedAt.getTime() + 100),
    completed_at: new Date(startedAt.getTime() + 1000),
    request_bytes: 10,
    response_bytes: 20,
    metadata: null,
    ...overrides,
  }
}

function dimensionsOf(row: RollupDimensions): RollupDimensions {
  return {
    organization_id: row.organization_id,
    org_membership_id: row.org_membership_id,
    inference_provider_id: row.inference_provider_id ?? null,
    route: row.route,
    protocol: row.protocol,
    upstream_provider_id: row.upstream_provider_id,
    upstream_model: row.upstream_model ?? null,
  }
}

function zeroSums(): RollupSums {
  return {
    request_count: 0,
    ok_count: 0,
    error_count: 0,
    aborted_count: 0,
    stream_count: 0,
    usage_missing_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_micro_usd: 0,
    latency_ms_sum: 0,
    ttfb_ms_sum: 0,
    request_bytes: 0,
    response_bytes: 0,
    source_row_count: 0,
  }
}

function inRange(date: Date, start: Date, end: Date) {
  return date.getTime() >= start.getTime() && date.getTime() < end.getTime()
}

// Mirrors the SQL aggregation in src/rollups.ts.
function aggregateRaw(rows: InferenceRequestLogRow[]): AggregatedRollup[] {
  const groups = new Map<string, AggregatedRollup>()
  for (const row of rows) {
    const dims = dimensionsOf(row)
    const dimensionKey = rollupDimensionKey(dims)
    const group = groups.get(dimensionKey) ?? { ...dims, ...zeroSums() }
    const aborted = row.completed_at === null || row.completed_at === undefined || row.outcome === "client_aborted"
    group.request_count += 1
    group.source_row_count += 1
    if (!aborted && row.outcome === "ok") group.ok_count += 1
    if (!aborted && row.outcome !== "ok") group.error_count += 1
    if (aborted) group.aborted_count += 1
    if (row.stream) group.stream_count += 1
    if (row.usage_source === "missing") group.usage_missing_count += 1
    group.input_tokens += row.input_tokens ?? 0
    group.output_tokens += row.output_tokens ?? 0
    group.total_tokens += row.total_tokens ?? 0
    group.cache_read_tokens += row.cache_read_tokens ?? 0
    group.cache_write_tokens += row.cache_write_tokens ?? 0
    group.reasoning_tokens += row.reasoning_tokens ?? 0
    group.cost_micro_usd += row.cost_micro_usd ?? 0
    group.latency_ms_sum += (row.completed_at ?? row.started_at).getTime() - row.started_at.getTime()
    group.ttfb_ms_sum += (row.first_byte_at ?? row.started_at).getTime() - row.started_at.getTime()
    group.request_bytes += row.request_bytes ?? 0
    group.response_bytes += row.response_bytes ?? 0
    groups.set(dimensionKey, group)
  }
  return [...groups.values()]
}

function aggregateHours(rows: RollupRow[]): AggregatedRollup[] {
  const groups = new Map<string, AggregatedRollup>()
  for (const row of rows) {
    const dims = dimensionsOf(row)
    const group = groups.get(row.dimension_key) ?? { ...dims, ...zeroSums() }
    for (const column of ROLLUP_SUM_COLUMNS) group[column] += row[column] ?? 0
    groups.set(row.dimension_key, group)
  }
  return [...groups.values()]
}

type FakeState = {
  raw: InferenceRequestLogRow[]
  rollups: RollupRow[]
  oauthStateExpiries: Date[]
  transactions: number
}

function createFakeRepository(state: FakeState): RollupRepository {
  const store: RollupStore = {
    async aggregateRawHour(bucketStart) {
      const end = new Date(bucketStart.getTime() + HOUR_MS)
      return aggregateRaw(state.raw.filter((row) => inRange(row.started_at, bucketStart, end)))
    },
    async aggregateHourRollupsToDay(dayStart) {
      const end = new Date(dayStart.getTime() + DAY_MS)
      return aggregateHours(state.rollups.filter((row) => row.granularity === "hour" && inRange(row.bucket_start, dayStart, end)))
    },
    async upsertRollups(rows) {
      for (const row of rows) {
        const existing = state.rollups.find((candidate) =>
          candidate.granularity === row.granularity
          && candidate.bucket_start.getTime() === row.bucket_start.getTime()
          && candidate.dimension_key === row.dimension_key)
        if (existing) {
          for (const column of ROLLUP_SUM_COLUMNS) existing[column] = row[column]
        } else {
          state.rollups.push({ ...row })
        }
      }
    },
    async deleteRawInRange(start, end) {
      const before = state.raw.length
      state.raw = state.raw.filter((row) => !inRange(row.started_at, start, end))
      return before - state.raw.length
    },
    async deleteHourRollupsInRange(start, end) {
      const before = state.rollups.length
      state.rollups = state.rollups.filter((row) => !(row.granularity === "hour" && inRange(row.bucket_start, start, end)))
      return before - state.rollups.length
    },
  }
  const buckets = (dates: Date[], before: Date, limit: number, sizeMs: number) => {
    const set = new Set(dates.filter((date) => date < before).map((date) => Math.floor(date.getTime() / sizeMs) * sizeMs))
    return [...set].sort((a, b) => a - b).slice(0, limit).map((ms) => new Date(ms))
  }
  return {
    ...store,
    async listCandidateHourBuckets(before, limit) {
      return buckets(state.raw.map((row) => row.started_at), before, limit, HOUR_MS)
    },
    async listCandidateDayBuckets(before, limit) {
      return buckets(state.rollups.filter((row) => row.granularity === "hour").map((row) => row.bucket_start), before, limit, DAY_MS)
    },
    async deleteExpiredOauthStates(now) {
      const before = state.oauthStateExpiries.length
      state.oauthStateExpiries = state.oauthStateExpiries.filter((expiry) => expiry >= now)
      return before - state.oauthStateExpiries.length
    },
    async transaction(run) {
      state.transactions += 1
      return run(store)
    },
  }
}

function seedRaw(): InferenceRequestLogRow[] {
  return [
    // hour 0: member A, claude-a (two rows, one streamed with cache tokens)
    rawRow({ started_at: new Date(T0 + 5 * 60_000) }),
    rawRow({ started_at: new Date(T0 + 10 * 60_000), stream: true, cache_read_tokens: 30, input_tokens: 200, output_tokens: 100, total_tokens: 300, cost_micro_usd: 2000 }),
    // hour 0: member B, claude-b, crashed mid-request (completed_at null)
    rawRow({ started_at: new Date(T0 + 20 * 60_000), org_membership_id: memberB, upstream_model: "claude-b", completed_at: null, first_byte_at: null, usage_source: "missing", input_tokens: null, output_tokens: null, total_tokens: null, cost_micro_usd: null }),
    // hour 1: member A, claude-b, upstream error
    rawRow({ started_at: new Date(T0 + HOUR_MS + 60_000), upstream_model: "claude-b", outcome: "upstream_error", status: 500 }),
  ]
}

// Past the 2d raw retention but inside the 90d hourly retention.
const farFuture = new Date(T0 + 10 * DAY_MS)

test("hourly pass groups raw rows by dimensions with stable, distinct dimension keys", async () => {
  const state: FakeState = { raw: seedRaw(), rollups: [], oauthStateExpiries: [], transactions: 0 }
  const summary = await runRollups({ repository: createFakeRepository(state), now: farFuture })

  assert.deepEqual(summary, { hourBuckets: 2, dayBuckets: 0, rawRowsDeleted: 4, hourRowsDeleted: 0, oauthStatesDeleted: 0 })
  assert.equal(state.raw.length, 0)
  assert.equal(state.rollups.length, 3)
  assert.equal(state.transactions, 2)

  const hour0 = state.rollups.filter((row) => row.bucket_start.getTime() === T0)
  assert.equal(hour0.length, 2)
  const memberARow = hour0.find((row) => row.org_membership_id === memberA)
  assert.ok(memberARow)
  assert.equal(memberARow.request_count, 2)
  assert.equal(memberARow.ok_count, 2)
  assert.equal(memberARow.stream_count, 1)
  assert.equal(memberARow.input_tokens, 300)
  assert.equal(memberARow.output_tokens, 150)
  assert.equal(memberARow.cache_read_tokens, 30)
  assert.equal(memberARow.cost_micro_usd, 3000)
  assert.equal(memberARow.latency_ms_sum, 2000)
  assert.equal(memberARow.ttfb_ms_sum, 200)
  assert.equal(memberARow.source_row_count, 2)
  assert.equal(memberARow.upstream_model, "claude-a")

  const memberBRow = hour0.find((row) => row.org_membership_id === memberB)
  assert.ok(memberBRow)
  assert.equal(memberBRow.request_count, 1)
  assert.equal(memberBRow.aborted_count, 1, "null completed_at counts as aborted")
  assert.equal(memberBRow.ok_count, 0)
  assert.equal(memberBRow.usage_missing_count, 1)
  assert.equal(memberBRow.latency_ms_sum, 0)

  const hour1 = state.rollups.filter((row) => row.bucket_start.getTime() === T0 + HOUR_MS)
  assert.equal(hour1.length, 1)
  assert.equal(hour1[0]?.error_count, 1)
  assert.equal(hour1[0]?.ok_count, 0)

  const keys = new Set(state.rollups.map((row) => row.dimension_key))
  assert.equal(keys.size, 3, "every (member, model) combination gets its own key")
  assert.equal(hour1[0]?.dimension_key, rollupDimensionKey({ ...dimensionsOf(memberARow), upstream_model: "claude-b" }))
  assert.notEqual(hour1[0]?.dimension_key, memberBRow.dimension_key, "same model, different member")
  assert.equal(memberARow.dimension_key, rollupDimensionKey(dimensionsOf(memberARow)))
  assert.match(memberARow.dimension_key, /^[0-9a-f]{64}$/)
  assert.equal(memberARow.granularity, "hour")
})

test("re-running with the same input is idempotent", async () => {
  const state: FakeState = { raw: seedRaw(), rollups: [], oauthStateExpiries: [], transactions: 0 }
  const repository = createFakeRepository(state)
  await runRollups({ repository, now: farFuture })
  const first = state.rollups.map((row) => ({ ...row }))

  state.raw = seedRaw()
  await runRollups({ repository, now: farFuture })
  assert.equal(state.rollups.length, first.length)
  for (const row of first) {
    const again = state.rollups.find((candidate) => candidate.dimension_key === row.dimension_key && candidate.bucket_start.getTime() === row.bucket_start.getTime())
    assert.ok(again)
    for (const column of ROLLUP_SUM_COLUMNS) assert.equal(again[column], row[column])
  }
})

test("raw rows newer than the retention are untouched and open hours never fold", async () => {
  const state: FakeState = { raw: seedRaw(), rollups: [], oauthStateExpiries: [], transactions: 0 }
  // now sits inside hour 1 + 2d retention: hour 0 closed, hour 1 still open.
  const now = new Date(T0 + HOUR_MS + 30 * 60_000 + 2 * DAY_MS)
  const summary = await runRollups({ repository: createFakeRepository(state), now })
  assert.equal(summary.hourBuckets, 1)
  assert.equal(summary.rawRowsDeleted, 3)
  assert.equal(state.raw.length, 1)
  assert.equal(state.raw[0]?.started_at.getTime(), T0 + HOUR_MS + 60_000)
})

test("maxBucketsPerRun bounds the work, oldest bucket first", async () => {
  const state: FakeState = { raw: seedRaw(), rollups: [], oauthStateExpiries: [], transactions: 0 }
  const repository = createFakeRepository(state)
  const summary = await runRollups({ repository, now: farFuture, maxBucketsPerRun: 1 })
  assert.equal(summary.hourBuckets, 1)
  assert.equal(state.rollups.every((row) => row.bucket_start.getTime() === T0), true)
  assert.equal(state.raw.length, 1)
  const second = await runRollups({ repository, now: farFuture, maxBucketsPerRun: 1 })
  assert.equal(second.hourBuckets, 1)
  assert.equal(state.raw.length, 0)
})

test("daily pass folds hour rollups into one day row per dimension", async () => {
  const groups = aggregateRaw(seedRaw().filter((row) => row.org_membership_id === memberA && row.upstream_model === "claude-a"))
  const hourRows = [
    ...buildRollupRows("hour", new Date(T0), groups),
    ...buildRollupRows("hour", new Date(T0 + 5 * HOUR_MS), groups),
    ...buildRollupRows("hour", new Date(T0 + DAY_MS), groups), // next day: stays
  ]
  const state: FakeState = { raw: [], rollups: hourRows, oauthStateExpiries: [], transactions: 0 }
  const now = new Date(T0 + DAY_MS + 90 * DAY_MS + HOUR_MS)
  const summary = await runRollups({ repository: createFakeRepository(state), now })

  assert.equal(summary.dayBuckets, 1)
  assert.equal(summary.hourRowsDeleted, 2)
  const day = state.rollups.filter((row) => row.granularity === "day")
  assert.equal(day.length, 1)
  assert.equal(day[0]?.bucket_start.getTime(), T0)
  assert.equal(day[0]?.request_count, 4)
  assert.equal(day[0]?.source_row_count, 4)
  assert.equal(day[0]?.cost_micro_usd, 6000)
  assert.equal(day[0]?.dimension_key, hourRows[0]?.dimension_key)
  assert.equal(state.rollups.filter((row) => row.granularity === "hour").length, 1)
})

test("expired oauth states are swept in the same run", async () => {
  const now = new Date(T0)
  const state: FakeState = { raw: [], rollups: [], oauthStateExpiries: [new Date(T0 - 1), new Date(T0 + 1)], transactions: 0 }
  const summary = await runRollups({ repository: createFakeRepository(state), now })
  assert.equal(summary.oauthStatesDeleted, 1)
  assert.equal(state.oauthStateExpiries.length, 1)
})

test("POST /internal/rollups/run is guarded by the admin token", async () => {
  const calls: Array<{ now?: Date; maxBucketsPerRun?: number }> = []
  const summary = { hourBuckets: 1, dayBuckets: 0, rawRowsDeleted: 2, hourRowsDeleted: 0, oauthStatesDeleted: 0 }
  const withToken = new Hono()
  registerRollupRoutes(withToken, {
    adminToken: "secret-admin-token",
    async runRollups(input) {
      calls.push({ now: input.now, maxBucketsPerRun: input.maxBucketsPerRun })
      return summary
    },
  })
  const noToken = new Hono()
  registerRollupRoutes(noToken, { adminToken: undefined, runRollups: async () => summary })

  assert.equal((await noToken.request("/internal/rollups/run", { method: "POST", headers: { authorization: "Bearer secret-admin-token" } })).status, 404)
  assert.equal((await withToken.request("/internal/rollups/run", { method: "POST" })).status, 401)
  assert.equal((await withToken.request("/internal/rollups/run", { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401)
  assert.equal(calls.length, 0)

  const ok = await withToken.request("/internal/rollups/run", {
    method: "POST",
    headers: { authorization: "Bearer secret-admin-token", "content-type": "application/json" },
    body: JSON.stringify({ now: "2026-01-10T00:00:00.000Z", maxBucketsPerRun: 3 }),
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), summary)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.now?.toISOString(), "2026-01-10T00:00:00.000Z")
  assert.equal(calls[0]?.maxBucketsPerRun, 3)

  const empty = await withToken.request("/internal/rollups/run", { method: "POST", headers: { authorization: "Bearer secret-admin-token" } })
  assert.equal(empty.status, 200)
  assert.equal(calls[1]?.now, undefined)
})
