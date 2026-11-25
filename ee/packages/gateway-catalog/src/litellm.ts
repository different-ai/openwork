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

/**
 * `settings.litellm.keySource` of a provider whose proxy accepts sign-in tokens
 * instead of LiteLLM keys (LiteLLM JWT auth): each member signs in with
 * Microsoft Entra ID and the gateway forwards their own access token.
 */
export const LITELLM_ENTRA_KEY_SOURCE = "entra"

/**
 * The API scope members' Entra access tokens are issued for, when the provider
 * is a LiteLLM provider in member Microsoft Entra sign-in mode. Null for every
 * other provider and LiteLLM mode.
 */
export function liteLlmEntraScope(provider: { provider_id: string; settings: unknown }): string | null {
  if (!isLiteLlmProviderId(provider.provider_id) || !isRecord(provider.settings)) return null
  const litellm = provider.settings.litellm
  if (!isRecord(litellm) || litellm.mode !== "member" || litellm.keySource !== LITELLM_ENTRA_KEY_SOURCE) return null
  return typeof litellm.entraScope === "string" && litellm.entraScope.trim() ? litellm.entraScope : null
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

export type LiteLlmKeySource = "personal" | "issued" | "entra"

export function liteLlmKeySource(provider: { provider_id: string; settings: unknown }): LiteLlmKeySource | null {
  if (!isLiteLlmProviderId(provider.provider_id) || !isRecord(provider.settings)) return null
  const litellm = provider.settings.litellm
  if (!isRecord(litellm) || litellm.mode !== "member") return null
  if (litellm.keySource === "issued" || litellm.keySource === LITELLM_ENTRA_KEY_SOURCE) return litellm.keySource
  return "personal"
}

export type LiteLlmAuthErrorReason = "model_denied" | "jwt_mismatch" | "user_not_found" | "budget_exceeded" | "other"

function extractErrorText(rawBody: string): string {
  const trimmed = rawBody.trim()
  if (!trimmed) return ""
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isRecord(parsed)) {
      const error = parsed.error
      if (typeof error === "string") return error
      if (isRecord(error) && typeof error.message === "string") return error.message
      const detail = parsed.detail
      if (typeof detail === "string") return detail
      if (isRecord(detail)) {
        if (typeof detail.error === "string") return detail.error
        if (typeof detail.message === "string") return detail.message
      }
      if (typeof parsed.message === "string") return parsed.message
    }
  } catch {
    return trimmed
  }
  return trimmed
}

export function classifyLiteLlmAuthError(rawBody: string): LiteLlmAuthErrorReason {
  const text = extractErrorText(rawBody)
  if (!text) return "other"
  if (/budget.{0,30}(?:exceeded|limit|reached)|(?:exceeded|max).{0,20}budget/i.test(text)) return "budget_exceeded"
  if (/user(?:_id)?\b.{0,30}(?:not found|does not exist|not in db|not valid)|unknown user|not a valid user/i.test(text)) return "user_not_found"
  if (/invalid issuer|audience\b.{0,24}(?:match|invalid|mismatch)|invalid audience|invalid jwt|signature verification|jwks|jwt.{0,24}(?:invalid|expired|verify|validation)|token.{0,20}(?:invalid|expired|issuer|audience)/i.test(text)) {
    return "jwt_mismatch"
  }
  if (/not available for this|not allowed to access model|model\b.{0,40}(?:not allowed|not permitted|not available|not found|access denied)|invalid model|team.{0,30}not allowed.{0,20}model|key.{0,30}not allowed.{0,20}model/i.test(text)) {
    return "model_denied"
  }
  return "other"
}
