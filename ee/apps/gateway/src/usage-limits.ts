import {
  createGatewayUsageLimits,
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

  return reportsCost || pricing?.getModelPrice(input.providerId, input.modelId) != null
}

export type CheckGatewayUsage = (
  input: GatewayUsageScope & GatewayUsagePreflight & {
    requestId: string
    startedAt?: Date
    onAdmission?: (snapshot: GatewayUsageSnapshot) => void
  },
) => Promise<Response | null>

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
    const admission = await createGatewayUsageLimits(db).admit(scope, input.requestId, accountable, input.startedAt)
    input.onAdmission?.(admission.snapshot)
    if (admission.accountingUnavailable) return gatewayAccountingUnavailableResponse()
    return gatewayUsageLimitResponse(admission.usage)
  } catch (error) {
    console.warn("[gateway-usage]", { stage: "admission", durationMs: Math.round(performance.now() - started), code: safeUsageDatabaseCode(error) })
    return gatewayAccountingUnavailableResponse()
  }
}
