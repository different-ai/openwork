import assert from "node:assert/strict"
import { test } from "node:test"
import { capabilityUsageSourceValues, type CapabilityUsageSource } from "@openwork-ee/den-db"
import {
  buildCapabilityUsageRollupRows,
  capabilityUsageRollupDimensionKey,
  runCapabilityUsageRollups,
  type CapabilityUsageAggregate,
  type CapabilityUsageRollupRepository,
  type CapabilityUsageRollupRow,
} from "../src/capability-usage-rollups.js"

const DAY_MS = 86_400_000
const org = "org_01aaaaaaaaaaaaaaaaaaaaaaaa"
const alice = "om_01aaaaaaaaaaaaaaaaaaaaaaaa"
const blair = "om_01bbbbbbbbbbbbbbbbbbbbbbbb"
const plugin = "plg_01aaaaaaaaaaaaaaaaaaaaaaaa"
const skill = "cob_01aaaaaaaaaaaaaaaaaaaaaaaa"

type RawEvent = {
  id: `cue_${string}`
  member: `om_${string}`
  kind: "skill" | "connector_tool"
  source: CapabilityUsageSource
  outcome: "ok" | "error" | null
  connection: string | null
  at: Date
}

function aggregate(events: readonly RawEvent[]): CapabilityUsageAggregate[] {
  const groups = new Map<string, CapabilityUsageAggregate>()
  for (const event of events) {
    const key = JSON.stringify([event.member, event.kind, event.connection, event.source])
    const group = groups.get(key) ?? {
      organization_id: org,
      org_membership_id: event.member,
      kind: event.kind,
      plugin_id: event.kind === "skill" ? plugin : null,
      config_object_id: event.kind === "skill" ? skill : null,
      connection_id: event.connection,
      source: event.source,
      use_count: 0,
      ok_count: 0,
      error_count: 0,
      last_used_at: event.at,
    }
    group.use_count += 1
    if (event.outcome === "ok") group.ok_count += 1
    if (event.outcome === "error") group.error_count += 1
    if (event.at > group.last_used_at) group.last_used_at = event.at
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** An in-memory store with the SQL's semantics: claim in order, sum on duplicate keys, delete what was claimed. */
function memoryRepository(events: RawEvent[]) {
  const rollups = new Map<string, CapabilityUsageRollupRow>()
  let transactions = 0
  const repository: CapabilityUsageRollupRepository = {
    async listCandidateDayBuckets(before, limit) {
      const days = new Set(events.filter((event) => event.at < before).map((event) => Math.floor(event.at.getTime() / DAY_MS) * DAY_MS))
      return [...days].sort((a, b) => a - b).slice(0, limit).map((day) => new Date(day))
    },
    async transaction(run) {
      transactions += 1
      return run({
        async aggregateRawDay(dayStart, limit) {
          const end = dayStart.getTime() + DAY_MS
          const claimed = events
            .filter((event) => event.at.getTime() >= dayStart.getTime() && event.at.getTime() < end)
            .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id))
            .slice(0, limit)
          return { ids: claimed.map((event) => event.id), groups: aggregate(claimed) }
        },
        async upsertRollups(rows) {
          for (const row of rows) {
            const key = `${row.bucket_start.getTime()}:${row.dimension_key}`
            const existing = rollups.get(key)
            if (!existing) {
              rollups.set(key, { ...row, source_counts: { ...row.source_counts } })
              continue
            }
            existing.use_count = (existing.use_count ?? 0) + (row.use_count ?? 0)
            existing.ok_count = (existing.ok_count ?? 0) + (row.ok_count ?? 0)
            existing.error_count = (existing.error_count ?? 0) + (row.error_count ?? 0)
            existing.source_row_count = (existing.source_row_count ?? 0) + (row.source_row_count ?? 0)
            for (const source of capabilityUsageSourceValues) {
              const count = row.source_counts[source]
              if (count) existing.source_counts[source] = (existing.source_counts[source] ?? 0) + count
            }
            if (row.last_used_at > existing.last_used_at) existing.last_used_at = row.last_used_at
          }
        },
        async deleteRawIds(ids) {
          const before = events.length
          events.splice(0, events.length, ...events.filter((event) => !ids.includes(event.id)))
          return before - events.length
        },
      })
    },
  }
  return { repository, rollups, transactions: () => transactions }
}

let sequence = 0
function event(at: string, member: `om_${string}`, source: CapabilityUsageSource, overrides: Partial<RawEvent> = {}): RawEvent {
  sequence += 1
  return { id: `cue_${String(sequence).padStart(26, "0")}`, member, kind: "skill", source, outcome: null, connection: null, at: new Date(at), ...overrides }
}

