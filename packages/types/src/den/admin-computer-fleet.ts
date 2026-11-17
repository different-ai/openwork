import { z } from "zod"

/**
 * The admin Computer fleet page: the sandboxes cloud conversations use as computers, as their providers report them
 * now, whether they run through the sandbox gateway (Differently) or on the direct provider (see
 * ee/apps/den-api/src/computer-fleet). States, sizes, times, provider ids and the owning organization's name only:
 * nothing a computer holds, and no credentials.
 */

/** At most this many computers are listed, those needing attention first; `listTruncated` says when there are more. */
export const COMPUTER_FLEET_LIST_LIMIT = 500
/** A failure older than this is history, not something to show or count. */
export const COMPUTER_FLEET_FAILURE_HOURS = 24
/** How long a computer may take to start, pause or stop before it is flagged as stuck. */
export const COMPUTER_FLEET_STUCK_MINUTES = { starting: 10, pausing: 15, stopping: 15 } as const

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = (max: number) => z.string().max(max).nullable()
const moment = z.string().datetime().nullable()

/** What a computer is doing, in one vocabulary for every provider. `failed`: it never started, or broke. */
export const computerFleetStateSchema = z.enum(["starting", "running", "pausing", "paused", "stopped", "stopping", "failed", "unknown"])
export type ComputerFleetState = z.infer<typeof computerFleetStateSchema>

/**
 * Why a computer needs a look. `failed`: it failed in the last day. `stuck_starting`, `stuck_pausing`,
 * `stuck_stopping`: it has been in that step far longer than the step takes. `expired`: it outlived its expiry.
 */
export const computerFleetAttentionSchema = z.enum(["failed", "stuck_starting", "stuck_pausing", "stuck_stopping", "expired"])
export type ComputerFleetAttention = z.infer<typeof computerFleetAttentionSchema>

/** `gateway`: placed by the sandbox gateway. `direct`: created straight at the runner's own provider. */
export const computerFleetSourceKindSchema = z.enum(["gateway", "direct"])
export type ComputerFleetSourceKind = z.infer<typeof computerFleetSourceKindSchema>

export const computerFleetSandboxSchema = z.object({
  /** The provider's id for the sandbox, to look it up there. */
  id: z.string().min(1).max(200),
  source: computerFleetSourceKindSchema,
  provider: z.string().min(1).max(40),
  /** Gateway only: the pool it was placed on and the backend that runs it. */
  pool: text(200),
  backend: text(200),
  region: text(200),
  state: computerFleetStateSchema,
  /** The provider's own word for the state, and its reason when it gave one. */
  status: z.string().min(1).max(40),
  statusReason: text(300),
  attention: computerFleetAttentionSchema.nullable(),
  cpu: count.nullable(),
  memoryMb: count.nullable(),
  diskGb: count.nullable(),
  createdAt: moment,
  /** When its provider last changed its record: for a computer mid-step, about when the step began. */
  lastChangedAt: moment,
  startedAt: moment,
  pausedAt: moment,
  lastActivityAt: moment,
  expiresAt: moment,
  endedAt: moment,
  /** The organization whose conversation it belongs to, when Den knows the conversation. */
  organization: z.object({ id: z.string().min(1).max(64), name: z.string().max(200) }).nullable(),
})
export type ComputerFleetSandbox = z.infer<typeof computerFleetSandboxSchema>

export const computerFleetPoolSchema = z.object({
  name: z.string().max(200),
  backend: text(200),
  region: text(200),
  enabled: z.boolean(),
  /** The gateway's word: `healthy`, `degraded`, `unhealthy`. */
  health: z.string().max(40),
})
export type ComputerFleetPool = z.infer<typeof computerFleetPoolSchema>

export const computerFleetSourceSchema = z.object({
  source: computerFleetSourceKindSchema,
  provider: z.string().min(1).max(40),
  /** `unsupported`: the runner uses this provider but cannot list its sandboxes. */
  status: z.enum(["ok", "unreachable", "unsupported"]),
  /** Why it could not be read (`timeout`, `http_503`); null when it was. */
  error: text(40),
  /** The provider holds more sandboxes than the runner read. */
  truncated: z.boolean(),
  pools: z.array(computerFleetPoolSchema).max(64),
  /** Computers at this source, by what they are doing. */
  counts: z.object({ total: count, running: count, paused: count, attention: count }),
})
export type ComputerFleetSource = z.infer<typeof computerFleetSourceSchema>

/**
 * `not_configured`: Den has no runner, or the runner has no computers. `unreachable`: the runner's list, or every
 * provider behind it, could not be read. `alert`: a provider or a pool is down, or a computer is stuck. `warning`:
 * computers failed in the last day, or the list is cut short.
 */
export const computerFleetStatusSchema = z.enum(["not_configured", "healthy", "warning", "alert", "unreachable"])
export type ComputerFleetStatus = z.infer<typeof computerFleetStatusSchema>

export const computerFleetTotalsSchema = z.object({
  total: count,
  running: count,
  starting: count,
  pausing: count,
  paused: count,
  stopped: count,
  stopping: count,
  failed: count,
  attention: count,
})
export type ComputerFleetTotals = z.infer<typeof computerFleetTotalsSchema>

export const adminComputerFleetSchema = z.object({
  status: computerFleetStatusSchema,
  generatedAt: z.string().datetime(),
  /** Why the runner's list could not be read (`http_404`: a runner from before it had one); null when it was. */
  runnerError: text(40),
  sources: z.array(computerFleetSourceSchema).max(8),
  sandboxes: z.array(computerFleetSandboxSchema).max(COMPUTER_FLEET_LIST_LIMIT),
  listTruncated: z.boolean(),
  totals: computerFleetTotalsSchema,
}).meta({ ref: "AdminComputerFleet" })
export type AdminComputerFleet = z.infer<typeof adminComputerFleetSchema>

export const computerFleetHistoryRangeSchema = z.enum(["24h", "7d", "30d"])
export type ComputerFleetHistoryRange = z.infer<typeof computerFleetHistoryRangeSchema>
/** How long one square of the grid covers, per range. */
export const COMPUTER_FLEET_HISTORY_BUCKET_MINUTES: Record<ComputerFleetHistoryRange, number> = { "24h": 10, "7d": 60, "30d": 60 }
export const COMPUTER_FLEET_HISTORY_HOURS: Record<ComputerFleetHistoryRange, number> = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24 }

/** The highest reading of the fleet in one bucket. */
export const computerFleetHistoryBucketSchema = z.object({
  /** Bucket start, in milliseconds since the epoch (UTC). */
  at: count,
  total: count,
  running: count,
  paused: count,
  starting: count,
  failed: count,
  attention: count,
  /** A provider, a pool or the runner's list was down at some reading in the bucket. */
  sourceDown: z.boolean(),
})
export type ComputerFleetHistoryBucket = z.infer<typeof computerFleetHistoryBucketSchema>

export const adminComputerFleetHistorySchema = z.object({
  range: computerFleetHistoryRangeSchema,
  bucketMinutes: z.number().int().positive(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  /** Only buckets with a reading are listed; a gap means nothing was recorded then. */
  buckets: z.array(computerFleetHistoryBucketSchema).max(30 * 24),
}).meta({ ref: "AdminComputerFleetHistory" })
export type AdminComputerFleetHistory = z.infer<typeof adminComputerFleetHistorySchema>
