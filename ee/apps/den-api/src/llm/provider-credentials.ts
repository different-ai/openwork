import { readProviderEnvNames, selectPrimaryCredentialEnvName, selectLegacyScalarCredentialEnvName } from "@openwork/types/managed-provider-config"
export { readProviderEnvNames, selectPrimaryCredentialEnvName, selectLegacyScalarCredentialEnvName } from "@openwork/types/managed-provider-config"
import { aiSdkEnvSetting } from "@openwork-ee/utils/ai-sdk-env-settings"
import { isAwsRegion } from "@openwork-ee/gateway-upstreams"

type JsonRecord = Record<string, unknown>

export class ProviderCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderCredentialError"
  }
}

export type DecodedProviderCredential = {
  apiKey: string | null
  apiKeys: Record<string, string> | null
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const RUNTIME_ENV_TAG_LENGTH = 5

export function runtimeProviderEnvTag(providerRowId: string): string {
  if (providerRowId.startsWith("ipr_")) return providerRowId.toUpperCase().replace(/[^A-Z0-9]/g, "_")
  const tail = providerRowId.replace(/[^0-9A-Za-z]/g, "").toUpperCase().slice(-RUNTIME_ENV_TAG_LENGTH)
  return `LPR_${tail}`
}

export type RuntimeEnvProvider = {
  id: string
  source: string
  providerConfig: JsonRecord
}

export function usesRuntimeProviderEnvTag(provider: Pick<RuntimeEnvProvider, "source">): boolean {
  return provider.source === "models_dev" || provider.source === "openwork_gateway"
}

export function runtimeProviderEnvName(provider: Pick<RuntimeEnvProvider, "id" | "source">, declaredName: string): string {
  return usesRuntimeProviderEnvTag(provider) ? `${runtimeProviderEnvTag(provider.id)}_${declaredName}` : declaredName
}

export function runtimeProviderEnvNames(provider: RuntimeEnvProvider): string[] {
  return readProviderEnvNames(provider.providerConfig).map((name) => runtimeProviderEnvName(provider, name))
}

export function runtimeProviderSdkOptions(
  provider: RuntimeEnvProvider,
  apiKeys: Record<string, string> | null | undefined,
): JsonRecord {
  const declaredNames = readProviderEnvNames(provider.providerConfig)
  if (!usesRuntimeProviderEnvTag(provider) || declaredNames.length < 2 || !apiKeys) return {}
  const options: JsonRecord = {}
  for (const name of declaredNames) {
    const setting = aiSdkEnvSetting(name)
    if (!setting || Object.hasOwn(options, setting) || !apiKeys[name]?.trim()) continue
    options[setting] = `{env:${runtimeProviderEnvName(provider, name)}}`
  }
  return options
}

export function toRuntimeProviderEnv<T extends RuntimeEnvProvider & { apiKeys?: Record<string, string> | null }>(provider: T): T {
  if (!usesRuntimeProviderEnvTag(provider) || provider.providerConfig.env === undefined) return provider
  const sdkOptions = runtimeProviderSdkOptions(provider, provider.apiKeys)
  const declaredOptions = isRecord(provider.providerConfig.options) ? provider.providerConfig.options : {}
  const providerConfig: JsonRecord = {
    ...provider.providerConfig,
    env: runtimeProviderEnvNames(provider),
    ...(Object.keys(sdkOptions).length > 0 ? { options: { ...sdkOptions, ...declaredOptions } } : {}),
  }
  if (!provider.apiKeys) return { ...provider, providerConfig }
  const apiKeys = Object.fromEntries(
    Object.entries(provider.apiKeys).map(([name, value]) => [runtimeProviderEnvName(provider, name), value]),
  )
  return { ...provider, providerConfig, apiKeys }
}

function parseCredentialMap(stored: string): Record<string, string> | null {
  if (!stored.startsWith("{")) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return null
  }

  if (!isRecord(parsed)) {
    return null
  }

  const entries = Object.entries(parsed)
  if (entries.length === 0 || !entries.every(([, value]) => typeof value === "string")) {
    return null
  }

  return parsed as Record<string, string>
}

export function decodeProviderCredential(stored: string | null): DecodedProviderCredential {
  const trimmed = stored?.trim() ?? ""
  if (!trimmed) {
    return { apiKey: null, apiKeys: null }
  }

  const apiKeys = parseCredentialMap(trimmed)
  if (apiKeys) {
    return { apiKey: null, apiKeys }
  }

  return { apiKey: trimmed, apiKeys: null }
}

export function bedrockCredentialError(providerConfig: JsonRecord, storedCredential: string | null): string | null {
  if (providerConfig.npm !== "@ai-sdk/amazon-bedrock" || !storedCredential) return null
  return isAwsRegion(decodeProviderCredential(storedCredential).apiKeys?.AWS_REGION)
    ? null
    : "Amazon Bedrock requires AWS_REGION set to an AWS region code such as us-east-1."
}

export function listConfiguredEnvKeys(stored: string | null, envNames: string[]): string[] {
  const credential = decodeProviderCredential(stored)
  if (credential.apiKeys) {
    const keys = Object.keys(credential.apiKeys)
    return [
      ...envNames.filter((name) => keys.includes(name)),
      ...keys.filter((key) => !envNames.includes(key)),
    ]
  }

  if (credential.apiKey) {
    const envName = selectLegacyScalarCredentialEnvName(envNames)
    return envName ? [envName] : []
  }

  return []
}

export function resolveProviderCredential(input: {
  envNames: string[]
  existing: { value: string | null; envNames: string[] } | null
  apiKey?: string
  apiKeys?: Record<string, string>
}): string | null {
  const existingValue = input.existing?.value ?? null

  if (input.apiKeys !== undefined) {
    for (const key of Object.keys(input.apiKeys)) {
      if (!input.envNames.includes(key)) {
        throw new ProviderCredentialError(
          `${key} is not one of this provider's env keys (${input.envNames.join(", ") || "none"}).`,
        )
      }
    }

    const existing = decodeProviderCredential(existingValue)
    const values: Record<string, string> = { ...(existing.apiKeys ?? {}) }
    if (!existing.apiKeys && existing.apiKey) {
      const legacyEnvName = selectLegacyScalarCredentialEnvName(input.existing?.envNames ?? [])
      if (legacyEnvName) {
        values[legacyEnvName] = existing.apiKey
      }
    }

    for (const [key, value] of Object.entries(input.apiKeys)) {
      const trimmed = value.trim()
      if (trimmed) {
        values[key] = trimmed
      } else {
        delete values[key]
      }
    }

    for (const key of Object.keys(values)) {
      if (!input.envNames.includes(key)) {
        delete values[key]
      }
    }

    if (input.envNames.length <= 1) {
      const single = input.envNames.length === 1 ? values[input.envNames[0]] : undefined
      return single ?? null
    }

    const orderedEntries = input.envNames.flatMap((name) =>
      values[name] ? [[name, values[name]] as const] : [],
    )
    return orderedEntries.length > 0 ? JSON.stringify(Object.fromEntries(orderedEntries)) : null
  }

  if (input.apiKey !== undefined) {
    return input.apiKey.trim() || null
  }

  return existingValue
}
