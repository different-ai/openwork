/**
 * LiteLLM is a customer-run, OpenAI-compatible proxy, not a models.dev
 * provider. Den and the gateway both see one synthetic `litellm` catalog
 * provider with no models: each organization's models come from syncing its
 * own LiteLLM instance, and the upstream URL always comes from the provider's
 * `settings.upstreamBaseUrl`.
 */

export const LITELLM_PROVIDER_ID = "litellm"
export const LITELLM_PROVIDER_NAME = "LiteLLM"
export const LITELLM_NPM = "@ai-sdk/openai-compatible"
export const LITELLM_ENV = ["LITELLM_API_KEY"] as const
export const LITELLM_DOC_URL = "https://docs.litellm.ai/docs/proxy/virtual_keys"

/**
 * Subject of the LiteLLM admin key row inside a per-user credential set. The
 * gateway only ever reads the `org` subject (organization sets) or the caller's
 * member id (member sets), so this row is used for syncing and never for inference.
 */
export const LITELLM_ADMIN_CREDENTIAL_SUBJECT = "litellm_admin"

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isLiteLlmProviderId(providerId: string): boolean {
  return providerId === LITELLM_PROVIDER_ID
}

/** The models.dev-shaped provider entry, without models. */
export function liteLlmCatalogEntry(): JsonRecord {
  return { id: LITELLM_PROVIDER_ID, name: LITELLM_PROVIDER_NAME, npm: LITELLM_NPM, env: [...LITELLM_ENV], doc: LITELLM_DOC_URL, models: {} }
}

/** Adds the synthetic provider to a models.dev payload. A real upstream entry wins. */
export function withLiteLlmProvider(raw: unknown): JsonRecord {
  const catalog = isRecord(raw) ? raw : {}
  if (isRecord(catalog[LITELLM_PROVIDER_ID])) return catalog
  return { ...catalog, [LITELLM_PROVIDER_ID]: liteLlmCatalogEntry() }
}

/**
 * Spend tracking follows the credential: one organization key is one bill we
 * can price and limit, while per-user keys are budgeted by LiteLLM itself.
 */
export function liteLlmSpendTrackingEnabled(credentialMode: "org" | "member"): boolean {
  return credentialMode === "org"
}
