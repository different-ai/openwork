import { nonSecretProviderConfig } from "./inference-provider-config.js"

type JsonRecord = Record<string, unknown>

// Beyond nonSecretProviderConfig's matcher (secrets, passwords, credentials,
// API keys, access/refresh tokens, authorization, cookies, non-allowlisted
// headers): any other *token, private keys and a bare auth object.
const EXTRA_SECRET_KEY = /^(?:.*token|.*private[-_]?key|auth)$/i

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dropExtraSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropExtraSecretKeys)
  if (!isRecord(value)) return value
  const clean: JsonRecord = {}
  for (const [key, entry] of Object.entries(value)) {
    if (EXTRA_SECRET_KEY.test(key)) continue
    clean[key] = dropExtraSecretKeys(entry)
  }
  return clean
}

/**
 * An LLM provider or model configuration with every secret-bearing field
 * removed, at any depth. Custom providers keep arbitrary fields, so inline
 * credentials (options.apiKey, headers.Authorization, ...) can live here
 * alongside the separate apiKey column; callers who may not edit the provider
 * get this view instead of the stored configuration.
 */
export function redactLlmProviderConfig(config: JsonRecord): JsonRecord {
  const cleaned = dropExtraSecretKeys(config)
  return nonSecretProviderConfig(isRecord(cleaned) ? cleaned : {})
}
