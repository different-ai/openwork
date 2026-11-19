import {
  createGatewayUsageLimits,
  gatewayProviderUsageLimitsEnabled,
  safeUsageDatabaseCode,
  type GatewayUsageScope,
  type GatewayUsageSnapshot,
} from "@openwork-ee/den-db/gateway-usage-limits"
import {
  gatewayAccountingUnavailableResponse,
  gatewayUsageLimitResponse,
} from "@openwork/types/den/gateway-usage-limits"
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import { loadPricingCatalogFromFile, type PricingCatalog } from "./pricing.js"

export type GatewayUsagePreflight = {
  protocol: GatewayRequestProtocol
  providerId: string
  modelId: string | null
  upstreamOrigin: string
  upstreamPath: string
  deferred: boolean
  /** The selected model row carries its own price (synced LiteLLM models). */
  priced?: boolean
  /** The organization's Gateway provider row, for per-provider limits. */
  inferenceProviderId?: string
}

export function isGatewayUsageAccountable(
  input: GatewayUsagePreflight,
  pricing: PricingCatalog | null,
): boolean {
  if (input.deferred || input.protocol === "passthrough" || input.modelId === null) return false

  const reportsCost =
    input.providerId === "openrouter" &&
    input.protocol === "openai_chat" &&
    input.upstreamOrigin === "https://openrouter.ai" &&
    input.upstreamPath === "/api/v1/chat/completions"

  return reportsCost || input.priced === true || pricing?.getModelPrice(input.providerId, input.modelId) != null
}

export type CheckGatewayUsage = (
  input: GatewayUsageScope & GatewayUsagePreflight & {
    requestId: string
    startedAt?: Date
    onAdmission?: (snapshot: GatewayUsageSnapshot) => void
  },
) => Promise<Response | null>

// The kill switch must take effect without a deploy, so the flag is only cached briefly.
const FEATURE_CACHE_MS = 10_000
const providerLimitsCache = new Map<string, { enabled: boolean; expiresAt: number }>()

async function providerLimitsEnabled(
  database: Parameters<typeof gatewayProviderUsageLimitsEnabled>[0],
  organizationId: string,
): Promise<boolean> {
  const now = Date.now()
  const cached = providerLimitsCache.get(organizationId)
  if (cached && cached.expiresAt > now) return cached.enabled
  const enabled = await gatewayProviderUsageLimitsEnabled(database, organizationId)
  if (providerLimitsCache.size > 10_000) providerLimitsCache.clear()
  providerLimitsCache.set(organizationId, { enabled, expiresAt: now + FEATURE_CACHE_MS })
  return enabled
}

export const checkGatewayUsage: CheckGatewayUsage = async (input) => {
  const started = performance.now()
  try {
    const { db } = await import("./db.js")
    let pricing: PricingCatalog | null = null
    try {
      pricing = loadPricingCatalogFromFile()
    } catch {
      console.warn("[gateway-usage]", { stage: "pricing_catalog", code: "CATALOG_UNAVAILABLE" })
    }

    const scope = { organizationId: input.organizationId, memberId: input.memberId }
    const accountable = isGatewayUsageAccountable(input, pricing)
    let providerLimits = false
    if (input.inferenceProviderId) {
      try {
        providerLimits = await providerLimitsEnabled(db, input.organizationId)
      } catch (error) {
        // Unknown flag state falls back to default limits, which stay enforced.
        console.warn("[gateway-usage]", { stage: "provider_limits_flag", code: safeUsageDatabaseCode(error) })
      }
    }
    const admission = await createGatewayUsageLimits(db).admit(scope, input.requestId, accountable, input.startedAt, {
      providerId: input.inferenceProviderId ?? null,
      providerLimits,
    })
    input.onAdmission?.(admission.snapshot)
    if (admission.accountingUnavailable) return gatewayAccountingUnavailableResponse()
    return gatewayUsageLimitResponse(admission.usage, admission.provider)
  } catch (error) {
    console.warn("[gateway-usage]", { stage: "admission", durationMs: Math.round(performance.now() - started), code: safeUsageDatabaseCode(error) })
    return gatewayAccountingUnavailableResponse()
  }
}
