import { beforeEach, expect, mock, test } from "bun:test"

type RecordedCall = Record<string, unknown>

const selectResults: Array<Array<Record<string, unknown>>> = []
const insertedSubscriptions: Array<Record<string, unknown>> = []
const customerCreates: RecordedCall[] = []
const checkoutCreates: RecordedCall[] = []
const subscriptionItemUpdates: RecordedCall[] = []
const databaseUpdates: RecordedCall[] = []
const inferenceEnableCalls: RecordedCall[] = []
let customerSearchResults: Array<Record<string, unknown>> = []
let customerListResults: Array<Record<string, unknown>> = []
let checkoutSessionResults: Array<Record<string, unknown>> = []
let checkoutLineItemResults: Array<Record<string, unknown>> = []
let subscriptionResults: Array<Record<string, unknown>> = []
let retrievedCheckoutSession: Record<string, unknown> | null = null
let retrievedSubscription: Record<string, unknown> | null = null
let retrievedSubscriptions: Record<string, Record<string, unknown>> = {}
let retrievedInvoices: Record<string, Record<string, unknown>> = {}
let webhookEvent: Record<string, unknown> | null = null
let customerSequence = 0
let retrievedPrice: Record<string, unknown> = {}

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

class FakeStripe {
  customers = {
    search: () => Promise.resolve({ data: customerSearchResults }),
    list: () => Promise.resolve({ data: customerListResults }),
    retrieve: (customerId: string) => Promise.resolve({
      id: customerId,
      deleted: false,
      metadata: { org_id: customerId.replace("cus_", "org_") },
    }),
    create: (params: RecordedCall, options?: RecordedCall) => {
      customerSequence += 1
      customerCreates.push({ params, options })
      return Promise.resolve({ id: `cus_created_${customerSequence}` })
    },
  }

  prices = {
    retrieve: () => Promise.resolve(retrievedPrice),
  }

  subscriptions = {
    list: () => Promise.resolve({ data: subscriptionResults }),
    retrieve: (subscriptionId: string) => Promise.resolve(retrievedSubscriptions[subscriptionId] ?? retrievedSubscription),
  }

  invoices = {
    retrieve: (invoiceId: string) => Promise.resolve(retrievedInvoices[invoiceId]),
  }

  subscriptionItems = {
    update: (itemId: string, params: RecordedCall) => {
      subscriptionItemUpdates.push({ itemId, params })
      return Promise.resolve({ id: itemId })
    },
  }

  checkout = {
    sessions: {
      list: () => Promise.resolve({ data: checkoutSessionResults }),
      listLineItems: () => Promise.resolve({ data: checkoutLineItemResults }),
      expire: () => Promise.resolve({}),
      retrieve: () => Promise.resolve(retrievedCheckoutSession),
      create: (params: RecordedCall, options?: RecordedCall) => {
        checkoutCreates.push({ params, options })
        return Promise.resolve({ id: "cs_created", status: "open", url: "https://checkout.test/new" })
      },
    },
  }

  webhooks = {
    constructEvent: () => webhookEvent,
  }
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
    update: () => ({
      set: (values: RecordedCall) => {
        databaseUpdates.push(values)
        return { where: () => Promise.resolve() }
      },
    }),
  },
}))

mock.module("../src/env.js", () => ({
  env: {
    orgMode: "multi_org",
    openworkWebEnabled: true,
    stripe: {
      secretKey: "sk_test_fake",
      webhookSecret: "whsec_test_fake",
      inferencePriceId: "price_inference_fake",
      seatPriceId: "price_seat_fake",
      openworkWebPriceId: "price_web_fake",
      billingSuccessUrl: undefined,
      billingCancelUrl: undefined,
    },
  },
}))

