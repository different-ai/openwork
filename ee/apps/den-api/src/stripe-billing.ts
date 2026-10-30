import { recordFreeAutoPurchase } from "./free-auto-purchases.js"
import { FREE_AUTO_CONVERSION_WINDOW_DAYS } from "@openwork-ee/den-db"
import Stripe from "stripe"
import { and, eq, isNotNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  MemberTable,
  OrgSubscriptionStatus,
  OrgSubscriptionType,
  OrgSubscriptionTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { db } from "./db.js"
import { env } from "./env.js"
import { setInferenceEnabled } from "./inference.js"
import { assertOrganizationManagedModelsAllowed, updateOrganizationMetadata } from "./organization-metadata.js"
import { appLogger } from "./observability/logger.js"
import { isOpenWorkWebAvailable } from "./openwork-web-availability.js"
import { hasOpenWorkWebComplimentaryAccess, resolveOpenWorkWebAccess } from "./openwork-web-access.js"
import { parseOrganizationPlan } from "./entitlements.js"
import {
  billingNotConfiguredMessage,
  PLAN_CURRENCY,
  PLAN_INTERVAL,
  quotePlan,
  TEAM_PLAN_UNIT_AMOUNT,
  type BillingNotConfiguredProduct,
  type BillingPlans,
  type BillingPlanSummary,
  type PlanCheckoutTier,
  type SeatPlanQuote,
} from "@openwork/types/den/billing-plans"
import {
  PER_PERSON_PRICING_MODEL,
  PLAN_OPENWORK_PRODUCT,
  planTierFromSubscriptionMetadata,
  reconcileOrganizationPlan,
} from "./billing-plans.js"
import { normalizeUserCount, OPENWORK_WEB_QUANTITY_DEFINITION, type OrganizationBillingQuantities } from "./billing-quantities.js"
import { billingUserCondition, getOrganizationBillingQuantities } from "./billing-users.js"
import { getOrganizationPlanState } from "./organization-plan-state.js"
import { personAddRefusal } from "./organization-plan.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type OrgSubscriptionStatusValue = (typeof OrgSubscriptionStatus)[number]
type OrgSubscriptionTypeValue = (typeof OrgSubscriptionType)[number]

const STRIPE_API_VERSION = "2026-04-22.dahlia"
const INFERENCE_SUBSCRIPTION_TYPE = "inference" as const
const SEAT_SUBSCRIPTION_TYPE = "seat" as const
const WEB_SUBSCRIPTION_TYPE = "web" as const
/**
 * Den no longer creates Enterprise subscriptions (Enterprise is set in /admin
 * and invoiced outside OpenWork). A Stripe subscription tagged this way is
 * still stored under its own type so it is never mistaken for another
 * product, but it changes nothing.
 */
const ENTERPRISE_SUBSCRIPTION_TYPE = "enterprise" as const
export const OPENWORK_WEB_UNIT_AMOUNT = 5000
export const OPENWORK_WEB_CURRENCY = "usd" as const
export const OPENWORK_WEB_INTERVAL = "month" as const
const ACTIVE_STATUSES = new Set<OrgSubscriptionStatusValue>(["active", "trialing"])
const ONGOING_STATUSES = new Set<OrgSubscriptionStatusValue>(["active", "trialing", "incomplete", "past_due", "unpaid", "paused"])
// Stripe keeps retrying a `past_due` subscription (Smart Retries) and only
// moves it to `canceled` / `unpaid` once dunning gives up. `incomplete` is an
// initial payment still pending (e.g. 3DS). Neither is a reason to revoke
// access yet — doing so is what pushed subscribers to buy a second
// subscription while the first one was still collectable.
const RECOVERABLE_STATUSES = new Set<OrgSubscriptionStatusValue>(["past_due", "incomplete"])
const INFERENCE_DISABLING_STATUSES = new Set<OrgSubscriptionStatusValue>(["canceled", "unpaid", "incomplete_expired", "paused", "expired"])
const logger = appLogger.child({ component: "stripe_billing" })

export type StripeCheckoutSubscriptionType = typeof INFERENCE_SUBSCRIPTION_TYPE | typeof SEAT_SUBSCRIPTION_TYPE | typeof WEB_SUBSCRIPTION_TYPE

let stripeClient: Stripe | null = null

function stripe() {
  if (!env.stripe.secretKey) {
    throw new Error("stripe_secret_key_missing")
  }
  if (!stripeClient) {
    stripeClient = new Stripe(env.stripe.secretKey, {
      apiVersion: STRIPE_API_VERSION as any,
    })
  }
  return stripeClient
}

function requireInferencePriceId() {
  if (!env.stripe.inferencePriceId) {
    throw new Error("stripe_inference_price_id_missing")
  }
  return env.stripe.inferencePriceId
}

function requireSeatPriceId() {
  if (!env.stripe.seatPriceId) {
    throw new Error("stripe_seat_price_id_missing")
  }
  return env.stripe.seatPriceId
}

function requireOpenWorkWebPriceId() {
  const priceId = env.stripe.openworkWebPriceId
  if (!isOpenWorkWebAvailable() || !priceId) {
    throw new Error("stripe_openwork_web_not_available")
  }
  return priceId
}

function requirePriceIdForSubscriptionType(subscriptionType: StripeCheckoutSubscriptionType) {
  switch (subscriptionType) {
    case INFERENCE_SUBSCRIPTION_TYPE:
      return requireInferencePriceId()
    case SEAT_SUBSCRIPTION_TYPE:
      return requireSeatPriceId()
    case WEB_SUBSCRIPTION_TYPE:
      return requireOpenWorkWebPriceId()
  }
}

/**
 * The deployment does not sell this product: a configuration state the API
 * answers with 503 `billing_not_configured`, never a 500.
 */
export class BillingNotConfiguredError extends Error {
  readonly product: BillingNotConfiguredProduct

  constructor(product: BillingNotConfiguredProduct) {
    super(billingNotConfiguredMessage(product))
    this.name = "BillingNotConfiguredError"
    this.product = product
  }
}

/** Whether this deployment has the Stripe key and the price a product needs. */
export function isBillingProductConfigured(product: BillingNotConfiguredProduct) {
  if (!env.stripe.secretKey) return false
  switch (product) {
    case "inference":
      return Boolean(env.stripe.inferencePriceId)
    case "seat":
    case "team":
      return Boolean(env.stripe.seatPriceId)
    case "web":
      return Boolean(env.stripe.openworkWebPriceId)
    case "portal":
    case "checkout":
      return true
  }
}

export function assertBillingProductConfigured(product: BillingNotConfiguredProduct) {
  if (!isBillingProductConfigured(product)) throw new BillingNotConfiguredError(product)
}

/**
 * Configuration failures thrown deep in a Stripe call (a missing key or price,
 * a price that does not match its contract), mapped to the product that is not
 * sold. Anything else is not a configuration failure and stays an error.
 */
export function billingNotConfiguredProductForError(error: unknown, fallback: BillingNotConfiguredProduct): BillingNotConfiguredProduct | null {
  if (error instanceof BillingNotConfiguredError) return error.product
  if (!(error instanceof Error)) return null
  switch (error.message) {
    case "stripe_secret_key_missing":
      return fallback
    case "stripe_inference_price_id_missing":
      return "inference"
    case "stripe_seat_price_id_missing":
      return fallback === "team" ? "team" : "seat"
    case "stripe_openwork_web_not_available":
    case "stripe_openwork_web_price_contract_invalid":
      return "web"
    default:
      return null
  }
}

function fromUnixSeconds(value: number | null | undefined) {
  return typeof value === "number" ? new Date(value * 1000) : null
}

function subscriptionStatus(value: string | null | undefined): OrgSubscriptionStatusValue {
  switch (value) {
    case "incomplete":
    case "incomplete_expired":
    case "trialing":
    case "active":
    case "past_due":
    case "canceled":
    case "unpaid":
    case "paused":
      return value
    default:
      return "expired"
  }
}

// Rank used to decide which of two Stripe subscriptions of the same type may
// own an organization's single `org_subscriptions` row. Access-granting
// statuses beat recoverable ones, which beat terminal ones.
export function subscriptionPrecedence(status: string | null | undefined) {
  const normalized = subscriptionStatus(status)
  if (ACTIVE_STATUSES.has(normalized)) return 3
  if (ONGOING_STATUSES.has(normalized)) return 2
  return 1
}

// The row is unique per (organization, type). When Stripe holds two
// subscriptions of the same type for one organization — a re-purchase after a
// failed renewal, a duplicate Checkout — only a subscription that outranks the
// one the row currently tracks may take the row over. Equal rank keeps the
// tracked subscription so late or replayed webhooks for the other one cannot
// flip the row back and forth.
export function shouldReplaceTrackedSubscription(input: {
  incomingStatus: string | null | undefined
  trackedStatus: string | null | undefined
}) {
  return subscriptionPrecedence(input.incomingStatus) > subscriptionPrecedence(input.trackedStatus)
}

function customerIdFromSubscription(subscription: Stripe.Subscription) {
  return typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id
}

function firstSubscriptionItem(subscription: Stripe.Subscription) {
  return subscription.items.data[0] ?? null
}

function unixSecondsField(source: object | null, key: "current_period_start" | "current_period_end") {
  if (!source) return null
  const value: unknown = Reflect.get(source, key)
  return typeof value === "number" ? value : null
}

// Newer Stripe API versions report the billing period on the subscription
// item; older payloads still carry it on the subscription itself. Neither
// location is part of the pinned SDK types, so both are read structurally.
function subscriptionPeriod(subscription: Stripe.Subscription, item: Stripe.SubscriptionItem | null) {
  return {
    start: fromUnixSeconds(unixSecondsField(subscription, "current_period_start") ?? unixSecondsField(item, "current_period_start")),
    end: fromUnixSeconds(unixSecondsField(subscription, "current_period_end") ?? unixSecondsField(item, "current_period_end")),
  }
}

function parseSubscriptionType(value: string | null | undefined): OrgSubscriptionTypeValue | null {
  switch (value) {
    case INFERENCE_SUBSCRIPTION_TYPE:
      return INFERENCE_SUBSCRIPTION_TYPE
    case SEAT_SUBSCRIPTION_TYPE:
    case "seats":
      return SEAT_SUBSCRIPTION_TYPE
    case WEB_SUBSCRIPTION_TYPE:
    case "openwork_web":
      return WEB_SUBSCRIPTION_TYPE
    case ENTERPRISE_SUBSCRIPTION_TYPE:
    case "openwork_enterprise":
      return ENTERPRISE_SUBSCRIPTION_TYPE
    default:
      return null
  }
}

function getBillingMetadata(metadata: Stripe.Metadata | null | undefined) {
  const orgId = metadata?.org_id?.trim() ?? ""
  const orgMemberId = metadata?.created_by_org_member_id?.trim() ?? ""
  return {
    organizationId: orgId || null,
    orgMemberId: orgMemberId || null,
    subscriptionType: parseSubscriptionType(metadata?.subscription_type?.trim()),
  }
}

function getSubscriptionMetadata(subscription: Stripe.Subscription) {
  return getBillingMetadata(subscription.metadata)
}

function subscriptionTypeFromStripeSubscription(subscription: Stripe.Subscription, item: Stripe.SubscriptionItem | null) {
  const metadataType = getSubscriptionMetadata(subscription).subscriptionType
  if (metadataType) {
    return metadataType
  }

  const priceId = typeof item?.price?.id === "string" ? item.price.id : null
  if (env.stripe.seatPriceId && priceId === env.stripe.seatPriceId) {
    return SEAT_SUBSCRIPTION_TYPE
  }
  if (env.stripe.openworkWebPriceId && priceId === env.stripe.openworkWebPriceId) {
    return WEB_SUBSCRIPTION_TYPE
  }
  return INFERENCE_SUBSCRIPTION_TYPE
}

async function activeMemberCount(organizationId: OrgId) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), billingUserCondition()))
  return Math.max(0, Number(row?.count ?? 0))
}

