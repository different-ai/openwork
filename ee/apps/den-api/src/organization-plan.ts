/**
 * One rule for how many people an organization may have, and the plan shape a
 * platform admin sets in /admin. Pure: no database, Stripe or clock access, so
 * every join path (email invitations, SSO sign-up, verified-domain join, SCIM),
 * /admin and the Billing page resolve the same answer and it is unit tested.
 *
 * Users are joined members plus unexpired pending invitations
 * (billing-users.ts). The limit:
 *
 * - An active Team seat subscription in Stripe (active or trialing): no
 *   limit, Stripe bills every user.
 * - Otherwise a Team or Enterprise plan a platform admin set (manual) or that
 *   was grandfathered: its seats, never fewer than the Free plan's 5.
 * - Otherwise Free: 5 plus any extra free users a platform admin allowed.
 *
 * Limits only apply where seat billing gates member additions (hosted
 * multi-organization deployments with Stripe seat billing configured); a
 * self-hosted install is never limited. No feature flag takes part.
 *
 * A plan's end date is display only: nothing changes when it passes.
 */
import type { BillingPlanSource, BillingPlanTier, OrganizationPlanState, PlanPaidBy } from "@openwork/types/den/billing-plans"
import { FREE_ORG_SEAT_COUNT, additionalFreeSeatCountFromMetadata, normalizeUserCount } from "./billing-quantities.js"
import type { DenOrgMode } from "./env.js"

export const FREE_PLAN_USER_LIMIT = FREE_ORG_SEAT_COUNT
export const MAX_PLAN_USERS = 100_000

/** Seat (Team plan) subscriptions grant the plan while Stripe bills normally. */
export const SEAT_PLAN_PAID_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"])

type MetadataRecord = Record<string, unknown>

function isRecord(value: unknown): value is MetadataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function without(record: MetadataRecord, keys: readonly string[]): MetadataRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

const END_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar date `YYYY-MM-DD` (rejects 2026-02-30), or null. */
export function normalizePlanEndDate(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = END_DATE_PATTERN.exec(value)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? value : null
}

/** Today as `YYYY-MM-DD` in UTC, the calendar `endsAt` is compared in. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** Seat billing gates member additions only on hosted multi-organization deployments with Stripe seat billing configured. */
export function isSeatBillingGateEnabled(input: {
  orgMode: DenOrgMode
  stripeSecretKey: string | undefined
  stripeSeatPriceId: string | undefined
}) {
  return input.orgMode === "multi_org" && Boolean(input.stripeSecretKey && input.stripeSeatPriceId)
}

export function isAdminSetPlan(plan: { tier: BillingPlanTier; source: BillingPlanSource }) {
  return (plan.tier === "team" || plan.tier === "enterprise") && (plan.source === "manual" || plan.source === "grandfathered")
}

/** The plan fields beyond tier and source: seats (falling back to the legacy `limits.members`), end date and grant time. */
export function readStoredPlanDetails(metadata: MetadataRecord) {
  const plan = isRecord(metadata.plan) ? metadata.plan : {}
  const limits = isRecord(metadata.limits) ? metadata.limits : {}
  return {
    seats: positiveInteger(plan.seats) ?? positiveInteger(limits.members) ?? FREE_PLAN_USER_LIMIT,
    endsAt: normalizePlanEndDate(plan.endsAt),
    grantedAt: typeof plan.grantedAt === "string" ? plan.grantedAt : null,
  }
}

/**
 * Who pays for the plan, from the organization's stored Team (seat)
 * subscription. Enterprise is never paid through Stripe: a platform admin
 * sets it and OpenWork invoices it, so it reads "none".
 */
export function planPaidBy(input: { seat: { status: string } | null }): PlanPaidBy {
  return input.seat && SEAT_PLAN_PAID_STATUSES.has(input.seat.status) ? "stripe_team" : "none"
}

export type OrganizationPlanInput = {
  plan: { tier: BillingPlanTier; source: BillingPlanSource }
  /** Raw organization metadata: seats, end date and extra free users are read from it. */
  metadata: MetadataRecord
  users: number
  paidBy: PlanPaidBy
  gateEnabled: boolean
  /** Today, `YYYY-MM-DD` (UTC). */
  today: string
}