mock.module("../src/inference.js", () => ({
  setInferenceEnabled: (input: RecordedCall) => {
    inferenceEnableCalls.push(input)
    return Promise.resolve()
  },
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
  OPENWORK_WEB_QUANTITY_DEFINITION,
  OPENWORK_WEB_UNIT_AMOUNT,
  calculateOpenWorkWebBilling,
  createOpenWorkWebCheckout,
  findOrCreateStripeCustomer,
  getOpenWorkWebBillingSummary,
  handleStripeWebhook,
  isEligibleOpenWorkWebSubscriptionStatus,
  isOngoingOpenWorkWebSubscriptionStatus,
  isOpenWorkWebBillableMember,
  openWorkWebCheckoutIdempotencyKey,
  syncInferenceSubscriptionQuantityAfterMemberChange,
  syncSeatSubscriptionQuantityAfterMemberChange,
  syncStripeCheckoutSession,
  syncWebSubscriptionQuantityAfterMemberChange,
  upsertOrgSubscriptionFromStripe,
} = await import("../src/stripe-billing.js")
const { env } = await import("../src/env.js")
const { openWorkWebAvailableForOrganization, openWorkWebDeploymentAvailable } = await import("../src/openwork-web-availability.js")

function webSubscription(input?: { status?: string; quantity?: number; organizationId?: string }) {
  const organizationId = input?.organizationId ?? "org_test"
  return {
    id: "sub_web",
    customer: "cus_test",
    status: input?.status ?? "active",
    metadata: {
      org_id: organizationId,
      created_by_org_member_id: "member_test",
      subscription_type: "web",
    },
    items: {
      data: [{ id: "si_web", quantity: input?.quantity ?? 2, price: { id: "price_web_fake" } }],
    },
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    latest_invoice: "in_web",
  }
}

function inferenceSubscription() {
  return {
    id: "sub_inference",
    customer: "cus_test",
    status: "active",
    metadata: {
      org_id: "org_test",
      created_by_org_member_id: "member_test",
      subscription_type: "inference",
    },
    items: {
      data: [{ id: "si_inference", quantity: 2, price: { id: "price_inference_fake" } }],
    },
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    latest_invoice: "in_inference",
  }
}

function checkoutInput(organizationId = "org_test") {
  return {
    organizationId,
    orgMemberId: "member_test",
    email: "owner@example.test",
    name: "Owner",
    successUrl: "https://app.example.test/dashboard/billing/stripe/checking?return=web",
    cancelUrl: "https://app.example.test/dashboard/web",
  }
}

function webSubscriptionRow(input?: { status?: string; paymentFailed?: boolean; subscriptionId?: string }) {
  return {
    id: "orgSubscription_web",
    organization_id: "org_test",
    created_by_org_membership_id: "member_test",
    type: "web",
    status: input?.status ?? "active",
    stripe_customer_id: "cus_test",
    stripe_subscription_id: input?.subscriptionId ?? "sub_web",
    stripe_price_id: "price_web_fake",
    stripe_subscription_item_id: "si_web",
    quantity: 2,
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    payment_failed: input?.paymentFailed ?? false,
    canceled_at: null,
    ended_at: null,
    last_event_id: null,
  }
}

beforeEach(() => {
  env.orgMode = "multi_org"
  env.openworkWebEnabled = true
  env.stripe.secretKey = "sk_test_fake"
  env.stripe.openworkWebPriceId = "price_web_fake"
  selectResults.length = 0
  insertedSubscriptions.length = 0
  customerCreates.length = 0
  checkoutCreates.length = 0
  subscriptionItemUpdates.length = 0
  databaseUpdates.length = 0
  inferenceEnableCalls.length = 0
  customerSearchResults = []
  customerListResults = []
  checkoutSessionResults = []
  checkoutLineItemResults = []
  subscriptionResults = []
  retrievedCheckoutSession = null
  retrievedSubscription = null
  retrievedSubscriptions = {}
  retrievedInvoices = {}
  webhookEvent = null
  customerSequence = 0
  retrievedPrice = {
    active: true,
    type: "recurring",
    billing_scheme: "per_unit",
    transform_quantity: null,
    unit_amount: 5000,
    currency: "usd",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  }
})

test("OpenWork Web bills joined non-removed members at $50 each", () => {
  expect(OPENWORK_WEB_QUANTITY_DEFINITION).toBe("joined_non_removed_members")
  expect(OPENWORK_WEB_UNIT_AMOUNT).toBe(5000)
  expect(isOpenWorkWebBillableMember({ joinedAt: new Date(), removedAt: null })).toBe(true)
  expect(isOpenWorkWebBillableMember({ joinedAt: null, removedAt: null })).toBe(false)
  expect(isOpenWorkWebBillableMember({ joinedAt: new Date(), removedAt: new Date() })).toBe(false)
  expect(calculateOpenWorkWebBilling({ joinedMemberCount: 3 })).toEqual({
    quantity: 3,
    unitAmount: 5000,
    expectedMonthlyTotal: 15000,
  })
})

test("only active and trialing Web subscriptions are eligible", () => {
  for (const status of ["active", "trialing"]) {
    expect(isEligibleOpenWorkWebSubscriptionStatus(status)).toBe(true)
  }
  for (const status of ["incomplete", "incomplete_expired", "past_due", "canceled", "unpaid", "paused", "expired"]) {
    expect(isEligibleOpenWorkWebSubscriptionStatus(status)).toBe(false)
  }
})

test("the deployment flag is global while the complimentary override is organization-scoped", () => {
  expect(openWorkWebDeploymentAvailable(true)).toBe(true)
  expect(openWorkWebDeploymentAvailable(false)).toBe(false)
  expect(openWorkWebAvailableForOrganization(false, {})).toBe(false)
  expect(openWorkWebAvailableForOrganization(false, { capabilities: { openworkWeb: true } })).toBe(false)
  expect(openWorkWebAvailableForOrganization(false, { complimentaryAccess: { openworkWeb: true } })).toBe(true)
  expect(openWorkWebAvailableForOrganization(true, {})).toBe(true)

  env.orgMode = "single_org"
  expect(openWorkWebDeploymentAvailable(env.openworkWebEnabled)).toBe(true)
})

test("ongoing Web statuses suppress duplicate checkout until the subscription is terminal", () => {
  for (const status of ["active", "trialing", "incomplete", "past_due", "unpaid", "paused"]) {
    expect(isOngoingOpenWorkWebSubscriptionStatus(status)).toBe(true)
  }
  for (const status of ["canceled", "incomplete_expired", "expired"]) {
    expect(isOngoingOpenWorkWebSubscriptionStatus(status)).toBe(false)
  }
})

test("member-readable Web billing summary omits Stripe identifiers and portal access", async () => {
  selectResults.push([{
    status: "active",
    stripe_customer_id: "cus_private",
    stripe_subscription_id: "sub_private",
    stripe_price_id: "price_web_fake",
    quantity: 2,
    current_period_start: new Date("2026-08-01T00:00:00.000Z"),
    current_period_end: new Date("2026-09-01T00:00:00.000Z"),
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
  }], [{ count: 2 }], [{ metadata: {} }])

  const summary = await getOpenWorkWebBillingSummary("org_test")

  expect(summary).toMatchObject({
    configured: true,
    unitAmount: 5000,
    quantity: 2,
    expectedMonthlyTotal: 10000,
    hasEligibleSubscription: true,
    hasAccess: true,
    accessSource: "subscription",
    complimentaryAccess: false,
    subscription: {
      status: "active",
      paymentStatus: "paid",
      quantity: 2,
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    },
  })
  expect(summary).not.toHaveProperty("priceId")
  expect(summary).not.toHaveProperty("portalUrl")
  expect(summary.subscription).not.toHaveProperty("stripeCustomerId")
  expect(summary.subscription).not.toHaveProperty("stripeSubscriptionId")
})

test("the Web flag controls availability while Stripe readiness controls purchasing", async () => {
  env.stripe.secretKey = ""
  selectResults.push([], [{ count: 2 }], [{ metadata: {} }])

  const summary = await getOpenWorkWebBillingSummary("org_test")

  expect(openWorkWebDeploymentAvailable(env.openworkWebEnabled)).toBe(true)
  expect(summary.configured).toBe(false)
  expect(summary.hasAccess).toBe(false)
})

test("complimentary Web access works without Stripe configuration and overrides the deployment flag for that organization", async () => {
  env.stripe.secretKey = ""
  selectResults.push([], [{ count: 2 }], [{ metadata: { complimentaryAccess: { openworkWeb: true } } }])

  const enabledSummary = await getOpenWorkWebBillingSummary("org_test")

  expect(enabledSummary).toMatchObject({
    configured: false,
    hasEligibleSubscription: false,
    hasAccess: true,
    accessSource: "complimentary",
    complimentaryAccess: true,
  })

  env.openworkWebEnabled = false
  selectResults.push([], [{ count: 2 }], [{ metadata: { complimentaryAccess: { openworkWeb: true } } }])
  const disabledSummary = await getOpenWorkWebBillingSummary("org_test")
  expect(disabledSummary).toMatchObject({
    configured: false,
    hasAccess: true,
    accessSource: "complimentary",
    complimentaryAccess: true,
  })

  selectResults.push([], [{ count: 2 }], [{ metadata: {} }])
  const ungrantedSummary = await getOpenWorkWebBillingSummary("org_other")
  expect(ungrantedSummary).toMatchObject({
    configured: false,
    hasAccess: false,
    accessSource: null,
    complimentaryAccess: false,
  })
})

test("an active Web subscription with a failed payment remains locked", async () => {
  selectResults.push([{
    status: "active",
    stripe_price_id: "price_web_fake",
    stripe_subscription_id: "sub_web",
    quantity: 2,
    current_period_start: null,
    current_period_end: new Date("2026-09-01T00:00:00.000Z"),
    cancel_at_period_end: false,
    payment_failed: true,
    canceled_at: null,
    ended_at: null,
  }], [{ count: 2 }], [{ metadata: {} }])

  const summary = await getOpenWorkWebBillingSummary("org_test")

  expect(summary.hasEligibleSubscription).toBe(false)
  expect(summary.hasAccess).toBe(false)
  expect(summary.subscription?.status).toBe("active")
  expect(summary.subscription?.paymentStatus).toBe("payment_failed")
})

test("Web checkout uses the configured monthly price and authoritative joined-member quantity", async () => {
  selectResults.push([{ count: 2 }], [], [])

  const session = await createOpenWorkWebCheckout(checkoutInput())

  expect(session.url).toBe("https://checkout.test/new")
  expect(checkoutCreates).toHaveLength(1)
  expect(checkoutCreates[0]?.params).toMatchObject({
    mode: "subscription",
    customer: "cus_created_1",
    line_items: [{ price: "price_web_fake", quantity: 2 }],
    client_reference_id: "org_test",
    metadata: { org_id: "org_test", subscription_type: "web", openwork_product: "openwork_web" },
    subscription_data: { metadata: { org_id: "org_test", subscription_type: "web" } },
  })
  expect(checkoutCreates[0]?.options).toEqual({
    idempotencyKey: openWorkWebCheckoutIdempotencyKey({ organizationId: "org_test", quantity: 2 }),
  })
})

test("deployments without the Web flag cannot create a checkout even when Stripe billing is configured", async () => {
  env.openworkWebEnabled = false

  await expect(createOpenWorkWebCheckout(checkoutInput())).rejects.toThrow("stripe_openwork_web_not_available")
  expect(checkoutCreates).toHaveLength(0)
})

test("Web checkout rejects a configured price that is not exactly $50 per licensed user each month", async () => {
  retrievedPrice = {
    ...retrievedPrice,
    recurring: { interval: "month", interval_count: 2, usage_type: "licensed" },
  }

  await expect(createOpenWorkWebCheckout(checkoutInput())).rejects.toThrow("stripe_openwork_web_price_contract_invalid")
  expect(checkoutCreates).toHaveLength(0)
})

test("matching open Web checkout is reused instead of creating a duplicate", async () => {
  selectResults.push([{ count: 2 }], [], [])
  checkoutSessionResults = [{
    id: "cs_open",
    status: "open",
    mode: "subscription",
    url: "https://checkout.test/existing",
    client_reference_id: "org_test",
    metadata: { org_id: "org_test", subscription_type: "web" },
  }]
  checkoutLineItemResults = [{ quantity: 2, price: { id: "price_web_fake" } }]

  const session = await createOpenWorkWebCheckout(checkoutInput())

  expect(session.url).toBe("https://checkout.test/existing")
  expect(checkoutCreates).toHaveLength(0)
})

test("an eligible Stripe Web subscription blocks a second checkout", async () => {
  selectResults.push([{ count: 2 }], [], [], [])
  subscriptionResults = [webSubscription()]

  await expect(createOpenWorkWebCheckout(checkoutInput())).rejects.toThrow("stripe_openwork_web_subscription_exists")
  expect(insertedSubscriptions).toHaveLength(1)
  expect(checkoutCreates).toHaveLength(0)
})

test("the organization subscription guard blocks a past-due subscription before selecting a Checkout customer", async () => {
  const subscription = webSubscription({ status: "past_due" })
  subscription.id = "sub_historical"
  subscription.customer = "cus_historical"
  retrievedSubscriptions = { sub_historical: subscription }
  const storedRow = {
    id: "orgSubscription_historical",
    organization_id: "org_test",
    type: "web",
    status: "past_due",
    stripe_customer_id: "cus_historical",
    stripe_subscription_id: "sub_historical",
    stripe_price_id: "price_web_fake",
    stripe_subscription_item_id: "si_web",
    quantity: 2,
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    payment_failed: true,
    canceled_at: null,
    ended_at: null,
  }
  selectResults.push([{ count: 2 }], [storedRow], [storedRow], [storedRow])

  await expect(createOpenWorkWebCheckout(checkoutInput())).rejects.toThrow("stripe_openwork_web_subscription_exists")
  expect(customerCreates).toHaveLength(0)
  expect(checkoutCreates).toHaveLength(0)
})

test("an incomplete Stripe Web subscription suppresses a second checkout", async () => {
  selectResults.push([{ count: 2 }], [], [], [], [])
  subscriptionResults = [webSubscription({ status: "incomplete" })]

  await expect(createOpenWorkWebCheckout(checkoutInput())).rejects.toThrow("stripe_openwork_web_subscription_exists")
  expect(checkoutCreates).toHaveLength(0)
})

test("an expired Web subscription allows a replacement checkout", async () => {
  const subscription = webSubscription({ status: "canceled" })
  subscription.id = "sub_expired"
  retrievedSubscriptions = { sub_expired: subscription }
  const storedRow = {
    id: "orgSubscription_expired",
    organization_id: "org_test",
    type: "web",
    status: "expired",
    stripe_customer_id: "cus_expired",
    stripe_subscription_id: "sub_expired",
    stripe_price_id: "price_web_fake",
    stripe_subscription_item_id: "si_web",
    quantity: 2,
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    payment_failed: true,
    canceled_at: null,
    ended_at: new Date(),
  }
  selectResults.push([{ count: 2 }], [storedRow], [storedRow], [storedRow], [])

  const session = await createOpenWorkWebCheckout(checkoutInput())

  expect(session.url).toBe("https://checkout.test/new")
  expect(checkoutCreates).toHaveLength(1)
})

test("organization-scoped customers never reuse another organization by email", async () => {
  selectResults.push([], [])
  const first = await findOrCreateStripeCustomer({
    organizationId: "org_alpha",
    email: "same@example.test",
    name: "Same Owner",
    metadata: { org_id: "org_alpha" },
  })
  const second = await findOrCreateStripeCustomer({
    organizationId: "org_beta",
    email: "same@example.test",
    name: "Same Owner",
    metadata: { org_id: "org_beta" },
  })

  expect(first).not.toBe(second)
  expect(customerListResults).toEqual([])
  expect(customerCreates.map((call) => call.options)).toEqual([
    { idempotencyKey: "openwork-org-customer:org_alpha" },
    { idempotencyKey: "openwork-org-customer:org_beta" },
  ])
})

test("checkout sync rejects cross-organization sessions and stores ineligible payment state without granting eligibility", async () => {
  retrievedCheckoutSession = {
    id: "cs_complete",
    status: "complete",
    payment_status: "unpaid",
    mode: "subscription",
    subscription: "sub_web",
    metadata: { org_id: "org_alpha", subscription_type: "web" },
  }

  await expect(syncStripeCheckoutSession({ organizationId: "org_beta", sessionId: "cs_complete" }))
    .rejects.toThrow("stripe_checkout_session_org_mismatch")

  retrievedSubscription = webSubscription({ status: "past_due", organizationId: "org_alpha" })
  selectResults.push([])
  await syncStripeCheckoutSession({ organizationId: "org_alpha", sessionId: "cs_complete" })

  expect(insertedSubscriptions.at(-1)).toMatchObject({
    organization_id: "org_alpha",
    type: "web",
    status: "past_due",
  })
  const insertedStatus = insertedSubscriptions.at(-1)?.status
  expect(isEligibleOpenWorkWebSubscriptionStatus(typeof insertedStatus === "string" ? insertedStatus : null)).toBe(false)
})

test("checkout sync keeps an active Web subscription locked until Checkout confirms payment", async () => {
  retrievedCheckoutSession = {
    id: "cs_unpaid",
    status: "complete",
    payment_status: "unpaid",
    mode: "subscription",
    subscription: "sub_web",
    metadata: { org_id: "org_test", subscription_type: "web" },
  }
  retrievedSubscription = webSubscription({ status: "active" })
  retrievedInvoices = { in_web: { id: "in_web", status: "open" } }
  const pendingRow = webSubscriptionRow({ paymentFailed: true })
  selectResults.push([], [], [pendingRow])

  const row = await syncStripeCheckoutSession({ organizationId: "org_test", sessionId: "cs_unpaid" })

  expect(row?.payment_failed).toBe(true)
  expect(databaseUpdates.at(-1)).toMatchObject({
    payment_failed: true,
    last_event_id: "checkout-session-sync:cs_unpaid",
  })
})

test("checkout sync unlocks an active Web subscription after Checkout confirms payment", async () => {
  retrievedCheckoutSession = {
    id: "cs_paid",
    status: "complete",
    payment_status: "paid",
    mode: "subscription",
    subscription: "sub_web",
    metadata: { org_id: "org_test", subscription_type: "web" },
  }
  retrievedSubscription = webSubscription({ status: "active" })
  retrievedInvoices = { in_web: { id: "in_web", status: "paid" } }
  const pendingRow = webSubscriptionRow({ paymentFailed: true })
  selectResults.push([], [], [pendingRow])

  const row = await syncStripeCheckoutSession({ organizationId: "org_test", sessionId: "cs_paid" })

  expect(row?.payment_failed).toBe(false)
  expect(databaseUpdates.at(-1)).toMatchObject({
    payment_failed: false,
    last_event_id: "checkout-session-sync:cs_paid",
  })
})

test("a stale paid Checkout sync cannot clear a failure on the current invoice", async () => {
  retrievedCheckoutSession = {
    id: "cs_stale_paid",
    status: "complete",
    payment_status: "paid",
    mode: "subscription",
    subscription: "sub_web",
    metadata: { org_id: "org_test", subscription_type: "web" },
  }
  retrievedSubscription = webSubscription({ status: "active" })
  retrievedInvoices = { in_web: { id: "in_web", status: "open" } }
  const failedRow = webSubscriptionRow({ paymentFailed: true })
  selectResults.push([], [], [failedRow])

  const row = await syncStripeCheckoutSession({ organizationId: "org_test", sessionId: "cs_stale_paid" })

  expect(row?.payment_failed).toBe(true)
  expect(databaseUpdates.at(-1)).toMatchObject({
    payment_failed: true,
    last_event_id: "checkout-session-sync:cs_stale_paid",
  })
})

test("an asynchronous Checkout failure locks an otherwise active Web subscription", async () => {
  const subscription = webSubscription({ status: "active" })
  retrievedSubscriptions = { sub_web: subscription }
  retrievedInvoices = { in_web: { id: "in_web", status: "open" } }
  webhookEvent = {
    id: "evt_checkout_async_failed",
    type: "checkout.session.async_payment_failed",
    data: {
      object: {
        id: "cs_async_failed",
        mode: "subscription",
        payment_status: "unpaid",
        subscription: "sub_web",
        metadata: { org_id: "org_test", subscription_type: "web" },
      },
    },
  }
  const paidRow = webSubscriptionRow({ paymentFailed: false })
  selectResults.push([paidRow], [paidRow], [paidRow])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(databaseUpdates.at(-1)).toMatchObject({
    payment_failed: true,
    last_event_id: "evt_checkout_async_failed",
  })
  expect(subscriptionItemUpdates).toHaveLength(0)
})

test("an asynchronous Checkout failure expires inference without enabling access", async () => {
  const subscription = inferenceSubscription()
  retrievedSubscriptions = { sub_inference: subscription }
  webhookEvent = {
    id: "evt_inference_checkout_async_failed",
    type: "checkout.session.async_payment_failed",
    data: {
      object: {
        id: "cs_inference_async_failed",
        mode: "subscription",
        payment_status: "unpaid",
        subscription: "sub_inference",
        metadata: { org_id: "org_test", subscription_type: "inference" },
      },
    },
  }
  const row = {
    ...webSubscriptionRow(),
    type: "inference",
    stripe_subscription_id: "sub_inference",
    stripe_price_id: "price_inference_fake",
    stripe_subscription_item_id: "si_inference",
  }
  selectResults.push([row])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(databaseUpdates.at(-1)).toMatchObject({
    status: "expired",
    last_event_id: "evt_inference_checkout_async_failed",
  })
  expect(inferenceEnableCalls).toEqual([{ organizationId: "org_test", enabled: false }])
})

test("an asynchronous Checkout success clears payment failure and reconciles Web quantity", async () => {
  const subscription = webSubscription({ status: "active" })
  retrievedSubscriptions = { sub_web: subscription }
  retrievedInvoices = { in_web: { id: "in_web", status: "paid" } }
  webhookEvent = {
    id: "evt_checkout_async_succeeded",
    type: "checkout.session.async_payment_succeeded",
    data: {
      object: {
        id: "cs_async_succeeded",
        mode: "subscription",
        payment_status: "paid",
        subscription: "sub_web",
        metadata: { org_id: "org_test", subscription_type: "web" },
      },
    },
  }
  const failedRow = webSubscriptionRow({ paymentFailed: true })
  const paidRow = webSubscriptionRow({ paymentFailed: false })
  selectResults.push([failedRow], [failedRow], [failedRow], [paidRow], [{ count: 2 }])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(databaseUpdates.at(-1)).toMatchObject({
    payment_failed: false,
    last_event_id: "evt_checkout_async_succeeded",
  })
  expect(subscriptionItemUpdates).toHaveLength(0)
})

test("a delayed asynchronous Checkout success cannot clear a later invoice failure", async () => {
  const subscription = webSubscription({ status: "active" })
  retrievedSubscriptions = { sub_web: subscription }
  retrievedInvoices = { in_web: { id: "in_web", status: "open" } }
  webhookEvent = {
    id: "evt_stale_checkout_success",
    type: "checkout.session.async_payment_succeeded",
    data: {
      object: {
        id: "cs_stale_success",
        mode: "subscription",
        payment_status: "paid",
        subscription: "sub_web",
        metadata: { org_id: "org_test", subscription_type: "web" },
      },
    },
  }
  const failedRow = webSubscriptionRow({ paymentFailed: true })
  selectResults.push([failedRow], [failedRow], [failedRow], [failedRow])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(databaseUpdates.at(-1)).toMatchObject({
    payment_failed: true,
    last_event_id: "evt_stale_checkout_success",
  })
  expect(subscriptionItemUpdates).toHaveLength(0)
})

test("the current failed invoice locks Web even when Stripe keeps the subscription active", async () => {
  const subscription = webSubscription({ status: "active" })
  retrievedSubscriptions = { sub_web: subscription }
  retrievedInvoices = {
    in_web: { id: "in_web", status: "open" },
  }
  webhookEvent = {
    id: "evt_payment_failed",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_web",
        parent: { subscription_details: { subscription: "sub_web" } },
      },
    },
  }
  const row = webSubscriptionRow()
  selectResults.push([row], [row], [row], [row])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(databaseUpdates.at(-1)).toMatchObject({ payment_failed: true, last_event_id: "evt_payment_failed" })
})

