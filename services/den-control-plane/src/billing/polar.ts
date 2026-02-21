import { env } from "../env.js"

type PolarCustomerState = {
  granted_benefits?: Array<{
    benefit_id?: string
  }>
}

type PolarCheckoutSession = {
  url?: string
}

export type CloudWorkerAccess =
  | {
      allowed: true
    }
  | {
      allowed: false
      checkoutUrl: string
    }

type CloudAccessInput = {
  userId: string
  email: string
  name: string
}

function sanitizeApiBase(value: string) {
  return value.replace(/\/+$/, "")
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

async function getCustomerState(externalCustomerId: string): Promise<PolarCustomerState | null> {
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

  return text ? (JSON.parse(text) as PolarCustomerState) : null
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

export async function requireCloudWorkerAccess(input: CloudAccessInput): Promise<CloudWorkerAccess> {
  if (!env.polar.featureGateEnabled) {
    return { allowed: true }
  }

  assertPaywallConfig()

  const state = await getCustomerState(input.userId)
  if (hasRequiredBenefit(state)) {
    return { allowed: true }
  }

  const checkoutUrl = await createCheckoutSession(input)
  return {
    allowed: false,
    checkoutUrl,
  }
}
