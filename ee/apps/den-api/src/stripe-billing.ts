import Stripe from "stripe"
import { and, eq, isNotNull, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  MemberTable,
  OrgSubscriptionStatus,
  OrgSubscriptionType,
  OrgSubscriptionTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"
import type { DenOrgMode } from "./env.js"
import { setInferenceEnabled } from "./inference.js"
import { appLogger } from "./observability/logger.js"
import { isOpenWorkWebAvailable } from "./openwork-web-availability.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type OrgSubscriptionStatusValue = (typeof OrgSubscriptionStatus)[number]
type OrgSubscriptionTypeValue = (typeof OrgSubscriptionType)[number]

const STRIPE_API_VERSION = "2026-04-22.dahlia"
const INFERENCE_SUBSCRIPTION_TYPE = "inference" as const
const SEAT_SUBSCRIPTION_TYPE = "seat" as const
const WEB_SUBSCRIPTION_TYPE = "web" as const
export const FREE_ORG_SEAT_COUNT = 5
export const OPENWORK_WEB_UNIT_AMOUNT = 5000
export const OPENWORK_WEB_CURRENCY = "usd" as const
export const OPENWORK_WEB_INTERVAL = "month" as const
export const OPENWORK_WEB_QUANTITY_DEFINITION = "joined_non_removed_members" as const
const ACTIVE_STATUSES = new Set<OrgSubscriptionStatusValue>(["active", "trialing"])
const ONGOING_STATUSES = new Set<OrgSubscriptionStatusValue>(["active", "trialing", "incomplete", "past_due", "unpaid", "paused"])
const EXPIRED_STATUSES = new Set<OrgSubscriptionStatusValue>(["past_due", "canceled", "unpaid", "incomplete_expired", "expired"])
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

function customerIdFromSubscription(subscription: Stripe.Subscription) {
  return typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id
}

function firstSubscriptionItem(subscription: Stripe.Subscription) {
  return subscription.items.data[0] ?? null
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
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
  return Math.max(0, Number(row?.count ?? 0))
}

async function joinedMemberCount(organizationId: OrgId) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, organizationId),
      isNotNull(MemberTable.joinedAt),
      isNull(MemberTable.removedAt),
    ))
  return normalizeSeatCount(Number(row?.count ?? 0))
}

export function isOpenWorkWebBillableMember(input: { joinedAt: Date | null; removedAt: Date | null }) {
  return input.joinedAt !== null && input.removedAt === null
}

export function calculateOpenWorkWebBilling(input: { joinedMemberCount: number }) {
  const quantity = normalizeSeatCount(input.joinedMemberCount)
  return {
    quantity,
    unitAmount: OPENWORK_WEB_UNIT_AMOUNT,
    expectedMonthlyTotal: quantity * OPENWORK_WEB_UNIT_AMOUNT,
  }
}

export function isEligibleOpenWorkWebSubscriptionStatus(status: string | null | undefined) {
  return status === "active" || status === "trialing"
}

export function isOngoingOpenWorkWebSubscriptionStatus(status: string | null | undefined) {
  return typeof status === "string" && ONGOING_STATUSES.has(subscriptionStatus(status)) && status !== "expired"
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

function normalizeSeatCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function normalizeAdditionalFreeSeats(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0
}

export function additionalFreeSeatCountFromMetadata(metadata: Record<string, unknown> | null | undefined) {
  return normalizeAdditionalFreeSeats(metadata?.seatsFreeAdditional)
}

// Seat billing only gates member additions on hosted multi-org deployments
// where Stripe seat billing is configured. Single-org (self-hosted /
// enterprise) deployments never restrict member count, and without Stripe
// configured the 402 would be a dead end the operator cannot resolve.
export function isSeatBillingGateEnabled(input: {
  orgMode: DenOrgMode
  stripeSecretKey: string | undefined
  stripeSeatPriceId: string | undefined
}) {
  return input.orgMode === "multi_org" && Boolean(input.stripeSecretKey && input.stripeSeatPriceId)
}

export function calculateOrganizationSeatBillingCounts(input: {
  memberCount: number
  metadata?: Record<string, unknown> | null
  additionalFreeSeats?: number
}) {
  const total = normalizeSeatCount(input.memberCount)
  const additionalFree = input.additionalFreeSeats === undefined
    ? additionalFreeSeatCountFromMetadata(input.metadata)
    : normalizeAdditionalFreeSeats(input.additionalFreeSeats)
  const free = FREE_ORG_SEAT_COUNT + additionalFree
  const chargeable = Math.max(0, total - free)

  return {
    total,
    chargeable,
    free,
    includedFree: FREE_ORG_SEAT_COUNT,
    additionalFree,
  }
}

export async function getOrganizationSeatBillingCounts(input: { organizationId: OrgId; memberCount?: number }) {
  const memberCountPromise = typeof input.memberCount === "number"
    ? Promise.resolve(input.memberCount)
    : activeMemberCount(input.organizationId)
  const metadataPromise = db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.organizationId))
    .limit(1)

  const [memberCount, rows] = await Promise.all([memberCountPromise, metadataPromise])
  return calculateOrganizationSeatBillingCounts({ memberCount, metadata: rows[0]?.metadata })
}

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

