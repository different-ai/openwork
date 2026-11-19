import type { OrgSubscriptionTable } from "@openwork-ee/den-db/schema"
import { env } from "../../env.js"
import { hasOpenWorkWebComplimentaryAccess, resolveOpenWorkWebAccess } from "../../openwork-web-access.js"
import { isOpenWorkWebAvailable } from "../../openwork-web-availability.js"
import { isEligibleOpenWorkWebSubscriptionStatus, isOngoingOpenWorkWebSubscriptionStatus } from "../../stripe-billing.js"

export type AdminOpenWorkWebSubscription = Pick<
  typeof OrgSubscriptionTable.$inferSelect,
  "status" | "stripe_price_id" | "payment_failed"
>

/** OpenWork Web access as /admin shows it: complimentary access (metadata) and any paid subscription. */
export function readAdminOpenWorkWebAccess(
  metadata: Record<string, unknown> | string | null | undefined,
  subscription: AdminOpenWorkWebSubscription | null,
) {
  const complimentaryAccess = hasOpenWorkWebComplimentaryAccess(metadata)
  const hasEligibleSubscription = Boolean(
    subscription
    && isEligibleOpenWorkWebSubscriptionStatus(subscription.status)
    && env.stripe.openworkWebPriceId
    && subscription.stripe_price_id === env.stripe.openworkWebPriceId
    && subscription.payment_failed !== true,
  )
  const access = resolveOpenWorkWebAccess({
    deploymentAvailable: isOpenWorkWebAvailable(),
    hasEligibleSubscription,
    complimentaryAccess,
  })
  return {
    ...access,
    hasEligibleSubscription,
    hasOngoingSubscription: Boolean(subscription && isOngoingOpenWorkWebSubscriptionStatus(subscription.status)),
    subscriptionStatus: subscription?.status ?? null,
  }
}

