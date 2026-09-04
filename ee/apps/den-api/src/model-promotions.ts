import type Stripe from "stripe"
import { eq, and } from "@openwork-ee/den-db/drizzle"
import { OrgSubscriptionTable, MemberTable, ModelPromotionGrantTable } from "@openwork-ee/den-db/schema"
import { createPromotionStore, PromotionError, validatePromotionKey } from "@openwork-ee/model-promotions"
import type { PromotionIdentity } from "@openwork-ee/model-promotions"
import { db } from "./db.js"
import { setInferenceEnabled } from "./inference.js"
import { env } from "./env.js"
import { stripeBillingClient, upsertOrgSubscriptionFromStripe } from "./stripe-billing.js"

export const modelPromotions = createPromotionStore(db)
const resourceId = (value: string | { id: string } | null) => typeof value === "string" ? value : value?.id ?? null
const routerBase = process.env.MODEL_PROMOTIONS_OPENROUTER_URL ?? "https://openrouter.ai/api/v1"

export async function validateCampaign(campaign: { terms: Parameters<typeof validatePromotionKey>[1]; encrypted_key: string }) {
  if (campaign.terms.stripePriceId !== env.stripe.inferencePriceId) throw new PromotionError("membership_price_mismatch", "Select the current OpenWork Models membership price.", 400)
  const price = await stripeBillingClient().prices.retrieve(campaign.terms.stripePriceId)
  if (!price.active || price.type !== "recurring" || price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 || !price.unit_amount)
    throw new PromotionError("membership_price_invalid", "The offer requires the active monthly OpenWork Models membership price.", 400)
  await validatePromotionKey(campaign.encrypted_key, campaign.terms, fetch, routerBase)
}

export async function promotionCheckout(input: { campaignId: string; version: number; identity: PromotionIdentity; visit?: string; email: string; name: string; origin: string }) {
  const grant = await modelPromotions.reserveClaim(input.campaignId, input.version, input.identity, input.visit)
  if (grant.status !== "reserved") return { grantId: grant.id, status: grant.status }
  const stripe = stripeBillingClient()
  if (grant.stripe_session_id?.startsWith("cs_")) {
    await syncPromotionCheckout(grant.stripe_session_id)
    const session = await stripe.checkout.sessions.retrieve(grant.stripe_session_id)
    return { grantId: grant.id, url: session.status === "open" ? session.url : null, status: (await modelPromotions.findGrant(grant.id))?.status }
  }
  const [existing] = await db.select().from(OrgSubscriptionTable).where(and(eq(OrgSubscriptionTable.organization_id, input.identity.organizationId), eq(OrgSubscriptionTable.type, "inference")))
  if (existing && !["canceled", "incomplete_expired", "expired"].includes(existing.status)) {
    if (grant.terms.newAccountsOnly) throw new PromotionError("membership_exists", "This new-account offer requires a new OpenWork Models subscription. Your existing membership has not been changed.")
    await modelPromotions.attachCheckout(grant.id, `existing:${existing.stripe_subscription_id}`)
    await qualifyExistingMember(grant.id, existing.stripe_subscription_id)
    return { grantId: grant.id, status: (await modelPromotions.findGrant(grant.id))?.status }
  }
  // Stripe retains idempotency keys for at least 24h. An uncertain old attempt
  // requires reconciliation rather than risking a second paid subscription.
  if (Date.now() - grant.created_at.getTime() >= 23 * 3600000) throw new PromotionError("checkout_needs_attention", "This checkout needs support before it can be retried. No additional subscription was created.")
  const metadata = { org_id: input.identity.organizationId, created_by_org_member_id: input.identity.memberId, openwork_product: "openwork_models", subscription_type: "inference", openwork_promotion_grant: grant.id }
  const session = await stripe.checkout.sessions.create({ mode: "subscription", payment_method_types: ["card"],
    ...(existing?.stripe_customer_id ? { customer: existing.stripe_customer_id } : { customer_email: input.email }),
    line_items: [{ price: grant.terms.stripePriceId, quantity: 1 }],
    client_reference_id: input.identity.organizationId, metadata, subscription_data: { metadata },
    success_url: `${input.origin}/dashboard/inference?promotion_session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/dashboard/inference`, expires_at: Math.floor(grant.created_at.getTime() / 1000) + 24 * 3600,
  }, { idempotencyKey: `model-promotion:${grant.id}` })
  await modelPromotions.attachCheckout(grant.id, session.id)
  return { grantId: grant.id, url: session.url, status: "reserved" }
}