test("per-source groups collapse into one row per member and item, with uses per source", () => {
  const day = new Date("2026-10-10T00:00:00Z")
  const base = { organization_id: org, kind: "skill" as const, plugin_id: plugin, config_object_id: skill, connection_id: null, ok_count: 0, error_count: 0 }
  const rows = buildCapabilityUsageRollupRows(day, [
    { ...base, org_membership_id: alice, source: "agent", use_count: 3, last_used_at: new Date("2026-10-10T09:00:00Z") },
    { ...base, org_membership_id: alice, source: "automation", use_count: 2, last_used_at: new Date("2026-10-10T11:00:00Z") },
    { ...base, org_membership_id: blair, source: "agent", use_count: 1, last_used_at: new Date("2026-10-10T08:00:00Z") },
  ])
  assert.equal(rows.length, 2)
  const aliceRow = rows.find((row) => row.org_membership_id === alice)
  assert.deepEqual(aliceRow?.source_counts, { agent: 3, automation: 2 })
  assert.equal(aliceRow?.use_count, 5)
  assert.equal(aliceRow?.source_row_count, 5)
  assert.equal(aliceRow?.last_used_at.toISOString(), "2026-10-10T11:00:00.000Z")
  assert.equal(aliceRow?.dimension_key, capabilityUsageRollupDimensionKey({ ...base, org_membership_id: alice }))
  assert.notEqual(aliceRow?.dimension_key, rows.find((row) => row.org_membership_id === blair)?.dimension_key)
})

test("only closed days older than 48 hours fold, and their raw rows are deleted", async () => {
  const events = [
    event("2026-10-10T09:00:00Z", alice, "agent"),
    event("2026-10-10T10:00:00Z", alice, "agent"),
    event("2026-10-10T23:59:59Z", alice, "workflow"),
    event("2026-10-10T12:00:00Z", blair, "agent", { kind: "connector_tool", connection: "emc_01aaaaaaaaaaaaaaaaaaaaaaaa", outcome: "error" }),
    // Inside the retention window: stays raw.
    event("2026-10-11T00:00:01Z", alice, "agent"),
    event("2026-10-12T15:00:00Z", alice, "agent"),
  ]
  const memory = memoryRepository(events)
  // 48h before now is 2026-10-11T18:00, so only Oct 10 is a closed day older than the retention.
  const summary = await runCapabilityUsageRollups({ repository: memory.repository, now: new Date("2026-10-13T18:00:00Z") })
  assert.deepEqual(summary, { dayBuckets: 1, batches: 1, rawRowsDeleted: 4 })
  assert.equal(events.length, 2)
  const rows = [...memory.rollups.values()]
  const skillRow = rows.find((row) => row.kind === "skill")
  assert.deepEqual(skillRow?.source_counts, { agent: 2, workflow: 1 })
  assert.equal(skillRow?.use_count, 3)
  assert.equal(skillRow?.bucket_start.toISOString(), "2026-10-10T00:00:00.000Z")
  const connectorRow = rows.find((row) => row.kind === "connector_tool")
  assert.equal(connectorRow?.error_count, 1)
  assert.equal(connectorRow?.ok_count, 0)
})

test("a day larger than one batch is consumed in several transactions and sums into the same row", async () => {
  const events = Array.from({ length: 7 }, (_, index) => event(`2026-10-01T0${index}:00:00Z`, alice, index % 2 ? "app" : "agent"))
  const memory = memoryRepository(events)
  const summary = await runCapabilityUsageRollups({ repository: memory.repository, now: new Date("2026-10-13T00:00:00Z"), maxSourceRowsPerBucket: 3 })
  assert.deepEqual(summary, { dayBuckets: 1, batches: 3, rawRowsDeleted: 7 })
  assert.equal(memory.transactions(), 3)
  const rows = [...memory.rollups.values()]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.use_count, 7)
  assert.deepEqual(rows[0]?.source_counts, { agent: 4, app: 3 })
})

test("a run stops at its batch budget and a later run finishes the day without double counting", async () => {
  const events = Array.from({ length: 5 }, (_, index) => event(`2026-10-02T0${index}:00:00Z`, blair, "agent"))
  const memory = memoryRepository(events)
  const first = await runCapabilityUsageRollups({ repository: memory.repository, now: new Date("2026-10-13T00:00:00Z"), maxSourceRowsPerBucket: 2, maxBatchesPerRun: 1 })
  assert.deepEqual(first, { dayBuckets: 1, batches: 1, rawRowsDeleted: 2 })
  const second = await runCapabilityUsageRollups({ repository: memory.repository, now: new Date("2026-10-13T00:00:00Z"), maxSourceRowsPerBucket: 2 })
  assert.deepEqual(second, { dayBuckets: 1, batches: 2, rawRowsDeleted: 3 })
  assert.equal([...memory.rollups.values()][0]?.use_count, 5)
  assert.equal(events.length, 0)
})

test("invalid bounds are rejected before touching the database", async () => {
  const memory = memoryRepository([])
  await assert.rejects(runCapabilityUsageRollups({ repository: memory.repository, maxSourceRowsPerBucket: 0 }), /Invalid capability usage rollup bounds/)
  await assert.rejects(runCapabilityUsageRollups({ repository: memory.repository, rawRetentionMs: -1 }), /Invalid capability usage rollup bounds/)
})
