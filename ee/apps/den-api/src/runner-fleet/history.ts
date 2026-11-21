import {
  RUNNER_FLEET_HISTORY_BUCKET_MINUTES,
  RUNNER_FLEET_HISTORY_HOURS,
  type AdminRunnerFleet,
  type AdminRunnerFleetHistory,
  type RunnerFleetHistoryBucket,
  type RunnerFleetHistoryRange,
} from "@openwork/types/den/admin-runner-fleet"

export const BUCKET_MS = 10 * 60_000
const HOUR_MS = 60 * 60_000
const MAX_NODES_PER_HOUR = 128

export type StoredBucket = {
  u: number
  r: number | null
  c: number
  o: number | null
  w: number
  x: 0 | 1
  d: 0 | 1
}
export type StoredHour = { v: 1; nodes: Record<string, Record<string, StoredBucket>> }

export const emptyHour = (): StoredHour => ({ v: 1, nodes: {} })
export const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13)
const hourStart = (key: string) => Date.parse(`${key}:00:00.000Z`)
const bucketIndex = (ms: number) => String(Math.floor((ms % HOUR_MS) / BUCKET_MS))

const higher = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))

function mergeBucket(a: StoredBucket | undefined, b: StoredBucket): StoredBucket {
  if (!a) return b
  return { u: Math.max(a.u, b.u), r: higher(a.r, b.r), c: Math.max(a.c, b.c), o: higher(a.o, b.o), w: Math.max(a.w, b.w), x: a.x || b.x ? 1 : 0, d: a.d || b.d ? 1 : 0 }
}

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

export function historyHourKeys(range: RunnerFleetHistoryRange, nowMs: number): { from: string; to: string } {
  return { from: hourKey(nowMs - (RUNNER_FLEET_HISTORY_HOURS[range] - 1) * HOUR_MS), to: hourKey(nowMs) }
}

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
    nodes: [...nodes].map(([id, buckets]) => ({ id, buckets })).sort((a, b) => (b.buckets.at(-1)?.at ?? 0) - (a.buckets.at(-1)?.at ?? 0) || a.id.localeCompare(b.id)).slice(0, 512),
  }
}
