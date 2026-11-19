/**
 * Stored state of AI Gateway custom OpenAI-compatible providers and the catalog derived from it. A custom provider
 * is a gateway_providers row with provider_id GATEWAY_CUSTOM_PROVIDER_ID; its
 * models live in settings.custom.catalog, never in models.dev. Kept free of
 * gateway-matrix imports so the matrix can resolve the catalog without a cycle.
 */
import {
  GATEWAY_CUSTOM_PROVIDER_ID,
  GATEWAY_CUSTOM_PROVIDER_NPM,
  gatewayCustomProviderSettingsSchema,
  isGatewayCustomProviderId,
  normalizeGatewayCustomBaseUrl,
  type GatewayCustomModel,
  type GatewayCustomProviderSettings,
  type GatewayCustomProviderStatus,
} from "@openwork/types/den/gateway-custom-providers"
import { upstreamBaseUrlSettingError } from "./inference-provider-config.js"
import type { ModelsDevModel, ModelsDevProvider } from "./models-dev.js"

type JsonRecord = Record<string, unknown>

/**
 * Declared credential env name. Gateway rows are delivered with names scoped to
 * the row (`IPR_<id>_OPENWORK_CUSTOM_API_KEY`, see runtimeProviderEnvTag), so
 * several custom providers never share a slot or shadow a member's own key.
 */
export const GATEWAY_CUSTOM_ENV = ["OPENWORK_CUSTOM_API_KEY"] as const

export function readCustomProviderSettings(settings: JsonRecord): GatewayCustomProviderSettings | null {
  const parsed = gatewayCustomProviderSettingsSchema.safeParse(settings.custom)
  return parsed.success ? parsed.data : null
}

/** The custom-provider settings of a row, or null for any other provider. */
export function customProviderSettingsOf(provider: { provider_id: string; settings: JsonRecord }): GatewayCustomProviderSettings | null {
  return isGatewayCustomProviderId(provider.provider_id) ? readCustomProviderSettings(provider.settings) : null
}

/** gateway_providers.provider_config for a custom provider (no URL: the gateway reads settings.upstreamBaseUrl). */
export function customProviderConfig(name: string): JsonRecord {
  return { id: GATEWAY_CUSTOM_PROVIDER_ID, name, npm: GATEWAY_CUSTOM_PROVIDER_NPM, env: [...GATEWAY_CUSTOM_ENV] }
}

/** The stored model config: the models.dev record shape catalog models use, with id and name. */
export function customModelConfig(model: GatewayCustomModel): JsonRecord & { id: string; name: string } {
  return { ...model, id: model.id, name: model.name ?? model.id }
}

export function customCatalogModels(models: readonly GatewayCustomModel[]): ModelsDevModel[] {
  return models.map((model) => ({ id: model.id, name: model.name ?? model.id, config: customModelConfig(model) }))
}

/** Catalog provider for the gateway matrix, from settings.custom.catalog. Null when the settings are unreadable. */
export function customCatalogProvider(provider: { name: string; settings: JsonRecord }): ModelsDevProvider | null {
  const settings = readCustomProviderSettings(provider.settings)
  if (!settings) return null
  const config = customProviderConfig(provider.name)
  return {
    id: GATEWAY_CUSTOM_PROVIDER_ID, name: provider.name, npm: GATEWAY_CUSTOM_PROVIDER_NPM, env: [...GATEWAY_CUSTOM_ENV], doc: null, api: null,
    config,
    models: customCatalogModels(settings.catalog),
  }
}

export type CustomBaseUrlCheck = { ok: true; baseUrl: string } | { ok: false; message: string }

/**
 * Normalizes an admin-entered base URL (drops a trailing /chat/completions,
 * /completions or /) and applies the same egress rule as
 * settings.upstreamBaseUrl: public HTTPS, or an operator-approved origin.
 */
export function checkCustomBaseUrl(input: string): CustomBaseUrlCheck {
  const baseUrl = normalizeGatewayCustomBaseUrl(input)
  if (!baseUrl) return { ok: false, message: "Enter the provider's API address, for example https://api.example.com/v1." }
  const error = upstreamBaseUrlSettingError({ upstreamBaseUrl: baseUrl })
  if (error) return { ok: false, message: "Use a public HTTPS address. Private networks (localhost, 10.x, internal hosts) need your OpenWork operator to approve the address first." }
  return { ok: true, baseUrl }
}

/** A saved key may only be sent to the origin it was saved for; another host needs the key entered again. */
export function sameCustomOrigin(left: string, right: string): boolean {
  try { return new URL(left).origin === new URL(right).origin } catch { return false }
}

/** Manage view. Never includes the key. */
export function customProviderStatus(provider: { provider_id: string; settings: JsonRecord }, hasKey: boolean): GatewayCustomProviderStatus | undefined {
  const settings = customProviderSettingsOf(provider)
  if (!settings) return undefined
  const baseUrl = typeof provider.settings.upstreamBaseUrl === "string" ? provider.settings.upstreamBaseUrl : ""
  return { baseUrl, models: settings.catalog, discovery: settings.discovery, hasKey }
}
