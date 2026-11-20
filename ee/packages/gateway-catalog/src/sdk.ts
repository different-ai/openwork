/**
 * The provider SDK packages AI Gateway can proxy, keyed by the models.dev `npm`
 * package, and the protocol family each one speaks. Den API (create-time
 * checks), Den Web (provider picker) and the Gateway (routing) all read this one
 * table. A package missing here is rejected as `unsupported_provider`.
 */
export type ProtocolFamily =
  | "anthropic"
  | "openai"
  | "mistral"
  | "azure"
  | "openai_compatible"
  | "google"
  | "google_vertex"
  | "google_vertex_anthropic"
  | "bedrock"
  | "bedrock_mantle"
  /** Claude on Microsoft Foundry: the Anthropic Messages API on `<resource>.services.ai.azure.com/anthropic`. */
  | "microsoft_foundry"

// Bedrock requests are re-signed with SigV4 by the Gateway.
export const GATEWAY_SDK_FAMILIES = {
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/openai": "openai",
  "@ai-sdk/mistral": "mistral",
  "@ai-sdk/azure": "azure",
  "@ai-sdk/openai-compatible": "openai_compatible",
  "@openrouter/ai-sdk-provider": "openai_compatible",
  "@ai-sdk/google": "google",
  "@ai-sdk/google-vertex": "google_vertex",
  "@ai-sdk/google-vertex/anthropic": "google_vertex_anthropic",
  "@ai-sdk/amazon-bedrock": "bedrock",
  "@ai-sdk/amazon-bedrock/mantle": "bedrock_mantle",
} as const satisfies Record<string, ProtocolFamily>

export type SupportedGatewayNpm = keyof typeof GATEWAY_SDK_FAMILIES

export const SUPPORTED_GATEWAY_NPM_PACKAGES = Object.keys(GATEWAY_SDK_FAMILIES) as readonly SupportedGatewayNpm[]

export function isSupportedGatewayNpm(npm: string | null | undefined): npm is SupportedGatewayNpm {
  return typeof npm === "string" && Object.hasOwn(GATEWAY_SDK_FAMILIES, npm)
}

export function gatewaySdkFamily(npm: string | null | undefined): ProtocolFamily | null {
  return isSupportedGatewayNpm(npm) ? GATEWAY_SDK_FAMILIES[npm] : null
}

/**
 * Where a family sends requests when the provider names no upstream. Families
 * whose address depends on settings (Azure resource, AWS region, Foundry
 * resource) are resolved by the Gateway and have no fixed default.
 */
export const GATEWAY_FAMILY_DEFAULT_BASE_URLS: Partial<Record<ProtocolFamily, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  mistral: "https://api.mistral.ai/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
}

/** The fixed default upstream for an SDK package, or null when it has none. */
export function gatewaySdkDefaultBaseUrl(npm: string | null | undefined): string | null {
  const family = gatewaySdkFamily(npm)
  return family ? GATEWAY_FAMILY_DEFAULT_BASE_URLS[family] ?? null : null
}
