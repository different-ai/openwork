import Stripe from "stripe"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import {
  MemberTable,
  OrgSubscriptionStatus,
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

const STRIPE_API_VERSION = "2026-04-22.dahlia"
const INFERENCE_SUBSCRIPTION_TYPE = "inference" as const
const ACTIVE_STATUSES = new Set<OrgSubscriptionStatusValue>(["active", "trialing"])
const EXPIRED_STATUSES = new Set<OrgSubscriptionStatusValue>(["past_due", "canceled", "unpaid", "incomplete_expired", "expired"])

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

function getSubscriptionMetadata(subscription: Stripe.Subscription) {
  const orgId = subscription.metadata.org_id?.trim() ?? ""
  const orgMemberId = subscription.metadata.created_by_org_member_id?.trim() ?? ""
  return {
    organizationId: orgId || null,
    orgMemberId: orgMemberId || null,
  }
}

async function activeMemberCount(organizationId: OrgId) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(eq(MemberTable.organizationId, organizationId))
  return Math.max(0, Number(row?.count ?? 0))
}

export async function getActiveMemberCountForBilling(organizationId: OrgId) {
  return activeMemberCount(organizationId)
}

async function findInferenceSubscriptionByOrg(organizationId: OrgId) {
  return db
    .select()
    .from(OrgSubscriptionTable)
    .where(and(
      eq(OrgSubscriptionTable.organization_id, organizationId),
      eq(OrgSubscriptionTable.type, INFERENCE_SUBSCRIPTION_TYPE),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

async function findInferenceSubscriptionByStripeId(stripeSubscriptionId: string) {
  return db
    .select()
    .from(OrgSubscriptionTable)
    .where(eq(OrgSubscriptionTable.stripe_subscription_id, stripeSubscriptionId))
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

export async function organizationHasActiveInferenceSubscription(organizationId: OrgId) {
  const row = await findInferenceSubscriptionByOrg(organizationId)
  return Boolean(row && ACTIVE_STATUSES.has(row.status))
}

export async function upsertInferenceSubscriptionFromStripe(subscription: Stripe.Subscription, eventId?: string | null) {
  const item = firstSubscriptionItem(subscription)
  const metadata = getSubscriptionMetadata(subscription)
  if (!metadata.organizationId) {
    return null
  }

  const status = subscriptionStatus(subscription.status)
  const quantity = item?.quantity ?? 0
  const priceId = typeof item?.price?.id === "string" ? item.price.id : null
  const now = new Date()
  const values = {
    id: createDenTypeId("orgSubscription"),
    organization_id: metadata.organizationId as OrgId,
    created_by_org_membership_id: metadata.orgMemberId as MemberId | null,
    type: INFERENCE_SUBSCRIPTION_TYPE,
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

  if (EXPIRED_STATUSES.has(status)) {
    await setInferenceEnabled({ organizationId: metadata.organizationId as OrgId, enabled: false })
  }

  return findInferenceSubscriptionByStripeId(subscription.id)
}

async function ensureStripeCustomer(input: { organizationId: OrgId; orgMemberId: MemberId; email: string; name: string }) {
  const existing = await findInferenceSubscriptionByOrg(input.organizationId)
  if (existing?.stripe_customer_id) {
    return existing.stripe_customer_id
  }

  const customer = await stripe().customers.create({
    email: input.email,
    name: input.name,
    metadata: {
      org_id: input.organizationId,
      created_by_org_member_id: input.orgMemberId,
      openwork_product: "openwork_models",
    },
  })
  return customer.id
}

export async function createInferenceCheckoutSession(input: {
  organizationId: OrgId
  orgMemberId: MemberId
  email: string
  name: string
  successUrl: string
  cancelUrl: string
}) {
  const priceId = requireInferencePriceId()
  const quantity = Math.max(1, await activeMemberCount(input.organizationId))
  const customer = await ensureStripeCustomer(input)
  return stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price: priceId, quantity }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.organizationId,
    metadata: {
      org_id: input.organizationId,
      created_by_org_member_id: input.orgMemberId,
      openwork_product: "openwork_models",
    },
    subscription_data: {
      metadata: {
        org_id: input.organizationId,
        created_by_org_member_id: input.orgMemberId,
        openwork_product: "openwork_models",
        subscription_type: INFERENCE_SUBSCRIPTION_TYPE,
      },
    },
  })
}

export async function createInferencePortalSession(input: { organizationId: OrgId; returnUrl: string }) {
  const row = await findInferenceSubscriptionByOrg(input.organizationId)
  if (!row?.stripe_customer_id) {
    throw new Error("stripe_customer_missing")
  }
  return stripe().billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: input.returnUrl,
  })
}

export async function getOrgBillingSummary(input: { organizationId: OrgId; includePortalUrl?: boolean; returnUrl: string }) {
  const row = await findInferenceSubscriptionByOrg(input.organizationId)
  const memberCount = await activeMemberCount(input.organizationId)
  const hasActiveSubscription = Boolean(row && ACTIVE_STATUSES.has(row.status))
  let portalUrl: string | null = null
  if (input.includePortalUrl && row?.stripe_customer_id) {
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
      memberCount,
      hasActiveSubscription,
      portalUrl,
      subscription: row ? {
        id: row.id,
        status: row.status,
        stripeCustomerId: row.stripe_customer_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        quantity: row.quantity,
        currentPeriodStart: row.current_period_start?.toISOString() ?? null,
        currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
        cancelAtPeriodEnd: row.cancel_at_period_end,
      } : null,
    },
  }
}

export async function syncInferenceSubscriptionQuantityAfterMemberChange(input: { organizationId: OrgId; memberCount: number }) {
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
      if (typeof session.subscription === "string") {
        const subscription = await stripe().subscriptions.retrieve(session.subscription)
        await upsertInferenceSubscriptionFromStripe(subscription, event.id)
        const metadata = getSubscriptionMetadata(subscription)
        if (metadata.organizationId && ACTIVE_STATUSES.has(subscriptionStatus(subscription.status))) {
          await setInferenceEnabled({ organizationId: metadata.organizationId as OrgId, enabled: true })
        }
      }
      break
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await upsertInferenceSubscriptionFromStripe(event.data.object as Stripe.Subscription, event.id)
      break
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice
      const subscriptionId = typeof (invoice as Stripe.Invoice & { subscription?: unknown }).subscription === "string"
        ? (invoice as Stripe.Invoice & { subscription: string }).subscription
        : null
      if (subscriptionId) {
        const row = await findInferenceSubscriptionByStripeId(subscriptionId)
        if (row) {
          await db
            .update(OrgSubscriptionTable)
            .set({ status: "expired", last_event_id: event.id, updated_at: new Date() })
            .where(eq(OrgSubscriptionTable.id, row.id))
          await setInferenceEnabled({ organizationId: row.organization_id, enabled: false })
        }
      }
      break
    }
  }

  return { received: true, type: event.type }
}
