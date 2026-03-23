import { env } from "../env.js"
import { sendSubscribedToDenEvent } from "../loops.js"

type PolarCustomerState = {
  granted_benefits?: Array<{
    benefit_id?: string
  }>
}

type PolarCheckoutSession = {
  url?: string
}

type PolarCustomerSession = {
  customer_portal_url?: string
}

type PolarCustomer = {
  id?: string
  email?: string
  external_id?: string | null
}

type PolarListResource<T> = {
  items?: T[]
}

type PolarSubscription = {
  id?: string
  status?: string
  amount?: number
  currency?: string
  recurring_interval?: string | null
  recurring_interval_count?: number | null
  current_period_start?: string | null
  current_period_end?: string | null
  cancel_at_period_end?: boolean
  canceled_at?: string | null
  ended_at?: string | null
}

type PolarOrder = {
  id?: string
  created_at?: string
  status?: string
  total_amount?: number
  net_amount?: number
  currency?: string
  invoice_number?: string
  is_invoice_generated?: boolean
}

type PolarOrderInvoice = {
  url?: string
}

type PolarProductPrice = {
  amount_type?: string
  price_currency?: string
  price_amount?: number
  minimum_amount?: number
  preset_amount?: number | null
  is_archived?: boolean
  seat_tiers?: {
    tiers?: Array<{
      price_per_seat?: number
    }>
  }
}

type PolarProduct = {
  recurring_interval?: string | null
  recurring_interval_count?: number | null
  prices?: PolarProductPrice[]
}

const CHECKOUT_TRIAL_INTERVAL = "day"
const CHECKOUT_TRIAL_INTERVAL_COUNT = 14

export type CloudWorkerAccess =
  | {
      allowed: true
    }
  | {
      allowed: false
      checkoutUrl: string
    }

export type CloudWorkerBillingPrice = {
  amount: number | null
  currency: string | null
  recurringInterval: string | null
  recurringIntervalCount: number | null
}

export type CloudWorkerBillingSubscription = {
  id: string
  status: string
  amount: number | null
  currency: string | null
  recurringInterval: string | null
  recurringIntervalCount: number | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  endedAt: string | null
}

export type CloudWorkerBillingInvoice = {
  id: string
  createdAt: string | null
  status: string
  totalAmount: number | null
  currency: string | null
  invoiceNumber: string | null
  invoiceUrl: string | null
}

export type CloudWorkerBillingStatus = {
  featureGateEnabled: boolean
  hasActivePlan: boolean
  checkoutRequired: boolean
  checkoutUrl: string | null
  portalUrl: string | null
  price: CloudWorkerBillingPrice | null
  subscription: CloudWorkerBillingSubscription | null
  invoices: CloudWorkerBillingInvoice[]
}

export type CloudWorkerAdminBillingStatus = {
  status: "paid" | "unpaid" | "unavailable"
  featureGateEnabled: boolean
  subscriptionId: string | null
  subscriptionStatus: string | null
  currentPeriodEnd: string | null
  source: "benefit" | "subscription" | "unavailable"
  note: string | null
}

type CloudAccessInput = {
  userId: string
  email: string
  name: string
}

type BillingStatusOptions = {
  includeCheckoutUrl?: boolean
  includePortalUrl?: boolean
  includeInvoices?: boolean
}

function sanitizeApiBase(value: string) {
  return value.replace(/\/+$/, "")
}

