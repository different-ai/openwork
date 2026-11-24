import {
  BILLING_RETURN_DESKTOP,
  isPlanCheckoutTier,
  planTierRank,
  withReturnParams,
  type BillingCheckoutReturnKind,
  type BillingReturnTo,
  type PlanCheckoutTier,
} from "@openwork/types/den/billing-plans"
import type { OrganizationPlan } from "./entitlements.js"

export {
  parseBillingReturnTo,
  quotePlan,
  TEAM_PLAN_UNIT_AMOUNT,
  PLAN_CURRENCY,
  PLAN_INTERVAL,
} from "@openwork/types/den/billing-plans"

export const PLAN_OPENWORK_PRODUCT = "openwork_plan"
export const PER_PERSON_PRICING_MODEL = "per_person"

type StripeMetadata = Record<string, string | null | undefined> | null | undefined

export function planTierFromSubscriptionMetadata(metadata: StripeMetadata): PlanCheckoutTier {
  const tier = metadata?.plan_tier?.trim()
  return isPlanCheckoutTier(tier) ? tier : "team"
}

export function isPerPersonPlanMetadata(metadata: StripeMetadata): boolean {
  return metadata?.pricing_model?.trim() === PER_PERSON_PRICING_MODEL
}

const PLAN_GRANTING_STATUSES = new Set(["active", "trialing", "past_due"])
const PLAN_REVOKING_STATUSES = new Set(["incomplete", "canceled", "unpaid", "incomplete_expired", "expired", "paused"])

export type PlanReconciliationInput = {
  current: OrganizationPlan
  status: string
  tier: PlanCheckoutTier
  legacyWithoutCharge?: boolean
}

export function reconcileOrganizationPlan(input: PlanReconciliationInput): OrganizationPlan | null {
  const { current, status, tier } = input
  if (PLAN_GRANTING_STATUSES.has(status)) {
    if (input.legacyWithoutCharge) return null
    const protectedGrant = current.source === "manual" || current.source === "grandfathered"
    if (protectedGrant && planTierRank(current.tier) >= planTierRank(tier)) return null
    if (current.source === "stripe" && current.tier === tier) return null
    return { tier, source: "stripe" }
  }
  if (PLAN_REVOKING_STATUSES.has(status)) {
    if (current.source !== "stripe") return null
    return { tier: "free", source: "default" }
  }
  return null
}

export const CHECKOUT_RETURN_PATH = "/dashboard/billing/stripe/checking"
const CHECKOUT_SESSION_PLACEHOLDER = "{CHECKOUT_SESSION_ID}"

function withQueryParam(input: string, key: string, value: string): string {
  try {
    const url = new URL(input)
    url.searchParams.set(key, value)
    return url.toString().replace(encodeURIComponent(CHECKOUT_SESSION_PLACEHOLDER), CHECKOUT_SESSION_PLACEHOLDER)
  } catch {
    return input
  }
}

function withoutSessionParam(input: string): string {
  try {
    const url = new URL(input.replace(CHECKOUT_SESSION_PLACEHOLDER, "pending"))
    url.searchParams.delete("session_id")
    return url.toString()
  } catch {
    return input
  }
}

function returnPageUrl(origin: string, kind: BillingCheckoutReturnKind, returnTo: BillingReturnTo | null, withSession: boolean): string {
  const query = [
    ...(withSession ? [`session_id=${CHECKOUT_SESSION_PLACEHOLDER}`] : []),
    `return=${kind}`,
    ...(returnTo ? [`returnTo=${encodeURIComponent(returnTo)}`] : []),
  ].join("&")
  return `${origin}${CHECKOUT_RETURN_PATH}?${query}`
}

export function defaultCheckoutReturnPageUrl(origin: string, kind: BillingCheckoutReturnKind): string {
  return returnPageUrl(origin, kind, null, true)
}

export type CheckoutReturnUrls = {
  successUrl: string
  cancelUrl: string
  completedUrl: string
}

export function checkoutReturnUrls(input: {
  origin: string
  kind: BillingCheckoutReturnKind
  returnTo: BillingReturnTo | null
  defaults: { successUrl: string; cancelUrl: string }
}): CheckoutReturnUrls {
  const { origin, kind, returnTo, defaults } = input
  if (!returnTo) {
    return { successUrl: defaults.successUrl, cancelUrl: defaults.cancelUrl, completedUrl: withoutSessionParam(defaults.successUrl) }
  }
  const cancelUrl = returnTo === BILLING_RETURN_DESKTOP
    ? withQueryParam(defaults.cancelUrl, "checkout", "canceled")
    : `${origin}${withReturnParams(returnTo, { checkout: "canceled" })}`
  return {
    successUrl: returnPageUrl(origin, kind, returnTo, true),
    cancelUrl,
    completedUrl: returnPageUrl(origin, kind, returnTo, false),
  }
}
