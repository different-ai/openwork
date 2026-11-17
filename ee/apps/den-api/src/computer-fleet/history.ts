import {
  COMPUTER_FLEET_HISTORY_BUCKET_MINUTES,
  COMPUTER_FLEET_HISTORY_HOURS,
  type AdminComputerFleet,
  type AdminComputerFleetHistory,
  type ComputerFleetHistoryBucket,
  type ComputerFleetHistoryRange,
} from "@openwork/types/den/admin-computer-fleet"

/**
 * The computer fleet's past, as the sampler records it: one stored document per UTC hour, holding the highest
 * reading of each 10 minutes. A reading is counts only. Pure: the service reads and writes the rows.
 */
export const BUCKET_MS = 10 * 60_000
const HOUR_MS = 60 * 60_000

/** The fleet's highest reading in one bucket. Short keys: stored for every hour of a month. */
export type StoredBucket = {
  /** Computers in all, running, paused, starting, failed in the last day, and needing a look. */
  t: number
  r: number
  p: number
  s: number
  f: number
  a: number
  /** 1 when a provider, a pool or the runner's list was down. */
  d: 0 | 1
}
export type StoredHour = { v: 1; buckets: Record<string, StoredBucket> }

export const emptyHour = (): StoredHour => ({ v: 1, buckets: {} })
/** The key of the hour a moment falls in: `2026-11-17T15`. Keys sort in time order. */
export const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13)
const hourStart = (key: string) => Date.parse(`${key}:00:00.000Z`)
const bucketIndex = (ms: number) => String(Math.floor((ms % HOUR_MS) / BUCKET_MS))

function mergeBucket(a: StoredBucket | undefined, b: StoredBucket): StoredBucket {
  if (!a) return b
  return { t: Math.max(a.t, b.t), r: Math.max(a.r, b.r), p: Math.max(a.p, b.p), s: Math.max(a.s, b.s), f: Math.max(a.f, b.f), a: Math.max(a.a, b.a), d: a.d || b.d ? 1 : 0 }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const amount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)

/** What was stored, when it has the shape this writes; anything else reads as an empty hour. */
export function storedHour(value: unknown): StoredHour {
  const parsed = typeof value === "string" ? safeJson(value) : value
  if (typeof parsed !== "object" || parsed === null || !("buckets" in parsed) || typeof parsed.buckets !== "object" || parsed.buckets === null) return emptyHour()
  const hour = emptyHour()
  for (const [index, bucket] of Object.entries(parsed.buckets as Record<string, unknown>)) {
    if (!/^[0-5]$/.test(index) || typeof bucket !== "object" || bucket === null) continue
    const { t, r, p, s, f, a, d } = bucket as Record<string, unknown>
    if (typeof t !== "number") continue
    hour.buckets[index] = { t: amount(t), r: amount(r), p: amount(p), s: amount(s), f: amount(f), a: amount(a), d: d === 1 ? 1 : 0 }
  }
  return hour
}

/** Whether something the fleet depends on was down at this reading. */
const sourceDown = (fleet: AdminComputerFleet) => fleet.status === "unreachable" || fleet.sources.some((source) => source.status === "unreachable" || source.pools.some((pool) => pool.enabled && pool.health !== "healthy"))

/** Adds one reading of the fleet to the hour it falls in. */
export function foldFleet(hour: StoredHour, fleet: AdminComputerFleet, atMs: number): StoredHour {
  const index = bucketIndex(atMs)
  const { total, running, paused, starting, failed, attention } = fleet.totals
  const reading: StoredBucket = { t: total, r: running, p: paused, s: starting, f: failed, a: attention, d: sourceDown(fleet) ? 1 : 0 }
  return { v: 1, buckets: { ...hour.buckets, [index]: mergeBucket(hour.buckets[index], reading) } }
}

/** Two documents of the same hour, written by different Den replicas, as one. */
export function mergeHours(a: StoredHour, b: StoredHour): StoredHour {
  const merged: StoredHour = { v: 1, buckets: { ...a.buckets } }
  for (const [index, bucket] of Object.entries(b.buckets)) merged.buckets[index] = mergeBucket(merged.buckets[index], bucket)
  return merged
}

const toBucket = (at: number, stored: StoredBucket): ComputerFleetHistoryBucket => ({
  at, total: stored.t, running: stored.r, paused: stored.p, starting: stored.s, failed: stored.f, attention: stored.a, sourceDown: stored.d === 1,
})

/** The first and last hour keys a range covers, ending at the current hour. */
export function historyHourKeys(range: ComputerFleetHistoryRange, nowMs: number): { from: string; to: string } {
  return { from: hourKey(nowMs - (COMPUTER_FLEET_HISTORY_HOURS[range] - 1) * HOUR_MS), to: hourKey(nowMs) }
}

/** Stored hours as the page's history: 10-minute squares for a day, one square an hour for longer ranges. */
export function historyFromHours(rows: ReadonlyArray<{ hour: string; payload: unknown }>, range: ComputerFleetHistoryRange, nowMs: number): AdminComputerFleetHistory {
  const keys = historyHourKeys(range, nowMs)
  const hourly = COMPUTER_FLEET_HISTORY_BUCKET_MINUTES[range] === 60
  const buckets: ComputerFleetHistoryBucket[] = []
  for (const row of [...rows].sort((a, b) => a.hour.localeCompare(b.hour))) {
    if (row.hour < keys.from || row.hour > keys.to) continue
    const start = hourStart(row.hour)
    if (!Number.isFinite(start)) continue
    const entries = Object.entries(storedHour(row.payload).buckets).sort(([a], [b]) => Number(a) - Number(b))
    if (hourly) {
      const highest = entries.reduce<StoredBucket | undefined>((sum, [, bucket]) => mergeBucket(sum, bucket), undefined)
      if (highest) buckets.push(toBucket(start, highest))
    } else {
      for (const [index, bucket] of entries) buckets.push(toBucket(start + Number(index) * BUCKET_MS, bucket))
    }
  }
  return {
    range,
    bucketMinutes: COMPUTER_FLEET_HISTORY_BUCKET_MINUTES[range],
    from: new Date(hourStart(keys.from)).toISOString(),
    to: new Date(nowMs).toISOString(),
    buckets,
  }
}