async function joinedMemberCount(organizationId: OrgId) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, organizationId),
      isNotNull(MemberTable.joinedAt),
      billingUserCondition(),
    ))
  return normalizeUserCount(Number(row?.count ?? 0))
}

/** Counted people ("N joined, M invited"): pending invitations count toward the plan. */
export async function getOrganizationPeopleCounts(organizationId: OrgId) {
  const [people, joined] = await Promise.all([activeMemberCount(organizationId), joinedMemberCount(organizationId)])
  return { people, joined: Math.min(joined, people), invited: Math.max(0, people - joined) }
}

async function organizationOpenWorkWebComplimentaryAccess(organizationId: OrgId) {
  const rows = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  return hasOpenWorkWebComplimentaryAccess(rows[0]?.metadata)
}

export function isEligibleOpenWorkWebSubscriptionStatus(status: string | null | undefined) {
  return status === "active" || status === "trialing"
}

export function isOngoingOpenWorkWebSubscriptionStatus(status: string | null | undefined) {
  return typeof status === "string" && ONGOING_STATUSES.has(subscriptionStatus(status)) && status !== "expired"
}

export function isRecoverableSubscriptionStatus(status: string | null | undefined) {
  return RECOVERABLE_STATUSES.has(subscriptionStatus(status))
}

export function isInferenceDisablingSubscriptionStatus(status: string | null | undefined) {
  return INFERENCE_DISABLING_STATUSES.has(subscriptionStatus(status))
}

export function openWorkWebPaymentStatus(status: string | null | undefined, paymentFailed = false) {
  if (paymentFailed) {
    return "payment_failed" as const
  }
  switch (status) {
    case "active":
      return "paid" as const
    case "trialing":
      return "trialing" as const
    case "past_due":
      return "past_due" as const
    case "unpaid":
      return "unpaid" as const
    case "incomplete":
      return "incomplete" as const
    case "paused":
      return "paused" as const
    default:
      return "inactive" as const
  }
}

// Seat billing only gates member additions on hosted multi-org deployments
// where Stripe seat billing is configured. Single-org (self-hosted /
// enterprise) deployments never restrict member count, and without Stripe
// configured the 402 would be a dead end the operator cannot resolve.
export { isSeatBillingGateEnabled } from "./organization-plan.js"