test("a paid current invoice clears the persisted Web payment failure", async () => {
  const subscription = webSubscription({ status: "active" })
  retrievedSubscriptions = { sub_web: subscription }
  retrievedInvoices = {
    in_web: { id: "in_web", status: "paid" },
  }
  webhookEvent = {
    id: "evt_invoice_paid",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_web",
        parent: { subscription_details: { subscription: "sub_web" } },
      },
    },
  }
  const failedRow = webSubscriptionRow({ paymentFailed: true })
  selectResults.push([failedRow], [failedRow], [failedRow], [failedRow], [failedRow])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(databaseUpdates.at(-1)).toMatchObject({ payment_failed: false, last_event_id: "evt_invoice_paid" })
})

test("a subscription status reactivation does not clear a persisted payment failure by itself", async () => {
  const subscription = webSubscription({ status: "active" })
  retrievedSubscriptions = { sub_web: subscription }
  webhookEvent = {
    id: "evt_reactivated",
    type: "customer.subscription.updated",
    data: { object: webSubscription({ status: "past_due" }) },
  }
  const failedRow = webSubscriptionRow({ status: "past_due", paymentFailed: true })
  const activeRow = webSubscriptionRow({ status: "active", paymentFailed: true })
  selectResults.push([failedRow], [failedRow], [activeRow])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(insertedSubscriptions.at(-1)).toMatchObject({
    stripe_subscription_id: "sub_web",
    status: "active",
    payment_failed: true,
  })
})

