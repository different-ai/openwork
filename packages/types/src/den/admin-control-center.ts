import { z } from "zod"

/**
 * The admin Control Center: platform product health served from snapshots a
 * den-api background job precomputes (see ee/apps/den-api/src/admin-metrics).
 * Every payload is aggregate counts, except organization names in the
 * accounts table. Days are UTC dates (YYYY-MM-DD); weeks start on Monday and
 * are named by that Monday's date.
 */

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** A share or rate; null when its denominator is zero. */
const rate = z.number().nonnegative().nullable()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** Usage tracking started on this day and finished rolling out by the trend start. */
export const CONTROL_CENTER_TRACKING_STARTED = "2026-10-09"
export const CONTROL_CENTER_TREND_START = "2026-10-13"
/** Skill and MCP usage tracking started on this day. */
export const CONTROL_CENTER_CAPABILITY_TRACKING_STARTED = "2026-10-26"

export const controlCenterRangeSchema = z.enum(["7d", "30d", "90d"])
export type ControlCenterRange = z.infer<typeof controlCenterRangeSchema>
export const CONTROL_CENTER_RANGE_DAYS: Record<ControlCenterRange, number> = { "7d": 7, "30d": 30, "90d": 90 }

export const controlCenterPulseSchema = z.object({
  taskUsers: z.object({ daily: count, weekly: count, monthly: count, previousWeekly: count, dailyOverMonthly: rate }),
  tasks: z.object({ weekly: count, previousWeekly: count, perWeekday: z.number().nonnegative(), perActiveUser: rate }),
  failures: z.object({ started: count, completed: count, failed: count, abandoned: count, failureRate: rate, abandonedRate: rate, previousFailureRate: rate }),
  teamOrganizations: z.object({ active: count, previous: count }),
  signups: z.object({ weekly: count, previousWeekly: count, workEmail: count, workEmailShare: rate }),
  daily: z.array(z.object({ date, taskUsers: count, started: count, completed: count, failed: count, signups: count, workEmailSignups: count })).max(90),
}).meta({ ref: "AdminControlCenterPulse" })
export type ControlCenterPulse = z.infer<typeof controlCenterPulseSchema>

export const controlCenterLifecycleSchema = z.object({
  weeks: z.array(z.object({ week: date, new: count, stillActive: count, returned: count, lost: count, gainsVsLosses: rate })).max(14),
  organizations: z.array(z.object({ week: date, personal: count, team: count })).max(14),
  /** People who signed up in the range at least 7 days ago, so every step had time to happen. */
  activation: z.object({ from: date, to: date, signedUp: count, ranTaskWithin3Days: count, backAfterDay1: count, activeInWeek1: count }),
  cohorts: z.array(z.object({ week: date, signups: count, retention: z.array(z.object({ offset: count, users: count, rate: rate })).max(14) })).max(14),
  reactivation: z.object({
    week: date,
    reactivated: count,
    returned: count,
    lost: count,
    inactivePool: count,
    /** People who came back in the previous complete week and were active again this week. */
    returnersStayed: z.object({ week: date, returned: count, stayed: count, rate }),
  }),
}).meta({ ref: "AdminControlCenterLifecycle" })
export type ControlCenterLifecycle = z.infer<typeof controlCenterLifecycleSchema>

export const controlCenterInvitationsSchema = z.object({
  joinedThroughInvite: count,
  joinedRanTask: count,
  joinedRanTaskWithin7Days: count,
  peopleWithAcceptedInvite: count,
  /** Invitations created in the range, by current state. Counts only; never rows, emails or tokens. */
  invitations: z.object({ sent: count, accepted: count, expired: count, pending: count, canceled: count, medianHoursToAccept: z.number().nonnegative().nullable() }),
  pendingNow: count,
  /** Null when no outreach has been recorded. */
  outreach: z.object({ contactedOrganizations: count, activeWithin7Days: count }).nullable(),
}).meta({ ref: "AdminControlCenterInvitations" })
export type ControlCenterInvitations = z.infer<typeof controlCenterInvitationsSchema>