function parseJson<T>(text: string): T | null {
  if (!text) {
    return null
  }

  return JSON.parse(text) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function polarFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${env.polar.accessToken}`)
  headers.set("Accept", "application/json")
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  return fetch(`${sanitizeApiBase(env.polar.apiBase)}${path}`, {
    ...init,
    headers,
  })
}

async function polarFetchJson<T>(path: string, init: RequestInit = {}) {
  const response = await polarFetch(path, init)
  const text = await response.text()
  const payload = parseJson<T>(text)
  return { response, text, payload }
}

function assertPaywallConfig() {
  if (!env.polar.accessToken) {
    throw new Error("POLAR_ACCESS_TOKEN is required when POLAR_FEATURE_GATE_ENABLED=true")
  }
  if (!env.polar.productId) {
    throw new Error("POLAR_PRODUCT_ID is required when POLAR_FEATURE_GATE_ENABLED=true")
  }
  if (!env.polar.benefitId) {
    throw new Error("POLAR_BENEFIT_ID is required when POLAR_FEATURE_GATE_ENABLED=true")
  }
  if (!env.polar.successUrl) {
    throw new Error("POLAR_SUCCESS_URL is required when POLAR_FEATURE_GATE_ENABLED=true")
  }
  if (!env.polar.returnUrl) {
    throw new Error("POLAR_RETURN_URL is required when POLAR_FEATURE_GATE_ENABLED=true")
  }
}

async function getCustomerStateByExternalId(externalCustomerId: string): Promise<PolarCustomerState | null> {
  const encodedExternalId = encodeURIComponent(externalCustomerId)
  const { response, payload, text } = await polarFetchJson<PolarCustomerState>(`/v1/customers/external/${encodedExternalId}/state`, {
    method: "GET",
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Polar customer state lookup failed (${response.status}): ${text.slice(0, 400)}`)
  }

  return payload
}

async function getCustomerStateById(customerId: string): Promise<PolarCustomerState | null> {
  const encodedCustomerId = encodeURIComponent(customerId)
  const { response, payload, text } = await polarFetchJson<PolarCustomerState>(`/v1/customers/${encodedCustomerId}/state`, {
    method: "GET",
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Polar customer state lookup by ID failed (${response.status}): ${text.slice(0, 400)}`)
  }

  return payload
}

async function getCustomerByEmail(email: string): Promise<PolarCustomer | null> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) {
    return null
  }

  const encodedEmail = encodeURIComponent(normalizedEmail)
  const { response, payload, text } = await polarFetchJson<PolarListResource<PolarCustomer>>(`/v1/customers/?email=${encodedEmail}`, {
    method: "GET",
  })

  if (!response.ok) {
    throw new Error(`Polar customer lookup by email failed (${response.status}): ${text.slice(0, 400)}`)
  }

  const customers = payload?.items ?? []
  const exact = customers.find((customer) => customer.email?.trim().toLowerCase() === normalizedEmail)
  return exact ?? customers[0] ?? null
}

async function linkCustomerExternalId(customer: PolarCustomer, externalCustomerId: string): Promise<void> {
  if (!customer.id) {
    return
  }

  if (typeof customer.external_id === "string" && customer.external_id.length > 0) {
    return
  }

  const encodedCustomerId = encodeURIComponent(customer.id)
  await polarFetch(`/v1/customers/${encodedCustomerId}`, {
    method: "PATCH",
    body: JSON.stringify({
      external_id: externalCustomerId,
    }),
  })
}

function hasRequiredBenefit(state: PolarCustomerState | null) {
  if (!state?.granted_benefits || !env.polar.benefitId) {
    return false
  }

  return state.granted_benefits.some((grant) => grant.benefit_id === env.polar.benefitId)
}

async function createCheckoutSession(input: CloudAccessInput): Promise<string> {
  const payload = {
    products: [env.polar.productId],
    success_url: env.polar.successUrl,
    return_url: env.polar.returnUrl,
    allow_trial: true,
    trial_interval: CHECKOUT_TRIAL_INTERVAL,
    trial_interval_count: CHECKOUT_TRIAL_INTERVAL_COUNT,
    external_customer_id: input.userId,
    customer_email: input.email,
    customer_name: input.name,
  }

  const { response, payload: checkout, text } = await polarFetchJson<PolarCheckoutSession>("/v1/checkouts/", {
    method: "POST",
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Polar checkout creation failed (${response.status}): ${text.slice(0, 400)}`)
  }

  if (!checkout?.url) {
    throw new Error("Polar checkout response missing URL")
  }

  return checkout.url
}

type CloudWorkerAccessEvaluation = {
  featureGateEnabled: boolean
  hasActivePlan: boolean
  checkoutUrl: string | null
}

