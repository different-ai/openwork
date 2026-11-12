// The model catalog's sources, read and validated in one place:
//   base.json            the models.dev snapshot (Update Models workflow)
//   providers/*.json     custom providers we add by hand, one file each
//   openwork-models.json the OpenWork provider's models (added by build-models.mjs)
//
// The gateway (pricing, provider catalog) and scripts/build-models.mjs (the
// published models.openworklabs.com/api.json) both read base + custom providers
// from here, so Den and the gateway always see the same providers.
//
// Node runs this file directly with type stripping (scripts/build-models.mjs),
// so it may only use erasable TypeScript and node: built-ins.
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type JsonRecord = Record<string, unknown>
export type ModelsCatalog = Record<string, JsonRecord>

/** Provider ids a custom provider file may never use: added by build-models.mjs or derived in code. */
export const RESERVED_PROVIDER_IDS: readonly string[] = [
  "openwork",
  "amazon-bedrock-mantle",
  "microsoft-foundry",
  "litellm",
]

/** SDK packages the gateway can proxy that a custom provider may use (Den's SUPPORTED_GATEWAY_NPM_PACKAGES, minus cloud-specific ones). */
export const CUSTOM_PROVIDER_NPM_PACKAGES: readonly string[] = [
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/mistral",
  "@ai-sdk/google",
  "@openrouter/ai-sdk-provider",
]

/** Effort values OpenWork understands (AUTO_ROUTER_THINKING_LEVELS without `default`). */
export const REASONING_EFFORT_VALUES: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
const REASONING_OPTION_TYPES: readonly string[] = ["toggle", "effort", "budget_tokens"]

// From src/models (tsx) or dist/models (compiled), the JSON sources stay in src/models.
export const MODELS_SOURCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "models")

export class CatalogValidationError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid model catalog source:\n  - ${problems.join("\n  - ")}`)
    this.name = "CatalogValidationError"
    this.problems = problems
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isNonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

const DATE = /^\d{4}-\d{2}(?:-\d{2})?$/
const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function validateReasoningOptions(where: string, value: unknown, problems: string[]) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    problems.push(`${where}: reasoning_options must be a list`)
    return
  }
  for (const option of value) {
    if (!isRecord(option) || typeof option.type !== "string" || !REASONING_OPTION_TYPES.includes(option.type)) {
      problems.push(`${where}: reasoning_options entries need a type of ${REASONING_OPTION_TYPES.join(", ")}`)
      continue
    }
    if (option.type === "effort") {
      if (!isNonEmptyStringList(option.values)) {
        problems.push(`${where}: effort reasoning option needs a non-empty values list`)
        continue
      }
      for (const effort of option.values) {
        if (!REASONING_EFFORT_VALUES.includes(effort)) {
          problems.push(`${where}: effort value "${effort}" is not one of ${REASONING_EFFORT_VALUES.join(", ")}`)
        }
      }
    }
    if (option.type === "budget_tokens") {
      for (const key of ["min", "max"]) {
        if (option[key] !== undefined && !(typeof option[key] === "number" && Number.isInteger(option[key]) && option[key] >= 0)) {
          problems.push(`${where}: budget_tokens ${key} must be a whole number`)
        }
      }
    }
  }
}

function validateCustomModel(where: string, modelId: string, model: unknown, problems: string[]) {
  if (!isRecord(model)) {
    problems.push(`${where}: must be an object`)
    return
  }
  if (model.id !== modelId) problems.push(`${where}: id must equal its key "${modelId}"`)
  if (!isNonEmptyString(model.name)) problems.push(`${where}: name is required`)
  for (const flag of ["attachment", "reasoning", "tool_call", "temperature"]) {
    if (typeof model[flag] !== "boolean") problems.push(`${where}: ${flag} must be true or false`)
  }
  for (const flag of ["structured_output", "open_weights"]) {
    if (model[flag] !== undefined && typeof model[flag] !== "boolean") problems.push(`${where}: ${flag} must be true or false`)
  }
  for (const date of ["release_date", "last_updated"]) {
    if (typeof model[date] !== "string" || !DATE.test(model[date])) problems.push(`${where}: ${date} must be YYYY-MM-DD`)
  }
  if (!isRecord(model.modalities) || !isNonEmptyStringList(model.modalities.input) || !isNonEmptyStringList(model.modalities.output)) {
    problems.push(`${where}: modalities.input and modalities.output must be non-empty lists`)
  }
  if (!isRecord(model.limit) || !isPositiveInteger(model.limit.context) || !isPositiveInteger(model.limit.output)) {
    problems.push(`${where}: limit.context and limit.output must be positive whole numbers`)
  } else if (model.limit.output > model.limit.context) {
    problems.push(`${where}: limit.output cannot exceed limit.context`)
  }
  const deprecated = model.status === "deprecated"
  if (model.cost === undefined) {
    if (!deprecated) problems.push(`${where}: cost.input and cost.output are required (USD per 1M tokens) unless status is "deprecated"`)
  } else if (!isRecord(model.cost) || !isPrice(model.cost.input) || !isPrice(model.cost.output)) {
    problems.push(`${where}: cost.input and cost.output must be prices (USD per 1M tokens)`)
  } else {
    for (const key of ["cache_read", "cache_write", "reasoning"]) {
      if (model.cost[key] !== undefined && !isPrice(model.cost[key])) problems.push(`${where}: cost.${key} must be a price`)
    }
  }
  if (model.status !== undefined && !["alpha", "beta", "deprecated"].includes(String(model.status))) {
    problems.push(`${where}: status must be alpha, beta or deprecated`)
  }
  validateReasoningOptions(where, model.reasoning_options, problems)
}

/**
 * Problems with one custom provider file's contents, as readable lines. The
 * file is a models.dev-shaped object keyed by provider id; `taken` holds the
 * ids already used by base.json and earlier files.
 */
export function validateCustomProviderFile(file: string, contents: unknown, taken: ReadonlySet<string>): string[] {
  const problems: string[] = []
  if (!isRecord(contents) || Object.keys(contents).length === 0) {
    return [`${file}: must be an object keyed by provider id`]
  }
  for (const [providerId, provider] of Object.entries(contents)) {
    const where = `${file} › ${providerId}`
    if (!PROVIDER_ID.test(providerId)) problems.push(`${where}: provider id must be lowercase letters, digits and dashes`)
    if (RESERVED_PROVIDER_IDS.includes(providerId)) problems.push(`${where}: provider id is reserved`)
    else if (taken.has(providerId)) problems.push(`${where}: provider id is already used by base.json or another provider file`)
    if (!isRecord(provider)) {
      problems.push(`${where}: must be an object`)
      continue
    }
    if (provider.id !== providerId) problems.push(`${where}: id must equal its key "${providerId}"`)
    if (!isNonEmptyString(provider.name)) problems.push(`${where}: name is required`)
    if (!isNonEmptyStringList(provider.env) || !provider.env.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))) {
      problems.push(`${where}: env must list the API key variable names, e.g. ["EXAMPLE_API_KEY"]`)
    }
    if (typeof provider.npm !== "string" || !CUSTOM_PROVIDER_NPM_PACKAGES.includes(provider.npm)) {
      problems.push(`${where}: npm must be one of ${CUSTOM_PROVIDER_NPM_PACKAGES.join(", ")}`)
    }
    if (!isNonEmptyString(provider.api) || !URL.canParse(provider.api) || new URL(provider.api).protocol !== "https:") {
      problems.push(`${where}: api must be an https:// URL`)
    }
    if (provider.doc !== undefined && (!isNonEmptyString(provider.doc) || !URL.canParse(provider.doc))) {
      problems.push(`${where}: doc must be a URL`)
    }
    if (!isRecord(provider.models) || Object.keys(provider.models).length === 0) {
      problems.push(`${where}: models must list at least one model`)
      continue
    }
    for (const [modelId, model] of Object.entries(provider.models)) {
      validateCustomModel(`${where} › ${modelId}`, modelId, model, problems)
    }
  }
  return problems
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"))
}