async function findOrgSubscriptionByType(organizationId: OrgId, subscriptionType: OrgSubscriptionTypeValue) {
  return db
    .select()
    .from(OrgSubscriptionTable)
    .where(and(
      eq(OrgSubscriptionTable.organization_id, organizationId),
      eq(OrgSubscriptionTable.type, subscriptionType),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

async function findInferenceSubscriptionByOrg(organizationId: OrgId) {
  return findOrgSubscriptionByType(organizationId, INFERENCE_SUBSCRIPTION_TYPE)
}

async function findSeatSubscriptionByOrg(organizationId: OrgId) {
  return findOrgSubscriptionByType(organizationId, SEAT_SUBSCRIPTION_TYPE)
}

async function findWebSubscriptionByOrg(organizationId: OrgId) {
  return findOrgSubscriptionByType(organizationId, WEB_SUBSCRIPTION_TYPE)
}

async function findOrgSubscriptionByStripeId(stripeSubscriptionId: string) {
  return db
    .select()
    .from(OrgSubscriptionTable)
    .where(eq(OrgSubscriptionTable.stripe_subscription_id, stripeSubscriptionId))
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

export async function cancelOrganizationSubscriptions(input: { organizationId: OrgId }) {
  if (!env.stripe.secretKey) {
    return
  }

  const rows = await db
    .select({
      id: OrgSubscriptionTable.id,
      stripeSubscriptionId: OrgSubscriptionTable.stripe_subscription_id,
    })
    .from(OrgSubscriptionTable)
    .where(eq(OrgSubscriptionTable.organization_id, input.organizationId))

  for (const row of rows) {
    if (!row.stripeSubscriptionId) {
      continue
    }

    try {
      await stripe().subscriptions.cancel(row.stripeSubscriptionId)
    } catch (error) {
      logger.warn("failed to cancel Stripe subscription during organization deletion", {
        organization_id: input.organizationId,
        org_subscription_id: row.id,
        stripe_subscription_id: row.stripeSubscriptionId,
        error,
      })
    }
  }
}

async function findInferenceSubscriptionByStripeId(stripeSubscriptionId: string) {
  const row = await findOrgSubscriptionByStripeId(stripeSubscriptionId)
  return row?.type === INFERENCE_SUBSCRIPTION_TYPE ? row : null
}

async function findStripeCustomerIdByOrg(organizationId: string) {
  return db
    .select({ stripeCustomerId: OrgSubscriptionTable.stripe_customer_id })
    .from(OrgSubscriptionTable)
    .where(eq(OrgSubscriptionTable.organization_id, organizationId as OrgId))
    .limit(1)
    .then((rows) => rows[0]?.stripeCustomerId ?? null)
}

function stripeSearchLiteral(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

async function findStripeCustomerIdByOrgMetadata(organizationId: string) {
  try {
    const customers = await stripe().customers.search({
      query: `metadata['org_id']:'${stripeSearchLiteral(organizationId)}'`,
      limit: 1,
    })
    return customers.data[0]?.id ?? null
  } catch (error) {
    logger.warn("failed to search Stripe customers by org metadata", { organization_id: organizationId, error })
    return null
  }
}

async function stripeCustomerBelongsToOrganization(customerId: string, organizationId: string) {
  try {
    const customer = await stripe().customers.retrieve(customerId)
    return !customer.deleted && customer.metadata.org_id?.trim() === organizationId
  } catch (error) {
    logger.warn("failed to verify Stripe customer organization metadata", {
      organization_id: organizationId,
      stripe_customer_id: customerId,
      error,
    })
    return false
  }
}

export async function organizationHasActiveInferenceSubscription(organizationId: OrgId) {
  const row = await findInferenceSubscriptionByOrg(organizationId)
  return Boolean(row && ACTIVE_STATUSES.has(row.status))
}

/** A payment problem with an existing subscription should lead to billing, not an upgrade offer. */
export async function organizationHasOngoingInferenceSubscription(organizationId: OrgId) {
  const row = await findInferenceSubscriptionByOrg(organizationId)
  return Boolean(row && ONGOING_STATUSES.has(row.status))
}

export async function organizationHasActiveSeatSubscription(organizationId: OrgId) {
  const row = await findSeatSubscriptionByOrg(organizationId)
  return Boolean(row && ACTIVE_STATUSES.has(row.status))
}

/**
 * Keeps the organization's plan in step with its Team plan (seat)
 * subscription: paying makes it Team (at any size), and ending it returns a
 * plan Stripe set to Free. Admin-set and grandfathered plans are left alone.
 */
async function syncOrganizationPlanFromSubscriptions(organizationId: OrgId, seatSubscription?: Stripe.Subscription) {
  const seatRow = await findSeatSubscriptionByOrg(organizationId)
  const seatTier = seatSubscription ? planTierFromSubscriptionMetadata(seatSubscription.metadata) : "team"
  await updateOrganizationMetadata(organizationId, (current) => {
    const next = reconcileOrganizationPlan({
      current: parseOrganizationPlan(current),
      status: seatRow?.status ?? "canceled",
      tier: seatTier,
      legacyWithoutCharge: Boolean(seatRow && seatRow.quantity < 1),
    })
    if (!next) return current
    return { ...current, plan: next }
  })
}

function isPlanSubscriptionType(type: OrgSubscriptionTypeValue) {
  return type === SEAT_SUBSCRIPTION_TYPE
}

function isEligibleOpenWorkWebSubscriptionRow(row: Awaited<ReturnType<typeof findWebSubscriptionByOrg>>) {
  return Boolean(
    row
    && isEligibleOpenWorkWebSubscriptionStatus(row.status)
    && env.stripe.openworkWebPriceId
    && row.stripe_price_id === env.stripe.openworkWebPriceId
    && row.payment_failed !== true,
  )
}

function isOngoingConfiguredOpenWorkWebSubscriptionRow(row: Awaited<ReturnType<typeof findWebSubscriptionByOrg>>) {
  return Boolean(
    row
    && isOngoingOpenWorkWebSubscriptionStatus(row.status)
    && env.stripe.openworkWebPriceId
    && row.stripe_price_id === env.stripe.openworkWebPriceId,
  )
}

export async function organizationHasEligibleOpenWorkWebSubscription(organizationId: OrgId) {
  return isEligibleOpenWorkWebSubscriptionRow(await findWebSubscriptionByOrg(organizationId))
}

export async function organizationHasOngoingOpenWorkWebSubscription(organizationId: OrgId) {
  let row = await findWebSubscriptionByOrg(organizationId)
  if (row?.stripe_subscription_id) {
    row = await refreshOrgSubscriptionFromStripe(row.stripe_subscription_id)
  }
  return Boolean(row && isOngoingOpenWorkWebSubscriptionStatus(row.status))
}

/**
 * Whether one more person may join the organization, by any path: an email
 * invitation, SSO sign-up, a verified-domain join or SCIM. One rule for all of
 * them (organization-plan.ts). `reason` tells a refusal on Free (offer the
 * Team plan) from a full plan a platform admin set (ask for more seats).
 */
export async function getOrganizationSeatAddEligibility(organizationId: OrgId) {
  const [plan, { seats }, hasActiveSeatSubscription] = await Promise.all([
    getOrganizationPlanState(organizationId),
    getOrganizationBillingQuantities(organizationId),
    organizationHasActiveSeatSubscription(organizationId),
  ])
  if (!plan) throw new Error("organization_not_found")
  const refusal = personAddRefusal(plan)
  return {
    allowed: refusal === null,
    reason: refusal,
    plan,
    currentCount: plan.users,
    freeSeatCount: seats.free,
    billableSeatCount: seats.chargeable,
    hasActiveSeatSubscription,
  }
}

export async function upsertOrgSubscriptionFromStripe(subscription: Stripe.Subscription, eventId?: string | null) {
  const item = firstSubscriptionItem(subscription)
  const metadata = getSubscriptionMetadata(subscription)
  if (!metadata.organizationId) {
    return null
  }

  const organizationId = metadata.organizationId as OrgId
  const status = subscriptionStatus(subscription.status)
  const subscriptionType = subscriptionTypeFromStripeSubscription(subscription, item)
  const existingSubscription = await findOrgSubscriptionByType(organizationId, subscriptionType)
  const sameSubscription = existingSubscription?.stripe_subscription_id === subscription.id

  if (existingSubscription && !sameSubscription) {
    // The organization already tracks a different Stripe subscription of this
    // type. Compare against Stripe's current view of that subscription rather
    // than the stored status, which may lag behind its own webhooks.
    const trackedStatus = await currentStripeSubscriptionStatus(existingSubscription.stripe_subscription_id)
      ?? existingSubscription.status
    if (!shouldReplaceTrackedSubscription({ incomingStatus: status, trackedStatus })) {
      logger.warn("ignoring Stripe subscription that does not outrank the organization's tracked subscription", {
        organization_id: organizationId,
        subscription_type: subscriptionType,
        tracked_stripe_subscription_id: existingSubscription.stripe_subscription_id,
        tracked_status: trackedStatus,
        incoming_stripe_subscription_id: subscription.id,
        incoming_status: status,
        event_id: eventId ?? null,
      })
      return existingSubscription
    }
    logger.info("replacing the organization's tracked Stripe subscription", {
      organization_id: organizationId,
      subscription_type: subscriptionType,
      previous_stripe_subscription_id: existingSubscription.stripe_subscription_id,
      previous_status: trackedStatus,
      stripe_subscription_id: subscription.id,
      status,
      event_id: eventId ?? null,
    })
  }

  const existingWebSubscription = subscriptionType === WEB_SUBSCRIPTION_TYPE ? existingSubscription : null
  const sameWebSubscription = subscriptionType === WEB_SUBSCRIPTION_TYPE && sameSubscription
  // An active Stripe subscription is not proof that its latest payment was
  // collected (notably for asynchronous payment methods). New or replacement
  // active Web subscriptions therefore fail closed until Checkout or an
  // invoice event positively confirms payment. Trialing subscriptions remain
  // eligible because Stripe does not require an initial payment for a trial.
  const paymentFailed = subscriptionType === WEB_SUBSCRIPTION_TYPE
    ? sameWebSubscription
      ? existingWebSubscription?.payment_failed ?? status === "active"
      : status === "active"
    : false
  const quantity = item?.quantity ?? 0
  const priceId = typeof item?.price?.id === "string" ? item.price.id : null
  const period = subscriptionPeriod(subscription, item)
  const now = new Date()
  const values = {
    id: createDenTypeId("orgSubscription"),
    organization_id: organizationId,
    created_by_org_membership_id: metadata.orgMemberId as MemberId | null,
    type: subscriptionType,
    status,
    stripe_customer_id: customerIdFromSubscription(subscription),
    stripe_subscription_id: subscription.id,
    stripe_price_id: priceId,
    stripe_subscription_item_id: item?.id ?? null,
    quantity,
    current_period_start: period.start,
    current_period_end: period.end,
    cancel_at_period_end: subscription.cancel_at_period_end,
    payment_failed: paymentFailed,
    canceled_at: fromUnixSeconds(subscription.canceled_at),
    ended_at: fromUnixSeconds(subscription.ended_at),
    last_event_id: eventId ?? null,
    created_at: now,
    updated_at: now,
  }

  await db.insert(OrgSubscriptionTable).values(values).onDuplicateKeyUpdate({
    set: {
      created_by_org_membership_id: values.created_by_org_membership_id,
      status: values.status,
      stripe_customer_id: values.stripe_customer_id,
      stripe_subscription_id: values.stripe_subscription_id,
      stripe_price_id: values.stripe_price_id,
      stripe_subscription_item_id: values.stripe_subscription_item_id,
      quantity: values.quantity,
      current_period_start: values.current_period_start,
      current_period_end: values.current_period_end,
      cancel_at_period_end: values.cancel_at_period_end,
      ...(subscriptionType !== WEB_SUBSCRIPTION_TYPE || !sameWebSubscription
        ? { payment_failed: values.payment_failed }
        : {}),
      canceled_at: values.canceled_at,
      ended_at: values.ended_at,
      last_event_id: values.last_event_id,
      updated_at: now,
    },
  })

  if (subscriptionType === INFERENCE_SUBSCRIPTION_TYPE) {
    if (INFERENCE_DISABLING_STATUSES.has(status)) {
      await setInferenceEnabled({ organizationId, enabled: false })
    } else if (
      ACTIVE_STATUSES.has(status)
      && existingSubscription
      && !ACTIVE_STATUSES.has(existingSubscription.status)
    ) {
      // A recovered renewal (Stripe retry succeeded, card updated in the
      // portal) or a replacement subscription taking over the row: restore
      // the access the earlier failure removed. Brand-new rows are activated
      // by the Checkout handlers once payment is confirmed.
      await activatePurchasedInference(organizationId)
    }
  }
  if (isPlanSubscriptionType(subscriptionType)) {
    await syncOrganizationPlanFromSubscriptions(organizationId, subscriptionType === SEAT_SUBSCRIPTION_TYPE ? subscription : undefined)
  }

  return findOrgSubscriptionByStripeId(subscription.id)
}

async function currentStripeSubscriptionStatus(stripeSubscriptionId: string) {
  try {
    const subscription = await stripe().subscriptions.retrieve(stripeSubscriptionId)
    return subscriptionStatus(subscription.status)
  } catch (error) {
    logger.warn("failed to retrieve the tracked Stripe subscription; falling back to the stored status", {
      stripe_subscription_id: stripeSubscriptionId,
      error,
    })
    return null
  }
}

export async function upsertInferenceSubscriptionFromStripe(subscription: Stripe.Subscription, eventId?: string | null) {
  return upsertOrgSubscriptionFromStripe(subscription, eventId)
}

export async function refreshOrgSubscriptionFromStripe(stripeSubscriptionId: string) {
  if (!env.stripe.secretKey) {
    return findOrgSubscriptionByStripeId(stripeSubscriptionId)
  }

  const existing = await findOrgSubscriptionByStripeId(stripeSubscriptionId)
  const subscription = await stripe().subscriptions.retrieve(stripeSubscriptionId)
  const item = firstSubscriptionItem(subscription)
  const status = subscriptionStatus(subscription.status)
  const quantity = item?.quantity ?? 0
  const priceId = typeof item?.price?.id === "string" ? item.price.id : null
  const paymentFailed = existing?.type === WEB_SUBSCRIPTION_TYPE
    ? existing.payment_failed
    : false
  const period = subscriptionPeriod(subscription, item)

  await db
    .update(OrgSubscriptionTable)
    .set({
      status,
      stripe_customer_id: customerIdFromSubscription(subscription),
      stripe_price_id: priceId,
      stripe_subscription_item_id: item?.id ?? null,
      quantity,
      current_period_start: period.start,
      current_period_end: period.end,
      cancel_at_period_end: subscription.cancel_at_period_end,
      ...(existing?.type !== WEB_SUBSCRIPTION_TYPE ? { payment_failed: paymentFailed } : {}),
      canceled_at: fromUnixSeconds(subscription.canceled_at),
      ended_at: fromUnixSeconds(subscription.ended_at),
      updated_at: new Date(),
    })
    .where(eq(OrgSubscriptionTable.stripe_subscription_id, subscription.id))

  const row = await findOrgSubscriptionByStripeId(subscription.id)
  if (row && isPlanSubscriptionType(row.type)) {
    await syncOrganizationPlanFromSubscriptions(row.organization_id)
  }
  return row
}

export async function findOrCreateStripeCustomer(input: {
  email: string
  name: string
  organizationId?: string | null
  metadata?: Stripe.MetadataParam
  existingCustomerId?: string | null
}) {
  const existingCustomerId = input.existingCustomerId?.trim()
  if (existingCustomerId) {
    const organizationId = input.organizationId?.trim()
    if (!organizationId || await stripeCustomerBelongsToOrganization(existingCustomerId, organizationId)) {
      return existingCustomerId
    }
  }

  const organizationId = input.organizationId?.trim()
  if (organizationId) {
    const dbCustomerId = await findStripeCustomerIdByOrg(organizationId)
    if (dbCustomerId && await stripeCustomerBelongsToOrganization(dbCustomerId, organizationId)) {
      return dbCustomerId
    }

    const stripeCustomerId = await findStripeCustomerIdByOrgMetadata(organizationId)
    if (stripeCustomerId && await stripeCustomerBelongsToOrganization(stripeCustomerId, organizationId)) {
      return stripeCustomerId
    }

    const email = input.email.trim()
    if (!email) {
      throw new Error("stripe_customer_email_missing")
    }

    const customer = await stripe().customers.create({
      email,
      name: input.name,
      metadata: {
        ...input.metadata,
        org_id: organizationId,
      },
    }, {
      idempotencyKey: `openwork-org-customer:${organizationId}`,
    })
    return customer.id
  }

  const email = input.email.trim()
  if (!email) {
    throw new Error("stripe_customer_email_missing")
  }

  const existing = await stripe().customers.list({ email, limit: 1 })
  if (existing.data[0]) {
    return existing.data[0].id
  }

  const customer = await stripe().customers.create({
    email,
    name: input.name,
    metadata: input.metadata,
  })
  return customer.id
}

export function openWorkWebCheckoutIdempotencyKey(input: {
  organizationId: string
  quantity: number
  previousSessionId?: string | null
}) {
  return `openwork-web-checkout:${input.organizationId}:${input.quantity}:${input.previousSessionId ?? "initial"}`
}

function subscriptionHasConfiguredOpenWorkWebPrice(subscription: Stripe.Subscription) {
  const item = firstSubscriptionItem(subscription)
  return Boolean(
    env.stripe.openworkWebPriceId
    && typeof item?.price?.id === "string"
    && item.price.id === env.stripe.openworkWebPriceId,
  )
}

async function validateOpenWorkWebPrice(priceId: string) {
  const price = await stripe().prices.retrieve(priceId)
  if (
    !price.active
    || price.type !== "recurring"
    || price.billing_scheme !== "per_unit"
    || price.transform_quantity !== null
    || price.unit_amount !== OPENWORK_WEB_UNIT_AMOUNT
    || price.currency.toLowerCase() !== OPENWORK_WEB_CURRENCY
    || price.recurring?.interval !== OPENWORK_WEB_INTERVAL
    || price.recurring.interval_count !== 1
    || price.recurring.usage_type !== "licensed"
  ) {
    throw new Error("stripe_openwork_web_price_contract_invalid")
  }
}

function checkoutSessionMatchesOpenWorkWeb(input: {
  session: Stripe.Checkout.Session
  organizationId: string
}) {
  const metadata = getBillingMetadata(input.session.metadata)
  return input.session.mode === "subscription"
    && input.session.client_reference_id === input.organizationId
    && metadata.organizationId === input.organizationId
    && metadata.subscriptionType === WEB_SUBSCRIPTION_TYPE
}

async function createOpenWorkWebCheckoutSession(input: {
  organizationId: OrgId
  orgMemberId: MemberId
  email: string
  name: string
  priceId: string
  metadata: Stripe.MetadataParam
  successUrl: string
  cancelUrl: string
}) {
  await validateOpenWorkWebPrice(input.priceId)
  const quantity = (await getOrganizationBillingQuantities(input.organizationId)).web.quantity
  if (quantity < 1) {
    throw new Error("stripe_openwork_web_quantity_empty")
  }

  const storedWebSubscription = await findWebSubscriptionByOrg(input.organizationId)
  if (storedWebSubscription?.stripe_subscription_id) {
    const refreshedWebSubscription = await refreshOrgSubscriptionFromStripe(storedWebSubscription.stripe_subscription_id)
    if (isOngoingConfiguredOpenWorkWebSubscriptionRow(refreshedWebSubscription)) {
      throw new Error("stripe_openwork_web_subscription_exists")
    }
  }

  const customer = await findOrCreateStripeCustomer({
    organizationId: input.organizationId,
    email: input.email,
    name: input.name,
    metadata: {
      org_id: input.organizationId,
      created_by_org_member_id: input.orgMemberId,
      openwork_product: "openwork_web",
    },
  })

  const subscriptions = await stripe().subscriptions.list({
    customer,
    status: "all",
    limit: 100,
  })
  const existingOngoingSubscription = subscriptions.data.find((subscription) => {
    const metadata = getSubscriptionMetadata(subscription)
    return metadata.organizationId === input.organizationId
      && metadata.subscriptionType === WEB_SUBSCRIPTION_TYPE
      && isOngoingOpenWorkWebSubscriptionStatus(subscription.status)
      && subscriptionHasConfiguredOpenWorkWebPrice(subscription)
  })
  if (existingOngoingSubscription) {
    await upsertOrgSubscriptionFromStripe(existingOngoingSubscription)
    throw new Error("stripe_openwork_web_subscription_exists")
  }

  const checkoutSessions = await stripe().checkout.sessions.list({
    customer,
    limit: 100,
  })
  const latestMatchingSession = checkoutSessions.data.find((session) => checkoutSessionMatchesOpenWorkWeb({
    session,
    organizationId: input.organizationId,
  }))

  if (latestMatchingSession?.status === "open" && latestMatchingSession.url) {
    const lineItems = await stripe().checkout.sessions.listLineItems(latestMatchingSession.id, { limit: 1 })
    const lineItem = lineItems.data[0]
    const lineItemPriceId = typeof lineItem?.price?.id === "string" ? lineItem.price.id : null
    if (lineItemPriceId === input.priceId && lineItem?.quantity === quantity) {
      return latestMatchingSession
    }

    await stripe().checkout.sessions.expire(latestMatchingSession.id).catch((error) => {
      logger.warn("failed to expire stale OpenWork Web Checkout session", {
        organization_id: input.organizationId,
        stripe_checkout_session_id: latestMatchingSession.id,
        error,
      })
    })
  }

  return stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    allow_promotion_codes: true,
    line_items: [{ price: input.priceId, quantity }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.organizationId,
    metadata: input.metadata,
    subscription_data: {
      metadata: input.metadata,
    },
  }, {
    idempotencyKey: openWorkWebCheckoutIdempotencyKey({
      organizationId: input.organizationId,
      quantity,
      previousSessionId: latestMatchingSession?.id,
    }),
  })
}

async function findOngoingStripeSubscription(input: {
  customer: string
  organizationId: OrgId
  subscriptionType: OrgSubscriptionTypeValue
}) {
  const subscriptions = await stripe().subscriptions.list({
    customer: input.customer,
    status: "all",
    limit: 100,
  })
  return subscriptions.data.find((subscription) => {
    const metadata = getSubscriptionMetadata(subscription)
    return metadata.organizationId === input.organizationId
      && subscriptionTypeFromStripeSubscription(subscription, firstSubscriptionItem(subscription)) === input.subscriptionType
      && ONGOING_STATUSES.has(subscriptionStatus(subscription.status))
  }) ?? null
}

export async function createOrgSubscriptionCheckoutSession(input: {
  subscriptionType: StripeCheckoutSubscriptionType
  organizationId: OrgId
  orgMemberId: MemberId
  email: string
  name: string
  successUrl: string
  cancelUrl: string
}) {
  if (input.subscriptionType === INFERENCE_SUBSCRIPTION_TYPE) {
    await assertOrganizationManagedModelsAllowed(input.organizationId)
  }
  const priceId = requirePriceIdForSubscriptionType(input.subscriptionType)
  const openworkProduct = input.subscriptionType === SEAT_SUBSCRIPTION_TYPE
    ? "openwork_seats"
    : input.subscriptionType === WEB_SUBSCRIPTION_TYPE
      ? "openwork_web"
      : "openwork_models"
  const metadata = {
    org_id: input.organizationId,
    created_by_org_member_id: input.orgMemberId,
    openwork_product: openworkProduct,
    subscription_type: input.subscriptionType,
  }
  if (input.subscriptionType === WEB_SUBSCRIPTION_TYPE) {
    return createOpenWorkWebCheckoutSession({
      organizationId: input.organizationId,
      orgMemberId: input.orgMemberId,
      email: input.email,
      name: input.name,
      priceId,
      metadata,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    })
  }

  const customer = await findOrCreateStripeCustomer({
    organizationId: input.organizationId,
    email: input.email,
    name: input.name,
    metadata: {
      org_id: input.organizationId,
      created_by_org_member_id: input.orgMemberId,
      openwork_product: openworkProduct,
    },
  })

  if (input.subscriptionType === SEAT_SUBSCRIPTION_TYPE) {
    return stripe().checkout.sessions.create({
      mode: "setup",
      customer,
      currency: "usd",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.organizationId,
      metadata,
      setup_intent_data: { metadata },
    })
  }

  const existingOngoingInference = await findOngoingStripeSubscription({
    customer,
    organizationId: input.organizationId,
    subscriptionType: INFERENCE_SUBSCRIPTION_TYPE,
  })
  if (existingOngoingInference) {
    if (INFERENCE_DISABLING_STATUSES.has(subscriptionStatus(existingOngoingInference.status))) {
      // `unpaid` / `paused`: dunning already gave up and access is already
      // revoked, so the customer is here to pay again. Sending them to the
      // portal would soft-lock them; leaving the old subscription in place
      // would keep generating uncollectible invoices next to the new one.
      // Retire it and let Checkout create a clean replacement.
      await stripe().subscriptions.cancel(existingOngoingInference.id, {
        prorate: false,
        invoice_now: false,
        cancellation_details: { comment: "Superseded by a new OpenWork Models checkout after collection stopped." },
      })
      logger.info("canceled a stopped inference subscription ahead of a replacement checkout", {
        organization_id: input.organizationId,
        stripe_subscription_id: existingOngoingInference.id,
        status: existingOngoingInference.status,
      })
    } else {
      // Active, trialing, past due or incomplete: Stripe is still collecting
      // on it. A second Checkout would bill the customer twice; the caller
      // sends them to the billing portal to fix the payment method instead.
      await upsertOrgSubscriptionFromStripe(existingOngoingInference)
      throw new Error("stripe_inference_subscription_exists")
    }
  }

  const quantity = (await getOrganizationBillingQuantities(input.organizationId)).models.quantity
  await assertOrganizationManagedModelsAllowed(input.organizationId)
  return stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    allow_promotion_codes: true,
    line_items: [{ price: priceId, quantity }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.organizationId,
    metadata,
    subscription_data: {
      metadata,
    },
  })
}

function planSubscriptionMetadata(input: { organizationId: OrgId; orgMemberId: MemberId; plan: PlanCheckoutTier }) {
  return {
    org_id: input.organizationId,
    created_by_org_member_id: input.orgMemberId,
    openwork_product: PLAN_OPENWORK_PRODUCT,
    subscription_type: SEAT_SUBSCRIPTION_TYPE,
    plan_tier: input.plan,
    pricing_model: PER_PERSON_PRICING_MODEL,
  }
}

export type PlanCheckoutResult = { kind: "checkout"; url: string }

/** Team already paid for, or a Team payment Stripe is still collecting. */
export class PlanSubscriptionExistsError extends Error {
  readonly reason: "same_plan" | "payment_pending"

  constructor(reason: "same_plan" | "payment_pending") {
    super("stripe_plan_subscription_exists")
    this.name = "PlanSubscriptionExistsError"
    this.reason = reason
  }
}

/**
 * An organization has one plan subscription. When one already exists, record
 * its latest state and refuse a second checkout: Team is already paid for, or
 * Stripe is still collecting its payment.
 */
async function refuseSecondPlanSubscription(stripeSubscriptionId: string): Promise<never> {
  const subscription = await stripe().subscriptions.retrieve(stripeSubscriptionId)
  await upsertOrgSubscriptionFromStripe(subscription)
  throw new PlanSubscriptionExistsError(ACTIVE_STATUSES.has(subscriptionStatus(subscription.status)) ? "same_plan" : "payment_pending")
}

/**
 * Starts paying for Team per person: a subscription Checkout for every counted
 * person (joined and invited) plus `addPeople`. It becomes the organization's
 * single seat subscription, and paying sets the plan to Team.
 */
export async function createPlanCheckout(input: {
  organizationId: OrgId
  orgMemberId: MemberId
  email: string
  name: string
  plan: PlanCheckoutTier
  addPeople: number
  successUrl: string
  cancelUrl: string
}): Promise<PlanCheckoutResult> {
  assertBillingProductConfigured(input.plan)
  const priceId = requireSeatPriceId()
  const metadata = planSubscriptionMetadata(input)

  const tracked = await findSeatSubscriptionByOrg(input.organizationId)
  if (tracked?.stripe_subscription_id && ONGOING_STATUSES.has(tracked.status)) {
    return refuseSecondPlanSubscription(tracked.stripe_subscription_id)
  }

  const customer = await findOrCreateStripeCustomer({
    organizationId: input.organizationId,
    email: input.email,
    name: input.name,
    metadata: {
      org_id: input.organizationId,
      created_by_org_member_id: input.orgMemberId,
      openwork_product: PLAN_OPENWORK_PRODUCT,
    },
  })

  // Stripe may hold a plan subscription our row has not seen yet (a webhook
  // still in flight); never start a second one next to it.
  const untracked = await findOngoingStripeSubscription({
    customer,
    organizationId: input.organizationId,
    subscriptionType: SEAT_SUBSCRIPTION_TYPE,
  })
  if (untracked) {
    return refuseSecondPlanSubscription(untracked.id)
  }

  const quantity = quotePlan({ plan: input.plan, people: await activeMemberCount(input.organizationId), addPeople: input.addPeople }).people
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    allow_promotion_codes: true,
    line_items: [{ price: priceId, quantity }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.organizationId,
    metadata,
    subscription_data: { metadata },
  })
  if (!session.url) {
    throw new Error("stripe_checkout_url_missing")
  }
  return { kind: "checkout", url: session.url }
}

export async function createInferenceCheckoutSession(input: Omit<Parameters<typeof createOrgSubscriptionCheckoutSession>[0], "subscriptionType">) {
  return createOrgSubscriptionCheckoutSession({ ...input, subscriptionType: INFERENCE_SUBSCRIPTION_TYPE })
}

export async function createSeatCheckoutSession(input: Omit<Parameters<typeof createOrgSubscriptionCheckoutSession>[0], "subscriptionType">) {
  return createOrgSubscriptionCheckoutSession({ ...input, subscriptionType: SEAT_SUBSCRIPTION_TYPE })
}

export async function createOpenWorkWebCheckout(input: Omit<Parameters<typeof createOrgSubscriptionCheckoutSession>[0], "subscriptionType">) {
  return createOrgSubscriptionCheckoutSession({ ...input, subscriptionType: WEB_SUBSCRIPTION_TYPE })
}

export async function createStripePortalSession(input: { organizationId: OrgId; returnUrl: string }) {
  const storedCustomerId = await findStripeCustomerIdByOrg(input.organizationId)
  const stripeCustomerId = storedCustomerId && await stripeCustomerBelongsToOrganization(storedCustomerId, input.organizationId)
    ? storedCustomerId
    : await findStripeCustomerIdByOrgMetadata(input.organizationId)
  if (!stripeCustomerId) {
    throw new Error("stripe_customer_missing")
  }
  return stripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: input.returnUrl,
  })
}

