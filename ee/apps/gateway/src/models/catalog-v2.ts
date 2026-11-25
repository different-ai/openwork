import { readFileSync } from "node:fs"
import path from "node:path"
import {
  CatalogValidationError,
  MODELS_SOURCE_DIR,
  readBaseCatalog,
  readCustomProviders,
  readOpenworkProvider,
  type JsonRecord,
  type ModelsCatalog,
} from "./catalog.ts"

export const OPENWORK_PROVIDER_DOC = "https://openworklabs.com/docs/ai-gateway/openwork-models"

type ApiRoute = { readonly protocol: string; readonly aisdk: string; readonly opencodeai: string }

export const V2_ROUTES: Readonly<Record<string, ApiRoute>> = {
  "@ai-sdk/openai-compatible": { protocol: "chat-completions", aisdk: "@ai-sdk/openai-compatible", opencodeai: "@opencode/ai/providers/openai-compatible" },
  "@ai-sdk/openai": { protocol: "responses", aisdk: "@ai-sdk/openai", opencodeai: "@opencode/ai/providers/openai/responses" },
  "@ai-sdk/anthropic": { protocol: "messages", aisdk: "@ai-sdk/anthropic", opencodeai: "@opencode/ai/providers/anthropic" },
  "@ai-sdk/mistral": { protocol: "chat-completions", aisdk: "@ai-sdk/mistral", opencodeai: "@opencode/ai/providers/mistral" },
  "@ai-sdk/google": { protocol: "generate-content", aisdk: "@ai-sdk/google", opencodeai: "@opencode/ai/providers/google" },
  "@openrouter/ai-sdk-provider": { protocol: "chat-completions", aisdk: "@openrouter/ai-sdk-provider", opencodeai: "@opencode/ai/providers/openrouter" },
}

const REASONING_FIELDS: readonly string[] = ["reasoning", "reasoning_content", "reasoning_text", "reasoning_details"]
const REASONING_EFFORTS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]
const MODEL_TYPES: readonly string[] = ["chat", "image", "video", "embedding", "reranking", "decision", "transcription", "speech", "realtime", "extraction", "audio"]
const STATUSES: readonly string[] = ["alpha", "beta", "deprecated"]

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"))
}

function compact(record: Record<string, unknown>): JsonRecord {
  const out: JsonRecord = {}
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value
  return out
}

export function readBaseCatalogV2(sourceDir: string = MODELS_SOURCE_DIR): ModelsCatalog {
  const base = readJson(path.join(sourceDir, "base-v2.json"))
  if (!isRecord(base)) throw new CatalogValidationError(["base-v2.json: must be an object keyed by provider id"])
  const catalog: ModelsCatalog = {}
  for (const [id, provider] of Object.entries(base)) if (isRecord(provider)) catalog[id] = provider
  return catalog
}

export function knownFamilies(baseV2: ModelsCatalog): Set<string> {
  const families = new Set<string>()
  for (const provider of Object.values(baseV2)) {
    if (!isRecord(provider.models)) continue
    for (const model of Object.values(provider.models)) {
      if (isRecord(model) && typeof model.family === "string") families.add(model.family)
    }
  }
  return families
}

function modalitiesV2(value: unknown): JsonRecord {
  const list = (items: unknown) =>
    Array.isArray(items) ? [...new Set(items.filter(isNonEmptyString).map((item) => (item === "pdf" ? "application/pdf" : item)))] : []
  const modalities = isRecord(value) ? value : {}
  const input = list(modalities.input)
  const output = list(modalities.output)
  return { input: input.length > 0 ? input : ["text"], output: output.length > 0 ? output : ["text"] }
}

function reasoningV2(model: JsonRecord): JsonRecord {
  if (model.reasoning !== true) return { supported: false }
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options.filter(isRecord) : []
  const effort = options.find((option) => option.type === "effort")
  const budget = options.find((option) => option.type === "budget_tokens")
  const efforts = effort && Array.isArray(effort.values)
    ? effort.values.filter((value): value is string => typeof value === "string" && REASONING_EFFORTS.includes(value))
    : []
  return compact({
    supported: true,
    toggle: options.some((option) => option.type === "toggle") ? true : undefined,
    effort: efforts.length > 0 ? efforts : undefined,
    budget: budget ? compact({ min: isNumber(budget.min) ? budget.min : undefined, max: isNumber(budget.max) ? budget.max : undefined }) : undefined,
  })
}

function cacheV2(read: unknown, write: unknown): JsonRecord | undefined {
  const cache = compact({ read: isNumber(read) ? read : undefined, write: isNumber(write) ? write : undefined })
  return Object.keys(cache).length > 0 ? cache : undefined
}