async function qualifyingInvoice(subscription: Stripe.Subscription, grant: NonNullable<Awaited<ReturnType<typeof modelPromotions.findGrant>>>, invoiceId: string) {
  const invoice = await stripeBillingClient().invoices.retrieve(invoiceId)
  return subscription.status === "active" && subscription.metadata.org_id === grant.organization_id
    && subscription.items.data.some((item) => item.price.id === grant.terms.stripePriceId && item.price.recurring?.interval === "month")
    && resourceId(invoice.customer) === resourceId(subscription.customer)
    && resourceId(invoice.parent?.subscription_details?.subscription ?? null) === subscription.id
    && invoice.status === "paid" && invoice.amount_paid > 0 && invoice.amount_remaining === 0
}

async function qualifyExistingMember(grantId: string, subscriptionId: string) {
  const grant = await modelPromotions.findGrant(grantId)
  if (!grant || grant.terms.newAccountsOnly) return
  const subscription = await stripeBillingClient().subscriptions.retrieve(subscriptionId)
  const invoiceId = resourceId(subscription.latest_invoice)
  if (!invoiceId || !await qualifyingInvoice(subscription, grant, invoiceId)) throw new PromotionError("payment_required", "A paid monthly membership invoice is required before this offer becomes available.")
  await upsertOrgSubscriptionFromStripe(subscription)
  const item = subscription.items.data.find((item) => item.price.id === grant.terms.stripePriceId)
  if (item) await db.update(OrgSubscriptionTable).set({ current_period_start: new Date(item.current_period_start * 1000), current_period_end: new Date(item.current_period_end * 1000) }).where(eq(OrgSubscriptionTable.stripe_subscription_id, subscription.id))
  await setInferenceEnabled({ organizationId: grant.organization_id, enabled: true })
  await modelPromotions.paid(grant.id, { sessionId: `existing:${subscriptionId}`, subscriptionId, invoiceId })
}

export async function syncPromotionCheckout(sessionId: string) {
  const stripe = stripeBillingClient()
  const session = await stripe.checkout.sessions.retrieve(sessionId)
  const grantId = session.metadata?.openwork_promotion_grant
  if (!grantId) return
  const grant = await modelPromotions.findGrant(grantId)
  if (!grant || grant.status !== "reserved" || session.metadata?.org_id !== grant.organization_id || session.metadata?.created_by_org_member_id !== grant.member_id || session.client_reference_id !== grant.organization_id) return
  if (grant.stripe_session_id && grant.stripe_session_id !== session.id) return
  // A webhook can precede the checkout-create response.
  if (!grant.stripe_session_id) await modelPromotions.attachCheckout(grant.id, session.id)
  if (session.status === "expired" && session.payment_status === "unpaid") {
    await modelPromotions.releaseUnpaid(grant.id, session.id)
    return
  }
  const subscriptionId = resourceId(session.subscription)
  const invoiceId = resourceId(session.invoice)
  if (session.status !== "complete" || session.payment_status !== "paid" || !subscriptionId || !invoiceId) return
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  if (subscription.metadata.openwork_promotion_grant !== grant.id || !await qualifyingInvoice(subscription, grant, invoiceId)) return
  await upsertOrgSubscriptionFromStripe(subscription)
  const item = subscription.items.data.find((item) => item.price.id === grant.terms.stripePriceId)
  if (item) await db.update(OrgSubscriptionTable).set({ current_period_start: new Date(item.current_period_start * 1000), current_period_end: new Date(item.current_period_end * 1000) }).where(eq(OrgSubscriptionTable.stripe_subscription_id, subscription.id))
  await setInferenceEnabled({ organizationId: grant.organization_id, enabled: true })
  await modelPromotions.paid(grant.id, { sessionId, subscriptionId, invoiceId })
}