export async function createInferencePortalSession(input: { organizationId: OrgId; returnUrl: string }) {
  return createStripePortalSession(input)
}

function serializeSubscription(row: Awaited<ReturnType<typeof findOrgSubscriptionByStripeId>>) {
  return row ? {
    id: row.id,
    status: row.status,
    paymentStatus: openWorkWebPaymentStatus(row.status, row.payment_failed),
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripePriceId: row.stripe_price_id,
    quantity: row.quantity,
    currentPeriodStart: row.current_period_start?.toISOString() ?? null,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    canceledAt: row.canceled_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
  } : null
}

function serializeOpenWorkWebSubscription(row: Awaited<ReturnType<typeof findWebSubscriptionByOrg>>) {
  return row ? {
    status: row.status,
    paymentStatus: openWorkWebPaymentStatus(row.status, row.payment_failed),
    quantity: row.quantity,
    currentPeriodStart: row.current_period_start?.toISOString() ?? null,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    canceledAt: row.canceled_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
  } : null
}

async function loadOpenWorkWebBillingSummary(organizationId: OrgId, loadedQuantities?: OrganizationBillingQuantities) {
  const [row, quantities, complimentaryAccess] = await Promise.all([
    findWebSubscriptionByOrg(organizationId),
    loadedQuantities ?? getOrganizationBillingQuantities(organizationId),
    organizationOpenWorkWebComplimentaryAccess(organizationId),
  ])
  const quantity = quantities.web.quantity
  const hasEligibleSubscription = isEligibleOpenWorkWebSubscriptionRow(row)
  const access = resolveOpenWorkWebAccess({
    deploymentAvailable: isOpenWorkWebAvailable(),
    hasEligibleSubscription,
    complimentaryAccess,
  })
  return {
    row,
    summary: {
      configured: isOpenWorkWebAvailable()
        && Boolean(env.stripe.secretKey && env.stripe.openworkWebPriceId),
      unitAmount: OPENWORK_WEB_UNIT_AMOUNT,
      currency: OPENWORK_WEB_CURRENCY,
      interval: OPENWORK_WEB_INTERVAL,
      quantityDefinition: OPENWORK_WEB_QUANTITY_DEFINITION,
      quantityDescription: "Every organization member and every pending invitation that has not expired.",
      quantity,
      expectedMonthlyTotal: quantity * OPENWORK_WEB_UNIT_AMOUNT,
      hasEligibleSubscription,
      ...access,
      subscription: serializeOpenWorkWebSubscription(row),
    },
  }
}

