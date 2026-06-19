import Stripe from "stripe"
import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
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
import { setInferenceEnabled } from "./inference.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type OrgSubscriptionStatusValue = (typeof OrgSubscriptionStatus)[number]
type OrgSubscriptionTypeValue = (typeof OrgSubscriptionType)[number]

const STRIPE_API_VERSION = "2026-04-22.dahlia"
const INFERENCE_SUBSCRIPTION_TYPE = "inference" as const
const SEAT_SUBSCRIPTION_TYPE = "seat" as const
export const FREE_ORG_SEAT_COUNT = 5
const ACTIVE_STATUSES = new Set<OrgSubscriptionStatusValue>(["active", "trialing"])
const EXPIRED_STATUSES = new Set<OrgSubscriptionStatusValue>(["past_due", "canceled", "unpaid", "incomplete_expired", "expired"])

export type StripeCheckoutSubscriptionType = typeof INFERENCE_SUBSCRIPTION_TYPE | typeof SEAT_SUBSCRIPTION_TYPE

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

function requirePriceIdForSubscriptionType(subscriptionType: StripeCheckoutSubscriptionType) {
  return subscriptionType === INFERENCE_SUBSCRIPTION_TYPE
    ? requireInferencePriceId()
    : requireSeatPriceId()
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

  return INFERENCE_SUBSCRIPTION_TYPE
}

async function activeMemberCount(organizationId: OrgId) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
  return Math.max(0, Number(row?.count ?? 0))
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

async function findOrgSubscriptionByStripeId(stripeSubscriptionId: string) {
  return db
    .select()
    .from(OrgSubscriptionTable)
    .where(eq(OrgSubscriptionTable.stripe_subscription_id, stripeSubscriptionId))
    .limit(1)
    .then((rows) => rows[0] ?? null)
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
    console.warn("[stripe-billing] failed to search customers by org metadata", error)
    return null
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

export async function getOrganizationSeatAddEligibility(organizationId: OrgId) {
  const seatCounts = await getOrganizationSeatBillingCounts({ organizationId })
  if (seatCounts.total < seatCounts.free) {
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

  const subscription = await stripe().subscriptions.retrieve(stripeSubscriptionId)
  const item = firstSubscriptionItem(subscription)
  const status = subscriptionStatus(subscription.status)
  const quantity = item?.quantity ?? 0
  const priceId = typeof item?.price?.id === "string" ? item.price.id : null

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
    return existingCustomerId
  }

  const organizationId = input.organizationId?.trim()
  if (organizationId) {
    const dbCustomerId = await findStripeCustomerIdByOrg(organizationId)
    if (dbCustomerId) {
      return dbCustomerId
    }

    const stripeCustomerId = await findStripeCustomerIdByOrgMetadata(organizationId)
    if (stripeCustomerId) {
      return stripeCustomerId
    }
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
  const openworkProduct = input.subscriptionType === SEAT_SUBSCRIPTION_TYPE ? "openwork_seats" : "openwork_models"
  const metadata = {
    org_id: input.organizationId,
    created_by_org_member_id: input.orgMemberId,
    openwork_product: openworkProduct,
    subscription_type: input.subscriptionType,
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

export async function createStripePortalSession(input: { organizationId: OrgId; returnUrl: string }) {
  const stripeCustomerId = await findStripeCustomerIdByOrg(input.organizationId)
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
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    quantity: row.quantity,
    currentPeriodStart: row.current_period_start?.toISOString() ?? null,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  } : null
}

export async function getOrgBillingSummary(input: { organizationId: OrgId; includePortalUrl?: boolean; returnUrl: string }) {
  const row = await findInferenceSubscriptionByOrg(input.organizationId)
  const seatRow = await findSeatSubscriptionByOrg(input.organizationId)
  const seatCounts = await getOrganizationSeatBillingCounts({ organizationId: input.organizationId })
  const hasActiveSubscription = Boolean(row && ACTIVE_STATUSES.has(row.status))
  const hasActiveSeatSubscription = Boolean(seatRow && ACTIVE_STATUSES.has(seatRow.status))
  let portalUrl: string | null = null
  if (input.includePortalUrl && (row?.stripe_customer_id || seatRow?.stripe_customer_id)) {
    try {
      portalUrl = (await createInferencePortalSession({ organizationId: input.organizationId, returnUrl: input.returnUrl })).url
    } catch (error) {
      console.warn("[stripe-billing] failed to create billing portal session", error)
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
    proration_behavior: "always_invoice",
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
    proration_behavior: "always_invoice",
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

export async function handleStripeWebhook(input: { payload: string; signature: string | null }) {
  if (!env.stripe.webhookSecret) {
    throw new Error("stripe_webhook_secret_missing")
  }
  if (!input.signature) {
    throw new Error("stripe_signature_missing")
  }

  const event = stripe().webhooks.constructEvent(input.payload, input.signature, env.stripe.webhookSecret)
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.mode === "setup") {
        await createSeatSubscriptionFromSetupCheckoutSession(session, event.id)
      } else if (typeof session.subscription === "string") {
        const subscription = await stripe().subscriptions.retrieve(session.subscription)
        const row = await upsertOrgSubscriptionFromStripe(subscription, event.id)
        if (row?.type === INFERENCE_SUBSCRIPTION_TYPE && ACTIVE_STATUSES.has(subscriptionStatus(subscription.status))) {
          await setInferenceEnabled({ organizationId: row.organization_id, enabled: true })
        }
      }
      break
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await upsertOrgSubscriptionFromStripe(event.data.object as Stripe.Subscription, event.id)
      break
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice
      const subscriptionId = typeof (invoice as Stripe.Invoice & { subscription?: unknown }).subscription === "string"
        ? (invoice as Stripe.Invoice & { subscription: string }).subscription
        : null
      if (subscriptionId) {
        const row = await findOrgSubscriptionByStripeId(subscriptionId)
        if (row) {
          await db
            .update(OrgSubscriptionTable)
            .set({ status: "expired", last_event_id: event.id, updated_at: new Date() })
            .where(eq(OrgSubscriptionTable.id, row.id))
          if (row.type === INFERENCE_SUBSCRIPTION_TYPE) {
            await setInferenceEnabled({ organizationId: row.organization_id, enabled: false })
          }
        }
      }
      break
    }
  }

  return { received: true, type: event.type }
}