function costV2(value: unknown): JsonRecord | undefined {
  if (!isRecord(value) || !isNumber(value.input) || !isNumber(value.output)) return undefined
  const tiers: { size: number; prices: JsonRecord }[] = []
  if (Array.isArray(value.tiers)) {
    for (const tier of value.tiers) {
      if (isRecord(tier) && isRecord(tier.tier) && isNumber(tier.tier.size)) tiers.push({ size: tier.tier.size, prices: tier })
    }
  } else if (isRecord(value.context_over_200k)) {
    tiers.push({ size: 200_000, prices: value.context_over_200k })
  }
  const inputOverrides = tiers.map(({ size, prices }) =>
    compact({ when: { context: { gt: size } }, price: isNumber(prices.input) ? prices.input : undefined, cache: cacheV2(prices.cache_read, prices.cache_write) }),
  )
  const outputOverrides = tiers.map(({ size, prices }) =>
    compact({ when: { context: { gt: size } }, price: isNumber(prices.output) ? prices.output : undefined }),
  )
  return {
    text: {
      input: compact({
        price: value.input,
        cache: cacheV2(value.cache_read, value.cache_write),
        overrides: inputOverrides.length > 0 ? inputOverrides : undefined,
      }),
      output: compact({
        price: value.output,
        reasoning: isNumber(value.reasoning) ? value.reasoning : undefined,
        overrides: outputOverrides.length > 0 ? outputOverrides : undefined,
      }),
    },
  }
}

function limitV2(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined
  const limit = compact({
    context: isNumber(value.context) ? value.context : undefined,
    input: isNumber(value.input) ? value.input : undefined,
    output: isNumber(value.output) ? value.output : undefined,
  })
  return Object.keys(limit).length > 0 ? limit : undefined
}

function interleavedField(value: unknown): string | undefined {
  const field = typeof value === "string" ? value : isRecord(value) ? value.field : undefined
  return typeof field === "string" && REASONING_FIELDS.includes(field) ? field : undefined
}

export type ModelV2Context = {
  readonly provider: JsonRecord
  readonly families: ReadonlySet<string>
  readonly describe?: (modelId: string) => string | undefined
}

export function modelToV2(model: JsonRecord, context: ModelV2Context): JsonRecord {
  const npm = String(context.provider.npm)
  const route = V2_ROUTES[npm]
  if (!route) throw new CatalogValidationError([`${String(context.provider.id)}: no v2 route for npm package ${npm}`])
  const id = String(model.id)
  const name = String(model.name)
  const description = isNonEmptyString(model.description) ? model.description : (context.describe?.(id) ?? name)
  const toolCall = model.tool_call === true
  const reasoningField = interleavedField(model.interleaved)
  return compact({
    id,
    canonical_id: isNonEmptyString(model.canonical_model_id) ? model.canonical_model_id : undefined,
    type: "chat",
    name,
    description,
    family: typeof model.family === "string" && context.families.has(model.family) ? model.family : undefined,
    open_weights: model.open_weights === true,
    knowledge: isNonEmptyString(model.knowledge) ? model.knowledge : undefined,
    release_date: model.release_date,
    last_updated: isNonEmptyString(model.last_updated) ? model.last_updated : model.release_date,
    status: typeof model.status === "string" && STATUSES.includes(model.status) ? model.status : undefined,
    modalities: modalitiesV2(model.modalities),
    capabilities: compact({
      tools: { supported: toolCall },
      reasoning: reasoningV2(model),
      structured_output: typeof model.structured_output === "boolean" ? model.structured_output : undefined,
      temperature: typeof model.temperature === "boolean" ? model.temperature : undefined,
      system_updates: false,
      effort_updates: false,
    }),
    limit: limitV2(model.limit),
    cost: costV2(model.cost),
    api: {
      [route.protocol]: compact({
        base_url: String(context.provider.api),
        sdk: { aisdk: route.aisdk, opencodeai: route.opencodeai },
        compatibility: reasoningField && route.protocol === "chat-completions" ? { reasoning_field: reasoningField } : undefined,
        capabilities: toolCall ? { tools: { updates: false } } : undefined,
      }),
    },
  })
}

