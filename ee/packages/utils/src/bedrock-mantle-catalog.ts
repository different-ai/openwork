/**
 * Amazon Bedrock Mantle (the OpenAI-compatible Bedrock endpoint) models are
 * listed by models.dev under `amazon-bedrock` with a model-level
 * `@ai-sdk/amazon-bedrock/mantle` SDK override. The gateway routes one SDK per
 * provider, so Den and the gateway both derive a separate
 * `amazon-bedrock-mantle` provider from those models with this one function.
 * A real upstream `amazon-bedrock-mantle` entry always wins over the derivation.
 */

export const BEDROCK_PROVIDER_ID = "amazon-bedrock"
export const BEDROCK_MANTLE_PROVIDER_ID = "amazon-bedrock-mantle"
export const BEDROCK_MANTLE_NPM = "@ai-sdk/amazon-bedrock/mantle"
export const BEDROCK_MANTLE_NAME = "Amazon Bedrock (OpenAI)"
/** Mantle's own SDK default; used when a model does not name its API path. */
export const BEDROCK_MANTLE_DEFAULT_API_PATH = "/v1"

const mantleApiPaths = new Set(["/v1", "/openai/v1"])

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function modelProvider(model: JsonRecord): JsonRecord | null {
  return isRecord(model.provider) ? model.provider : null
}

function isMantleModel(model: unknown): model is JsonRecord {
  return isRecord(model) && (model.npm === BEDROCK_MANTLE_NPM || modelProvider(model)?.npm === BEDROCK_MANTLE_NPM)
}

/**
 * The API path of a catalog Mantle endpoint template such as
 * `https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1`. Only the host
 * pattern and a known path are accepted: the region always comes from the
 * provider settings, never from the catalog.
 */
export function bedrockMantleApiPath(api: unknown): string | null {
  if (typeof api !== "string") return null
  const match = /^https:\/\/bedrock-mantle\.(?:\$\{AWS_REGION\}|[a-z]{2}(?:-[a-z]+)+-\d{1,2})\.api\.aws(\/[a-z0-9/]*?)\/?$/.exec(api)
  const path = match?.[1]
  return path && mantleApiPaths.has(path) ? path : null
}

/** Model id → API path for a provider's Mantle models. */
export function bedrockMantleModelApiPaths(models: unknown): Map<string, string> {
  const paths = new Map<string, string>()
  if (!isRecord(models)) return paths
  for (const [key, model] of Object.entries(models)) {
    if (!isMantleModel(model)) continue
    const path = bedrockMantleApiPath(modelProvider(model)?.api ?? model.api)
    if (path) paths.set(typeof model.id === "string" ? model.id : key, path)
  }
  return paths
}

/**
 * The synthetic provider, or null when the source has no Mantle models. Model
 * configs keep everything except the per-model endpoint template (the gateway
 * owns the destination), so Den can store and the desktop can load them.
 */
export function deriveBedrockMantleProvider(catalog: JsonRecord): JsonRecord | null {
  const source = catalog[BEDROCK_PROVIDER_ID]
  if (!isRecord(source) || !isRecord(source.models)) return null
  const models: JsonRecord = {}
  for (const [key, model] of Object.entries(source.models)) {
    if (!isMantleModel(model)) continue
    const { npm: _npm, api: _api, provider, ...rest } = model
    const { api: _providerApi, npm: _providerNpm, ...providerRest } = isRecord(provider) ? provider : {}
    models[key] = { ...rest, provider: { ...providerRest, npm: BEDROCK_MANTLE_NPM } }
  }
  if (!Object.keys(models).length) return null
  return {
    id: BEDROCK_MANTLE_PROVIDER_ID,
    name: BEDROCK_MANTLE_NAME,
    npm: BEDROCK_MANTLE_NPM,
    env: ["AWS_BEARER_TOKEN_BEDROCK"],
    ...(typeof source.doc === "string" ? { doc: source.doc } : {}),
    models,
  }
}

/** The catalog plus the derived provider. Never replaces an upstream entry with the same id. */
export function withBedrockMantleProvider(catalog: JsonRecord): JsonRecord {
  if (Object.hasOwn(catalog, BEDROCK_MANTLE_PROVIDER_ID)) return catalog
  const derived = deriveBedrockMantleProvider(catalog)
  return derived ? { ...catalog, [BEDROCK_MANTLE_PROVIDER_ID]: derived } : catalog
}

/**
 * API paths for the catalog's Mantle provider: from its own models when
 * models.dev ships the id, otherwise from the Bedrock models it was derived from.
 */
export function bedrockMantleApiPathsFromCatalog(catalog: JsonRecord): Map<string, string> {
  const upstream = catalog[BEDROCK_MANTLE_PROVIDER_ID]
  if (isRecord(upstream)) return bedrockMantleModelApiPaths(upstream.models)
  const source = catalog[BEDROCK_PROVIDER_ID]
  return isRecord(source) ? bedrockMantleModelApiPaths(source.models) : new Map()
}