export async function handlePromotionStripeEvent(event: Stripe.Event) {
  if (event.type.startsWith("checkout.session.")) {
    const object = event.data.object
    if ("object" in object && object.object === "checkout.session") await syncPromotionCheckout(object.id)
  }
  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const subscription = await stripeBillingClient().subscriptions.retrieve(event.data.object.id)
    if (["canceled", "unpaid", "past_due", "paused", "incomplete_expired"].includes(subscription.status)) await modelPromotions.revokeSubscription(subscription.id)
  }
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const invoice = await stripeBillingClient().invoices.retrieve(event.data.object.id)
    const subscriptionId = resourceId(invoice.parent?.subscription_details?.subscription ?? null)
    if (!subscriptionId) return
    const subscription = await stripeBillingClient().subscriptions.retrieve(subscriptionId)
    if (["past_due", "unpaid", "canceled"].includes(subscription.status)) await modelPromotions.revokeSubscription(subscriptionId)
    const grantId = subscription.metadata.openwork_promotion_grant
    const grant = grantId ? await modelPromotions.findGrant(grantId) : null
    if (grant?.stripe_session_id?.startsWith("cs_")) await syncPromotionCheckout(grant.stripe_session_id)
  }
  // Refunds and disputes identify an invoice through the invoice payment list;
  // never infer ownership from an email or arbitrary client metadata.
  if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
    const chargeId = event.type === "charge.refunded" ? event.data.object.id : resourceId(event.data.object.charge)
    if (!chargeId) return
    const charge = await stripeBillingClient().charges.retrieve(chargeId)
    const paymentIntentId = resourceId(charge.payment_intent)
    if (!paymentIntentId) return
    const payments = await stripeBillingClient().invoicePayments.list({ payment: { type: "payment_intent", payment_intent: paymentIntentId } })
    for (const payment of payments.data) {
      const invoiceId = resourceId(payment.invoice)
      const grants = await db.select({ id: ModelPromotionGrantTable.id }).from(ModelPromotionGrantTable).where(eq(ModelPromotionGrantTable.stripe_invoice_id, invoiceId ?? ""))
      for (const grant of grants) await modelPromotions.revoke(grant.id, "stripe")
    }
  }
}

export async function reconcilePromotionRequest(id: string) {
  const request = await modelPromotions.request(id)
  if (!request?.generation_id) throw new PromotionError("generation_unknown", "No provider generation has been confirmed yet. The reservation remains held.")
  const key = await modelPromotions.campaignKey(request.campaign_id)
  const response = await fetch(`${routerBase}/generation?id=${encodeURIComponent(request.generation_id)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new PromotionError("usage_pending", "Provider usage is not available yet. The reservation remains held.")
  const { z } = await import("zod")
  const data = z.object({ data: z.object({ id: z.string(), total_cost: z.number().finite().nonnegative(), is_byok: z.boolean(), upstream_inference_cost: z.number().finite().nonnegative().nullable() }) }).parse(await response.json()).data
  if (data.id !== request.generation_id || data.is_byok && data.upstream_inference_cost == null) throw new PromotionError("usage_pending", "The provider has not confirmed the full cost yet.")
  await modelPromotions.settle(id, Math.ceil((data.total_cost + (data.is_byok ? data.upstream_inference_cost ?? 0 : 0)) * 1000000), data.id)
}

export async function promotionModelsForMember(memberId: PromotionIdentity["memberId"], organizationId: PromotionIdentity["organizationId"]) {
  const [member] = await db.select().from(MemberTable).where(eq(MemberTable.id, memberId))
  if (!member?.userId || member.removedAt || member.organizationId !== organizationId) return []
  const models = await modelPromotions.executableModels({ userId: member.userId, organizationId, memberId })
  return models.map((model) => ({ id: model.id, name: model.displayName, config: { id: model.id, name: model.displayName, tool_call: true, attachment: false, modalities: { input: ["text"], output: ["text"] } }, createdAt: new Date(0) }))
}
