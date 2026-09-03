type JsonRecord = Record<string, unknown>

/**
 * Provider credentials live in the single encrypted `api_key` column. Providers
 * with one env key store the bare credential string (the legacy format, still
 * written for every existing row); providers with several env keys store a JSON
 * object of env name → value. The stored value is self-describing, so decoding
 * never needs a schema migration.
 */

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

export function readProviderEnvNames(providerConfig: JsonRecord): string[] {
  return Array.isArray(providerConfig.env)
    ? providerConfig.env.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : []
}

function credentialEnvRank(name: string): number | null {
  const normalized = name.trim().toUpperCase()
  if (/(^|_)API_KEY$/.test(normalized)) return 0
  if (/(^|_)ACCESS_KEY_ID$/.test(normalized)) return 1
  if (/(^|_)BEARER_TOKEN(_|$)/.test(normalized) || /(^|_)TOKEN$/.test(normalized)) return 2
  if (/(^|_)KEY$/.test(normalized)) return 3
  return null
}

export function selectPrimaryCredentialEnvName(envNames: string[], availableNames: Iterable<string>): string | null {
  const available = new Set([...availableNames].filter((name) => name.trim().length > 0))
  const orderedNames = envNames.filter((name) => available.has(name))
  const ranked = orderedNames
    .map((name, index) => ({ name, index, rank: credentialEnvRank(name) }))
    .filter((entry): entry is { name: string; index: number; rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
  if (ranked[0]) return ranked[0].name
  if (envNames.length > 1 && envNames.some((name) => credentialEnvRank(name) !== null)) return null
  return orderedNames[0] ?? null
}

export function selectLegacyScalarCredentialEnvName(envNames: string[]): string | null {
  return selectPrimaryCredentialEnvName(envNames, envNames) ?? envNames[0] ?? null
}

const RUNTIME_ENV_TAG_LENGTH = 5

/**
 * The tag that scopes a catalog provider's env names to one provider row:
 * `LPR_` plus the last five alphanumerics of the row id, upper-cased
 * (`lpr_01kx…120jv` → `LPR_120JV`). It is a pure function of the id, so the
 * same row always yields the same names and nothing has to be stored or
 * migrated.
 */
export function runtimeProviderEnvTag(providerRowId: string): string {
  const tail = providerRowId.replace(/[^0-9A-Za-z]/g, "").toUpperCase().slice(-RUNTIME_ENV_TAG_LENGTH)
  return `LPR_${tail}`
}

export type RuntimeEnvProvider = {
  id: string
  source: string
  providerConfig: JsonRecord
}

/**
 * Only providers created from the models.dev catalog get scoped names. Their
 * declared names are well-known (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …):
 * materialized bare, one organization provider would switch on OpenCode's whole
 * built-in catalog for that vendor and shadow a key the member set themselves,
 * and two rows for the same vendor would share one credential slot. Custom
 * providers keep the exact names their author declared, and the hosted
 * OpenWork provider keeps `OPENWORK_API_KEY`.
 */
export function usesRuntimeProviderEnvTag(provider: Pick<RuntimeEnvProvider, "source">): boolean {
  return provider.source === "models_dev"
}

/** The env name a member's machine or a cloud worker sees for one declared name. */
export function runtimeProviderEnvName(provider: Pick<RuntimeEnvProvider, "id" | "source">, declaredName: string): string {
  return usesRuntimeProviderEnvTag(provider) ? `${runtimeProviderEnvTag(provider.id)}_${declaredName}` : declaredName
}

export function runtimeProviderEnvNames(provider: RuntimeEnvProvider): string[] {
  return readProviderEnvNames(provider.providerConfig).map((name) => runtimeProviderEnvName(provider, name))
}

/**
 * Rewrite a provider's declared env names (and the keys of a decoded multi-env
 * credential) to their runtime names. Stored rows are never rewritten; this is
 * applied where a provider leaves Den for a machine or worker.
 */
export function toRuntimeProviderEnv<T extends RuntimeEnvProvider & { apiKeys?: Record<string, string> | null }>(provider: T): T {
  if (!usesRuntimeProviderEnvTag(provider) || provider.providerConfig.env === undefined) return provider
  const providerConfig: JsonRecord = { ...provider.providerConfig, env: runtimeProviderEnvNames(provider) }
  if (!provider.apiKeys) return { ...provider, providerConfig }
  const apiKeys = Object.fromEntries(
    Object.entries(provider.apiKeys).map(([name, value]) => [runtimeProviderEnvName(provider, name), value]),
  )
  return { ...provider, providerConfig, apiKeys }
}

/**
 * A stored credential is a multi-env map only when it parses to a non-empty
 * JSON object whose values are all strings. Real API keys never take that
 * shape, so legacy plain-string rows keep decoding as a single credential.
 */
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

/**
 * Compute the next `api_key` column value for a provider write.
 *
 * - `apiKeys` merges per-env values into the existing credential: a non-empty
 *   value sets that env key, an empty value clears it, an absent key keeps the
 *   stored value (the dashboard never sees secrets back, so blank inputs must
 *   not wipe them).
 * - `apiKey` keeps its legacy replace-the-whole-credential semantics.
 * - With neither field the stored value is kept verbatim.
 */
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