async function evaluateCloudWorkerAccess(
  input: CloudAccessInput,
  options: { includeCheckoutUrl?: boolean } = {},
): Promise<CloudWorkerAccessEvaluation> {
  if (!env.polar.featureGateEnabled) {
    return {
      featureGateEnabled: false,
      hasActivePlan: true,
      checkoutUrl: null,
    }
  }

  assertPaywallConfig()

  const externalState = await getCustomerStateByExternalId(input.userId)
  if (hasRequiredBenefit(externalState)) {
    return {
      featureGateEnabled: true,
      hasActivePlan: true,
      checkoutUrl: null,
    }
  }

  const customer = await getCustomerByEmail(input.email)
  if (customer?.id) {
    const emailState = await getCustomerStateById(customer.id)
    if (hasRequiredBenefit(emailState)) {
      await linkCustomerExternalId(customer, input.userId).catch(() => undefined)
      return {
        featureGateEnabled: true,
        hasActivePlan: true,
        checkoutUrl: null,
      }
    }
  }

  return {
    featureGateEnabled: true,
    hasActivePlan: false,
    checkoutUrl: options.includeCheckoutUrl ? await createCheckoutSession(input) : null,
  }
}

function normalizeRecurringInterval(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function normalizeRecurringIntervalCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isActiveSubscriptionStatus(status: string | null | undefined) {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : ""
  return normalized === "active" || normalized === "trialing"
}

function toBillingSubscription(subscription: PolarSubscription | null): CloudWorkerBillingSubscription | null {
  if (!subscription?.id) {
    return null
  }

  return {
    id: subscription.id,
    status: typeof subscription.status === "string" ? subscription.status : "unknown",
    amount: typeof subscription.amount === "number" ? subscription.amount : null,
    currency: typeof subscription.currency === "string" ? subscription.currency : null,
    recurringInterval: normalizeRecurringInterval(subscription.recurring_interval),
    recurringIntervalCount: normalizeRecurringIntervalCount(subscription.recurring_interval_count),
    currentPeriodStart: typeof subscription.current_period_start === "string" ? subscription.current_period_start : null,
    currentPeriodEnd: typeof subscription.current_period_end === "string" ? subscription.current_period_end : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    canceledAt: typeof subscription.canceled_at === "string" ? subscription.canceled_at : null,
    endedAt: typeof subscription.ended_at === "string" ? subscription.ended_at : null,
  }
}

function toBillingPriceFromSubscription(subscription: CloudWorkerBillingSubscription | null): CloudWorkerBillingPrice | null {
  if (!subscription) {
    return null
  }

  return {
    amount: subscription.amount,
    currency: subscription.currency,
    recurringInterval: subscription.recurringInterval,
    recurringIntervalCount: subscription.recurringIntervalCount,
  }
}

async function getSubscriptionById(subscriptionId: string): Promise<PolarSubscription | null> {
  const encodedId = encodeURIComponent(subscriptionId)
  const { response, payload, text } = await polarFetchJson<PolarSubscription>(`/v1/subscriptions/${encodedId}`, {
    method: "GET",
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Polar subscription lookup failed (${response.status}): ${text.slice(0, 400)}`)
  }

  return payload
}

async function listSubscriptionsByExternalCustomer(
  externalCustomerId: string,
  options: { activeOnly?: boolean; limit?: number } = {},
): Promise<PolarSubscription[]> {
  const params = new URLSearchParams()
  params.set("external_customer_id", externalCustomerId)
  if (env.polar.productId) {
    params.set("product_id", env.polar.productId)
  }
  params.set("limit", String(options.limit ?? 1))
  params.set("sorting", "-started_at")

  if (options.activeOnly === true) {
    params.set("active", "true")
  }

  const lookup = await polarFetchJson<PolarListResource<PolarSubscription>>(`/v1/subscriptions/?${params.toString()}`, {
    method: "GET",
  })
  let response = lookup.response
  let payload = lookup.payload
  let text = lookup.text

  if (response.status === 422 && params.has("sorting")) {
    params.delete("sorting")
    const fallbackLookup = await polarFetchJson<PolarListResource<PolarSubscription>>(`/v1/subscriptions/?${params.toString()}`, {
      method: "GET",
    })
    response = fallbackLookup.response
    payload = fallbackLookup.payload
    text = fallbackLookup.text
  }

  if (!response.ok) {
    throw new Error(`Polar subscriptions lookup failed (${response.status}): ${text.slice(0, 400)}`)
  }

  return payload?.items ?? []
}

async function getPrimarySubscriptionForCustomer(externalCustomerId: string): Promise<PolarSubscription | null> {
  const active = await listSubscriptionsByExternalCustomer(externalCustomerId, { activeOnly: true, limit: 1 })
  if (active[0]) {
    return active[0]
  }

  const recent = await listSubscriptionsByExternalCustomer(externalCustomerId, { activeOnly: false, limit: 1 })
  return recent[0] ?? null
}

async function listRecentOrdersByExternalCustomer(externalCustomerId: string, limit = 6): Promise<PolarOrder[]> {
  const params = new URLSearchParams()
  params.set("external_customer_id", externalCustomerId)
  if (env.polar.productId) {
    params.set("product_id", env.polar.productId)
  }
  params.set("limit", String(limit))
  params.set("sorting", "-created_at")

  const { response, payload, text } = await polarFetchJson<PolarListResource<PolarOrder>>(`/v1/orders/?${params.toString()}`, {
    method: "GET",
  })

  if (!response.ok) {
    throw new Error(`Polar orders lookup failed (${response.status}): ${text.slice(0, 400)}`)
  }

  return payload?.items ?? []
}

async function getOrderInvoiceUrl(orderId: string): Promise<string | null> {
  const encodedId = encodeURIComponent(orderId)
  const { response, payload, text } = await polarFetchJson<PolarOrderInvoice>(`/v1/orders/${encodedId}/invoice`, {
    method: "GET",
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Polar invoice lookup failed (${response.status}): ${text.slice(0, 400)}`)
  }

  return typeof payload?.url === "string" ? payload.url : null
}

function toBillingInvoice(order: PolarOrder, invoiceUrl: string | null): CloudWorkerBillingInvoice | null {
  if (!order.id) {
    return null
  }

  const totalAmount =
    typeof order.total_amount === "number"
      ? order.total_amount
      : typeof order.net_amount === "number"
        ? order.net_amount
        : null

  return {
    id: order.id,
    createdAt: typeof order.created_at === "string" ? order.created_at : null,
    status: typeof order.status === "string" ? order.status : "unknown",
    totalAmount,
    currency: typeof order.currency === "string" ? order.currency : null,
    invoiceNumber: typeof order.invoice_number === "string" ? order.invoice_number : null,
    invoiceUrl,
  }
}

async function listBillingInvoices(externalCustomerId: string, limit = 6): Promise<CloudWorkerBillingInvoice[]> {
  const orders = await listRecentOrdersByExternalCustomer(externalCustomerId, limit)
  const invoices = await Promise.all(
    orders.map(async (order) => {
      const invoiceUrl = order.id && order.is_invoice_generated === true ? await getOrderInvoiceUrl(order.id).catch(() => null) : null
      return toBillingInvoice(order, invoiceUrl)
    }),
  )

  return invoices.filter((invoice): invoice is CloudWorkerBillingInvoice => invoice !== null)
}

async function createCustomerPortalUrl(externalCustomerId: string): Promise<string | null> {
  const body = {
    external_customer_id: externalCustomerId,
    return_url: env.polar.returnUrl ?? env.polar.successUrl ?? null,
  }

  const { response, payload, text } = await polarFetchJson<PolarCustomerSession>("/v1/customer-sessions/", {
    method: "POST",
    body: JSON.stringify(body),
  })

  if (response.status === 404 || response.status === 422) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Polar customer portal session failed (${response.status}): ${text.slice(0, 400)}`)
  }

  return typeof payload?.customer_portal_url === "string" ? payload.customer_portal_url : null
}

function extractAmountFromProductPrice(price: PolarProductPrice): number | null {
  if (price.amount_type === "fixed" && typeof price.price_amount === "number") {
    return price.price_amount
  }

  if (price.amount_type === "seat_based") {
    const firstTier = Array.isArray(price.seat_tiers?.tiers) ? price.seat_tiers?.tiers[0] : null
    if (firstTier && typeof firstTier.price_per_seat === "number") {
      return firstTier.price_per_seat
    }
  }

  if (price.amount_type === "custom") {
    if (typeof price.preset_amount === "number") {
      return price.preset_amount
    }
    if (typeof price.minimum_amount === "number") {
      return price.minimum_amount
    }
  }

  if (price.amount_type === "free") {
    return 0
  }

  return null
}

function extractBillingPriceFromProduct(product: PolarProduct | null): CloudWorkerBillingPrice | null {
  if (!product || !Array.isArray(product.prices)) {
    return null
  }

  for (const price of product.prices) {
    if (!isRecord(price) || price.is_archived === true) {
      continue
    }

    const amount = extractAmountFromProductPrice(price as PolarProductPrice)
    if (amount === null) {
      continue
    }

    const currency = typeof price.price_currency === "string" ? price.price_currency : null
    return {
      amount,
      currency,
      recurringInterval: normalizeRecurringInterval(product.recurring_interval),
      recurringIntervalCount: normalizeRecurringIntervalCount(product.recurring_interval_count),
    }
  }

  return null
}

async function getProductBillingPrice(productId: string): Promise<CloudWorkerBillingPrice | null> {
  const encodedId = encodeURIComponent(productId)
  const { response, payload, text } = await polarFetchJson<PolarProduct>(`/v1/products/${encodedId}`, {
    method: "GET",
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Polar product lookup failed (${response.status}): ${text.slice(0, 400)}`)
  }

  return extractBillingPriceFromProduct(payload)
}

