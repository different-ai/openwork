/**
 * TrueFoundry is a customer-run AI gateway, not a models.dev provider. Den and
 * the gateway both see one synthetic `truefoundry` catalog provider with no
 * models: each organization's models come from syncing its own TrueFoundry
 * tenant, and the upstream URL always comes from the provider's
 * `settings.upstreamBaseUrl` (the tenant's OpenAI-compatible `/api/llm` base).
 *
 * Every person calls TrueFoundry with their own personal access token, which
 * OpenWork creates with the organization's TrueFoundry admin key. TrueFoundry
 * budgets and logs those tokens, so OpenWork never prices or limits them.
 */

export const TRUEFOUNDRY_PROVIDER_ID = "truefoundry"
export const TRUEFOUNDRY_PROVIDER_NAME = "TrueFoundry"
export const TRUEFOUNDRY_NPM = "@ai-sdk/openai-compatible"
export const TRUEFOUNDRY_ENV = ["TRUEFOUNDRY_API_KEY"] as const
export const TRUEFOUNDRY_DOC_URL = "https://www.truefoundry.com/docs/ai-gateway"

/**
 * Subject of the TrueFoundry admin key row inside the provider's member
 * credential set. The gateway only reads the caller's member id in member
 * sets, so this row is used for syncing and creating tokens, never for inference.
 */
export const TRUEFOUNDRY_ADMIN_CREDENTIAL_SUBJECT = "truefoundry_admin"

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isTrueFoundryProviderId(providerId: string): boolean {
  return providerId === TRUEFOUNDRY_PROVIDER_ID
}

/** The models.dev-shaped provider entry, without models. */
export function trueFoundryCatalogEntry(): JsonRecord {
  return { id: TRUEFOUNDRY_PROVIDER_ID, name: TRUEFOUNDRY_PROVIDER_NAME, npm: TRUEFOUNDRY_NPM, env: [...TRUEFOUNDRY_ENV], doc: TRUEFOUNDRY_DOC_URL, models: {} }
}

/** Adds the synthetic provider to a models.dev payload. A real upstream entry wins. */
export function withTrueFoundryProvider(raw: unknown): JsonRecord {
  const catalog = isRecord(raw) ? raw : {}
  if (isRecord(catalog[TRUEFOUNDRY_PROVIDER_ID])) return catalog
  return { ...catalog, [TRUEFOUNDRY_PROVIDER_ID]: trueFoundryCatalogEntry() }
}
