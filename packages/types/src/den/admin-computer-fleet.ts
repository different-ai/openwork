import { z } from "zod"

/** At most this many computers are listed, those needing attention first; `listTruncated` says when there are more. */
export const COMPUTER_FLEET_LIST_LIMIT = 500
/** At most this many organizations are offered to filter by. */
export const COMPUTER_FLEET_ORGANIZATION_LIMIT = 500
/** A failure older than this is history, not something to show or count. */
export const COMPUTER_FLEET_FAILURE_HOURS = 24
/** How long a computer may take to start, pause or stop before it is flagged as stuck. */
export const COMPUTER_FLEET_STUCK_MINUTES = { starting: 10, pausing: 15, stopping: 15 } as const
/**
 * A computer running with no use for this long is flagged. The runner pauses one minutes after its last use, so one
 * still running this long after is held by something: a pause that failed, or a runner that lost track of it. The
 * wait is longer where the runner's own pause, or the provider's idle rule for that computer, is longer.
 */
export const COMPUTER_FLEET_IDLE_RUNNING_MINUTES = 30
/**
 * A computer still running this long after its conversation was last active, with no turn under way, is flagged as
 * running unused. The provider cannot tell: a desktop's browser keeps connections open, so a computer nobody uses
 * still looks active to it. Den knows when the conversation last had a turn or an open view.
 */
export const COMPUTER_FLEET_QUIET_HOURS = 2
/**
 * A computer at least this old that has spent more than this share of its life running is flagged. One normally
 * sleeps between uses; one awake most of the time is being kept awake, or the runner never paused it. Only where
 * the provider counts run time, and a provider's count can lag while the computer runs, so this catches fewer
 * than the conversation rule above; it is what is left for a computer whose conversation Den does not know.
 */
export const COMPUTER_FLEET_LONG_RUNNING = { minAgeHours: 48, share: 0.5 } as const
/** Events shown for one computer, newest first. */
export const COMPUTER_FLEET_EVENT_LIMIT = 100

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = (max: number) => z.string().max(max).nullable()
const moment = z.string().datetime().nullable()

/** What a computer is doing, in one vocabulary for every provider. `failed`: it never started, or broke. */
export const computerFleetStateSchema = z.enum(["starting", "running", "pausing", "paused", "stopped", "stopping", "failed", "unknown"])
export type ComputerFleetState = z.infer<typeof computerFleetStateSchema>

/**
 * Why a computer needs a look. `failed`: it failed in the last day. `stuck_starting`, `stuck_pausing`,
 * `stuck_stopping`: it has been in that step far longer than the step takes. `expired`: it outlived its expiry.
 * `idle_running`: it is running and nothing has used it for far longer than the runner waits before pausing one,
 * as its provider reports, or as Den knows from a conversation that has been quiet for hours.
 * `long_running`: it is running and has been for most of its life, though its provider sees it in use.
 */
export const computerFleetAttentionSchema = z.enum(["failed", "stuck_starting", "stuck_pausing", "stuck_stopping", "expired", "idle_running", "long_running"])
export type ComputerFleetAttention = z.infer<typeof computerFleetAttentionSchema>

/** `gateway`: placed by the sandbox gateway. `direct`: created straight at the runner's own provider. */
export const computerFleetSourceKindSchema = z.enum(["gateway", "direct"])
export type ComputerFleetSourceKind = z.infer<typeof computerFleetSourceKindSchema>

export const computerFleetSandboxSchema = z.object({
  id: z.string().min(1).max(200),
  source: computerFleetSourceKindSchema,
  provider: z.string().min(1).max(40),
  pool: text(200),
  backend: text(200),
  region: text(200),
  state: computerFleetStateSchema,
  status: z.string().min(1).max(40),
  statusReason: text(300),
  attention: computerFleetAttentionSchema.nullable(),
  cpu: count.nullable(),
  memoryMb: count.nullable(),
  diskGb: count.nullable(),
  createdAt: moment,
  lastChangedAt: moment,
  startedAt: moment,
  pausedAt: moment,
  lastActivityAt: moment,
  expiresAt: moment,
  endedAt: moment,
  organization: z.object({ id: z.string().min(1).max(64), name: z.string().max(200) }).nullable(),
  image: text(200).default(null),
  imageCurrent: z.boolean().nullable().default(null),
  runSeconds: count.nullable().default(null),
})
export type ComputerFleetSandbox = z.infer<typeof computerFleetSandboxSchema>

