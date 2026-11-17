import { z } from "zod"

/**
 * The admin Computer fleet page: the sandboxes cloud conversations use as computers, as their providers report them
 * now, whether they run through the sandbox gateway (Differently) or on the direct provider (see
 * ee/apps/den-api/src/computer-fleet). States, sizes, times, provider ids and the owning organization's name only:
 * nothing a computer holds, and no credentials.
 */

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
 * `idle_running`: it is running and nothing has used it for far longer than the runner waits before pausing one.
 */
export const computerFleetAttentionSchema = z.enum(["failed", "stuck_starting", "stuck_pausing", "stuck_stopping", "expired", "idle_running"])
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
  /** What it was built from: the gateway's template or snapshot, or the provider's snapshot. */
  image: text(200).default(null),
  /** Whether that is what the runner builds new computers from now; null when either is not known. */
  imageCurrent: z.boolean().nullable().default(null),
})
export type ComputerFleetSandbox = z.infer<typeof computerFleetSandboxSchema>

/** How the runner treats one source's computers: what new ones are built from, and when it pauses and deletes them. */
export const computerFleetSettingsSchema = z.object({
  image: text(200),
  /** Seconds after a computer's last use before the runner pauses it. */
  idlePauseSeconds: count,
  /** Days a computer is kept unused before it is deleted; ignored when `persistent`. */
  keepDays: count,
  persistent: z.boolean(),
})
export type ComputerFleetSettings = z.infer<typeof computerFleetSettingsSchema>

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
  /** Null from a runner that does not say. */
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
  /** Why the runner's list could not be read (`http_404`: a runner from before it had one); null when it was. */
  runnerError: text(40),
  sources: z.array(computerFleetSourceSchema).max(8),
  /** Every computer, or one organization's when the request named one. Always the whole fleet's in `totals`. */
  sandboxes: z.array(computerFleetSandboxSchema).max(COMPUTER_FLEET_LIST_LIMIT),
  listTruncated: z.boolean(),
  totals: computerFleetTotalsSchema,
  /** The whole fleet's computers needing a look, by why; null from a server that does not say. */
  attentionCounts: computerFleetAttentionCountsSchema.nullable().default(null),
  /** The organizations that have computers, most computers first, for the page's filter. */
  organizations: z.array(z.object({ id: z.string().min(1).max(64), name: z.string().max(200), computers: count })).max(COMPUTER_FLEET_ORGANIZATION_LIMIT).default([]),
  /** Computers whose conversation Den does not know, so no organization can be named. */
  unknownOrganization: count.default(0),
}).meta({ ref: "AdminComputerFleet" })
export type AdminComputerFleet = z.infer<typeof adminComputerFleetSchema>

/** The request's `organization` for computers whose organization is not known. */
export const COMPUTER_FLEET_UNKNOWN_ORGANIZATION = "unknown"

/** A lifecycle event of one computer. Never a command, a path or anything else a conversation did on it. */
export const computerFleetEventSchema = z.object({
  at: moment,
  /** `provider`: the sandbox gateway's own record. `den`: what Workbot's server reported to Den. */
  origin: z.enum(["provider", "den"]),
  /** A fixed name: the gateway's action (`idled`, `woke`, `running`), or Den's event (`viewer_opened`, `paused`). */
  type: z.string().max(60),
  level: z.enum(["info", "warning", "error"]),
  /** Den's one plain sentence, or the gateway's details as `name: value` pairs. */
  message: z.string().max(600),
})
export type ComputerFleetEvent = z.infer<typeof computerFleetEventSchema>

/** Where the sandbox gateway placed a computer and why, with every pool it weighed. */
export const computerFleetPlacementSchema = z.object({
  pool: text(200),
  strategy: text(200),
  /** `placed`, `waiting` or `rejected`. */
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
  /** The label that ties it to its conversation at the provider: `hc-` and a hash of the session id. */
  key: text(200),
  /** Gateway only: `private` (our own pool) or `external` (a provider's). */
  trust: text(40),
  /** How many times the gateway tried to start it. */
  attempts: count.nullable(),
  /** Gateway only: set while it is stopped or paused for being idle; its next use wakes it. */
  idledAt: moment,
  /** Gateway only: set while a resume waits for a free slot or for a pause to finish. */
  resumeRequestedAt: moment,
  /** Gateway only: a paused computer that holds no pool slot until it resumes. */
  slotReleased: z.boolean().nullable(),
  /** The provider's own rules for this computer, in seconds; null where it has none or does not say. */
  limits: z.object({
    idleTimeoutSeconds: count.nullable(),
    ttlSeconds: count.nullable(),
    maxRunSeconds: count.nullable(),
    maxPausedSeconds: count.nullable(),
    autoDeleteSeconds: count.nullable(),
    /** Seconds it has spent running over its whole life, where the provider counts them. */
    totalRunSeconds: count.nullable(),
  }),
  profile: text(200),
  classification: text(200),
  capabilities: z.array(z.string().max(200)).max(100),
  preemptible: z.boolean().nullable(),
  /** How the runner treats this source's computers. */
  settings: computerFleetSettingsSchema.nullable(),
  placement: computerFleetPlacementSchema.nullable(),
  /** The conversation it belongs to, when Den knows it. Never its name or content. */
  conversation: z.object({
    sessionId: z.string().min(1).max(128),
    /** Workbot's main chat or a side chat; null when Den has no record of which. */
    chat: z.enum(["main", "side"]).nullable(),
    member: z.object({ id: z.string().min(1).max(64), name: z.string().max(255), email: z.string().max(320) }).nullable(),
    createdAt: moment,
    lastActiveAt: moment,
    /** When the turn now running began; null when none is. */
    activeTurnSince: moment,
  }).nullable(),
  /** What Workbot's server last reported about it to Den: `ready`, `paused`, `setup_required`, `unavailable`. */
  reported: z.object({ state: z.string().max(24), detail: text(300), at: moment }).nullable(),
  /** Newest first. */
  events: z.array(computerFleetEventSchema).max(COMPUTER_FLEET_EVENT_LIMIT),
  /** Why the provider's own events are missing: `unsupported` (it keeps none) or a read code such as `http_403`. */
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