export async function getOpenWorkWebAccess(organizationId: OrgId) {
  const [row, complimentaryAccess] = await Promise.all([
    findWebSubscriptionByOrg(organizationId),
    organizationOpenWorkWebComplimentaryAccess(organizationId),
  ])
  return resolveOpenWorkWebAccess({
    deploymentAvailable: isOpenWorkWebAvailable(),
    hasEligibleSubscription: isEligibleOpenWorkWebSubscriptionRow(row),
    complimentaryAccess,
  })
}

export async function getOpenWorkWebBillingSummary(organizationId: OrgId) {
  return (await loadOpenWorkWebBillingSummary(organizationId)).summary
}

/** Plans an organization may buy by card: Team, wherever the deployment sells it. Enterprise is set in /admin. */
export function billingPlanOffers(): BillingPlans {
  return {
    team: {
      available: isBillingProductConfigured("team"),
      unitAmount: TEAM_PLAN_UNIT_AMOUNT,
      currency: PLAN_CURRENCY,
      interval: PLAN_INTERVAL,
    },
  }
}

/**
 * The Team quote attached to a seat 402: the workspace after this invitation,
 * every person at the Team price ("6 people x $10 = $60/month").
 */
export async function getSeatPlanQuote(input: { organizationId: OrgId; currentCount: number }): Promise<SeatPlanQuote> {
  const counts = await getOrganizationPeopleCounts(input.organizationId)
  const quote = quotePlan({ plan: "team", people: input.currentCount, addPeople: 1 })
  return {
    plan: "team",
    people: quote.people,
    joined: counts.joined,
    invited: counts.invited,
    unitAmount: quote.unitAmount,
    monthlyTotal: quote.monthlyTotal,
    currency: PLAN_CURRENCY,
    interval: PLAN_INTERVAL,
    available: isBillingProductConfigured("team"),
  }
}