test("an unrelated active Web subscription update preserves the payment failure", async () => {
  const subscription = webSubscription({ status: "active" })
  retrievedSubscriptions = { sub_web: subscription }
  webhookEvent = {
    id: "evt_active_update",
    type: "customer.subscription.updated",
    data: { object: subscription },
  }
  const failedRow = webSubscriptionRow({ status: "active", paymentFailed: true })
  selectResults.push([failedRow], [failedRow], [failedRow])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(insertedSubscriptions.at(-1)).toMatchObject({
    stripe_subscription_id: "sub_web",
    status: "active",
    payment_failed: true,
  })
})

test("a replacement active Web subscription starts locked until payment is confirmed", async () => {
  const replacement = webSubscription({ status: "active" })
  replacement.id = "sub_replacement"
  const failedPriorRow = webSubscriptionRow({ paymentFailed: true, subscriptionId: "sub_prior" })
  const replacementRow = webSubscriptionRow({ paymentFailed: true, subscriptionId: "sub_replacement" })
  selectResults.push([failedPriorRow], [replacementRow])

  await upsertOrgSubscriptionFromStripe(replacement, "evt_replacement")

  expect(insertedSubscriptions.at(-1)).toMatchObject({
    stripe_subscription_id: "sub_replacement",
    status: "active",
    payment_failed: true,
  })
})

