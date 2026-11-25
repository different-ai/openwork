import type { BillingPlanSource, BillingPlanTier, OrganizationPlanState, PlanPaidBy } from "@openwork/types/den/billing-plans"
import { FREE_ORG_SEAT_COUNT, additionalFreeSeatCountFromMetadata, normalizeUserCount } from "./billing-quantities.js"
import type { DenOrgMode } from "./env.js"

export const FREE_PLAN_USER_LIMIT = FREE_ORG_SEAT_COUNT
export const MAX_PLAN_USERS = 100_000

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

export function normalizePlanEndDate(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = END_DATE_PATTERN.exec(value)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? value : null
}

export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

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

export function readStoredPlanDetails(metadata: MetadataRecord) {
  const plan = isRecord(metadata.plan) ? metadata.plan : {}
  const limits = isRecord(metadata.limits) ? metadata.limits : {}
  return {
    seats: positiveInteger(plan.seats) ?? positiveInteger(limits.members) ?? FREE_PLAN_USER_LIMIT,
    endsAt: normalizePlanEndDate(plan.endsAt),
    grantedAt: typeof plan.grantedAt === "string" ? plan.grantedAt : null,
  }
}

export function planPaidBy(input: { seat: { status: string } | null }): PlanPaidBy {
  return input.seat && SEAT_PLAN_PAID_STATUSES.has(input.seat.status) ? "stripe_team" : "none"
}

export type OrganizationPlanInput = {
  plan: { tier: BillingPlanTier; source: BillingPlanSource }
  metadata: MetadataRecord
  users: number
  paidBy: PlanPaidBy
  gateEnabled: boolean
  today: string
}

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

export function personAddRefusal(state: OrganizationPlanState): "free_limit_reached" | "plan_limit_reached" | null {
  if (canAddPerson(state)) return null
  return state.seats !== null ? "plan_limit_reached" : "free_limit_reached"
}

export function freePlanLimitReachedMessage(freeSeatCount: number, billingUrl: string) {
  return `The Free plan is limited to ${freeSeatCount} users, counting pending invitations. Upgrade to the Team plan at ${billingUrl} to invite more people.`
}

export function planLimitReachedMessage(state: Pick<OrganizationPlanState, "tier" | "userLimit">) {
  const plan = state.tier === "enterprise" ? "Enterprise" : "Team"
  return `Your ${plan} plan includes ${state.userLimit ?? 0} users, counting pending invitations. Ask your OpenWork contact to add seats.`
}

export type AdminPlanInput = {
  tier: BillingPlanTier
  seatLimit: number
  endsAt?: string | null
}

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
