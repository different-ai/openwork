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

export const GATEWAY_CUSTOM_ENV = ["OPENWORK_CUSTOM_API_KEY"] as const

export function readCustomProviderSettings(settings: JsonRecord): GatewayCustomProviderSettings | null {
  const parsed = gatewayCustomProviderSettingsSchema.safeParse(settings.custom)
  return parsed.success ? parsed.data : null
}

export function customProviderSettingsOf(provider: { provider_id: string; settings: JsonRecord }): GatewayCustomProviderSettings | null {
  return isGatewayCustomProviderId(provider.provider_id) ? readCustomProviderSettings(provider.settings) : null
}

export function customProviderConfig(name: string): JsonRecord {
  return { id: GATEWAY_CUSTOM_PROVIDER_ID, name, npm: GATEWAY_CUSTOM_PROVIDER_NPM, env: [...GATEWAY_CUSTOM_ENV] }
}

export function customModelConfig(model: GatewayCustomModel): JsonRecord & { id: string; name: string } {
  return { ...model, id: model.id, name: model.name ?? model.id }
}

export function customCatalogModels(models: readonly GatewayCustomModel[]): ModelsDevModel[] {
  return models.map((model) => ({ id: model.id, name: model.name ?? model.id, config: customModelConfig(model) }))
}

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

export function checkCustomBaseUrl(input: string): CustomBaseUrlCheck {
  const baseUrl = normalizeGatewayCustomBaseUrl(input)
  if (!baseUrl) return { ok: false, message: "Enter the provider's API address, for example https://api.example.com/v1." }
  const error = upstreamBaseUrlSettingError({ upstreamBaseUrl: baseUrl })
  if (error) return { ok: false, message: "Use a public HTTPS address. Private networks (localhost, 10.x, internal hosts) need your OpenWork operator to approve the address first." }
  return { ok: true, baseUrl }
}

export function sameCustomOrigin(left: string, right: string): boolean {
  try { return new URL(left).origin === new URL(right).origin } catch { return false }
}

export function customProviderStatus(provider: { provider_id: string; settings: JsonRecord }, hasKey: boolean): GatewayCustomProviderStatus | undefined {
  const settings = customProviderSettingsOf(provider)
  if (!settings) return undefined
  const baseUrl = typeof provider.settings.upstreamBaseUrl === "string" ? provider.settings.upstreamBaseUrl : ""
  return { baseUrl, models: settings.catalog, discovery: settings.discovery, hasKey }
}