test("a delayed invoice event cannot alter Web payment state when it is not the subscription latest invoice", async () => {
  const subscription = webSubscription({ status: "active" })
  subscription.latest_invoice = "in_current"
  retrievedSubscriptions = { sub_web: subscription }
  retrievedInvoices = {
    in_current: { id: "in_current", status: "paid" },
  }
  webhookEvent = {
    id: "evt_delayed_invoice",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_old",
        parent: { subscription_details: { subscription: "sub_web" } },
      },
    },
  }
  selectResults.push([webSubscriptionRow()])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(databaseUpdates).toHaveLength(0)
  expect(insertedSubscriptions).toHaveLength(0)
})

test("a paid inference invoice still synchronizes the existing non-Web billing path", async () => {
  const subscription = inferenceSubscription()
  retrievedSubscriptions = { sub_inference: subscription }
  webhookEvent = {
    id: "evt_inference_paid",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_inference",
        parent: { subscription_details: { subscription: "sub_inference" } },
      },
    },
  }
  const row = {
    ...webSubscriptionRow(),
    type: "inference",
    stripe_subscription_id: "sub_inference",
    stripe_price_id: "price_inference_fake",
    stripe_subscription_item_id: "si_inference",
  }
  selectResults.push([], [row])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(insertedSubscriptions.at(-1)).toMatchObject({
    type: "inference",
    status: "active",
    stripe_subscription_id: "sub_inference",
  })
})

