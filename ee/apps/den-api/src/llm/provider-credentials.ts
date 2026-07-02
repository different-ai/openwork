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
    return envNames.length > 0 ? [envNames[0]] : []
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
      const legacyEnvName = input.existing?.envNames[0]
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