export const controlCenterSharingSchema = z.object({
  weekly: z.array(z.object({ week: date, skillUsers: count, skillUses: count, mcpUsers: count, mcpCalls: count })).max(14),
  skills: z.object({ creators: count, teamSkills: count, sharedTeamSkills: count, sharingRate: rate, teamUses: count, teammateUses: count, teammateReuseRate: rate }),
  mcp: z.object({ teamCalls: count, sharedConnectionCalls: count, sharedReuseRate: rate }),
  connectors: z.array(z.object({ name: z.string().max(255), people: count, calls: count, errors: count, errorRate: rate })).max(10),
  /** Built-in default plugins and marketplaces every organization gets are excluded. */
  catalog: z.object({ plugins: count, marketplaces: count }),
}).meta({ ref: "AdminControlCenterSharing" })
export type ControlCenterSharing = z.infer<typeof controlCenterSharingSchema>

export const controlCenterSubscriptionTypeSchema = z.enum(["inference", "seat", "web", "enterprise"])
export const controlCenterRevenueSchema = z.object({
  activePaidSeats: count,
  activePlans: count,
  pastDue: count,
  monthly: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), type: controlCenterSubscriptionTypeSchema, started: count, canceled: count })).max(48),
  /** Paid organizations whose active members use the smallest share of their seats. */
  atRisk: z.array(z.object({ organizationId: z.string(), name: z.string(), seats: count, activeMembers: count, seatUsage: rate })).max(10),
}).meta({ ref: "AdminControlCenterRevenue" })
export type ControlCenterRevenue = z.infer<typeof controlCenterRevenueSchema>

export const controlCenterAccountsSchema = z.object({
  rows: z.array(z.object({
    organizationId: z.string(),
    name: z.string(),
    members: count,
    active7d: count,
    tasks7d: count,
    plan: z.enum(["free", "team", "enterprise"]),
    paying: z.boolean(),
    seats: count.nullable(),
    seatUsage: rate,
  })).max(25),
}).meta({ ref: "AdminControlCenterAccounts" })
export type ControlCenterAccounts = z.infer<typeof controlCenterAccountsSchema>

export const CONTROL_CENTER_SECTIONS = {
  pulse: controlCenterPulseSchema,
  lifecycle: controlCenterLifecycleSchema,
  invitations: controlCenterInvitationsSchema,
  sharing: controlCenterSharingSchema,
  revenue: controlCenterRevenueSchema,
  accounts: controlCenterAccountsSchema,
} as const
export type ControlCenterSectionKey = keyof typeof CONTROL_CENTER_SECTIONS
export const CONTROL_CENTER_SECTION_KEYS = Object.keys(CONTROL_CENTER_SECTIONS) as ControlCenterSectionKey[]

function sectionSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    /** When the shown data was computed; null until the first successful refresh. */
    computedAt: z.string().datetime().nullable(),
    /** True when the data is older than twice its refresh interval, or missing. */
    stale: z.boolean(),
    /** The last refresh failed; the data shown is the last good snapshot. */
    error: z.string().max(500).nullable(),
    durationMs: count.nullable(),
    data: data.nullable(),
  })
}

export const adminControlCenterSchema = z.object({
  range: controlCenterRangeSchema,
  generatedAt: z.string().datetime(),
  sections: z.object({
    pulse: sectionSchema(controlCenterPulseSchema),
    lifecycle: sectionSchema(controlCenterLifecycleSchema),
    invitations: sectionSchema(controlCenterInvitationsSchema),
    sharing: sectionSchema(controlCenterSharingSchema),
    revenue: sectionSchema(controlCenterRevenueSchema),
    accounts: sectionSchema(controlCenterAccountsSchema),
  }),
  refresh: z.object({ fastIntervalMs: count, heavyIntervalMs: count, lastRequestedAt: z.string().datetime().nullable() }),
}).meta({ ref: "AdminControlCenter" })
export type AdminControlCenter = z.infer<typeof adminControlCenterSchema>
export type ControlCenterSection<K extends ControlCenterSectionKey> = AdminControlCenter["sections"][K]

export const adminControlCenterRefreshSchema = z.object({
  scheduled: z.literal(true),
  requestedAt: z.string().datetime(),
}).meta({ ref: "AdminControlCenterRefresh" })

export const adminControlCenterRefreshLimitedSchema = z.object({
  error: z.literal("refresh_rate_limited"),
  message: z.string(),
  retryAfterSeconds: count,
}).meta({ ref: "AdminControlCenterRefreshLimited" })
