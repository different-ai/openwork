import type { ModelsDevProvider } from "./models-dev.js"
import { validateInferenceUrl } from "@openwork-ee/utils/inference-egress"
import { inferenceCredentialEnvNames } from "@openwork-ee/utils/inference-credentials"
import { readProviderEnvNames, runtimeProviderEnvNames } from "./provider-credentials.js"

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
 * Snapshot of the catalog block persisted in `gateway_providers.provider_config`.
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

export function hasUnresolvedGatewayTemplate(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnresolvedGatewayTemplate)
  if (isRecord(value)) return Object.values(value).some(hasUnresolvedGatewayTemplate)
  if (typeof value !== "string") return false
  let decoded = value
  for (let pass = 0; pass < 4; pass++) {
    if (/[{}]|\$\(|\$[A-Za-z_][A-Za-z0-9_]*|<[A-Z_][A-Z0-9_]*>|%[A-Z_][A-Z0-9_]*%|process\.env\./.test(decoded)) return true
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return false
      decoded = next
    } catch { return true }
  }
  // Do not accept deeply encoded substitutions we could not inspect completely.
  return /%|[{}]|\$/.test(decoded)
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

export function gatewayModelConfigurationError(config: JsonRecord, models: JsonRecord[]): string | null {
  const npm = readProviderConfigNpm(config)
  for (const model of models) {
    const provider = isRecord(model.provider) ? model.provider : {}
    if ([model.npm, provider.npm].some((override) => override !== undefined && override !== npm)) {
      return "Selected models override the provider SDK. Use a separate gateway provider with the matching SDK."
    }
    if (hasUnresolvedGatewayTemplate({ provider, options: model.options })) {
      return "Model configuration contains unresolved environment/template dependencies."
    }
  }
  return null
}

/**
 * `settings.upstreamBaseUrl` (plan §4.1 "upstream base override") lets an
 * organization point the gateway at a regional host or a compatible
 * self-hosted endpoint instead of the catalog default. Non-secret; validated
 * here so a malformed value fails at create/update time rather than per
 * request. Returns the error message, or null when absent or valid.
 */
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
  // Share the gateway's operator-owned exceptions; settings cannot opt into private egress.
  url.hostname = url.hostname.replace(/\.$/, "")
  try {
    validateInferenceUrl(url, { base: true })
  } catch {
    return "settings.upstreamBaseUrl must use HTTPS and a public host or an operator-approved origin."
  }
  return null
}

/** Persist and expose only the documented non-secret settings. */
export function publicProviderSettings(settings: JsonRecord): JsonRecord {
  return Object.fromEntries(["project", "location", "resourceName", "apiVersion", "region", "upstreamBaseUrl"]
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
  row: { id: string; provider_config: JsonRecord; settings?: JsonRecord },
  baseUrl: string,
): JsonRecord {
  const url = gatewayProviderUrl(baseUrl, row.id)
  const npm = readProviderConfigNpm(row.provider_config)
  const swap = npm ? vertexDesktopSwap[npm] : undefined
  const config = nonSecretProviderConfig(row.provider_config)
  const options = isRecord(config.options) ? config.options : {}
  if (npm === "@ai-sdk/azure") {
    // Azure takes its destination settings as options, never as credential env values.
    for (const key of ["resourceName", "apiVersion"]) {
      if (typeof row.settings?.[key] === "string") options[key] = row.settings[key]
    }
  }
  const credentialEnv = swap?.env ?? (npm === "@ai-sdk/azure" ? ["AZURE_API_KEY"] : inferenceCredentialEnvNames(readProviderEnvNames(config)))
  const env = runtimeProviderEnvNames({ id: row.id, source: "openwork_gateway", providerConfig: { env: credentialEnv } })
  return {
    ...config,
    ...(swap ? { npm: swap.npm } : {}),
    env,
    api: url,
    options: { ...options, baseURL: url },
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
