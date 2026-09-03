import type { ModelsDevProvider } from "./models-dev.js"

type JsonRecord = Record<string, unknown>

/**
 * models.dev `npm` packages the inference gateway can proxy (plan §5.3 minus
 * Bedrock, which needs SigV4 re-signing and is deferred). Anything else is
 * rejected at create time with `unsupported_provider`.
 */
export const SUPPORTED_GATEWAY_NPM_PACKAGES = [
  "@ai-sdk/anthropic",
  "@ai-sdk/openai",
  "@ai-sdk/azure",
  "@ai-sdk/openai-compatible",
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/google-vertex/anthropic",
] as const

export type SupportedGatewayNpm = (typeof SUPPORTED_GATEWAY_NPM_PACKAGES)[number]

export function isSupportedGatewayNpm(npm: string | null): npm is SupportedGatewayNpm {
  return npm !== null && SUPPORTED_GATEWAY_NPM_PACKAGES.some((entry) => entry === npm)
}

/**
 * Snapshot of the catalog block persisted in `inference_providers.provider_config`.
 * Kept upstream-shaped (no gateway URL) because the gateway reads
 * `options.baseURL` / `api` from it as the upstream base.
 */
export function buildProviderConfigSnapshot(provider: ModelsDevProvider): JsonRecord {
  const snapshot: JsonRecord = {
    id: provider.id,
    name: provider.name,
    npm: provider.npm,
    env: provider.env,
  }
  if (provider.api) {
    snapshot.api = provider.api
  }
  if (isRecord(provider.config.options)) {
    snapshot.options = provider.config.options
  }
  return snapshot
}

export function readProviderConfigNpm(providerConfig: JsonRecord): string | null {
  return typeof providerConfig.npm === "string" && providerConfig.npm.trim() ? providerConfig.npm : null
}

export function gatewayProviderUrl(baseUrl: string, inferenceProviderId: string) {
  return `${baseUrl.replace(/\/+$/, "")}/api/v1/providers/${inferenceProviderId}`
}

/**
 * `@ai-sdk/google-vertex*` mint Google tokens client-side and cannot take a
 * static bearer, so the desktop gets the plain-key SDK and the gateway adapts
 * the request (plan §5.6).
 */
const vertexDesktopSwap: Record<string, { npm: string; env: string[] }> = {
  "@ai-sdk/google-vertex": { npm: "@ai-sdk/google", env: ["GOOGLE_GENERATIVE_AI_API_KEY"] },
  "@ai-sdk/google-vertex/anthropic": { npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"] },
}

/**
 * Rewrite a stored provider config into the opencode block the desktop
 * materializes: `api` and `options.baseURL` point at the gateway, Vertex SDKs
 * are swapped for their static-key equivalents. Pure; never touches secrets.
 */
export function buildGatewayProviderConfig(
  row: { id: string; provider_config: JsonRecord },
  baseUrl: string,
): JsonRecord {
  const url = gatewayProviderUrl(baseUrl, row.id)
  const npm = readProviderConfigNpm(row.provider_config)
  const swap = npm ? vertexDesktopSwap[npm] : undefined
  const options = isRecord(row.provider_config.options) ? row.provider_config.options : {}
  return {
    ...row.provider_config,
    ...(swap ? { npm: swap.npm, env: swap.env } : {}),
    api: url,
    options: { ...options, baseURL: url },
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
