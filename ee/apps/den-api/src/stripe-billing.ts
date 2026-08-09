import Stripe from "stripe"
import { and, eq, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  MemberTable,
  OrgSubscriptionStatus,
  OrgSubscriptionTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { getAddon, getAddonByStripePriceId, listAddons, resolveAddon } from "./billing/addons.js"
import type { BillingAddon } from "./billing/addons.js"
import { db } from "./db.js"
import { env } from "./env.js"
import type { DenOrgMode } from "./env.js"
import { setInferenceEnabled } from "./inference.js"
import { appLogger } from "./observability/logger.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type OrgSubscriptionRow = typeof OrgSubscriptionTable.$inferSelect
type OrgSubscriptionStatusValue = (typeof OrgSubscriptionStatus)[number]

const STRIPE_API_VERSION = "2026-04-22.dahlia"
export const FREE_ORG_SEAT_COUNT = 5
const ACTIVE_STATUSES = new Set<OrgSubscriptionStatusValue>(["active", "trialing"])
const EXPIRED_STATUSES = new Set<OrgSubscriptionStatusValue>(["past_due", "canceled", "unpaid", "incomplete_expired", "expired"])
const logger = appLogger.child({ component: "stripe_billing" })

let stripeClient: Stripe | null = null

function requireAddon(key: string) {
  const addon = getAddon(key)
  if (!addon) {
    throw new Error("billing_addon_not_found")
  }
  return addon
}

const inferenceAddon = requireAddon("inference")
const seatsAddon = requireAddon("seats")

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

function requireAddonPriceId(addon: BillingAddon) {
  const priceId = addon.stripePriceId()
  if (!priceId) {
    throw new Error(addon.priceIdMissingError)
  }
  return priceId
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

export function resolveStripeBillingAddon(input: {
  addonKey?: string | null
  subscriptionType?: string | null
  priceId?: string | null
}) {
  return resolveAddon(input.addonKey)
    ?? resolveAddon(input.subscriptionType)
    ?? getAddonByStripePriceId(input.priceId)
}

function getBillingMetadata(metadata: Stripe.Metadata | null | undefined) {
  const orgId = metadata?.org_id?.trim() ?? ""
  const orgMemberId = metadata?.created_by_org_member_id?.trim() ?? ""
  return {
    organizationId: orgId || null,
    orgMemberId: orgMemberId || null,
    addon: resolveStripeBillingAddon({
      addonKey: metadata?.addon_key?.trim(),
      subscriptionType: metadata?.subscription_type?.trim(),
    }),
  }
}

function getSubscriptionMetadata(subscription: Stripe.Subscription) {
  return getBillingMetadata(subscription.metadata)
}

function addonFromStripeSubscription(subscription: Stripe.Subscription, item: Stripe.SubscriptionItem | null) {
  const metadataAddon = getSubscriptionMetadata(subscription).addon
  const priceId = typeof item?.price?.id === "string" ? item.price.id : null
  return metadataAddon ?? getAddonByStripePriceId(priceId) ?? inferenceAddon
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

function addonStorageKeys(addon: BillingAddon) {
  return [addon.key, ...(addon.legacyKeys ?? [])]
}

async function findOrgSubscriptionByAddon(organizationId: OrgId, addon: BillingAddon) {
  return db
    .select()
    .from(OrgSubscriptionTable)
    .where(and(
      eq(OrgSubscriptionTable.organization_id, organizationId),
      inArray(OrgSubscriptionTable.type, addonStorageKeys(addon)),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

async function findInferenceSubscriptionByOrg(organizationId: OrgId) {
  return findOrgSubscriptionByAddon(organizationId, inferenceAddon)
}

async function findSeatSubscriptionByOrg(organizationId: OrgId) {
  return findOrgSubscriptionByAddon(organizationId, seatsAddon)
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
  const addon = addonFromStripeSubscription(subscription, item)
  const quantity = item?.quantity ?? 0
  const priceId = typeof item?.price?.id === "string" ? item.price.id : null
  const now = new Date()
  const values = {
    id: createDenTypeId("orgSubscription"),
    organization_id: metadata.organizationId as OrgId,
    created_by_org_membership_id: metadata.orgMemberId as MemberId | null,
    type: addon.legacyKeys?.[0] ?? addon.key,
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
      type: values.type,
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

  if (addon.enablesInference && EXPIRED_STATUSES.has(status)) {
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
  addonKey: string
  organizationId: OrgId
  orgMemberId: MemberId
  email: string
  name: string
  successUrl: string
  cancelUrl: string
}) {
  const addon = requireAddon(input.addonKey)
  const priceId = requireAddonPriceId(addon)
  const legacySubscriptionType = addon.legacyKeys?.[0] ?? addon.key
  const metadata = {
    org_id: input.organizationId,
    created_by_org_member_id: input.orgMemberId,
    openwork_product: addon.stripeProduct,
    addon_key: addon.key,
    subscription_type: legacySubscriptionType,
  }
  const customer = await findOrCreateStripeCustomer({
    organizationId: input.organizationId,
    email: input.email,
    name: input.name,
    metadata: {
      org_id: input.organizationId,
      created_by_org_member_id: input.orgMemberId,
      openwork_product: addon.stripeProduct,
      addon_key: addon.key,
    },
  })

  if (addon.billingModel === "per-seat") {
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

export async function createInferenceCheckoutSession(input: Omit<Parameters<typeof createOrgSubscriptionCheckoutSession>[0], "addonKey">) {
  return createOrgSubscriptionCheckoutSession({ ...input, addonKey: inferenceAddon.key })
}

export async function createSeatCheckoutSession(input: Omit<Parameters<typeof createOrgSubscriptionCheckoutSession>[0], "addonKey">) {
  return createOrgSubscriptionCheckoutSession({ ...input, addonKey: seatsAddon.key })
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

function serializeSubscription(row: OrgSubscriptionRow | null) {
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
  const addonSubscriptions = await Promise.all(listAddons().map(async (addon) => ({
    addon,
    row: await findOrgSubscriptionByAddon(input.organizationId, addon),
  })))
  const row = addonSubscriptions.find((entry) => entry.addon === inferenceAddon)?.row ?? null
  const seatRow = addonSubscriptions.find((entry) => entry.addon === seatsAddon)?.row ?? null
  const seatCounts = await getOrganizationSeatBillingCounts({ organizationId: input.organizationId })
  const hasActiveSubscription = Boolean(row && ACTIVE_STATUSES.has(row.status))
  const hasActiveSeatSubscription = Boolean(seatRow && ACTIVE_STATUSES.has(seatRow.status))
  let portalUrl: string | null = null
  const hasStripeCustomer = addonSubscriptions.some((entry) => Boolean(entry.row?.stripe_customer_id))
  if (input.includePortalUrl && hasStripeCustomer) {
    try {
      portalUrl = (await createInferencePortalSession({ organizationId: input.organizationId, returnUrl: input.returnUrl })).url
    } catch (error) {
      logger.warn("failed to create billing portal session", { organization_id: input.organizationId, error })
    }
  }

  const addons = addonSubscriptions.map(({ addon, row: addonRow }) => ({
    key: addon.key,
    label: addon.label,
    billingModel: addon.billingModel,
    status: addonRow?.status ?? null,
    quantity: addonRow?.quantity ?? 0,
    price: {
      configured: Boolean(env.stripe.secretKey && addon.stripePriceId()),
      priceId: addon.stripePriceId() ?? null,
      unitAmount: addon.unitAmount,
      currency: addon.currency,
      interval: addon.interval,
    },
    subscription: serializeSubscription(addonRow),
  }))

  return {
    addons,
    stripe: {
      configured: Boolean(env.stripe.secretKey && inferenceAddon.stripePriceId()),
      priceId: inferenceAddon.stripePriceId() ?? null,
      unitAmount: inferenceAddon.unitAmount,
      currency: inferenceAddon.currency,
      interval: inferenceAddon.interval,
      memberCount: seatCounts.total,
      hasActiveSubscription,
      portalUrl,
      subscription: serializeSubscription(row),
      seats: {
        configured: Boolean(env.stripe.secretKey && seatsAddon.stripePriceId()),
        priceId: seatsAddon.stripePriceId() ?? null,
        unitAmount: seatsAddon.unitAmount,
        currency: seatsAddon.currency,
        interval: seatsAddon.interval,
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

async function createPerSeatSubscriptionFromSetupCheckoutSession(session: Stripe.Checkout.Session, eventId: string) {
  if (typeof session.setup_intent !== "string" || typeof session.customer !== "string") {
    return null
  }

  const metadata = getBillingMetadata(session.metadata)
  if (metadata.addon?.billingModel !== "per-seat" || !metadata.organizationId) {
    return null
  }

  const existingSubscription = await findOrgSubscriptionByAddon(metadata.organizationId as OrgId, metadata.addon)
  if (existingSubscription && ACTIVE_STATUSES.has(existingSubscription.status)) {
    return existingSubscription
  }

  const setupIntent = await stripe().setupIntents.retrieve(session.setup_intent)
  const paymentMethod = typeof setupIntent.payment_method === "string"
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id ?? null

  if (!paymentMethod) {
    throw new Error("stripe_setup_payment_method_missing")
  }

  const legacySubscriptionType = metadata.addon.legacyKeys?.[0] ?? metadata.addon.key
  const subscription = await stripe().subscriptions.create(
    {
      customer: session.customer,
      default_payment_method: paymentMethod,
      items: [{ price: requireAddonPriceId(metadata.addon), quantity: 0 }],
      metadata: {
        org_id: metadata.organizationId,
        created_by_org_member_id: metadata.orgMemberId ?? "",
        openwork_product: metadata.addon.stripeProduct,
        addon_key: metadata.addon.key,
        subscription_type: legacySubscriptionType,
      },
    },
    { idempotencyKey: `openwork-${legacySubscriptionType}-subscription-${session.id}` },
  )

  return upsertOrgSubscriptionFromStripe(subscription, eventId)
}

export async function syncSeatCheckoutSession(input: { organizationId: OrgId; sessionId: string }) {
  const session = await stripe().checkout.sessions.retrieve(input.sessionId)
  const metadata = getBillingMetadata(session.metadata)
  if (metadata.addon?.billingModel !== "per-seat") {
    return null
  }
  if (metadata.organizationId !== input.organizationId) {
    throw new Error("stripe_checkout_session_org_mismatch")
  }
  if (session.status !== "complete") {
    return null
  }
  return createPerSeatSubscriptionFromSetupCheckoutSession(session, `checkout-session-sync:${session.id}`)
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
        await createPerSeatSubscriptionFromSetupCheckoutSession(session, event.id)
      } else if (typeof session.subscription === "string") {
        const subscription = await stripe().subscriptions.retrieve(session.subscription)
        const row = await upsertOrgSubscriptionFromStripe(subscription, event.id)
        if (row && resolveAddon(row.type)?.enablesInference && ACTIVE_STATUSES.has(subscriptionStatus(subscription.status))) {
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
          if (resolveAddon(row.type)?.enablesInference) {
            await setInferenceEnabled({ organizationId: row.organization_id, enabled: false })
          }
        }
      }
      break
    }
  }

  return { received: true, type: event.type }
}
