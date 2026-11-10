import { z } from "zod"

/**
 * What Workbot costs an organization (Den › Analytics › Workbot).
 *
 * Workbot runs on the headless runner, which names its conversation on every
 * model call (`HEADLESS_SESSION_HEADER`). The gateway keeps that id on the
 * request log, never forwards it upstream, and folds the tagged requests into
 * one row per day, member, surface and model (`workbot_usage_day`); the
 * conversation id itself is not kept. Costs are
 * the gateway's own: the provider's reported cost when it sends one, the
 * price list otherwise. Requests the gateway could not price are counted in
 * `unpricedRequests` and add nothing to the cost.
 */
export const HEADLESS_SESSION_HEADER = "x-openwork-headless-session"

const HEADLESS_SESSION_ID = /^hs_[A-Za-z0-9_-]{8,96}$/

/** The runner conversation a model call belongs to, or null when the header is absent or not a session id. */
export function parseHeadlessSessionHeader(value: string | null | undefined): string | null {
  return typeof value === "string" && HEADLESS_SESSION_ID.test(value) ? value : null
}

/**
 * Where the conversation ran, read from its id: Den derives the ids of a person's Workbot chats (`hs_wb_`, `hs_wbs_`,
 * `hs_c_`) and of their background agent (`hs_agent_`); the runner names every other conversation itself, which today
 * means Workbot in Slack and cloud Automations (`other`). Decided when the request is folded, so a later change to
 * these prefixes never rewrites history.
 */
export const WORKBOT_USAGE_SURFACES = ["chat", "agent", "other"] as const
export type WorkbotUsageSurface = (typeof WORKBOT_USAGE_SURFACES)[number]

export function workbotUsageSurfaceOfSession(sessionId: string): WorkbotUsageSurface {
  if (/^hs_(?:wb|wbs|c)_/.test(sessionId)) return "chat"
  if (/^hs_agent[a-z]*_/.test(sessionId)) return "agent"
  return "other"
}

export function workbotUsageSurface(value: unknown): WorkbotUsageSurface {
  return WORKBOT_USAGE_SURFACES.find((surface) => surface === value) ?? "other"
}

/** The window the Workbot view reports, in whole UTC days including today. */
export const WORKBOT_USAGE_DAYS = 30

const count = z.number().int().nonnegative()

const workbotUsageSumsSchema = z.object({
  /** US dollars in millionths, as the gateway recorded it. */
  costMicroUsd: count,
  /** Model requests; one Workbot answer makes several. */
  requests: count,
  /** Requests with no known cost; they add nothing to `costMicroUsd`. */
  unpricedRequests: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
})
export type WorkbotUsageSums = z.infer<typeof workbotUsageSumsSchema>

export const workbotUsageResponseSchema = z.object({
  days: count,
  /** The first UTC day (YYYY-MM-DD) with any recorded Workbot usage; null when there is none yet. */
  since: z.string().nullable(),
  totals: workbotUsageSumsSchema.extend({ members: count }),
  /** One entry per UTC day in the window, oldest first, days without usage included. */
  daily: z.array(workbotUsageSumsSchema.extend({ day: z.string() })),
  surfaces: z.array(workbotUsageSumsSchema.extend({ surface: z.enum(WORKBOT_USAGE_SURFACES) })),
  /** Most expensive first. An empty `model` is a request whose model the gateway never learned. */
  models: z.array(workbotUsageSumsSchema.extend({ model: z.string() })),
  /** Most expensive first. `name` is null for a member who has since left. */
  members: z.array(workbotUsageSumsSchema.extend({ memberId: z.string(), name: z.string().nullable(), email: z.string().nullable() })),
})
export type WorkbotUsageResponse = z.infer<typeof workbotUsageResponseSchema>

export function emptyWorkbotUsageSums(): WorkbotUsageSums {
  return { costMicroUsd: 0, requests: 0, unpricedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
}

export function addWorkbotUsageSums(into: WorkbotUsageSums, row: WorkbotUsageSums): void {
  into.costMicroUsd += row.costMicroUsd
  into.requests += row.requests
  into.unpricedRequests += row.unpricedRequests
  into.inputTokens += row.inputTokens
  into.outputTokens += row.outputTokens
  into.cacheReadTokens += row.cacheReadTokens
}
