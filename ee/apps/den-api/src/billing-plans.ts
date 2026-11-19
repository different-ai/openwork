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

/**
 * Pure rules for plan checkout (ENG-874): which plan a Stripe subscription
 * pays for, how that changes `organization.metadata.plan`, and where a
 * checkout returns. No I/O, so every transition is unit tested.
 */

export {
  parseBillingReturnTo,
  quotePlan,
  TEAM_PLAN_UNIT_AMOUNT,
  PLAN_CURRENCY,
  PLAN_INTERVAL,
} from "@openwork/types/den/billing-plans"

/** Stripe metadata values written on plan checkouts and their subscriptions. */
export const PLAN_OPENWORK_PRODUCT = "openwork_plan"
export const PER_PERSON_PRICING_MODEL = "per_person"

type StripeMetadata = Record<string, string | null | undefined> | null | undefined

/** The plan a seat subscription pays for: always Team (Enterprise is set in /admin, never bought by card). */
export function planTierFromSubscriptionMetadata(metadata: StripeMetadata): PlanCheckoutTier {
  const tier = metadata?.plan_tier?.trim()
  return isPlanCheckoutTier(tier) ? tier : "team"
}

/** Per-person plans bill every counted person; legacy seat subscriptions bill people beyond the free ones. */
export function isPerPersonPlanMetadata(metadata: StripeMetadata): boolean {
  return metadata?.pricing_model?.trim() === PER_PERSON_PRICING_MODEL
}

/** Active plans and renewal grace periods grant access; an unpaid initial payment does not. */
const PLAN_GRANTING_STATUSES = new Set(["active", "trialing", "past_due"])
/** Unpaid initial payments and stopped subscriptions return a Stripe-sourced plan to Free. */
const PLAN_REVOKING_STATUSES = new Set(["incomplete", "canceled", "unpaid", "incomplete_expired", "expired", "paused"])

export type PlanReconciliationInput = {
  current: OrganizationPlan
  status: string
  tier: PlanCheckoutTier
  /**
   * A seat subscription created before plans existed that bills nobody yet
   * (quantity 0, a saved card) is not a payment, so it never grants a plan.
   */
  legacyWithoutCharge?: boolean
}

/**
 * The organization plan after a seat subscription changed, or `null` when it
 * stays as it is. Paying sets `{ tier, source: "stripe" }`; Stripe giving up
 * returns a Stripe-sourced plan to Free. A manual or grandfathered plan is
 * never lowered by Stripe: an equal or higher grant is kept as it is.
 */
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

// ─── Checkout return URLs ────────────────────────────────────────────────────

export const CHECKOUT_RETURN_PATH = "/dashboard/billing/stripe/checking"
const CHECKOUT_SESSION_PLACEHOLDER = "{CHECKOUT_SESSION_ID}"

function withQueryParam(input: string, key: string, value: string): string {
  try {
    const url = new URL(input)
    url.searchParams.set(key, value)
    // Stripe substitutes the literal placeholder; keep it unencoded.
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

/** The Den return page for a checkout of this kind, with no `returnTo`. */
export function defaultCheckoutReturnPageUrl(origin: string, kind: BillingCheckoutReturnKind): string {
  return returnPageUrl(origin, kind, null, true)
}

export type CheckoutReturnUrls = {
  /** Stripe success_url; carries `{CHECKOUT_SESSION_ID}`. */
  successUrl: string
  cancelUrl: string
  /** Where to go when the plan changed without a payment page (success URL without the session). */
  completedUrl: string
}

/**
 * Success, cancel and completed URLs for one checkout. Without `returnTo` the
 * product's existing defaults are kept exactly. With one, success goes to the
 * Den return page (which syncs the session, then returns there) and cancel
 * goes back to that page (or the default, for Desktop) with `checkout=canceled`.
 */
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
