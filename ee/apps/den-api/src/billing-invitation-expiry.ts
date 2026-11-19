import { listOrganizationsWithInvitationsExpiredBetween } from "./billing-users.js"
import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"
import { captureException } from "./observability/runtime.js"
import { syncOrganizationBillingQuantities } from "./stripe-billing.js"

/**
 * Pending invitations stop counting as users when they expire, which happens
 * without any request. This loop finds organizations whose invitations expired
 * recently and brings their Stripe quantities down to match.
 *
 * Runs hourly and looks back a day, so a missed run or a restart still catches
 * every expiry. Re-checking an organization is cheap and safe: quantities that
 * are already right are not sent to Stripe again.
 */
const BILLING_INVITATION_EXPIRY_INTERVAL_MS = 60 * 60 * 1000
const BILLING_INVITATION_EXPIRY_LOOKBACK_MS = 26 * 60 * 60 * 1000

const logger = appLogger.child({ component: "billing_invitation_expiry" })
let running: Promise<void> | null = null

export async function syncBillingForExpiredInvitationsOnce(now = new Date()) {
  if (!env.stripe.secretKey) {
    return { organizations: 0, failures: 0 }
  }
  const organizationIds = await listOrganizationsWithInvitationsExpiredBetween({
    since: new Date(now.getTime() - BILLING_INVITATION_EXPIRY_LOOKBACK_MS),
    until: now,
  })
  let failures = 0
  for (const organizationId of organizationIds) {
    try {
      await syncOrganizationBillingQuantities({ organizationId })
    } catch (error) {
      failures += 1
      logger.warn("failed to sync billing after invitations expired", { organization_id: organizationId, error })
    }
  }
  return { organizations: organizationIds.length, failures }
}

export function startBillingInvitationExpiryLoop(intervalMs = BILLING_INVITATION_EXPIRY_INTERVAL_MS) {
  if (!env.stripe.secretKey) {
    return async () => undefined
  }

  const run = () => {
    if (running) {
      return
    }
    running = syncBillingForExpiredInvitationsOnce()
      .then(() => undefined)
      .catch((error) => {
        logger.error("billing invitation expiry sync failed", { error })
        captureException(error, { component: "billing_invitation_expiry" })
      })
      .finally(() => {
        running = null
      })
  }

  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return async () => {
    clearInterval(timer)
    await running
  }
}
