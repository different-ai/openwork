// A models.dev-shaped catalog exposed as npm/api/env per provider id, with the
// derived Bedrock Mantle, Microsoft Foundry, LiteLLM and TrueFoundry providers
// and the synthetic custom-provider entry. The Gateway classifies protocols
// from `npm`; it reads the catalog file itself (ee/apps/gateway/src/provider-catalog.ts).
import { BEDROCK_MANTLE_PROVIDER_ID, bedrockMantleApiPathsFromCatalog, withBedrockMantleProvider } from "@openwork-ee/gateway-catalog/bedrock-mantle"
import { withLiteLlmProvider } from "@openwork-ee/gateway-catalog/litellm"
import { MICROSOFT_FOUNDRY_PROVIDER_ID, withMicrosoftFoundryProvider } from "@openwork-ee/gateway-catalog/microsoft-foundry"
import { withTrueFoundryProvider } from "@openwork-ee/gateway-catalog/truefoundry"
import { GATEWAY_CUSTOM_PROVIDER_ID, GATEWAY_CUSTOM_PROVIDER_NPM } from "@openwork/types/den/gateway-custom-providers"

export type CatalogProvider = {
  npm: string | null
  api: string | null
  env: string[]
  /** Upstream API path per model id (Bedrock Mantle serves models under /v1 or /openai/v1). */
  modelApiPaths?: ReadonlyMap<string, string>
  /** A protocol family the SDK package alone does not identify (Claude on Microsoft Foundry speaks @ai-sdk/anthropic). */
  family?: "microsoft_foundry"
}

export type ProviderCatalog = {
  getCatalogProvider(providerId: string): CatalogProvider | null
}

/**
 * Custom OpenAI-compatible providers are not
 * in models.dev. Every such row shares this synthetic, address-less entry: the
 * upstream always comes from the row's `settings.upstreamBaseUrl`, which must be
 * a public HTTPS address or an operator-allowlisted origin.
 */
export const GATEWAY_CUSTOM_PROVIDER_ENV = "OPENWORK_CUSTOM_API_KEY"
export const gatewayCustomCatalogProvider: CatalogProvider = { npm: GATEWAY_CUSTOM_PROVIDER_NPM, api: null, env: [GATEWAY_CUSTOM_PROVIDER_ENV] }


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readCatalogProvider(value: unknown): CatalogProvider | null {
  if (!isRecord(value)) return null
  return {
    npm: typeof value.npm === "string" ? value.npm : null,
    api: typeof value.api === "string" ? value.api : null,
    env: Array.isArray(value.env) ? value.env.filter((name): name is string => typeof name === "string") : [],
  }
}

export function createProviderCatalog(raw: unknown): ProviderCatalog {
  const providers = new Map<string, CatalogProvider>()
  if (isRecord(raw)) {
    // Same derivation as Den's catalog, so both see one amazon-bedrock-mantle and
    // one microsoft-foundry provider, and synthetic, modelless litellm and truefoundry providers.
    for (const [id, value] of Object.entries(withTrueFoundryProvider(withLiteLlmProvider(withMicrosoftFoundryProvider(withBedrockMantleProvider(raw)))))) {
      const provider = readCatalogProvider(value)
      if (!provider) continue
      providers.set(id, id === BEDROCK_MANTLE_PROVIDER_ID ? { ...provider, modelApiPaths: bedrockMantleApiPathsFromCatalog(raw) }
        : id === MICROSOFT_FOUNDRY_PROVIDER_ID ? { ...provider, family: "microsoft_foundry" } : provider)
    }
  }
  // A real upstream entry with this id never replaces the synthetic one: its address would bypass the custom-provider rules.
  providers.set(GATEWAY_CUSTOM_PROVIDER_ID, gatewayCustomCatalogProvider)
  return {
    getCatalogProvider(providerId) {
      return providers.get(providerId) ?? null
    },
  }
}
