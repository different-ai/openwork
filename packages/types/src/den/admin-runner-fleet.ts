import { z } from "zod"

/**
 * The admin Runner fleet page: the cloud runner's celld nodes as each node reports itself on its own state
 * endpoint (see ee/apps/den-api/src/runner-fleet). Counts, byte sizes and opaque cell ids, and for each cell in
 * memory the organization and kind of conversation it belongs to: never a conversation's name or content, a
 * member, or credentials.
 */

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
  /** The first 12 characters of the cell's id: enough to tell cells apart, and opaque. */
  id: z.string().min(1).max(16),
  /** When it was first seen in memory on this node, to within a minute; null before anything has recorded it. */
  since: z.string().datetime().nullable(),
  /**
   * `conversation`: one conversation's own cell. `person`: a person's cell (their Workbot main chat, their memory
   * and their list of chats). `service`: the runner's own. `unknown`: no conversation Den knows has this cell.
   */
  kind: z.enum(["conversation", "person", "service", "unknown"]),
  /** What the conversation is part of; null for the runner's own cell and for one Den cannot name. */
  product: z.enum(["workbot", "slack", "automation"]).nullable(),
  organization: z.object({ id: z.string().min(1).max(64), name: z.string().max(200) }).nullable(),
  /** The conversation's last activity as Den's index has it (for a person's cell, the latest of theirs). */
  lastActiveAt: z.string().datetime().nullable(),
  /** A turn is under way in it (for a person's cell, in any of their conversations). */
  turnRunning: z.boolean(),
})
export type RunnerFleetCell = z.infer<typeof runnerFleetCellSchema>

export const runnerFleetNodeSchema = z.object({
  /** The node's private address: what it is known by between restarts. */
  id: z.string().min(1).max(64),
  state: runnerFleetNodeStateSchema,
  /** Why the state endpoint could not be read (`timeout`, `http_503`, `invalid_state`); null when it answered. */
  error: z.string().max(40).nullable(),
  /** What celld is shedding cells for (`memory`, …); null when it is not. */
  shedReason: z.string().max(40).nullable(),
  memory: z.object({
    /** What celld weighs against its ceiling: the greater of memory in use and the cgroup working set. */
    usedBytes: count,
    /** The machine's memory, when the deployment says it (DEN_HEADLESS_FLEET_NODE_MEMORY_MB). */
    limitBytes: count.nullable(),
    ratio: ratio.nullable(),
    residentBytes: count,
    inUseBytes: count,
    workingSetBytes: count.nullable(),
    /** Memory the allocator holds but nothing uses. */
    retainedBytes: count.nullable(),
    /** V8 heaps of the cells' isolates, and memory they hold outside the heap. */
    heapBytes: count.nullable(),
    externalBytes: count.nullable(),
  }),
  cells: z.object({
    /** Cells in memory. */
    resident: count,
    /** Cells this node owns, asleep ones included; null until the node has read its ownership records. */
    owned: count.nullable(),
    /** Cells waiting for room on this node. Above zero, requests for them are failing or about to. */
    waitingForRoom: count,
    /** Cold starts queued or running. */
    starting: count,
    /** Short ids of the cells in memory, for showing where each one lives. */
    residents: z.array(z.string().min(1).max(16)).max(RUNNER_FLEET_RESIDENT_LIMIT),
    residentsTruncated: z.boolean(),
    /** The first of those cells, each with whose it is and since when it has been in memory. */
    inMemory: z.array(runnerFleetCellSchema).max(RUNNER_FLEET_CELL_LIMIT).default([]),
  }),
  sockets: count,
  cpuPercent: z.number().nonnegative().max(100_000).nullable(),
  /** Since the node started: cells handed to other nodes, the part balancing moved, and cells shed under pressure. */
  moved: z.object({ handedOff: count, rebalanced: count, shed: count }),
  isolates: z.object({ live: count, retiring: count }).nullable(),
  /** The runner version this node serves. */
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
  /** Why the nodes could not be listed (`dns_failed`); null when they were. */
  discoveryError: z.string().max(40).nullable(),
  /**
   * Why cells cannot be matched to conversations (`http_404`: a runner from before it could say which id a name
   * has; `not_configured`); null when they can. Cells are then listed without whose they are.
   */
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
  /** Bucket start, in milliseconds since the epoch (UTC). */
  at: count,
  usedBytes: count,
  ratio: ratio.nullable(),
  resident: count,
  owned: count.nullable(),
  waitingForRoom: count,
  /** The node was closed, or did not answer, at some reading in the bucket. */
  closed: z.boolean(),
  unreachable: z.boolean(),
})
export type RunnerFleetHistoryBucket = z.infer<typeof runnerFleetHistoryBucketSchema>

export const adminRunnerFleetHistorySchema = z.object({
  range: runnerFleetHistoryRangeSchema,
  bucketMinutes: z.number().int().positive(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  /** Only buckets with a reading are listed; a gap means nothing was recorded then. */
  nodes: z.array(z.object({ id: z.string().min(1).max(64), buckets: z.array(runnerFleetHistoryBucketSchema).max(30 * 24) })).max(512),
}).meta({ ref: "AdminRunnerFleetHistory" })
export type AdminRunnerFleetHistory = z.infer<typeof adminRunnerFleetHistorySchema>