test("a failed inference invoice still records and expires a previously missing non-Web row", async () => {
  const subscription = inferenceSubscription()
  retrievedSubscriptions = { sub_inference: subscription }
  webhookEvent = {
    id: "evt_inference_failed",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_inference",
        parent: { subscription_details: { subscription: "sub_inference" } },
      },
    },
  }
  const insertedRow = {
    ...webSubscriptionRow(),
    type: "inference",
    stripe_subscription_id: "sub_inference",
    stripe_price_id: "price_inference_fake",
    stripe_subscription_item_id: "si_inference",
  }
  selectResults.push([], [insertedRow])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(insertedSubscriptions.at(-1)).toMatchObject({
    type: "inference",
    status: "active",
    stripe_subscription_id: "sub_inference",
  })
  expect(databaseUpdates.at(-1)).toMatchObject({
    status: "expired",
    last_event_id: "evt_inference_failed",
  })
})

test("a delayed terminal webhook cannot replace a newer eligible Web subscription", async () => {
  const currentOldSubscription = webSubscription({ status: "canceled" })
  currentOldSubscription.id = "sub_old"
  const currentNewSubscription = webSubscription({ status: "active" })
  currentNewSubscription.id = "sub_new"
  retrievedSubscriptions = {
    sub_old: currentOldSubscription,
    sub_new: currentNewSubscription,
  }
  webhookEvent = {
    id: "evt_delayed",
    type: "customer.subscription.deleted",
    data: { object: { ...currentOldSubscription, status: "active" } },
  }
  const canonicalRow = {
    id: "orgSubscription_existing",
    organization_id: "org_test",
    type: "web",
    status: "active",
    stripe_customer_id: "cus_test",
    stripe_subscription_id: "sub_new",
    stripe_price_id: "price_web_fake",
    stripe_subscription_item_id: "si_web",
    quantity: 2,
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    last_event_id: "evt_newer",
  }
  selectResults.push([canonicalRow], [canonicalRow], [canonicalRow], [{ count: 2 }])

  await handleStripeWebhook({ payload: "{}", signature: "test_signature" })

  expect(insertedSubscriptions).toHaveLength(0)
  expect(subscriptionItemUpdates).toHaveLength(0)
})

