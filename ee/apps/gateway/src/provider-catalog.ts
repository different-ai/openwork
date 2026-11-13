// Provider catalog (src/models/base.json from models.dev plus the custom
// providers in src/models/providers), read once and exposed as
// npm/api/env per provider id. The gateway classifies protocols from `npm`.
import { BEDROCK_MANTLE_PROVIDER_ID, bedrockMantleApiPathsFromCatalog, withBedrockMantleProvider } from "@openwork-ee/utils/bedrock-mantle-catalog"
import { withLiteLlmProvider } from "@openwork-ee/utils/litellm-catalog"
import { withTrueFoundryProvider } from "@openwork-ee/utils/truefoundry-catalog"
import { MICROSOFT_FOUNDRY_PROVIDER_ID, withMicrosoftFoundryProvider } from "@openwork-ee/utils/microsoft-foundry-catalog"
import { GATEWAY_CUSTOM_PROVIDER_ID, GATEWAY_CUSTOM_PROVIDER_NPM } from "@openwork/types/den/gateway-custom-providers"
import { readProviderCatalog } from "./models/catalog.js"

export type CatalogProvider = {
  npm: string | null
  api: string | null
  env: string[]
  /** Upstream API path per model id (Bedrock Mantle serves models under /v1 or /openai/v1). */
  modelApiPaths?: ReadonlyMap<string, string>
  /** A protocol family the SDK package alone does not identify (Claude on Microsoft Foundry speaks @ai-sdk/anthropic). */
  family?: "microsoft_foundry"
  /** Request headers this provider's own API requires, forwarded beyond its protocol family's allowlist. */
  requestHeaders?: readonly string[]
}

// OpenCode Zen and Go reject a request without the session headers OpenCode
// sends its own providers.
const opencodeRequestHeaders = ["x-opencode-session", "x-opencode-request", "x-opencode-project", "x-opencode-client"]
const providerRequestHeaders = new Map<string, readonly string[]>([
  ["opencode", opencodeRequestHeaders],
  ["opencode-go", opencodeRequestHeaders],
])

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
      const entry = id === BEDROCK_MANTLE_PROVIDER_ID ? { ...provider, modelApiPaths: bedrockMantleApiPathsFromCatalog(raw) }
        : id === MICROSOFT_FOUNDRY_PROVIDER_ID ? { ...provider, family: "microsoft_foundry" as const } : provider
      const requestHeaders = providerRequestHeaders.get(id)
      providers.set(id, requestHeaders ? { ...entry, requestHeaders } : entry)
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

let fileCatalog: ProviderCatalog | null = null

export function loadProviderCatalogFromFile(): ProviderCatalog {
  if (!fileCatalog) {
    const parsed: unknown = readProviderCatalog()
    fileCatalog = createProviderCatalog(parsed)
  }
  return fileCatalog
}

export function getCatalogProvider(providerId: string) {
  return loadProviderCatalogFromFile().getCatalogProvider(providerId)
}