export async function requireCloudWorkerAccess(input: CloudAccessInput): Promise<CloudWorkerAccess> {
  const evaluation = await evaluateCloudWorkerAccess(input, { includeCheckoutUrl: true })
  if (evaluation.hasActivePlan) {
    return { allowed: true }
  }

  if (!evaluation.checkoutUrl) {
    throw new Error("Polar checkout URL unavailable")
  }

  return {
    allowed: false,
    checkoutUrl: evaluation.checkoutUrl,
  }
}

export async function getCloudWorkerBillingStatus(
  input: CloudAccessInput,
  options: BillingStatusOptions = {},
): Promise<CloudWorkerBillingStatus> {
  const includePortalUrl = options.includePortalUrl !== false
  const includeInvoices = options.includeInvoices !== false
  const evaluation = await evaluateCloudWorkerAccess(input, {
    includeCheckoutUrl: options.includeCheckoutUrl,
  })

  if (!evaluation.featureGateEnabled) {
    return {
      featureGateEnabled: false,
      hasActivePlan: true,
      checkoutRequired: false,
      checkoutUrl: null,
      portalUrl: null,
      price: null,
      subscription: null,
      invoices: [],
    }
  }

  if (evaluation.hasActivePlan) {
    await sendSubscribedToDenEvent(input)
  }

  let subscription: CloudWorkerBillingSubscription | null = null
  let productPrice: CloudWorkerBillingPrice | null = null
  let portalUrl: string | null = null
  let invoices: CloudWorkerBillingInvoice[] = []

  const [subscriptionResult, priceResult, portalResult, invoicesResult] = await Promise.all([
    getPrimarySubscriptionForCustomer(input.userId).catch(() => null),
    env.polar.productId ? getProductBillingPrice(env.polar.productId).catch(() => null) : Promise.resolve<CloudWorkerBillingPrice | null>(null),
    includePortalUrl ? createCustomerPortalUrl(input.userId).catch(() => null) : Promise.resolve<string | null>(null),
    includeInvoices ? listBillingInvoices(input.userId).catch(() => []) : Promise.resolve<CloudWorkerBillingInvoice[]>([]),
  ])

  subscription = toBillingSubscription(subscriptionResult)
  productPrice = priceResult
  portalUrl = portalResult
  invoices = invoicesResult

  return {
    featureGateEnabled: evaluation.featureGateEnabled,
    hasActivePlan: evaluation.hasActivePlan,
    checkoutRequired: evaluation.featureGateEnabled && !evaluation.hasActivePlan,
    checkoutUrl: evaluation.checkoutUrl,
    portalUrl,
    price: productPrice ?? toBillingPriceFromSubscription(subscription),
    subscription,
    invoices,
  }
}

