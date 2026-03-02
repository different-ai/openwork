import { env } from "../env.js"

type PolarCustomerState = {
  granted_benefits?: Array<{
    benefit_id?: string
  }>
}

type PolarCheckoutSession = {
  url?: string
}

type PolarCustomer = {
  id?: string
  email?: string
  external_id?: string | null
}

type PolarCustomerList = {
  items?: PolarCustomer[]
}

export type CloudWorkerAccess =
  | {
      allowed: true
    }
  | {
      allowed: false
      checkoutUrl: string
    }

export type CloudWorkerBillingStatus = {
  featureGateEnabled: boolean
  hasActivePlan: boolean
  checkoutRequired: boolean
  checkoutUrl: string | null
}

type CloudAccessInput = {
  userId: string
  email: string
  name: string
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
  const response = await polarFetch(`/v1/customers/external/${encodedExternalId}/state`, {
    method: "GET",
  })

  if (response.status === 404) {
    return null
  }

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Polar customer state lookup failed (${response.status}): ${text.slice(0, 400)}`)
  }

  return parseJson<PolarCustomerState>(text)
}

async function getCustomerStateById(customerId: string): Promise<PolarCustomerState | null> {
  const encodedCustomerId = encodeURIComponent(customerId)
  const response = await polarFetch(`/v1/customers/${encodedCustomerId}/state`, {
    method: "GET",
  })

  if (response.status === 404) {
    return null
  }

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Polar customer state lookup by ID failed (${response.status}): ${text.slice(0, 400)}`)
  }

  return parseJson<PolarCustomerState>(text)
}

async function getCustomerByEmail(email: string): Promise<PolarCustomer | null> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) {
    return null
  }

  const encodedEmail = encodeURIComponent(normalizedEmail)
  const response = await polarFetch(`/v1/customers/?email=${encodedEmail}`, {
    method: "GET",
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Polar customer lookup by email failed (${response.status}): ${text.slice(0, 400)}`)
  }

  const payload = parseJson<PolarCustomerList>(text)
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
    external_customer_id: input.userId,
    customer_email: input.email,
    customer_name: input.name,
  }

  const response = await polarFetch("/v1/checkouts/", {
    method: "POST",
    body: JSON.stringify(payload),
  })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`Polar checkout creation failed (${response.status}): ${text.slice(0, 400)}`)
  }

  const checkout = text ? (JSON.parse(text) as PolarCheckoutSession) : null
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
  options: { includeCheckoutUrl?: boolean } = {},
): Promise<CloudWorkerBillingStatus> {
  const evaluation = await evaluateCloudWorkerAccess(input, {
    includeCheckoutUrl: options.includeCheckoutUrl,
  })

  return {
    featureGateEnabled: evaluation.featureGateEnabled,
    hasActivePlan: evaluation.hasActivePlan,
    checkoutRequired: evaluation.featureGateEnabled && !evaluation.hasActivePlan,
    checkoutUrl: evaluation.checkoutUrl,
  }
}