test("joined-member changes update an eligible Web subscription with monthly prorations", async () => {
  selectResults.push(
    [{ status: "active", quantity: 1, stripe_price_id: "price_web_fake", stripe_subscription_item_id: "si_web" }],
    [{ count: 3 }],
  )

  await syncWebSubscriptionQuantityAfterMemberChange({ organizationId: "org_test", memberCount: 9 })

  expect(subscriptionItemUpdates).toEqual([{
    itemId: "si_web",
    params: { quantity: 3, proration_behavior: "create_prorations" },
  }])
})

test("seat quantity sync keeps its free-seat policy and monthly prorations", async () => {
  selectResults.push(
    [{ status: "active", stripe_subscription_item_id: "si_seat_item" }],
    [{ metadata: null }],
  )

  await syncSeatSubscriptionQuantityAfterMemberChange({ organizationId: "org_test", memberCount: 8 })

  expect(subscriptionItemUpdates).toEqual([{
    itemId: "si_seat_item",
    params: { quantity: 3, proration_behavior: "create_prorations" },
  }])
})

test("inference quantity sync retains monthly prorations", async () => {
  selectResults.push([{ status: "active", stripe_subscription_item_id: "si_inference_item" }])

  await syncInferenceSubscriptionQuantityAfterMemberChange({ organizationId: "org_test", memberCount: 4 })

  expect(subscriptionItemUpdates).toEqual([{
    itemId: "si_inference_item",
    params: { quantity: 4, proration_behavior: "create_prorations" },
  }])
})

test("seat quantity sync skips terminal subscriptions", async () => {
  selectResults.push([{ status: "canceled", stripe_subscription_item_id: "si_seat_item" }])

  await syncSeatSubscriptionQuantityAfterMemberChange({ organizationId: "org_test", memberCount: 8 })

  expect(subscriptionItemUpdates).toHaveLength(0)
})
