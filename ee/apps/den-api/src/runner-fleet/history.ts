import {
  RUNNER_FLEET_HISTORY_BUCKET_MINUTES,
  RUNNER_FLEET_HISTORY_HOURS,
  type AdminRunnerFleet,
  type AdminRunnerFleetHistory,
  type RunnerFleetHistoryBucket,
  type RunnerFleetHistoryRange,
} from "@openwork/types/den/admin-runner-fleet"

/**
 * The fleet's history for the page's grids: per node, the worst reading in each 10 minutes. One stored document per
 * UTC hour (`2026-11-17T15`), so a write is a few kilobytes however long the history gets, and reading a range is one
 * indexed lookup. Folding keeps the maximum of every figure: a node that was closed for one reading in a bucket shows
 * as closed for that bucket.
 */
export const BUCKET_MS = 10 * 60_000
const HOUR_MS = 60 * 60_000
/** Nodes change address when they restart; an hour with more than this many is cut, newest kept. */
const MAX_NODES_PER_HOUR = 128

/** One node's worst reading in one bucket. Short keys: these are stored a few thousand times a day. */
export type StoredBucket = {
  /** Memory celld weighs against its ceiling, in bytes, and as a share of the machine (null when unknown). */
  u: number
  r: number | null
  /** Cells in memory, cells owned (null when unknown), and cells waiting for room. */
  c: number
  o: number | null
  w: number
  /** 1 when the node was closed, and when it did not answer. */
  x: 0 | 1
  d: 0 | 1
}
export type StoredHour = { v: 1; nodes: Record<string, Record<string, StoredBucket>> }

export const emptyHour = (): StoredHour => ({ v: 1, nodes: {} })
/** The key of the hour a moment falls in: `2026-11-17T15`. Keys sort in time order. */
export const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13)
const hourStart = (key: string) => Date.parse(`${key}:00:00.000Z`)
const bucketIndex = (ms: number) => String(Math.floor((ms % HOUR_MS) / BUCKET_MS))

const higher = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))

function mergeBucket(a: StoredBucket | undefined, b: StoredBucket): StoredBucket {
  if (!a) return b
  return { u: Math.max(a.u, b.u), r: higher(a.r, b.r), c: Math.max(a.c, b.c), o: higher(a.o, b.o), w: Math.max(a.w, b.w), x: a.x || b.x ? 1 : 0, d: a.d || b.d ? 1 : 0 }
}

/** What was stored, when it has the shape this writes; anything else reads as an empty hour. */
export function storedHour(value: unknown): StoredHour {
  const parsed = typeof value === "string" ? safeJson(value) : value
  if (typeof parsed !== "object" || parsed === null || !("nodes" in parsed) || typeof parsed.nodes !== "object" || parsed.nodes === null) return emptyHour()
  const hour = emptyHour()
  for (const [id, buckets] of Object.entries(parsed.nodes as Record<string, unknown>)) {
    if (typeof buckets !== "object" || buckets === null) continue
    for (const [index, bucket] of Object.entries(buckets as Record<string, unknown>)) {
      if (!/^[0-5]$/.test(index) || typeof bucket !== "object" || bucket === null) continue
      const { u, r, c, o, w, x, d } = bucket as Record<string, unknown>
      if (typeof u !== "number" || typeof c !== "number") continue
      ;(hour.nodes[id] ??= {})[index] = { u, r: typeof r === "number" ? r : null, c, o: typeof o === "number" ? o : null, w: typeof w === "number" ? w : 0, x: x === 1 ? 1 : 0, d: d === 1 ? 1 : 0 }
    }
  }
  return hour
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Adds one reading of the fleet to the hour it falls in. */
export function foldFleet(hour: StoredHour, fleet: AdminRunnerFleet, atMs: number): StoredHour {
  const index = bucketIndex(atMs)
  const next: StoredHour = { v: 1, nodes: { ...hour.nodes } }
  for (const node of fleet.nodes) {
    const reading: StoredBucket = {
      u: node.memory.usedBytes, r: node.memory.ratio, c: node.cells.resident, o: node.cells.owned, w: node.cells.waitingForRoom,
      x: node.state === "closed" ? 1 : 0, d: node.state === "unreachable" ? 1 : 0,
    }
    next.nodes[node.id] = { ...next.nodes[node.id], [index]: mergeBucket(next.nodes[node.id]?.[index], reading) }
  }
  const ids = Object.keys(next.nodes)
  if (ids.length > MAX_NODES_PER_HOUR) for (const id of ids.slice(0, ids.length - MAX_NODES_PER_HOUR)) delete next.nodes[id]
  return next
}

/** Two documents of the same hour, written by different Den replicas, as one. */
export function mergeHours(a: StoredHour, b: StoredHour): StoredHour {
  const merged: StoredHour = { v: 1, nodes: { ...a.nodes } }
  for (const [id, buckets] of Object.entries(b.nodes)) {
    const mine = { ...merged.nodes[id] }
    for (const [index, bucket] of Object.entries(buckets)) mine[index] = mergeBucket(mine[index], bucket)
    merged.nodes[id] = mine
  }
  return merged
}

const toBucket = (at: number, stored: StoredBucket): RunnerFleetHistoryBucket => ({
  at, usedBytes: stored.u, ratio: stored.r, resident: stored.c, owned: stored.o, waitingForRoom: stored.w, closed: stored.x === 1, unreachable: stored.d === 1,
})

/** The first and last hour keys a range covers, ending at the current hour. */
export function historyHourKeys(range: RunnerFleetHistoryRange, nowMs: number): { from: string; to: string } {
  return { from: hourKey(nowMs - (RUNNER_FLEET_HISTORY_HOURS[range] - 1) * HOUR_MS), to: hourKey(nowMs) }
}

/** Stored hours as the page's history: 10-minute squares for a day, one square an hour for longer ranges. */
export function historyFromHours(rows: ReadonlyArray<{ hour: string; payload: unknown }>, range: RunnerFleetHistoryRange, nowMs: number): AdminRunnerFleetHistory {
  const keys = historyHourKeys(range, nowMs)
  const hourly = RUNNER_FLEET_HISTORY_BUCKET_MINUTES[range] === 60
  const nodes = new Map<string, RunnerFleetHistoryBucket[]>()
  for (const row of [...rows].sort((a, b) => a.hour.localeCompare(b.hour))) {
    if (row.hour < keys.from || row.hour > keys.to) continue
    const start = hourStart(row.hour)
    if (!Number.isFinite(start)) continue
    for (const [id, buckets] of Object.entries(storedHour(row.payload).nodes)) {
      const list = nodes.get(id) ?? []
      const entries = Object.entries(buckets).sort(([a], [b]) => Number(a) - Number(b))
      if (hourly) {
        const worst = entries.reduce<StoredBucket | undefined>((sum, [, bucket]) => mergeBucket(sum, bucket), undefined)
        if (worst) list.push(toBucket(start, worst))
      } else {
        for (const [index, bucket] of entries) list.push(toBucket(start + Number(index) * BUCKET_MS, bucket))
      }
      nodes.set(id, list)
    }
  }
  return {
    range,
    bucketMinutes: RUNNER_FLEET_HISTORY_BUCKET_MINUTES[range],
    from: new Date(hourStart(keys.from)).toISOString(),
    to: new Date(nowMs).toISOString(),
    // Nodes seen most recently first: the ones running now.
    nodes: [...nodes].map(([id, buckets]) => ({ id, buckets })).sort((a, b) => (b.buckets.at(-1)?.at ?? 0) - (a.buckets.at(-1)?.at ?? 0) || a.id.localeCompare(b.id)).slice(0, 512),
  }
}
