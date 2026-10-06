import {
  OPENWORK_WEB_CURRENCY,
  OPENWORK_WEB_INTERVAL,
  OPENWORK_WEB_QUANTITY_DEFINITION,
  OPENWORK_WEB_UNIT_AMOUNT,
} from "@openwork/types/den/openwork-web"
import type { OpenWorkWebBillingFields } from "../core/providers/openwork-web-paid-source.js"

export type OpenWorkWebAccessSource = "subscription" | "complimentary" | null

export const OPENWORK_WEB_QUANTITY_DESCRIPTION =
  "Every joined, non-removed organization member; pending invitations are excluded."

/** The billing fields of a deployment without a paid source (no billing). */
export const NO_OPENWORK_WEB_BILLING: OpenWorkWebBillingFields = {
  configured: false,
  hasEligibleSubscription: false,
  subscription: null,
}

export function resolveOpenWorkWebAccess(input: {
  deploymentAvailable: boolean
  hasEligibleSubscription: boolean
  complimentaryAccess: boolean
}): {
  hasAccess: boolean
  accessSource: OpenWorkWebAccessSource
  complimentaryAccess: boolean
} {
  const accessSource: OpenWorkWebAccessSource = input.deploymentAvailable && input.hasEligibleSubscription
    ? "subscription"
    : input.complimentaryAccess
      ? "complimentary"
      : null

  return {
    hasAccess: accessSource !== null,
    accessSource,
    complimentaryAccess: input.complimentaryAccess,
  }
}

function normalizeMemberCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function calculateOpenWorkWebBilling(input: { joinedMemberCount: number }) {
  const quantity = normalizeMemberCount(input.joinedMemberCount)
  return {
    quantity,
    unitAmount: OPENWORK_WEB_UNIT_AMOUNT,
    expectedMonthlyTotal: quantity * OPENWORK_WEB_UNIT_AMOUNT,
  }
}

/** The `billing.stripe.web` body of `GET /v1/billing/web`. Field order is part of the wire shape. */
export function composeOpenWorkWebSummary(input: {
  deploymentAvailable: boolean
  joinedMemberCount: number
  complimentaryAccess: boolean
  billing: OpenWorkWebBillingFields
}) {
  const offer = calculateOpenWorkWebBilling({ joinedMemberCount: input.joinedMemberCount })
  const access = resolveOpenWorkWebAccess({
    deploymentAvailable: input.deploymentAvailable,
    hasEligibleSubscription: input.billing.hasEligibleSubscription,
    complimentaryAccess: input.complimentaryAccess,
  })
  return {
    configured: input.billing.configured,
    unitAmount: OPENWORK_WEB_UNIT_AMOUNT,
    currency: OPENWORK_WEB_CURRENCY,
    interval: OPENWORK_WEB_INTERVAL,
    quantityDefinition: OPENWORK_WEB_QUANTITY_DEFINITION,
    quantityDescription: OPENWORK_WEB_QUANTITY_DESCRIPTION,
    quantity: offer.quantity,
    expectedMonthlyTotal: offer.expectedMonthlyTotal,
    hasEligibleSubscription: input.billing.hasEligibleSubscription,
    ...access,
    subscription: input.billing.subscription,
  }
}

export type OpenWorkWebSummary = ReturnType<typeof composeOpenWorkWebSummary>
