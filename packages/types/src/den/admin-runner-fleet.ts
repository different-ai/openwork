import { z } from "zod"

/** celld's defaults: a node closes to new cells at 80% of the machine's memory and reopens at 80% of that. */
export const RUNNER_FLEET_CLOSE_RATIO = 0.8
export const RUNNER_FLEET_REOPEN_RATIO = 0.64
/** At most this many of a node's cells in memory are listed; `residentsTruncated` says when there are more. */
export const RUNNER_FLEET_RESIDENT_LIMIT = 600
export const RUNNER_FLEET_NODE_LIMIT = 64
/** At most this many of a node's cells in memory are described (whose they are, since when). */
export const RUNNER_FLEET_CELL_LIMIT = 300

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const ratio = z.number().nonnegative().max(100)

/**
 * `open`: takes new cells. `no_headroom`: still open, but above the line a closed node must fall under to reopen.
 * `closed`: refuses to start cells until its memory falls (the conversations it owns do not answer meanwhile).
 * `draining`: shutting down and handing its cells over. `unreachable`: its state endpoint did not answer.
 */
export const runnerFleetNodeStateSchema = z.enum(["open", "no_headroom", "closed", "draining", "unreachable"])
export type RunnerFleetNodeState = z.infer<typeof runnerFleetNodeStateSchema>

/** One cell a node holds in memory. */
export const runnerFleetCellSchema = z.object({
  id: z.string().min(1).max(16),
  since: z.string().datetime().nullable(),
  kind: z.enum(["conversation", "person", "service", "unknown"]),
  product: z.enum(["workbot", "slack", "automation"]).nullable(),
  organization: z.object({ id: z.string().min(1).max(64), name: z.string().max(200) }).nullable(),
  lastActiveAt: z.string().datetime().nullable(),
  turnRunning: z.boolean(),
})
export type RunnerFleetCell = z.infer<typeof runnerFleetCellSchema>

export const runnerFleetNodeSchema = z.object({
  id: z.string().min(1).max(64),
  state: runnerFleetNodeStateSchema,
  error: z.string().max(40).nullable(),
  shedReason: z.string().max(40).nullable(),
  memory: z.object({
    usedBytes: count,
    limitBytes: count.nullable(),
    ratio: ratio.nullable(),
    residentBytes: count,
    inUseBytes: count,
    workingSetBytes: count.nullable(),
    retainedBytes: count.nullable(),
    heapBytes: count.nullable(),
    externalBytes: count.nullable(),
  }),
  cells: z.object({
    resident: count,
    owned: count.nullable(),
    waitingForRoom: count,
    starting: count,
    residents: z.array(z.string().min(1).max(16)).max(RUNNER_FLEET_RESIDENT_LIMIT),
    residentsTruncated: z.boolean(),
    inMemory: z.array(runnerFleetCellSchema).max(RUNNER_FLEET_CELL_LIMIT).default([]),
  }),
  sockets: count,
  cpuPercent: z.number().nonnegative().max(100_000).nullable(),
  moved: z.object({ handedOff: count, rebalanced: count, shed: count }),
  isolates: z.object({ live: count, retiring: count }).nullable(),
  version: z.string().max(80).nullable(),
}).meta({ ref: "AdminRunnerFleetNode" })
export type RunnerFleetNode = z.infer<typeof runnerFleetNodeSchema>

/**
 * `not_configured`: the deployment does not say where the nodes answer. `unreachable`: no node answered.
 * `alert`: a node is closed, cells are waiting for room, or one node is left. `warning`: a node is near its line or
 * did not answer.
 */
export const runnerFleetStatusSchema = z.enum(["not_configured", "healthy", "warning", "alert", "unreachable"])
export type RunnerFleetStatus = z.infer<typeof runnerFleetStatusSchema>

export const adminRunnerFleetSchema = z.object({
  status: runnerFleetStatusSchema,
  generatedAt: z.string().datetime(),
  nodes: z.array(runnerFleetNodeSchema).max(RUNNER_FLEET_NODE_LIMIT),
  totals: z.object({
    nodes: count,
    reachable: count,
    closed: count,
    residentCells: count,
    ownedCells: count.nullable(),
    waitingForRoom: count,
    usedBytes: count,
  }),
  discoveryError: z.string().max(40).nullable(),
  cellNamesError: z.string().max(40).nullable().default(null),
}).meta({ ref: "AdminRunnerFleet" })
export type AdminRunnerFleet = z.infer<typeof adminRunnerFleetSchema>

export const runnerFleetHistoryRangeSchema = z.enum(["24h", "7d", "30d"])
export type RunnerFleetHistoryRange = z.infer<typeof runnerFleetHistoryRangeSchema>
/** How long one square of the grid covers, per range. */
export const RUNNER_FLEET_HISTORY_BUCKET_MINUTES: Record<RunnerFleetHistoryRange, number> = { "24h": 10, "7d": 60, "30d": 60 }
export const RUNNER_FLEET_HISTORY_HOURS: Record<RunnerFleetHistoryRange, number> = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24 }

/** The worst reading of one node in one bucket. */
export const runnerFleetHistoryBucketSchema = z.object({
  at: count,
  usedBytes: count,
  ratio: ratio.nullable(),
  resident: count,
  owned: count.nullable(),
  waitingForRoom: count,
  closed: z.boolean(),
  unreachable: z.boolean(),
})
export type RunnerFleetHistoryBucket = z.infer<typeof runnerFleetHistoryBucketSchema>

export const adminRunnerFleetHistorySchema = z.object({
  range: runnerFleetHistoryRangeSchema,
  bucketMinutes: z.number().int().positive(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  nodes: z.array(z.object({ id: z.string().min(1).max(64), buckets: z.array(runnerFleetHistoryBucketSchema).max(30 * 24) })).max(512),
}).meta({ ref: "AdminRunnerFleetHistory" })
export type AdminRunnerFleetHistory = z.infer<typeof adminRunnerFleetHistorySchema>