export async function getOrgBillingSummary(input: {
  organizationId: OrgId
  includePortalUrl?: boolean
  returnUrl: string
}) {
  const quantities = await getOrganizationBillingQuantities(input.organizationId)
  const [row, seatRow, webBillingState] = await Promise.all([
    findInferenceSubscriptionByOrg(input.organizationId),
    findSeatSubscriptionByOrg(input.organizationId),
    loadOpenWorkWebBillingSummary(input.organizationId, quantities),
  ])
  const webRow = webBillingState.row
  const seatCounts = quantities.seats
  const [peopleCounts, organizationPlan] = await Promise.all([
    getOrganizationPeopleCounts(input.organizationId),
    getOrganizationPlanState(input.organizationId),
  ])
  const plan: BillingPlanSummary = {
    tier: organizationPlan?.tier ?? "free",
    source: organizationPlan?.source ?? "default",
    people: peopleCounts.people,
    joined: peopleCounts.joined,
    invited: peopleCounts.invited,
    freeSeatCount: seatCounts.free,
    userLimit: organizationPlan?.userLimit ?? null,
    endsAt: organizationPlan?.endsAt ?? null,
  }
  const hasActiveSubscription = Boolean(row && ACTIVE_STATUSES.has(row.status))
  const hasActiveSeatSubscription = Boolean(seatRow && ACTIVE_STATUSES.has(seatRow.status))
  const hasEligibleWebSubscription = isEligibleOpenWorkWebSubscriptionRow(webRow)
  let portalUrl: string | null = null
  if (input.includePortalUrl && (row?.stripe_customer_id || seatRow?.stripe_customer_id || webRow?.stripe_customer_id)) {
    try {
      portalUrl = (await createInferencePortalSession({ organizationId: input.organizationId, returnUrl: input.returnUrl })).url
    } catch (error) {
      logger.warn("failed to create billing portal session", { organization_id: input.organizationId, error })
    }
  }

  return {
    stripe: {
      configured: Boolean(env.stripe.secretKey && env.stripe.inferencePriceId),
      priceId: env.stripe.inferencePriceId ?? null,
      unitAmount: 1000,
      currency: "usd",
      interval: "month",
      memberCount: quantities.models.users,
      hasActiveSubscription,
      portalUrl,
      subscription: serializeSubscription(row),
      seats: {
        configured: Boolean(env.stripe.secretKey && env.stripe.seatPriceId),
        priceId: env.stripe.seatPriceId ?? null,
        unitAmount: 1000,
        currency: "usd",
        interval: "month",
        freeSeatCount: quantities.seats.free,
        seatsFreeAdditional: quantities.seats.additionalFree,
        billableSeatCount: quantities.seats.chargeable,
        hasActiveSubscription: hasActiveSeatSubscription,
        subscription: serializeSubscription(seatRow),
      },
      web: {
        ...webBillingState.summary,
        priceId: env.stripe.openworkWebPriceId ?? null,
        hasEligibleSubscription: hasEligibleWebSubscription,
        portalUrl,
        subscription: serializeSubscription(webRow),
      },
    },
    plan,
    plans: billingPlanOffers(),
  }
}

type BillingSubscriptionRow = NonNullable<Awaited<ReturnType<typeof findOrgSubscriptionByType>>>

function stripeQuantityForSubscription(row: BillingSubscriptionRow, quantities: OrganizationBillingQuantities) {
  switch (row.type) {
    case SEAT_SUBSCRIPTION_TYPE:
      return quantities.seats.chargeable
    case WEB_SUBSCRIPTION_TYPE:
      return quantities.web.quantity
    case INFERENCE_SUBSCRIPTION_TYPE:
      return quantities.models.quantity
    default:
      return null
  }
}

/**
 * Only subscriptions Stripe is billing normally (active or trialing) follow
 * the user count. OpenWork Web also requires its configured price and no
 * failed payment, the same rule that grants access to it.
 */
function subscriptionFollowsUserCount(row: BillingSubscriptionRow | null): row is BillingSubscriptionRow {
  if (!row || !row.stripe_subscription_item_id) return false
  if (row.type === WEB_SUBSCRIPTION_TYPE) return isEligibleOpenWorkWebSubscriptionRow(row)
  return ACTIVE_STATUSES.has(row.status)
}

async function syncSubscriptionQuantity(row: BillingSubscriptionRow | null, quantities: OrganizationBillingQuantities) {
  if (!subscriptionFollowsUserCount(row) || !row.stripe_subscription_item_id) {
    return
  }
  const quantity = stripeQuantityForSubscription(row, quantities)
  // Stripe rejects quantity 0 on the per-user OpenWork Web price.
  if (quantity === null || (row.type === WEB_SUBSCRIPTION_TYPE && quantity < 1)) {
    return
  }
  // Already right: skip, so the subscription.updated webhook this update
  // causes does not trigger another update.
  if (row.quantity === quantity) {
    return
  }
  await stripe().subscriptionItems.update(row.stripe_subscription_item_id, {
    quantity,
    // Accrue prorations onto the next monthly invoice instead of charging
    // (and invoicing) every quantity change immediately. Customers get one
    // consolidated invoice per cycle; add/remove churn nets out.
    proration_behavior: "create_prorations",
  })
  // Show the quantity Stripe accepted immediately, before its webhook arrives.
  await db
    .update(OrgSubscriptionTable)
    .set({ quantity, updated_at: new Date() })
    .where(eq(OrgSubscriptionTable.id, row.id))
}

