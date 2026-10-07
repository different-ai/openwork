/**
 * Microsoft Entra ID for per-member Microsoft Foundry credentials. Den runs the
 * authorization-code flow (PKCE + the organization's own confidential app
 * registration) and the Gateway renews the access token with the stored
 * refresh token. Tokens are issued for Azure Cognitive Services, the audience
 * every Foundry resource accepts. The only host reached is login.microsoftonline.com.
 */

export const MICROSOFT_LOGIN_ORIGIN = "https://login.microsoftonline.com"
/** Microsoft Foundry (and Azure OpenAI) accept tokens for this resource. */
export const MICROSOFT_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"
/** Requested at sign-in: the resource plus a refresh token and an ID token naming the person. */
export const MICROSOFT_SIGN_IN_SCOPES = `${MICROSOFT_COGNITIVE_SERVICES_SCOPE} offline_access openid profile email`
/** Requested when renewing: the resource and a new refresh token. */
export const MICROSOFT_REFRESH_SCOPES = `${MICROSOFT_COGNITIVE_SERVICES_SCOPE} offline_access`
/** Entra access tokens last 60-90 minutes; anything far longer is not a token we asked for. */
export const MICROSOFT_MAX_EXPIRES_IN_SECONDS = 86_400

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const tokenMaterial = /^[\x21-\x7e]+$/

export function isMicrosoftTenantId(value: unknown): value is string {
  return typeof value === "string" && guid.test(value)
}

export function microsoftAuthorizeUrl(tenantId: string) {
  if (!isMicrosoftTenantId(tenantId)) throw new Error("invalid_tenant_id")
  return `${MICROSOFT_LOGIN_ORIGIN}/${tenantId.toLowerCase()}/oauth2/v2.0/authorize`
}

export function microsoftTokenUrl(tenantId: string) {
  if (!isMicrosoftTenantId(tenantId)) throw new Error("invalid_tenant_id")
  return `${MICROSOFT_LOGIN_ORIGIN}/${tenantId.toLowerCase()}/oauth2/v2.0/token`
}

export function microsoftIssuer(tenantId: string) {
  return `${MICROSOFT_LOGIN_ORIGIN}/${tenantId.toLowerCase()}/v2.0`
}

export function microsoftJwksUrl(tenantId: string) {
  return `${MICROSOFT_LOGIN_ORIGIN}/${tenantId.toLowerCase()}/discovery/v2.0/keys`
}

export function isMicrosoftTokenMaterial(value: unknown, max = 16_384): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && tokenMaterial.test(value)
}

export type MicrosoftTokenError = "invalid_client" | "invalid_grant" | "token_endpoint_unavailable" | "token_exchange_failed"

/** Entra token errors, by what the person or an administrator must do. */
export function classifyMicrosoftTokenError(status: number, body: unknown): MicrosoftTokenError {
  if (status === 429 || status >= 500) return "token_endpoint_unavailable"
  const error = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null
  // invalid_client covers a wrong or expired client secret (AADSTS7000215, AADSTS7000222): administrator repair.
  if (error === "invalid_client" || error === "unauthorized_client") return "invalid_client"
  // invalid_grant and interaction_required: expired, revoked, or needs MFA or consent again. The person signs in again.
  if (error === "invalid_grant" || error === "interaction_required" || error === "consent_required") return "invalid_grant"
  return "token_exchange_failed"
}

export type MicrosoftTokens = { accessToken: string; refreshToken: string | null; expiresIn: number; idToken: string | null; scope: string | null }

export function readMicrosoftTokens(body: unknown): MicrosoftTokens | null {
  if (typeof body !== "object" || body === null) return null
  const record: Record<string, unknown> = { ...body }
  const accessToken = isMicrosoftTokenMaterial(record.access_token) && /^[A-Za-z0-9._~+/-]+=*$/.test(record.access_token) ? record.access_token : null
  const refreshToken = record.refresh_token === undefined ? null : isMicrosoftTokenMaterial(record.refresh_token, 32_768) ? record.refresh_token : undefined
  const idToken = record.id_token === undefined ? null : isMicrosoftTokenMaterial(record.id_token) ? record.id_token : undefined
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : typeof record.expires_in === "string" && /^\d+$/.test(record.expires_in) ? Number(record.expires_in) : null
  const tokenType = record.token_type
  if (!accessToken || refreshToken === undefined || idToken === undefined || expiresIn === null || !Number.isInteger(expiresIn)
    || expiresIn <= 0 || expiresIn > MICROSOFT_MAX_EXPIRES_IN_SECONDS || typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") return null
  if (record.scope !== undefined && (typeof record.scope !== "string" || !record.scope.split(/\s+/).some((scope) => scope.toLowerCase().startsWith("https://cognitiveservices.azure.com/")))) return null
  return { accessToken, refreshToken, expiresIn, idToken, scope: typeof record.scope === "string" ? record.scope : null }
}
