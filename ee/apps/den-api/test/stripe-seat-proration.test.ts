import { beforeEach, expect, mock, test } from "bun:test"

// Regression guard for OpenWork seat billing: quantity syncs must accrue
// prorations onto the next monthly invoice ("create_prorations") instead of
// invoicing and charging the card on every seat change ("always_invoice"),
// which produced a separate bank charge per added/removed member.

type UpdateCall = { itemId: string; params: Record<string, unknown> }
type FakeSubscription = {
  id: string
  customer: string
  status: "active"
  metadata: { org_id: string }
  items: {
    data: Array<{
      id: string
      quantity: number
      price: { id: string }
    }>
  }
  cancel_at_period_end: boolean
  canceled_at: null
  ended_at: null
}
type FakeEvent = {
  id: string
  type: "customer.subscription.created"
  data: { object: FakeSubscription }
}

const updateCalls: UpdateCall[] = []
const selectResults: Array<Array<Record<string, unknown>>> = []
const insertedSubscriptions: Array<Record<string, unknown>> = []

function createFakeEvent(priceId: string, suffix: string): FakeEvent {
  return {
    id: `evt_${suffix}`,
    type: "customer.subscription.created",
    data: {
      object: {
        id: `sub_${suffix}`,
        customer: "cus_addons",
        status: "active",
        metadata: { org_id: "org_addons" },
        items: {
          data: [{ id: `si_${suffix}`, quantity: 2, price: { id: priceId } }],
        },
        cancel_at_period_end: false,
        canceled_at: null,
        ended_at: null,
      },
    },
  }
}

let webhookEvent = createFakeEvent("price_inference_fake", "initial")

class FakeStripe {
  webhooks = {
    constructEvent: () => webhookEvent,
  }

  subscriptionItems = {
    update: (itemId: string, params: Record<string, unknown>) => {
      updateCalls.push({ itemId, params })
      return Promise.resolve({ id: itemId })
    },
  }
}

function queryChain() {
  const result = selectResults.shift() ?? []
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(result),
    then: (onFulfilled: (rows: Array<Record<string, unknown>>) => unknown) => Promise.resolve(result).then(onFulfilled),
  }
  return chain
}

mock.module("stripe", () => ({ default: FakeStripe }))

mock.module("../src/db.js", () => ({
  db: {
    select: () => queryChain(),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertedSubscriptions.push(values)
        return { onDuplicateKeyUpdate: () => Promise.resolve() }
      },
    }),
  },
}))

mock.module("../src/env.js", () => ({
  env: {
    stripe: {
      secretKey: "sk_test_fake",
      webhookSecret: "whsec_test_fake",
      inferencePriceId: "price_inference_fake",
      seatPriceId: "price_seat_fake",
      billingSuccessUrl: undefined,
      billingCancelUrl: undefined,
    },
  },
}))

mock.module("../src/inference.js", () => ({
  setInferenceEnabled: () => Promise.resolve(),
}))

const loggerStub = {
  child: () => loggerStub,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

mock.module("../src/observability/logger.js", () => ({ appLogger: loggerStub }))

const {
  getOrgBillingSummary,
  handleStripeWebhook,
  resolveStripeBillingAddon,
  syncInferenceSubscriptionQuantityAfterMemberChange,
  syncSeatSubscriptionQuantityAfterMemberChange,
} = await import("../src/stripe-billing.js")

beforeEach(() => {
  updateCalls.length = 0
  selectResults.length = 0
  insertedSubscriptions.length = 0
})

test("seat quantity sync accrues prorations instead of invoicing each change", async () => {
  // 1st select: active seat subscription; 2nd select: organization metadata.
  selectResults.push(
    [{ status: "active", stripe_subscription_item_id: "si_seat_item" }],
    [{ metadata: null }],
  )

  await syncSeatSubscriptionQuantityAfterMemberChange({ organizationId: "org_test", memberCount: 8 })

  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]?.itemId).toBe("si_seat_item")
  // 8 members minus 5 included free seats.
  expect(updateCalls[0]?.params.quantity).toBe(3)
  expect(updateCalls[0]?.params.proration_behavior).toBe("create_prorations")
})

test("inference quantity sync accrues prorations instead of invoicing each change", async () => {
  selectResults.push([{ status: "active", stripe_subscription_item_id: "si_inference_item" }])

  await syncInferenceSubscriptionQuantityAfterMemberChange({ organizationId: "org_test", memberCount: 4 })

  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]?.itemId).toBe("si_inference_item")
  expect(updateCalls[0]?.params.quantity).toBe(4)
  expect(updateCalls[0]?.params.proration_behavior).toBe("create_prorations")
})

test("no Stripe call when the seat subscription is not active", async () => {
  selectResults.push([{ status: "canceled", stripe_subscription_item_id: "si_seat_item" }])

  await syncSeatSubscriptionQuantityAfterMemberChange({ organizationId: "org_test", memberCount: 8 })

  expect(updateCalls).toHaveLength(0)
})

test("billing summary includes every catalog addon", async () => {
  selectResults.push(
    [{ status: "active", quantity: 3, stripe_customer_id: "cus_addons" }],
    [{ status: "trialing", quantity: 2, stripe_customer_id: "cus_addons" }],
    [{ count: 7 }],
    [{ metadata: null }],
  )

  const summary = await getOrgBillingSummary({
    organizationId: "org_addons",
    returnUrl: "https://example.test/dashboard/billing",
  })

  expect(summary.addons).toHaveLength(2)
  expect(summary.addons[0]).toMatchObject({
    key: "inference",
    status: "active",
    quantity: 3,
    price: { priceId: "price_inference_fake", unitAmount: 1000, currency: "usd", interval: "month" },
  })
  expect(summary.addons[1]).toMatchObject({
    key: "seats",
    status: "trialing",
    quantity: 2,
    price: { priceId: "price_seat_fake", unitAmount: 1000, currency: "usd", interval: "month" },
  })
  expect(summary.stripe.seats.billableSeatCount).toBe(2)
})

test("subscription webhooks resolve both addons from Stripe price IDs", async () => {
  for (const [priceId, expectedKey, expectedStoredType] of [
    ["price_inference_fake", "inference", "inference"],
    ["price_seat_fake", "seats", "seat"],
  ]) {
    webhookEvent = createFakeEvent(priceId, expectedKey)
    selectResults.push([])

    await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

    expect(resolveStripeBillingAddon({ priceId })?.key).toBe(expectedKey)
    expect(insertedSubscriptions.at(-1)?.type).toBe(expectedStoredType)
  }
})