/**
 * Brings every active subscription's Stripe quantity in line with the
 * organization's current users: Team seats, OpenWork Models and
 * OpenWork Web.
 * Call after a member or pending invitation is added or removed, or after the
 * free seat count changes.
 */
export async function syncOrganizationBillingQuantities(input: { organizationId: OrgId }) {
  if (!env.stripe.secretKey) {
    return
  }
  const [quantities, seatRow, inferenceRow, webRow] = await Promise.all([
    getOrganizationBillingQuantities(input.organizationId),
    findSeatSubscriptionByOrg(input.organizationId),
    findInferenceSubscriptionByOrg(input.organizationId),
    findWebSubscriptionByOrg(input.organizationId),
  ])
  for (const row of [seatRow, inferenceRow, webRow]) {
    await syncSubscriptionQuantity(row, quantities)
  }
}

async function syncOpenWorkWebQuantity(organizationId: OrgId) {
  if (!env.stripe.secretKey) {
    return
  }
  const [quantities, row] = await Promise.all([
    getOrganizationBillingQuantities(organizationId),
    findWebSubscriptionByOrg(organizationId),
  ])
  await syncSubscriptionQuantity(row, quantities)
}

async function createSeatSubscriptionFromSetupCheckoutSession(session: Stripe.Checkout.Session, eventId: string) {
  if (typeof session.setup_intent !== "string" || typeof session.customer !== "string") {
    return null
  }

  const metadata = getBillingMetadata(session.metadata)
  if (metadata.subscriptionType !== SEAT_SUBSCRIPTION_TYPE || !metadata.organizationId) {
    return null
  }

  const existingSeatSubscription = await findSeatSubscriptionByOrg(metadata.organizationId as OrgId)
  if (existingSeatSubscription && ACTIVE_STATUSES.has(existingSeatSubscription.status)) {
    return existingSeatSubscription
  }

  const setupIntent = await stripe().setupIntents.retrieve(session.setup_intent)
  const paymentMethod = typeof setupIntent.payment_method === "string"
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id ?? null

  if (!paymentMethod) {
    throw new Error("stripe_setup_payment_method_missing")
  }

  const subscription = await stripe().subscriptions.create(
    {
      customer: session.customer,
      default_payment_method: paymentMethod,
      // Created at 0 so the idempotent request is identical on every retry
      // (webhook and checkout sync both land here); the real quantity is set
      // right after.
      items: [{ price: requireSeatPriceId(), quantity: 0 }],
      metadata: {
        org_id: metadata.organizationId,
        created_by_org_member_id: metadata.orgMemberId ?? "",
        openwork_product: "openwork_seats",
        subscription_type: SEAT_SUBSCRIPTION_TYPE,
      },
    },
    { idempotencyKey: `openwork-seat-subscription-${session.id}` },
  )

  const row = await upsertOrgSubscriptionFromStripe(subscription, eventId)
  // An organization that is already past its free seats owes for them from
  // the start, not only after the next member change.
  await syncSubscriptionQuantity(row, await getOrganizationBillingQuantities(metadata.organizationId as OrgId))
  return row
}

export async function syncSeatCheckoutSession(input: { organizationId: OrgId; sessionId: string }) {
  const session = await stripe().checkout.sessions.retrieve(input.sessionId)
  const metadata = getBillingMetadata(session.metadata)
  if (metadata.subscriptionType !== SEAT_SUBSCRIPTION_TYPE) {
    return null
  }
  if (metadata.organizationId !== input.organizationId) {
    throw new Error("stripe_checkout_session_org_mismatch")
  }
  if (session.status !== "complete") {
    return null
  }
  return createSeatSubscriptionFromSetupCheckoutSession(session, `checkout-session-sync:${session.id}`)
}

export async function syncStripeCheckoutSession(input: { organizationId: OrgId; sessionId: string }) {
  const session = await stripe().checkout.sessions.retrieve(input.sessionId)
  const metadata = getBillingMetadata(session.metadata)
  if (metadata.organizationId !== input.organizationId) {
    throw new Error("stripe_checkout_session_org_mismatch")
  }
  if (session.status !== "complete") {
    return null
  }
  if (session.mode === "setup") {
    return createSeatSubscriptionFromSetupCheckoutSession(session, `checkout-session-sync:${session.id}`)
  }
  if (typeof session.subscription !== "string") {
    return null
  }

  const subscription = await stripe().subscriptions.retrieve(session.subscription)
  const subscriptionMetadata = getSubscriptionMetadata(subscription)
  if (subscriptionMetadata.organizationId !== input.organizationId) {
    throw new Error("stripe_checkout_session_org_mismatch")
  }
  const eventId = `checkout-session-sync:${session.id}`
  let row = await syncCurrentStripeSubscription(subscription.id, eventId)
  if (row?.type === WEB_SUBSCRIPTION_TYPE) {
    row = await syncOpenWorkWebPaymentStateFromCurrentInvoice({
      row,
      stripeSubscriptionId: subscription.id,
      eventId,
    })
  }
  if (row?.type === INFERENCE_SUBSCRIPTION_TYPE && ACTIVE_STATUSES.has(subscriptionStatus(subscription.status))) {
    await activatePurchasedInference(row.organization_id)
  }
  if (session.payment_status === "paid" && (session.amount_total ?? 0) > 0) {
    await recordFreeAutoPurchase({ subscription, row, paidAt: new Date() })
  }
  return row
}

async function activatePurchasedInference(organizationId: OrgId) {
  try {
    await setInferenceEnabled({ organizationId, enabled: true })
  } catch (error) {
    // Keep the purchase history, but acknowledge a deliberate policy denial.
    // Unavailable policy must still fail safely so a later delivery can retry.
    if (error instanceof ManagedModelsPolicyError && error.code === "managed_models_disabled_for_dpa") return
    throw error
  }
}

async function syncCurrentStripeSubscription(stripeSubscriptionId: string, eventId: string) {
  const subscription = await stripe().subscriptions.retrieve(stripeSubscriptionId)
  const item = firstSubscriptionItem(subscription)
  const metadata = getSubscriptionMetadata(subscription)
  const subscriptionType = subscriptionTypeFromStripeSubscription(subscription, item)

  if (subscriptionType === WEB_SUBSCRIPTION_TYPE && metadata.organizationId) {
    const existing = await findWebSubscriptionByOrg(metadata.organizationId as OrgId)
    if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== subscription.id) {
      const refreshedExisting = await refreshOrgSubscriptionFromStripe(existing.stripe_subscription_id)
      if (isOngoingConfiguredOpenWorkWebSubscriptionRow(refreshedExisting)) {
        return refreshedExisting
      }
    }
  }

  return upsertOrgSubscriptionFromStripe(subscription, eventId)
}

async function syncOpenWorkWebPaymentStateFromCurrentInvoice(input: {
  row: Awaited<ReturnType<typeof findOrgSubscriptionByStripeId>>
  stripeSubscriptionId: string
  eventId: string
}) {
  if (
    !input.row
    || input.row.type !== WEB_SUBSCRIPTION_TYPE
    || input.row.stripe_subscription_id !== input.stripeSubscriptionId
  ) {
    return input.row
  }

  const subscription = await stripe().subscriptions.retrieve(input.stripeSubscriptionId)
  if (subscription.id !== input.stripeSubscriptionId) {
    return input.row
  }

  const latestInvoiceId = stripeResourceId(subscription.latest_invoice)
  if (!latestInvoiceId) {
    return input.row
  }

  const currentInvoice = await stripe().invoices.retrieve(latestInvoiceId)
  if (currentInvoice.id !== latestInvoiceId) {
    return input.row
  }

  const paymentFailed = currentInvoice.status !== "paid"
  await db
    .update(OrgSubscriptionTable)
    .set({ payment_failed: paymentFailed, last_event_id: input.eventId, updated_at: new Date() })
    .where(eq(OrgSubscriptionTable.id, input.row.id))

  return { ...input.row, payment_failed: paymentFailed }
}

function stripeResourceId(resource: string | { id: string } | null | undefined) {
  return typeof resource === "string" ? resource : resource?.id ?? null
}

async function expireNonWebSubscriptionAfterPaymentFailure(
  row: NonNullable<Awaited<ReturnType<typeof findOrgSubscriptionByStripeId>>>,
  eventId: string,
) {
  await db
    .update(OrgSubscriptionTable)
    .set({ status: "expired", last_event_id: eventId, updated_at: new Date() })
    .where(eq(OrgSubscriptionTable.id, row.id))
  if (row.type === INFERENCE_SUBSCRIPTION_TYPE) {
    await setInferenceEnabled({ organizationId: row.organization_id, enabled: false })
  }
  if (isPlanSubscriptionType(row.type)) {
    await syncOrganizationPlanFromSubscriptions(row.organization_id)
  }
}

