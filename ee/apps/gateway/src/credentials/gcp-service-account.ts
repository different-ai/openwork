// Mints Google access tokens from a service-account JSON secret (plan §5.6,
// org-level Vertex): RS256 JWT → token endpoint, cached per credential until
// 60s before expiry. node:crypto only.
import { createHash, createSign } from "node:crypto"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import type { GatewayGcpServiceAccountSecret } from "@openwork/types/den/gateway"

export const GCP_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"
const JWT_LIFETIME_SECONDS = 3600
const EXPIRY_MARGIN_MS = 60_000
const TOKEN_REQUEST_TIMEOUT_MS = 15_000
export const GCP_TOKEN_CACHE_LIMIT = 256
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

export type MintGcpAccessTokenResult =
  | { kind: "token"; accessToken: string }
  | { kind: "error"; message: string }

export type MintGcpAccessToken = (input: {
  credentialId: string
  serviceAccount: GatewayGcpServiceAccountSecret
  now: Date
}) => Promise<MintGcpAccessTokenResult>

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url")
}

export function buildServiceAccountJwt(serviceAccount: GatewayGcpServiceAccountSecret, now: Date, scope = GCP_CLOUD_PLATFORM_SCOPE) {
  if (serviceAccount.token_uri !== GOOGLE_TOKEN_URL) throw new Error("service account token_uri is not permitted")
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
  const expiresIn = record.expires_in
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > JWT_LIFETIME_SECONDS) return null
  return { accessToken: record.access_token, expiresIn }
}

export function createGcpServiceAccountTokenMinter(deps: { tokenFetch?: typeof fetch; scope?: string } = {}): MintGcpAccessToken {
  const fetchToken = deps.tokenFetch ?? createInferenceEgressFetch({ allowedOrigins: new Set() })
  const cache = new Map<string, { accessToken: string; expiresAt: number }>()
  const inflight = new Map<string, Promise<MintGcpAccessTokenResult>>()

  async function mint(input: Parameters<MintGcpAccessToken>[0], cacheKey: string): Promise<MintGcpAccessTokenResult> {
    const started = performance.now()
    let assertion: string
    try {
      assertion = buildServiceAccountJwt(input.serviceAccount, input.now, deps.scope)
    } catch {
      return { kind: "error", message: "service account private_key could not sign" }
    }
    let response: Response
    try {
      response = await fetchToken(GOOGLE_TOKEN_URL, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      })
    } catch {
      return { kind: "error", message: "token endpoint unavailable" }
    }
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    const token = response.ok ? readTokenResponse(body) : null
    if (!token) return { kind: "error", message: `token endpoint returned ${response.status}` }
    if (token.expiresIn * 1000 <= performance.now() - started) return { kind: "error", message: "token endpoint returned an expired token" }
    if (cache.size >= GCP_TOKEN_CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(cacheKey, { accessToken: token.accessToken, expiresAt: input.now.getTime() + token.expiresIn * 1000 })
    return { kind: "token", accessToken: token.accessToken }
  }

  return async (input) => {
    // Exact allowlist before signing, cache lookup or HTTP. A public attacker
    // endpoint must never receive a signed assertion either.
    if (input.serviceAccount.token_uri !== GOOGLE_TOKEN_URL) return { kind: "error", message: "service account token_uri is not permitted" }
    const revision = createHash("sha256").update(JSON.stringify(input.serviceAccount)).digest("hex")
    const key = `${input.credentialId}:${revision}`
    for (const [id, entry] of cache) {
      if (entry.expiresAt - EXPIRY_MARGIN_MS <= input.now.getTime()) cache.delete(id)
    }
    const cached = cache.get(key)
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > input.now.getTime()) return { kind: "token", accessToken: cached.accessToken }
    const pending = inflight.get(key)
    if (pending) return pending
    if (inflight.size >= GCP_TOKEN_CACHE_LIMIT) return { kind: "error", message: "token mint capacity exceeded; retry later" }
    const promise = mint(input, key).finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }
}
