import { beforeEach, expect, mock, test } from "bun:test"

// Regression guard for Micx seat billing: quantity syncs must accrue
// prorations onto the next monthly invoice ("create_prorations") instead of
// invoicing and charging the card on every seat change ("always_invoice"),
// which produced a separate bank charge per added/removed member.

type UpdateCall = { itemId: string; params: Record<string, unknown> }

const updateCalls: UpdateCall[] = []
const selectResults: Array<Array<Record<string, unknown>>> = []

class FakeStripe {
  subscriptionItems = {
    update: (itemId: string, params: Record<string, unknown>) => {
      updateCalls.push({ itemId, params })
      return Promise.resolve({ id: itemId })
    },
  }
}

function queryChain() {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(selectResults.shift() ?? []),
  }
  return chain
}

mock.module("stripe", () => ({ default: FakeStripe }))

mock.module("../src/db.js", () => ({
  db: { select: () => queryChain() },
}))

mock.module("../src/env.js", () => ({
  env: {
    stripe: {
      secretKey: "sk_test_fake",
      webhookSecret: undefined,
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
  syncInferenceSubscriptionQuantityAfterMemberChange,
  syncSeatSubscriptionQuantityAfterMemberChange,
} = await import("../src/stripe-billing.js")

beforeEach(() => {
  updateCalls.length = 0
  selectResults.length = 0
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
