// Mints Google access tokens from a service-account JSON secret (plan §5.6,
// org-level Vertex): RS256 JWT → token endpoint, cached per credential until
// 60s before expiry. node:crypto only.
import { createSign } from "node:crypto"
import type { InferenceGcpServiceAccountSecret } from "@openwork/types/den/inference"

export const GCP_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"
const JWT_LIFETIME_SECONDS = 3600
const EXPIRY_MARGIN_MS = 60_000
const TOKEN_REQUEST_TIMEOUT_MS = 15_000

export type MintGcpAccessTokenResult =
  | { kind: "token"; accessToken: string }
  | { kind: "error"; message: string }

export type MintGcpAccessToken = (input: {
  credentialId: string
  serviceAccount: InferenceGcpServiceAccountSecret
  now: Date
}) => Promise<MintGcpAccessTokenResult>

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url")
}

export function buildServiceAccountJwt(serviceAccount: InferenceGcpServiceAccountSecret, now: Date, scope = GCP_CLOUD_PLATFORM_SCOPE) {
  const iat = Math.floor(now.getTime() / 1000)
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope,
    aud: serviceAccount.token_uri,
    iat,
    exp: iat + JWT_LIFETIME_SECONDS,
  }))
  const signingInput = `${header}.${claims}`
  const signature = createSign("RSA-SHA256").update(signingInput).sign(serviceAccount.private_key, "base64url")
  return `${signingInput}.${signature}`
}

function readTokenResponse(body: unknown): { accessToken: string; expiresIn: number } | null {
  if (typeof body !== "object" || body === null) return null
  const record: Record<string, unknown> = { ...body }
  if (typeof record.access_token !== "string" || !record.access_token) return null
  const expiresIn = typeof record.expires_in === "number" && Number.isFinite(record.expires_in) ? record.expires_in : JWT_LIFETIME_SECONDS
  return { accessToken: record.access_token, expiresIn }
}

export function createGcpServiceAccountTokenMinter(deps: { fetch: typeof fetch; scope?: string }): MintGcpAccessToken {
  const cache = new Map<string, { accessToken: string; expiresAt: number }>()
  const inflight = new Map<string, Promise<MintGcpAccessTokenResult>>()

  async function mint(input: Parameters<MintGcpAccessToken>[0]): Promise<MintGcpAccessTokenResult> {
    let assertion: string
    try {
      assertion = buildServiceAccountJwt(input.serviceAccount, input.now, deps.scope)
    } catch (error) {
      return { kind: "error", message: `service account private_key could not sign: ${error instanceof Error ? error.message : String(error)}` }
    }
    let response: Response
    try {
      response = await deps.fetch(input.serviceAccount.token_uri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { kind: "error", message: `token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}` }
    }
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    const token = response.ok ? readTokenResponse(body) : null
    if (!token) return { kind: "error", message: `token endpoint returned ${response.status}` }
    cache.set(input.credentialId, { accessToken: token.accessToken, expiresAt: input.now.getTime() + token.expiresIn * 1000 })
    return { kind: "token", accessToken: token.accessToken }
  }

  return async (input) => {
    const cached = cache.get(input.credentialId)
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > input.now.getTime()) return { kind: "token", accessToken: cached.accessToken }
    const pending = inflight.get(input.credentialId)
    if (pending) return pending
    const promise = mint(input).finally(() => inflight.delete(input.credentialId))
    inflight.set(input.credentialId, promise)
    return promise
  }
}