export async function organizationHasActiveSeatSubscription(organizationId: OrgId) {
  const row = await findSeatSubscriptionByOrg(organizationId)
  return Boolean(row && ACTIVE_STATUSES.has(row.status))
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

export async function getOrganizationSeatAddEligibility(organizationId: OrgId) {
  const seatCounts = await getOrganizationSeatBillingCounts({ organizationId })
  const gateEnabled = isSeatBillingGateEnabled({
    orgMode: env.orgMode,
    stripeSecretKey: env.stripe.secretKey,
    stripeSeatPriceId: env.stripe.seatPriceId,
  })
  if (!gateEnabled || seatCounts.total < seatCounts.free) {
    return {
      allowed: true,
      currentCount: seatCounts.total,
      freeSeatCount: seatCounts.free,
      billableSeatCount: seatCounts.chargeable,
      hasActiveSeatSubscription: false,
    }
  }

  const hasActiveSeatSubscription = await organizationHasActiveSeatSubscription(organizationId)
  return {
    allowed: hasActiveSeatSubscription,
    currentCount: seatCounts.total,
    freeSeatCount: seatCounts.free,
    billableSeatCount: seatCounts.chargeable,
    hasActiveSeatSubscription,
  }
}

export async function upsertOrgSubscriptionFromStripe(subscription: Stripe.Subscription, eventId?: string | null) {
  const item = firstSubscriptionItem(subscription)
  const metadata = getSubscriptionMetadata(subscription)
  if (!metadata.organizationId) {
    return null
  }

  const status = subscriptionStatus(subscription.status)
  const subscriptionType = subscriptionTypeFromStripeSubscription(subscription, item)
  const existingWebSubscription = subscriptionType === WEB_SUBSCRIPTION_TYPE
    ? await findWebSubscriptionByOrg(metadata.organizationId as OrgId)
    : null
  const sameWebSubscription = existingWebSubscription?.stripe_subscription_id === subscription.id
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
  const now = new Date()
  const values = {
    id: createDenTypeId("orgSubscription"),
    organization_id: metadata.organizationId as OrgId,
    created_by_org_membership_id: metadata.orgMemberId as MemberId | null,
    type: subscriptionType,
    status,
    stripe_customer_id: customerIdFromSubscription(subscription),
    stripe_subscription_id: subscription.id,
    stripe_price_id: priceId,
    stripe_subscription_item_id: item?.id ?? null,
    quantity,
    current_period_start: fromUnixSeconds((subscription as Stripe.Subscription & { current_period_start?: number }).current_period_start),
    current_period_end: fromUnixSeconds((subscription as Stripe.Subscription & { current_period_end?: number }).current_period_end),
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

  if (subscriptionType === INFERENCE_SUBSCRIPTION_TYPE && EXPIRED_STATUSES.has(status)) {
    await setInferenceEnabled({ organizationId: metadata.organizationId as OrgId, enabled: false })
  }

  return findOrgSubscriptionByStripeId(subscription.id)
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

  await db
    .update(OrgSubscriptionTable)
    .set({
      status,
      stripe_customer_id: customerIdFromSubscription(subscription),
      stripe_price_id: priceId,
      stripe_subscription_item_id: item?.id ?? null,
      quantity,
      current_period_start: fromUnixSeconds((subscription as Stripe.Subscription & { current_period_start?: number }).current_period_start),
      current_period_end: fromUnixSeconds((subscription as Stripe.Subscription & { current_period_end?: number }).current_period_end),
      cancel_at_period_end: subscription.cancel_at_period_end,
      ...(existing?.type !== WEB_SUBSCRIPTION_TYPE ? { payment_failed: paymentFailed } : {}),
      canceled_at: fromUnixSeconds(subscription.canceled_at),
      ended_at: fromUnixSeconds(subscription.ended_at),
      updated_at: new Date(),
    })
    .where(eq(OrgSubscriptionTable.stripe_subscription_id, subscription.id))

  return findOrgSubscriptionByStripeId(subscription.id)
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
  const quantity = await joinedMemberCount(input.organizationId)
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

export async function createOrgSubscriptionCheckoutSession(input: {
  subscriptionType: StripeCheckoutSubscriptionType
  organizationId: OrgId
  orgMemberId: MemberId
  email: string
  name: string
  successUrl: string
  cancelUrl: string
}) {
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

  const quantity = Math.max(1, await activeMemberCount(input.organizationId))
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

async function loadOpenWorkWebBillingSummary(organizationId: OrgId) {
  const row = await findWebSubscriptionByOrg(organizationId)
  const billing = calculateOpenWorkWebBilling({ joinedMemberCount: await joinedMemberCount(organizationId) })
  return {
    row,
    summary: {
      configured: isOpenWorkWebAvailable()
        && Boolean(env.stripe.secretKey && env.stripe.openworkWebPriceId),
      unitAmount: OPENWORK_WEB_UNIT_AMOUNT,
      currency: OPENWORK_WEB_CURRENCY,
      interval: OPENWORK_WEB_INTERVAL,
      quantityDefinition: OPENWORK_WEB_QUANTITY_DEFINITION,
      quantityDescription: "Every joined, non-removed organization member; pending invitations are excluded.",
      quantity: billing.quantity,
      expectedMonthlyTotal: billing.expectedMonthlyTotal,
      hasEligibleSubscription: isEligibleOpenWorkWebSubscriptionRow(row),
      subscription: serializeOpenWorkWebSubscription(row),
    },
  }
}

export async function getOpenWorkWebBillingSummary(organizationId: OrgId) {
  return (await loadOpenWorkWebBillingSummary(organizationId)).summary
}

export async function getOrgBillingSummary(input: { organizationId: OrgId; includePortalUrl?: boolean; returnUrl: string }) {
  const row = await findInferenceSubscriptionByOrg(input.organizationId)
  const seatRow = await findSeatSubscriptionByOrg(input.organizationId)
  const webBillingState = await loadOpenWorkWebBillingSummary(input.organizationId)
  const webRow = webBillingState.row
  const seatCounts = await getOrganizationSeatBillingCounts({ organizationId: input.organizationId })
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
      memberCount: seatCounts.total,
      hasActiveSubscription,
      portalUrl,
      subscription: serializeSubscription(row),
      seats: {
        configured: Boolean(env.stripe.secretKey && env.stripe.seatPriceId),
        priceId: env.stripe.seatPriceId ?? null,
        unitAmount: 1000,
        currency: "usd",
        interval: "month",
        freeSeatCount: seatCounts.free,
        seatsFreeAdditional: seatCounts.additionalFree,
        billableSeatCount: seatCounts.chargeable,
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
  }
}

export async function syncInferenceSubscriptionQuantityAfterMemberChange(input: { organizationId: OrgId; memberCount: number }) {
  if (!env.stripe.secretKey) {
    return
  }

  const row = await findInferenceSubscriptionByOrg(input.organizationId)
  if (!row || !ACTIVE_STATUSES.has(row.status) || !row.stripe_subscription_item_id) {
    return
  }

  const quantity = Math.max(1, input.memberCount)
  await stripe().subscriptionItems.update(row.stripe_subscription_item_id, {
    quantity,
    // Accrue prorations onto the next monthly invoice instead of charging
    // (and invoicing) every quantity change immediately. Customers get one
    // consolidated invoice per cycle; add/remove churn nets out.
    proration_behavior: "create_prorations",
  })
}

export async function syncSeatSubscriptionQuantityAfterMemberChange(input: { organizationId: OrgId; memberCount: number }) {
  if (!env.stripe.secretKey) {
    return
  }

  const row = await findSeatSubscriptionByOrg(input.organizationId)
  if (!row || !ACTIVE_STATUSES.has(row.status) || !row.stripe_subscription_item_id) {
    return
  }

  const seatCounts = await getOrganizationSeatBillingCounts(input)
  await stripe().subscriptionItems.update(row.stripe_subscription_item_id, {
    quantity: seatCounts.chargeable,
    // See syncInferenceSubscriptionQuantityAfterMemberChange: one invoice per
    // cycle instead of a card charge per seat change.
    proration_behavior: "create_prorations",
  })
}

export async function syncWebSubscriptionQuantityAfterMemberChange(input: { organizationId: OrgId; memberCount: number }) {
  if (!env.stripe.secretKey) {
    return
  }

  const row = await findWebSubscriptionByOrg(input.organizationId)
  if (!isEligibleOpenWorkWebSubscriptionRow(row) || !row?.stripe_subscription_item_id) {
    return
  }

  const quantity = await joinedMemberCount(input.organizationId)
  if (quantity < 1 || row.quantity === quantity) {
    return
  }

  await stripe().subscriptionItems.update(row.stripe_subscription_item_id, {
    quantity,
    proration_behavior: "create_prorations",
  })
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

  return upsertOrgSubscriptionFromStripe(subscription, eventId)
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
    await setInferenceEnabled({ organizationId: row.organization_id, enabled: true })
  }
  return row
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

  const existingRow = await findOrgSubscriptionByStripeId(subscriptionId)
  if (input.eventType === "invoice.payment_failed" && existingRow && existingRow.type !== WEB_SUBSCRIPTION_TYPE) {
    await expireNonWebSubscriptionAfterPaymentFailure(existingRow, input.eventId)
    return null
  }

  const subscription = await stripe().subscriptions.retrieve(subscriptionId)
  const subscriptionType = subscriptionTypeFromStripeSubscription(subscription, firstSubscriptionItem(subscription))
  if (subscriptionType !== WEB_SUBSCRIPTION_TYPE) {
    const row = await syncCurrentStripeSubscription(subscription.id, input.eventId)
    if (input.eventType === "invoice.payment_failed" && row) {
      await expireNonWebSubscriptionAfterPaymentFailure(row, input.eventId)
      return null
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

  return { ...row, payment_failed: paymentFailed }
}

export async function handleStripeWebhook(input: { payload: string; signature: string | null }) {
  if (!env.stripe.webhookSecret) {
    throw new Error("stripe_webhook_secret_missing")
  }
  if (!input.signature) {
    throw new Error("stripe_signature_missing")
  }

  const event = stripe().webhooks.constructEvent(input.payload, input.signature, env.stripe.webhookSecret)
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
        } else if (row) {
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
          await setInferenceEnabled({ organizationId: row.organization_id, enabled: true })
        }
        if (row?.type === WEB_SUBSCRIPTION_TYPE && isEligibleOpenWorkWebSubscriptionStatus(subscription.status)) {
          await syncWebSubscriptionQuantityAfterMemberChange({
            organizationId: row.organization_id,
            memberCount: row.quantity,
          })
        }
      }
      break
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const row = await syncCurrentStripeSubscription((event.data.object as Stripe.Subscription).id, event.id)
      if (row?.type === WEB_SUBSCRIPTION_TYPE && isEligibleOpenWorkWebSubscriptionStatus(row.status)) {
        await syncWebSubscriptionQuantityAfterMemberChange({
          organizationId: row.organization_id,
          memberCount: row.quantity,
        })
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
        await syncWebSubscriptionQuantityAfterMemberChange({
          organizationId: row.organization_id,
          memberCount: row.quantity,
        })
      }
      break
    }
  }

  return { received: true, type: event.type }
}