export async function getCloudWorkerAdminBillingStatus(
  input: CloudAccessInput,
): Promise<CloudWorkerAdminBillingStatus> {
  if (!env.polar.accessToken) {
    return {
      status: "unavailable",
      featureGateEnabled: env.polar.featureGateEnabled,
      subscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      source: "unavailable",
      note: "Polar access token is not configured.",
    }
  }

  if (!env.polar.benefitId && !env.polar.productId) {
    return {
      status: "unavailable",
      featureGateEnabled: env.polar.featureGateEnabled,
      subscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      source: "unavailable",
      note: "Polar product or benefit configuration is missing.",
    }
  }

  try {
    let note: string | null = null
    let paidByBenefit = false

    if (env.polar.benefitId) {
      const externalState = await getCustomerStateByExternalId(input.userId)
      if (hasRequiredBenefit(externalState)) {
        paidByBenefit = true
        note = "Benefit granted via external customer id."
      } else {
        const customer = await getCustomerByEmail(input.email)
        if (customer?.id) {
          const emailState = await getCustomerStateById(customer.id)
          if (hasRequiredBenefit(emailState)) {
            paidByBenefit = true
            note = "Benefit granted via matching customer email."
            await linkCustomerExternalId(customer, input.userId).catch(() => undefined)
          }
        }
      }
    }

    const subscription = env.polar.productId ? await getPrimarySubscriptionForCustomer(input.userId) : null
    const normalizedSubscription = toBillingSubscription(subscription)
    const paidBySubscription = isActiveSubscriptionStatus(normalizedSubscription?.status)

    return {
      status: paidByBenefit || paidBySubscription ? "paid" : "unpaid",
      featureGateEnabled: env.polar.featureGateEnabled,
      subscriptionId: normalizedSubscription?.id ?? null,
      subscriptionStatus: normalizedSubscription?.status ?? null,
      currentPeriodEnd: normalizedSubscription?.currentPeriodEnd ?? null,
      source: paidByBenefit ? "benefit" : "subscription",
      note:
        note ??
        (normalizedSubscription
          ? "Subscription status resolved from Polar."
          : "No active billing record was found for this user."),
    }
  } catch (error) {
    return {
      status: "unavailable",
      featureGateEnabled: env.polar.featureGateEnabled,
      subscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      source: "unavailable",
      note: error instanceof Error ? error.message : "Billing lookup failed.",
    }
  }
}

export async function setCloudWorkerSubscriptionCancellation(
  input: CloudAccessInput,
  cancelAtPeriodEnd: boolean,
): Promise<CloudWorkerBillingSubscription | null> {
  if (!env.polar.featureGateEnabled) {
    return null
  }

  assertPaywallConfig()

  const activeSubscriptions = await listSubscriptionsByExternalCustomer(input.userId, {
    activeOnly: true,
    limit: 1,
  })
  const active = activeSubscriptions[0]
  if (!active?.id) {
    return null
  }

  const encodedId = encodeURIComponent(active.id)
  const { response, payload, text } = await polarFetchJson<PolarSubscription>(`/v1/subscriptions/${encodedId}`, {
    method: "PATCH",
    body: JSON.stringify({
      cancel_at_period_end: cancelAtPeriodEnd,
    }),
  })

  if (!response.ok) {
    throw new Error(`Polar subscription update failed (${response.status}): ${text.slice(0, 400)}`)
  }

  if (payload?.id) {
    return toBillingSubscription(payload)
  }

  const refreshed = await getSubscriptionById(active.id)
  return toBillingSubscription(refreshed)
}