/** Analytics failures never fail invoice settlement or cause another billing mutation. */
async function recordPaidInvoiceConversion(subscription: Stripe.Subscription, row: typeof OrgSubscriptionTable.$inferSelect | null, invoiceId: string) {
  // A subscription started before the attribution window can never convert; skip the extra Stripe read for renewals.
  if (Date.now() - subscription.created * 1000 > FREE_AUTO_CONVERSION_WINDOW_DAYS * 86_400_000) return
  try {
    const invoice = await stripe().invoices.retrieve(invoiceId)
    if (invoice.status === "paid" && invoice.amount_paid > 0
      && stripeResourceId(invoice.parent?.subscription_details?.subscription) === subscription.id) {
      await recordFreeAutoPurchase({ subscription, row, paidAt: fromUnixSeconds(invoice.status_transitions.paid_at) ?? new Date() })
    }
  } catch { logger.warn("Free Auto paid invoice behavior could not be recorded.") }
}

async function syncPaymentStateFromInvoiceEvent(input: {
  invoice: Stripe.Invoice
  eventType: "invoice.paid" | "invoice.payment_failed"
  eventId: string
}) {
  const subscriptionId = stripeResourceId(input.invoice.parent?.subscription_details?.subscription)
  if (!subscriptionId) {
    return null
  }

  const subscription = await stripe().subscriptions.retrieve(subscriptionId)
  const subscriptionType = subscriptionTypeFromStripeSubscription(subscription, firstSubscriptionItem(subscription))
  if (subscriptionType !== WEB_SUBSCRIPTION_TYPE) {
    // A failed renewal leaves the subscription `past_due` while Stripe keeps
    // retrying; syncing records that status without revoking access. Access
    // is only revoked once Stripe itself gives up (`canceled` / `unpaid`),
    // which the same sync applies when that status arrives. The returned row
    // may also track a different subscription of the same type (a replacement
    // the customer already paid for), so nothing here may expire it on behalf
    // of the subscription this invoice belongs to.
    const row = await syncCurrentStripeSubscription(subscription.id, input.eventId)
    if (input.eventType === "invoice.paid") {
      await recordPaidInvoiceConversion(subscription, row, input.invoice.id)
    }
    return row
  }

  const latestInvoiceId = stripeResourceId(subscription.latest_invoice)
  if (!latestInvoiceId || latestInvoiceId !== input.invoice.id) {
    return null
  }

  const currentInvoice = await stripe().invoices.retrieve(latestInvoiceId)
  if (currentInvoice.id !== latestInvoiceId) {
    return null
  }

  const paymentFailed = currentInvoice.status === "paid"
    ? false
    : input.eventType === "invoice.payment_failed"
      ? true
      : null
  if (paymentFailed === null) {
    return null
  }

  const row = await syncCurrentStripeSubscription(subscription.id, input.eventId)
  if (!row || row.type !== WEB_SUBSCRIPTION_TYPE || row.stripe_subscription_id !== subscription.id) {
    return null
  }

  await db
    .update(OrgSubscriptionTable)
    .set({ payment_failed: paymentFailed, last_event_id: input.eventId, updated_at: new Date() })
    .where(eq(OrgSubscriptionTable.id, row.id))

  if (currentInvoice.status === "paid" && currentInvoice.amount_paid > 0) {
    await recordFreeAutoPurchase({ subscription, row, paidAt: fromUnixSeconds(currentInvoice.status_transitions.paid_at) ?? new Date() })
  }
  return { ...row, payment_failed: paymentFailed }
}

/**
 * Audit attribution hook for a verified Stripe event. "before": our stored
 * subscription row already maps the event to an organization and nothing has
 * been applied yet (false aborts with StripeWebhookAuditBlockedError). "after":
 * the event created the mapping (first checkout), so it is known only now.
 */
export type StripeWebhookOrganizationHook = (organizationId: OrgId, phase: "before" | "after") => Promise<boolean>

export class StripeWebhookAuditBlockedError extends Error {
  constructor() {
    super("stripe_webhook_audit_unavailable")
    this.name = "StripeWebhookAuditBlockedError"
  }
}

function stripeEventSubscriptionId(event: Stripe.Event): string | null {
  switch (event.type) {
    case "checkout.session.async_payment_failed":
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return stripeResourceId(event.data.object.subscription)
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return event.data.object.id
    case "invoice.paid":
    case "invoice.payment_failed":
      return stripeResourceId(event.data.object.parent?.subscription_details?.subscription)
    default:
      return null
  }
}

/** The organization our stored subscription rows map a verified event to (never event metadata alone). */
async function stripeEventOrganizationId(event: Stripe.Event): Promise<OrgId | null> {
  const subscriptionId = stripeEventSubscriptionId(event)
  if (subscriptionId) {
    const row = await findOrgSubscriptionByStripeId(subscriptionId)
    if (row) return row.organization_id
  }
  if ((event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") && event.data.object.mode === "setup") {
    const metadata = getBillingMetadata(event.data.object.metadata)
    let metadataOrganizationId: OrgId | null = null
    try { metadataOrganizationId = metadata.organizationId ? normalizeDenTypeId("organization", metadata.organizationId) : null } catch { metadataOrganizationId = null }
    if (metadata.subscriptionType === SEAT_SUBSCRIPTION_TYPE && metadataOrganizationId) {
      const row = await findSeatSubscriptionByOrg(metadataOrganizationId)
      if (row && typeof event.data.object.customer === "string" && row.stripe_customer_id === event.data.object.customer) return row.organization_id
    }
  }
  return null
}

export async function handleStripeWebhook(input: { payload: string; signature: string | null }, options: { onOrganization?: StripeWebhookOrganizationHook } = {}) {
  if (!env.stripe.webhookSecret) {
    throw new Error("stripe_webhook_secret_missing")
  }
  if (!input.signature) {
    throw new Error("stripe_signature_missing")
  }

  const event = stripe().webhooks.constructEvent(input.payload, input.signature, env.stripe.webhookSecret)
  let attributed = false
  if (options.onOrganization) {
    const organizationId = await stripeEventOrganizationId(event)
    if (organizationId) {
      if (!(await options.onOrganization(organizationId, "before"))) throw new StripeWebhookAuditBlockedError()
      attributed = true
    }
  }
  await applyStripeWebhookEvent(event)
  if (options.onOrganization && !attributed) {
    const organizationId = await stripeEventOrganizationId(event)
    if (organizationId) await options.onOrganization(organizationId, "after")
  }
  return { received: true, type: event.type }
}

async function applyStripeWebhookEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session
      if (typeof session.subscription === "string") {
        const subscription = await stripe().subscriptions.retrieve(session.subscription)
        let row = await syncCurrentStripeSubscription(subscription.id, event.id)
        if (row?.type === WEB_SUBSCRIPTION_TYPE) {
          row = await syncOpenWorkWebPaymentStateFromCurrentInvoice({
            row,
            stripeSubscriptionId: subscription.id,
            eventId: event.id,
          })
        } else if (row && row.stripe_subscription_id === subscription.id) {
          // The initial payment for this subscription never completed, so
          // there is nothing for Stripe to retry. Only the row tracking this
          // subscription is expired; a row tracking another subscription of
          // the same type keeps whatever access that one grants.
          await expireNonWebSubscriptionAfterPaymentFailure(row, event.id)
        }
      }
      break
    }
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.mode === "setup") {
        await createSeatSubscriptionFromSetupCheckoutSession(session, event.id)
      } else if (typeof session.subscription === "string") {
        const subscription = await stripe().subscriptions.retrieve(session.subscription)
        let row = await syncCurrentStripeSubscription(subscription.id, event.id)
        if (row?.type === WEB_SUBSCRIPTION_TYPE) {
          row = await syncOpenWorkWebPaymentStateFromCurrentInvoice({
            row,
            stripeSubscriptionId: subscription.id,
            eventId: event.id,
          })
        }
        if (row?.type === INFERENCE_SUBSCRIPTION_TYPE && ACTIVE_STATUSES.has(subscriptionStatus(subscription.status))) {
          await activatePurchasedInference(row.organization_id)
        }
        if (session.payment_status === "paid" && (session.amount_total ?? 0) > 0) {
          await recordFreeAutoPurchase({ subscription, row, paidAt: new Date(event.created * 1000) })
        }
        if (row?.type === WEB_SUBSCRIPTION_TYPE && isEligibleOpenWorkWebSubscriptionStatus(subscription.status)) {
          await syncOpenWorkWebQuantity(row.organization_id)
        }
      }
      break
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const row = await syncCurrentStripeSubscription((event.data.object as Stripe.Subscription).id, event.id)
      if (row?.type === WEB_SUBSCRIPTION_TYPE && isEligibleOpenWorkWebSubscriptionStatus(row.status)) {
        await syncOpenWorkWebQuantity(row.organization_id)
      }
      break
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const row = await syncPaymentStateFromInvoiceEvent({
        invoice: event.data.object as Stripe.Invoice,
        eventType: event.type,
        eventId: event.id,
      })
      if (row && isEligibleOpenWorkWebSubscriptionRow(row)) {
        await syncOpenWorkWebQuantity(row.organization_id)
      }
      break
    }
  }
}
