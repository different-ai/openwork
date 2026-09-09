// Cost snapshot from models.dev pricing (src/models/base.json). Prices are USD
// per 1M tokens, so micro-USD per token equals the listed price.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"

export type ModelPrice = {
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
  reasoning: number | null
  contextTiers?: { above: number; price: ModelPrice }[]
}

export type PricingCatalog = {
  getModelPrice(providerId: string, modelId: string): ModelPrice | null
}

export type CostEstimateInput = {
  providerId: string
  modelId: string
  protocol?: GatewayRequestProtocol
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
}

const baseJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "models", "base.json")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPrice(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function readModelPrice(model: unknown): ModelPrice | null {
  if (!isRecord(model) || !isRecord(model.cost)) return null
  const input = readPrice(model.cost.input)
  const output = readPrice(model.cost.output)
  if (input === null || output === null) return null
  const contextTiers: { above: number; price: ModelPrice }[] = []
  if (Array.isArray(model.cost.tiers)) {
    for (const entry of model.cost.tiers) {
      if (!isRecord(entry) || !isRecord(entry.tier) || entry.tier.type !== "context") continue
      const above = readPrice(entry.tier.size)
      const price = readModelPrice({ cost: { ...model.cost, ...entry, tiers: undefined, context_over_200k: undefined } })
      if (above !== null && price) contextTiers.push({ above, price })
    }
  } else if (isRecord(model.cost.context_over_200k)) {
    // Older catalog snapshots predate the explicit tier threshold.
    const price = readModelPrice({ cost: { ...model.cost, ...model.cost.context_over_200k, context_over_200k: undefined } })
    if (price) contextTiers.push({ above: 200_000, price })
  }
  return {
    input,
    output,
    cacheRead: readPrice(model.cost.cache_read),
    cacheWrite: readPrice(model.cost.cache_write),
    reasoning: readPrice(model.cost.reasoning),
    contextTiers: contextTiers.sort((a, b) => a.above - b.above),
  }
}

export function createPricingCatalog(raw: unknown): PricingCatalog {
  const prices = new Map<string, ModelPrice>()
  if (isRecord(raw)) {
    for (const [providerId, provider] of Object.entries(raw)) {
      if (!isRecord(provider) || !isRecord(provider.models)) continue
      for (const [modelId, model] of Object.entries(provider.models)) {
        const price = readModelPrice(model)
        if (price) prices.set(`${providerId}\u001f${modelId}`, price)
      }
    }
  }
  return {
    getModelPrice(providerId, modelId) {
      return prices.get(`${providerId}\u001f${modelId}`) ?? null
    },
  }
}

let fileCatalog: PricingCatalog | null = null

export function loadPricingCatalogFromFile(): PricingCatalog {
  if (!fileCatalog) {
    const parsed: unknown = JSON.parse(readFileSync(baseJsonPath, "utf8"))
    fileCatalog = createPricingCatalog(parsed)
  }
  return fileCatalog
}

function tokens(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

export function estimateCostMicroUsd(input: CostEstimateInput, catalog: PricingCatalog = loadPricingCatalogFromFile()): number | null {
  let price = catalog.getModelPrice(input.providerId, input.modelId)
  if (!price) return null
  // Optional detail counters may be absent, but partial primary usage must not
  // become an apparently complete (and under-priced) cost.
  if (input.inputTokens === null || input.outputTokens === null
    || Object.values(input).some((value) => typeof value === "number" && (!Number.isFinite(value) || value < 0))) return null
  const disjointCache = input.protocol === "anthropic_messages" || input.protocol === "bedrock_converse"
    || (!input.protocol && (input.providerId === "anthropic" || input.providerId === "amazon-bedrock" || input.providerId === "google-vertex-anthropic"))
  const cache = tokens(input.cacheReadTokens) + tokens(input.cacheWriteTokens)
  const contextTokens = input.inputTokens + (disjointCache ? cache : 0)
  const uncachedInput = input.inputTokens - (disjointCache ? 0 : cache)
  if (uncachedInput < 0) return null
  for (const tier of price.contextTiers ?? []) if (contextTokens > tier.above) price = tier.price
  // Only Gemini reports thoughts separately from output. Anthropic and OpenAI
  // already include reasoning in their output counters.
  const separateReasoning = input.protocol === "google_generate_content"
  const microUsd =
    uncachedInput * price.input +
    tokens(input.outputTokens) * price.output +
    tokens(input.cacheReadTokens) * (price.cacheRead ?? price.input) +
    tokens(input.cacheWriteTokens) * (price.cacheWrite ?? price.input) +
    (separateReasoning ? tokens(input.reasoningTokens) * (price.reasoning ?? price.output) : 0)
  return Number.isSafeInteger(Math.round(microUsd)) ? Math.round(microUsd) : null
}
