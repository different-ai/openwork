import { and, eq } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderModelTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { parseGatewayModelAlias } from "@openwork-ee/gateway-catalog"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import type { RunnerTurn } from "../headless-runner/client.js"

export async function headlessRunPricing(organizationId: string, modelId: string) {
  const selected = parseGatewayModelAlias(modelId)
  if (!selected) return null
  const [catalog] = await db.$primary.select({ providerId: GatewayProviderTable.provider_id, config: GatewayProviderModelTable.model_config })
    .from(GatewayProviderModelTable)
    .innerJoin(GatewayProviderTable, eq(GatewayProviderTable.id, GatewayProviderModelTable.gateway_provider_id))
    .where(and(eq(GatewayProviderTable.organization_id, normalizeDenTypeId("organization", organizationId)),
      eq(GatewayProviderModelTable.id, selected.gatewayProviderModelId))).limit(1)
  return catalog ? { model: { modelId, providerId: catalog.providerId }, rates: catalog.config.cost } : null
}

function rate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

export function headlessRunCostMicros(rates: unknown, usage: RunnerTurn["usage"]): number | null {
  if (!usage || typeof rates !== "object" || rates === null || !("input" in rates) || !("output" in rates)) return null
  const input = rate(rates.input)
  const output = rate(rates.output)
  const cached = "cache_read" in rates ? rate(rates.cache_read) : null
  if (input === null || output === null || (usage.cachedInputTokens > 0 && cached === null)) return null
  if (("tiers" in rates && Array.isArray(rates.tiers) && rates.tiers.length > 0) || "context_over_200k" in rates) return null
  if (usage.cachedInputTokens > usage.inputTokens) return null
  const micros = Math.round((usage.inputTokens - usage.cachedInputTokens) * input + usage.cachedInputTokens * (cached ?? 0) + usage.outputTokens * output)
  return Number.isSafeInteger(micros) && micros >= 0 ? micros : null
}