export function providerToV2(
  provider: JsonRecord,
  context: { readonly families: ReadonlySet<string>; readonly doc?: string; readonly describe?: (modelId: string) => string | undefined },
): JsonRecord {
  const models: JsonRecord = {}
  if (isRecord(provider.models)) {
    for (const [id, model] of Object.entries(provider.models)) {
      if (isRecord(model)) models[id] = modelToV2(model, { provider, families: context.families, describe: context.describe })
    }
  }
  return {
    id: provider.id,
    name: provider.name,
    doc: isNonEmptyString(provider.doc) ? provider.doc : (context.doc ?? String(provider.api)),
    env: Array.isArray(provider.env) ? [...provider.env] : [],
    models,
  }
}

function describeFrom(provider: JsonRecord | undefined) {
  return (modelId: string) => {
    const model = provider && isRecord(provider.models) ? provider.models[modelId] : undefined
    return isRecord(model) && isNonEmptyString(model.description) ? model.description : undefined
  }
}

export function validateProviderV2(providerId: string, provider: unknown): string[] {
  const problems: string[] = []
  const where = `v2 ${providerId}`
  if (!isRecord(provider)) return [`${where}: must be an object`]
  if (provider.id !== providerId) problems.push(`${where}: id must equal its key`)
  if (!isNonEmptyString(provider.name)) problems.push(`${where}: name is required`)
  if (!isNonEmptyString(provider.doc)) problems.push(`${where}: doc is required`)
  if (!Array.isArray(provider.env) || !provider.env.every(isNonEmptyString)) problems.push(`${where}: env must be a list of names`)
  for (const key of ["npm", "api"]) if (key in provider) problems.push(`${where}: v2 providers have no ${key}`)
  if (!isRecord(provider.models) || Object.keys(provider.models).length === 0) {
    problems.push(`${where}: models must list at least one model`)
    return problems
  }
  for (const [modelId, model] of Object.entries(provider.models)) {
    const at = `${where} › ${modelId}`
    if (!isRecord(model)) {
      problems.push(`${at}: must be an object`)
      continue
    }
    if (model.id !== modelId) problems.push(`${at}: id must equal its key`)
    if (typeof model.type !== "string" || !MODEL_TYPES.includes(model.type)) problems.push(`${at}: type is not a models.dev v2 type`)
    for (const key of ["name", "description", "release_date", "last_updated"]) {
      if (!isNonEmptyString(model[key])) problems.push(`${at}: ${key} is required`)
    }
    if (typeof model.open_weights !== "boolean") problems.push(`${at}: open_weights must be true or false`)
    if (!isRecord(model.modalities) || !Array.isArray(model.modalities.input) || !Array.isArray(model.modalities.output)) {
      problems.push(`${at}: modalities.input and modalities.output are required`)
    }
    const capabilities = model.capabilities
    if (
      !isRecord(capabilities) ||
      !isRecord(capabilities.tools) ||
      typeof capabilities.tools.supported !== "boolean" ||
      !isRecord(capabilities.reasoning) ||
      typeof capabilities.reasoning.supported !== "boolean" ||
      typeof capabilities.system_updates !== "boolean" ||
      typeof capabilities.effort_updates !== "boolean"
    ) {
      problems.push(`${at}: capabilities need tools.supported, reasoning.supported, system_updates and effort_updates`)
    }
    if (!isRecord(model.api) || Object.keys(model.api).length === 0) {
      problems.push(`${at}: api must list at least one protocol`)
      continue
    }
    for (const [protocol, entry] of Object.entries(model.api)) {
      if (!isRecord(entry) || !isNonEmptyString(entry.base_url) || !URL.canParse(entry.base_url)) {
        problems.push(`${at}: api.${protocol}.base_url must be a URL`)
      }
    }
  }
  return problems
}

export function readPublishedCatalogV2(openworkApi: string, sourceDir: string = MODELS_SOURCE_DIR): ModelsCatalog {
  const baseV2 = readBaseCatalogV2(sourceDir)
  const families = knownFamilies(baseV2)
  const custom = readCustomProviders(readBaseCatalog(sourceDir), sourceDir)
  const taken = Object.keys(baseV2)
  const problems: string[] = []
  const converted: ModelsCatalog = {}
  for (const [id, provider] of Object.entries(custom)) {
    if (taken.includes(id)) problems.push(`providers › ${id}: provider id is already used by base-v2.json`)
    converted[id] = providerToV2(provider, { families })
  }
  const openwork = readOpenworkProvider(openworkApi, sourceDir).openwork
  converted.openwork = providerToV2(openwork, {
    families,
    doc: OPENWORK_PROVIDER_DOC,
    describe: describeFrom(baseV2.openrouter),
  })
  for (const [id, provider] of Object.entries(converted)) problems.push(...validateProviderV2(id, provider))
  if (problems.length > 0) throw new CatalogValidationError(problems)
  return { ...baseV2, ...converted }
}
