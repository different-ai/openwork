// Cost snapshot from models.dev pricing (src/models/base.json). Prices are USD
// per 1M tokens, so micro-USD per token equals the listed price.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type ModelPrice = {
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
  reasoning: number | null
}

export type PricingCatalog = {
  getModelPrice(providerId: string, modelId: string): ModelPrice | null
}

export type CostEstimateInput = {
  providerId: string
  modelId: string
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
  return {
    input,
    output,
    cacheRead: readPrice(model.cost.cache_read),
    cacheWrite: readPrice(model.cost.cache_write),
    reasoning: readPrice(model.cost.reasoning),
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
  const price = catalog.getModelPrice(input.providerId, input.modelId)
  if (!price) return null
  const microUsd =
    tokens(input.inputTokens) * price.input +
    tokens(input.outputTokens) * price.output +
    tokens(input.cacheReadTokens) * (price.cacheRead ?? price.input) +
    tokens(input.cacheWriteTokens) * (price.cacheWrite ?? price.input) +
    tokens(input.reasoningTokens) * (price.reasoning ?? price.output)
  return Math.round(microUsd)
}