/** How the runner treats one source's computers: what new ones are built from, and when it pauses and deletes them. */
export const computerFleetSettingsSchema = z.object({
  image: text(200),
  idlePauseSeconds: count,
  keepDays: count,
  persistent: z.boolean(),
})
export type ComputerFleetSettings = z.infer<typeof computerFleetSettingsSchema>

export const computerFleetPoolSchema = z.object({
  name: z.string().max(200),
  backend: text(200),
  region: text(200),
  enabled: z.boolean(),
  health: z.string().max(40),
})
export type ComputerFleetPool = z.infer<typeof computerFleetPoolSchema>

export const computerFleetSourceSchema = z.object({
  source: computerFleetSourceKindSchema,
  provider: z.string().min(1).max(40),
  status: z.enum(["ok", "unreachable", "unsupported"]),
  error: text(40),
  truncated: z.boolean(),
  pools: z.array(computerFleetPoolSchema).max(64),
  counts: z.object({ total: count, running: count, paused: count, attention: count }),
  settings: computerFleetSettingsSchema.nullable().default(null),
})
export type ComputerFleetSource = z.infer<typeof computerFleetSourceSchema>

/**
 * `not_configured`: Den has no runner, or the runner has no computers. `unreachable`: the runner's list, or every
 * provider behind it, could not be read. `alert`: a provider or a pool is down, or a computer is stuck. `warning`:
 * computers failed in the last day, or the list is cut short.
 */
export const computerFleetStatusSchema = z.enum(["not_configured", "healthy", "warning", "alert", "unreachable"])
export type ComputerFleetStatus = z.infer<typeof computerFleetStatusSchema>

/** How many computers in the whole fleet need a look, by why. */
export const computerFleetAttentionCountsSchema = z.object({
  failed: count.default(0),
  stuck_starting: count.default(0),
  stuck_pausing: count.default(0),
  stuck_stopping: count.default(0),
  expired: count.default(0),
  idle_running: count.default(0),
  long_running: count.default(0),
})
export type ComputerFleetAttentionCounts = z.infer<typeof computerFleetAttentionCountsSchema>

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
  runnerError: text(40),
  sources: z.array(computerFleetSourceSchema).max(8),
  sandboxes: z.array(computerFleetSandboxSchema).max(COMPUTER_FLEET_LIST_LIMIT),
  listTruncated: z.boolean(),
  totals: computerFleetTotalsSchema,
  attentionCounts: computerFleetAttentionCountsSchema.nullable().default(null),
  organizations: z.array(z.object({ id: z.string().min(1).max(64), name: z.string().max(200), computers: count })).max(COMPUTER_FLEET_ORGANIZATION_LIMIT).default([]),
  unknownOrganization: count.default(0),
}).meta({ ref: "AdminComputerFleet" })
export type AdminComputerFleet = z.infer<typeof adminComputerFleetSchema>

/** The request's `organization` for computers whose organization is not known. */
export const COMPUTER_FLEET_UNKNOWN_ORGANIZATION = "unknown"

/** A lifecycle event of one computer. Never a command, a path or anything else a conversation did on it. */
export const computerFleetEventSchema = z.object({
  at: moment,
  origin: z.enum(["provider", "den"]),
  type: z.string().max(60),
  level: z.enum(["info", "warning", "error"]),
  message: z.string().max(600),
})
export type ComputerFleetEvent = z.infer<typeof computerFleetEventSchema>

