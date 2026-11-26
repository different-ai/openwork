import type { ModelsDevProvider } from "./models-dev.js"
import { GATEWAY_REQUEST_MODEL_HEADER } from "@openwork/types/den/gateway"
import { hasUnresolvedGatewayTemplate } from "@openwork/types/den/inference"
import { inferenceEgressAllowedOrigins, isAwsRegion, validateInferenceUrl } from "@openwork-ee/gateway-upstreams"
import { inferenceCredentialEnvNames, isMicrosoftFoundryOverrideAllowed } from "@openwork-ee/gateway-catalog"
import { readProviderEnvNames, runtimeProviderEnvNames } from "./provider-credentials.js"

export { gatewayModelConfigurationError, hasUnresolvedGatewayTemplate } from "@openwork/types/den/inference"

type JsonRecord = Record<string, unknown>

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

export function gatewayConfigurationError(config: JsonRecord, settings: JsonRecord): string | null {
  const options = isRecord(config.options) ? config.options : {}
  const endpointOverride = settings.upstreamBaseUrl
  const effective = {
    api: endpointOverride ?? config.api,
    options: endpointOverride === undefined ? options : { ...options, baseURL: endpointOverride },
  }
  return hasUnresolvedGatewayTemplate(effective)
    ? "Provider configuration contains unresolved environment/template dependencies. Set a concrete settings.upstreamBaseUrl or use a separately configured provider."
    : null
}

export function upstreamBaseUrlSettingError(settings: JsonRecord): string | null {
  const value = settings.upstreamBaseUrl
  if (value === undefined) {
    return null
  }
  if (typeof value !== "string" || !value.trim()) {
    return "settings.upstreamBaseUrl must be a non-empty http(s) URL."
  }
  if (hasUnresolvedGatewayTemplate(value)) return "settings.upstreamBaseUrl must be concrete, without environment/template substitutions."
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "settings.upstreamBaseUrl must be a valid absolute URL."
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "settings.upstreamBaseUrl must use http or https."
  }
  if (url.username || url.password || url.search || url.hash) {
    return "settings.upstreamBaseUrl must not carry credentials, a query string, or a fragment."
  }
  url.hostname = url.hostname.replace(/\.$/, "")
  try {
    validateInferenceUrl(url, { base: true })
  } catch {
    return "settings.upstreamBaseUrl must use HTTPS and a public host or an operator-approved origin."
  }
  return null
}

export function isAwsGatewayNpm(npm: string | null): boolean {
  return npm === "@ai-sdk/amazon-bedrock" || npm === "@ai-sdk/amazon-bedrock/mantle"
}

export function bedrockSettingsError(settings: JsonRecord, allowedOrigins = inferenceEgressAllowedOrigins()): string | null {
  if (!isAwsRegion(settings.region)) return "Amazon Bedrock requires an AWS region code such as us-east-1."
  const override = settings.upstreamBaseUrl
  if (override === undefined) return null
  const origin = (() => { try { return typeof override === "string" ? new URL(override).origin : null } catch { return null } })()
  return origin && allowedOrigins.has(origin) ? null : "Amazon Bedrock endpoints are derived from the region; a custom upstream URL must be an operator-approved origin."
}

export function microsoftFoundrySettingsError(settings: JsonRecord, allowedOrigins = inferenceEgressAllowedOrigins()): string | null {
  const override = settings.upstreamBaseUrl
  if (override === undefined) return null
  return isMicrosoftFoundryOverrideAllowed(settings.resourceName, override, allowedOrigins)
    ? null : "Microsoft Foundry endpoints are derived from the resource name; a custom upstream URL must be an operator-approved origin."
}

export function publicProviderSettings(settings: JsonRecord): JsonRecord {
  return Object.fromEntries(["project", "location", "resourceName", "apiVersion", "region", "upstreamBaseUrl", "guardrailIdentifier", "guardrailVersion"]
    .filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]))
}

export function nonSecretProviderConfig(config: JsonRecord): JsonRecord {
  const clean: JsonRecord = {}
  for (const [key, value] of Object.entries(config)) {
    if (/^(?:.*secret.*|.*password.*|.*credential.*|.*api[-_]?key|.*access[-_]?token|.*refresh[-_]?token|token|authorization|cookie)$/i.test(key)) continue
    if (key === "headers") {
      if (isRecord(value)) clean[key] = Object.fromEntries(Object.entries(value)
        .filter(([name]) => ["anthropic-version", "anthropic-beta", "openai-organization", "openai-project"].includes(name.toLowerCase())))
    } else {
      clean[key] = isRecord(value) ? nonSecretProviderConfig(value)
        : Array.isArray(value) ? value.map((entry) => isRecord(entry) ? nonSecretProviderConfig(entry) : entry) : value
    }
  }
  return clean
}

export function gatewayProviderUrl(baseUrl: string, inferenceProviderId: string) {
  const base = new URL(baseUrl)
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("invalid_inference_proxy_base_url")
  }
  return `${base.toString().replace(/\/+$/, "")}/api/v1/providers/${inferenceProviderId}`
}

const vertexDesktopSwap: Record<string, { npm: string; env: string[] }> = {
  "@ai-sdk/google-vertex": { npm: "@ai-sdk/google", env: ["GOOGLE_GENERATIVE_AI_API_KEY"] },
  "@ai-sdk/google-vertex/anthropic": { npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"] },
}

export function buildGatewayProviderConfig(
  row: { id: string; provider_config: JsonRecord; settings?: JsonRecord },
  baseUrl: string,
): JsonRecord {
  const url = gatewayProviderUrl(baseUrl, row.id)
  const npm = readProviderConfigNpm(row.provider_config)
  const swap = npm ? vertexDesktopSwap[npm] : undefined
  const config = nonSecretProviderConfig(row.provider_config)
  const options = isRecord(config.options) ? config.options : {}
  if (npm === "@ai-sdk/azure") {
    for (const key of ["resourceName", "apiVersion"]) {
      if (typeof row.settings?.[key] === "string") options[key] = row.settings[key]
    }
  }
  const credentialEnv = swap?.env ?? (npm === "@ai-sdk/azure" ? ["AZURE_API_KEY"]
    : isAwsGatewayNpm(npm) ? ["AWS_BEARER_TOKEN_BEDROCK"]
      : inferenceCredentialEnvNames(readProviderEnvNames(config)))
  const env = runtimeProviderEnvNames({ id: row.id, source: "openwork_gateway", providerConfig: { env: credentialEnv } })
  return {
    ...config,
    ...(swap ? { npm: swap.npm } : {}),
    env,
    api: url,
    options: { ...options, baseURL: url },
  }
}

export function buildGatewayModelConfig(model: { id: string; name: string; config: JsonRecord }): JsonRecord & { id: string } {
  const config = nonSecretProviderConfig(model.config)
  const swap = typeof config.npm === "string" ? vertexDesktopSwap[config.npm] : undefined
  if (swap) config.npm = swap.npm
  if (isRecord(config.provider)) {
    const providerSwap = typeof config.provider.npm === "string" ? vertexDesktopSwap[config.provider.npm] : undefined
    if (providerSwap) config.provider = { ...config.provider, npm: providerSwap.npm }
  }
  const headers = Object.fromEntries(Object.entries(isRecord(config.headers) ? config.headers : {})
    .filter(([name]) => name.toLowerCase() !== GATEWAY_REQUEST_MODEL_HEADER))
  return { ...config, id: model.id, name: model.name, headers: {
    ...headers,
    [GATEWAY_REQUEST_MODEL_HEADER]: model.id,
  } }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
