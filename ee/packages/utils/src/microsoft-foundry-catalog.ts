/**
 * Claude on Microsoft Foundry speaks the Anthropic Messages API at
 * `https://<resource>.services.ai.azure.com/anthropic/v1`. models.dev lists those
 * models under `azure` with a model-level `@ai-sdk/anthropic` override, while the
 * Gateway routes one SDK per provider. Den and the Gateway both derive a separate
 * `microsoft-foundry` provider from those models with this one function, as for
 * Bedrock Mantle. A real upstream `microsoft-foundry` entry always wins.
 */

export const MICROSOFT_FOUNDRY_PROVIDER_ID = "microsoft-foundry"
export const MICROSOFT_FOUNDRY_NPM = "@ai-sdk/anthropic"
export const MICROSOFT_FOUNDRY_NAME = "Microsoft Foundry (Claude)"
/** The Foundry SDK's own variable names; the resource name comes from provider settings. */
export const MICROSOFT_FOUNDRY_ENV = ["ANTHROPIC_FOUNDRY_API_KEY"] as const
const SOURCE_PROVIDER_IDS = ["azure", "azure-cognitive-services"] as const

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Foundry resource names: Azure Cognitive Services custom subdomains. */
export function isMicrosoftFoundryResourceName(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(value) && !value.endsWith("-")
}

/** The only upstream a Microsoft Foundry provider may reach, from a validated resource name. */
export function microsoftFoundryBaseUrl(resourceName: unknown): string | null {
  return isMicrosoftFoundryResourceName(resourceName) ? `https://${resourceName.toLowerCase()}.services.ai.azure.com/anthropic/v1` : null
}

function isFoundryAnthropicModel(model: unknown): model is JsonRecord {
  if (!isRecord(model)) return false
  const provider = isRecord(model.provider) ? model.provider : null
  const npm = provider?.npm ?? model.npm
  const api = provider?.api ?? model.api
  return npm === MICROSOFT_FOUNDRY_NPM && typeof api === "string"
    && /^https:\/\/\$\{[A-Z_]+\}\.services\.ai\.azure\.com\/anthropic\/v1\/?$/.test(api)
}

/**
 * The synthetic provider, or null when no source has Foundry Claude models. Model
 * configs keep everything except the endpoint template: the Gateway derives the
 * destination from the provider's resource name.
 */
export function deriveMicrosoftFoundryProvider(catalog: JsonRecord): JsonRecord | null {
  const models: JsonRecord = {}
  for (const sourceId of SOURCE_PROVIDER_IDS) {
    const source = catalog[sourceId]
    if (!isRecord(source) || !isRecord(source.models)) continue
    for (const [key, model] of Object.entries(source.models)) {
      if (!isFoundryAnthropicModel(model) || Object.hasOwn(models, key)) continue
      const { npm: _npm, api: _api, provider, ...rest } = model
      const { api: _providerApi, npm: _providerNpm, ...providerRest } = isRecord(provider) ? provider : {}
      models[key] = { ...rest, provider: { ...providerRest, npm: MICROSOFT_FOUNDRY_NPM } }
    }
  }
  if (!Object.keys(models).length) return null
  return {
    id: MICROSOFT_FOUNDRY_PROVIDER_ID,
    name: MICROSOFT_FOUNDRY_NAME,
    npm: MICROSOFT_FOUNDRY_NPM,
    env: [...MICROSOFT_FOUNDRY_ENV],
    doc: "https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry",
    models,
  }
}

/** The catalog plus the derived provider. Never replaces an upstream entry with the same id. */
export function withMicrosoftFoundryProvider(catalog: JsonRecord): JsonRecord {
  if (Object.hasOwn(catalog, MICROSOFT_FOUNDRY_PROVIDER_ID)) return catalog
  const derived = deriveMicrosoftFoundryProvider(catalog)
  return derived ? { ...catalog, [MICROSOFT_FOUNDRY_PROVIDER_ID]: derived } : catalog
}