/** Where the sandbox gateway placed a computer and why, with every pool it weighed. */
export const computerFleetPlacementSchema = z.object({
  pool: text(200),
  strategy: text(200),
  outcome: text(40),
  reason: text(300),
  evaluatedAt: moment,
  policies: z.array(z.string().max(200)).max(50),
  candidates: z.array(z.object({
    pool: z.string().max(200),
    trust: text(40),
    eligible: z.boolean().nullable(),
    hasCapacity: z.boolean().nullable(),
    rank: count.nullable(),
    reasons: z.array(z.string().max(300)).max(20),
  })).max(50),
})
export type ComputerFleetPlacement = z.infer<typeof computerFleetPlacementSchema>

/**
 * One computer in full: its provider's record, the rules that pause and delete it, where it was placed and why, the
 * conversation it belongs to, and what happened to it. Read without running anything on the computer, so looking
 * never wakes a paused computer or keeps an idle one awake. What is installed inside it is therefore not here.
 */
export const adminComputerDetailSchema = z.object({
  generatedAt: z.string().datetime(),
  computer: computerFleetSandboxSchema,
  key: text(200),
  trust: text(40),
  attempts: count.nullable(),
  idledAt: moment,
  resumeRequestedAt: moment,
  slotReleased: z.boolean().nullable(),
  limits: z.object({
    idleTimeoutSeconds: count.nullable(),
    ttlSeconds: count.nullable(),
    maxRunSeconds: count.nullable(),
    maxPausedSeconds: count.nullable(),
    autoDeleteSeconds: count.nullable(),
    totalRunSeconds: count.nullable(),
  }),
  profile: text(200),
  classification: text(200),
  capabilities: z.array(z.string().max(200)).max(100),
  preemptible: z.boolean().nullable(),
  settings: computerFleetSettingsSchema.nullable(),
  placement: computerFleetPlacementSchema.nullable(),
  conversation: z.object({
    sessionId: z.string().min(1).max(128),
    chat: z.enum(["main", "side"]).nullable(),
    member: z.object({ id: z.string().min(1).max(64), name: z.string().max(255), email: z.string().max(320) }).nullable(),
    createdAt: moment,
    lastActiveAt: moment,
    activeTurnSince: moment,
  }).nullable(),
  reported: z.object({ state: z.string().max(24), detail: text(300), at: moment }).nullable(),
  events: z.array(computerFleetEventSchema).max(COMPUTER_FLEET_EVENT_LIMIT),
  providerEventsError: text(40),
}).meta({ ref: "AdminComputerDetail" })
export type AdminComputerDetail = z.infer<typeof adminComputerDetailSchema>

export const computerFleetHistoryRangeSchema = z.enum(["24h", "7d", "30d"])
export type ComputerFleetHistoryRange = z.infer<typeof computerFleetHistoryRangeSchema>
/** How long one square of the grid covers, per range. */
export const COMPUTER_FLEET_HISTORY_BUCKET_MINUTES: Record<ComputerFleetHistoryRange, number> = { "24h": 10, "7d": 60, "30d": 60 }
export const COMPUTER_FLEET_HISTORY_HOURS: Record<ComputerFleetHistoryRange, number> = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24 }

/** The highest reading of the fleet in one bucket. */
export const computerFleetHistoryBucketSchema = z.object({
  at: count,
  total: count,
  running: count,
  paused: count,
  starting: count,
  failed: count,
  attention: count,
  sourceDown: z.boolean(),
})
export type ComputerFleetHistoryBucket = z.infer<typeof computerFleetHistoryBucketSchema>

export const adminComputerFleetHistorySchema = z.object({
  range: computerFleetHistoryRangeSchema,
  bucketMinutes: z.number().int().positive(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  buckets: z.array(computerFleetHistoryBucketSchema).max(30 * 24),
}).meta({ ref: "AdminComputerFleetHistory" })
export type AdminComputerFleetHistory = z.infer<typeof adminComputerFleetHistorySchema>