/** The one rule. See the module comment. */
export function resolveOrganizationPlanState(input: OrganizationPlanInput): OrganizationPlanState {
  const users = normalizeUserCount(input.users)
  const adminSet = isAdminSetPlan(input.plan)
  const details = readStoredPlanDetails(input.metadata)
  const seats = adminSet ? Math.max(details.seats, FREE_PLAN_USER_LIMIT) : null
  const endsAt = adminSet ? details.endsAt : null
  const userLimit = !input.gateEnabled || input.paidBy !== "none"
    ? null
    : seats ?? FREE_PLAN_USER_LIMIT + additionalFreeSeatCountFromMetadata(input.metadata)
  return {
    tier: input.plan.tier,
    source: input.plan.source,
    paidBy: input.paidBy,
    users,
    userLimit,
    seats,
    endsAt,
    ended: endsAt !== null && endsAt < input.today,
  }
}

export function canAddPerson(state: Pick<OrganizationPlanState, "users" | "userLimit">) {
  return state.userLimit === null || state.users < state.userLimit
}

/**
 * Why one more person may not be added: `free_limit_reached` leads to the Team
 * upgrade, `plan_limit_reached` (a plan set by a platform admin or
 * grandfathered) to asking OpenWork for more seats.
 */
export function personAddRefusal(state: OrganizationPlanState): "free_limit_reached" | "plan_limit_reached" | null {
  if (canAddPerson(state)) return null
  return state.seats !== null ? "plan_limit_reached" : "free_limit_reached"
}

/** "Your Enterprise plan includes 20 users, counting pending invitations. Ask your OpenWork contact to add seats." */
export function planLimitReachedMessage(state: Pick<OrganizationPlanState, "tier" | "userLimit">) {
  const plan = state.tier === "enterprise" ? "Enterprise" : "Team"
  return `Your ${plan} plan includes ${state.userLimit ?? 0} users, counting pending invitations. Ask your OpenWork contact to add seats.`
}

export type AdminPlanInput = {
  tier: BillingPlanTier
  /** Users allowed; never fewer than the Free plan's 5. */
  seatLimit: number
  /** Team and Enterprise only; null or omitted clears it. */
  endsAt?: string | null
}

/**
 * The organization metadata after a platform admin sets its plan. Pure: the
 * caller writes it. Team and Enterprise store their seats in `plan.seats` and
 * clear any extra free users, so the number shown is the number enforced.
 * Free stores the number as extra free users above 5. Either way
 * `limits.members` mirrors the number for one release, for older readers.
 * Never touches Stripe.
 */
export function applyAdminPlan(current: MetadataRecord, input: AdminPlanInput, now: Date): MetadataRecord {
  const users = Math.min(MAX_PLAN_USERS, Math.max(FREE_PLAN_USER_LIMIT, Math.floor(input.seatLimit)))
  const stored = isRecord(current.plan) ? current.plan : {}
  const limits = isRecord(current.limits) ? current.limits : {}
  const next: MetadataRecord = { ...current, limits: { ...limits, members: users } }
  if (input.tier === "free") {
    next.plan = { ...without(stored, ["seats", "endsAt", "grantedAt"]), tier: "free", source: "manual" }
    next.seatsFreeAdditional = users - FREE_PLAN_USER_LIMIT
    return next
  }
  const endsAt = normalizePlanEndDate(input.endsAt ?? null)
  // Keep when Enterprise was first granted while an admin only edits seats or the end date.
  const keepsGrant = input.tier === "enterprise" && stored.tier === "enterprise" && typeof stored.grantedAt === "string"
  next.plan = {
    ...without(stored, ["endsAt", "grantedAt"]),
    tier: input.tier,
    source: "manual",
    seats: users,
    ...(endsAt ? { endsAt } : {}),
    ...(input.tier === "enterprise" ? { grantedAt: keepsGrant ? stored.grantedAt : now.toISOString() } : {}),
  }
  delete next.seatsFreeAdditional
  return next
}
