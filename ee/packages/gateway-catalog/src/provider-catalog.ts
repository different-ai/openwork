import { BEDROCK_MANTLE_PROVIDER_ID, bedrockMantleApiPathsFromCatalog, withBedrockMantleProvider } from "@openwork-ee/gateway-catalog/bedrock-mantle"
import { withLiteLlmProvider } from "@openwork-ee/gateway-catalog/litellm"
import { MICROSOFT_FOUNDRY_PROVIDER_ID, withMicrosoftFoundryProvider } from "@openwork-ee/gateway-catalog/microsoft-foundry"
import { withTrueFoundryProvider } from "@openwork-ee/gateway-catalog/truefoundry"
import { GATEWAY_CUSTOM_PROVIDER_ID, GATEWAY_CUSTOM_PROVIDER_NPM } from "@openwork/types/den/gateway-custom-providers"

export type CatalogProvider = {
  npm: string | null
  api: string | null
  env: string[]
  modelApiPaths?: ReadonlyMap<string, string>
  requestHeaders?: readonly string[]
  family?: "microsoft_foundry"
}

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
    for (const [id, value] of Object.entries(withTrueFoundryProvider(withLiteLlmProvider(withMicrosoftFoundryProvider(withBedrockMantleProvider(raw)))))) {
      const provider = readCatalogProvider(value)
      if (!provider) continue
      const entry = id === BEDROCK_MANTLE_PROVIDER_ID ? { ...provider, modelApiPaths: bedrockMantleApiPathsFromCatalog(raw) }
        : id === MICROSOFT_FOUNDRY_PROVIDER_ID ? { ...provider, family: "microsoft_foundry" as const } : provider
      const requestHeaders = providerRequestHeaders.get(id)
      providers.set(id, requestHeaders ? { ...entry, requestHeaders } : entry)
    }
  }
  providers.set(GATEWAY_CUSTOM_PROVIDER_ID, gatewayCustomCatalogProvider)
  return {
    getCatalogProvider(providerId) {
      return providers.get(providerId) ?? null
    },
  }
}