export function readBaseCatalog(sourceDir: string = MODELS_SOURCE_DIR): ModelsCatalog {
  const base = readJson(path.join(sourceDir, "base.json"))
  if (!isRecord(base)) throw new CatalogValidationError(["base.json: must be an object keyed by provider id"])
  const catalog: ModelsCatalog = {}
  for (const [id, provider] of Object.entries(base)) if (isRecord(provider)) catalog[id] = provider
  return catalog
}

/**
 * Every providers/*.json file, validated, in file-name order. Throws one
 * CatalogValidationError listing every problem, so a bad file fails the build
 * instead of silently dropping a provider.
 */
export function readCustomProviders(base: ModelsCatalog, sourceDir: string = MODELS_SOURCE_DIR): ModelsCatalog {
  const providersDir = path.join(sourceDir, "providers")
  let files: string[]
  try {
    files = readdirSync(providersDir).filter((name) => name.endsWith(".json")).sort()
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {}
    throw error
  }
  const taken = new Set(Object.keys(base))
  const custom: ModelsCatalog = {}
  const problems: string[] = []
  for (const file of files) {
    let contents: unknown
    try {
      contents = readJson(path.join(providersDir, file))
    } catch (error) {
      problems.push(`providers/${file}: ${error instanceof Error ? error.message : "is not valid JSON"}`)
      continue
    }
    const fileProblems = validateCustomProviderFile(`providers/${file}`, contents, taken)
    problems.push(...fileProblems)
    if (!isRecord(contents)) continue
    for (const [id, provider] of Object.entries(contents)) {
      // Claim ids even from a failing file, so later clashes are reported too.
      taken.add(id)
      if (fileProblems.length === 0 && isRecord(provider)) custom[id] = provider
    }
  }
  if (problems.length > 0) throw new CatalogValidationError(problems)
  return custom
}

/** base.json plus every custom provider: the catalog the gateway serves from. */
export function readProviderCatalog(sourceDir: string = MODELS_SOURCE_DIR): ModelsCatalog {
  const base = readBaseCatalog(sourceDir)
  return { ...base, ...readCustomProviders(base, sourceDir) }
}

/** The OpenWork provider built from openwork-models.json, served by the OpenWork inference API at `api`. */
export function readOpenworkProvider(api: string, sourceDir: string = MODELS_SOURCE_DIR): ModelsCatalog {
  const models = readJson(path.join(sourceDir, "openwork-models.json"))
  if (!isRecord(models)) throw new CatalogValidationError(["openwork-models.json: must be an object keyed by model id"])
  return {
    openwork: {
      id: "openwork",
      env: ["OPENWORK_API_KEY"],
      npm: "@openrouter/ai-sdk-provider",
      name: "OpenWork Models",
      api,
      models,
    },
  }
}

/** The published catalog (models-site/models/api.json): base, custom providers, then OpenWork. */
export function readPublishedCatalog(openworkApi: string, sourceDir: string = MODELS_SOURCE_DIR): ModelsCatalog {
  return { ...readProviderCatalog(sourceDir), ...readOpenworkProvider(openworkApi, sourceDir) }
}
