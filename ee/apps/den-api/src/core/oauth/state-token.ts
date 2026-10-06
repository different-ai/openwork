import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { base64UrlEncode } from "./pkce.js"

export type OAuthStatePayload = {
  version?: 1 | 2
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  providerId: string
  binding?: string
  callbackMode?: "shared-v1" | "isolated-v1" | "legacy-v1"
  authorizationServerIssuer?: string
  authorizationResponseIssuerRequired?: boolean
  nonce: string
  iat?: number
  exp: number
}

export function createOAuthStateToken(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  providerId: string
  binding?: string
  version?: 1 | 2
  callbackMode?: "shared-v1" | "isolated-v1" | "legacy-v1"
  authorizationServerIssuer?: string
  authorizationResponseIssuerRequired?: boolean
  secret: string
  ttlSeconds?: number
  now?: number
}) {
  const nowMs = input.now ?? Date.now()
  const payload: OAuthStatePayload = {
    ...(input.version ? { version: input.version } : {}),
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.providerId,
    ...(input.binding ? { binding: input.binding } : {}),
    ...(input.callbackMode ? { callbackMode: input.callbackMode } : {}),
    ...(input.authorizationServerIssuer ? { authorizationServerIssuer: input.authorizationServerIssuer } : {}),
    ...(input.authorizationResponseIssuerRequired !== undefined
      ? { authorizationResponseIssuerRequired: input.authorizationResponseIssuerRequired }
      : {}),
    nonce: randomUUID(),
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + (input.ttlSeconds ?? 10 * 60),
  }
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signature = base64UrlEncode(createHmac("sha256", input.secret).update(encodedPayload).digest())
  return `${encodedPayload}.${signature}`
}

export function verifyOAuthStateToken(input: { token: string; secret: string; now?: number }): OAuthStatePayload | null {
  const [encodedPayload, encodedSignature] = input.token.split(".")
  if (!encodedPayload || !encodedSignature) return null

  const expectedSignature = createHmac("sha256", input.secret).update(encodedPayload).digest()
  const providedSignature = Buffer.from(encodedSignature, "base64url")
  const expectedBytes = new Uint8Array(expectedSignature)
  const providedBytes = new Uint8Array(providedSignature)
  if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<OAuthStatePayload>
    const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000)
    if (
      typeof payload.organizationId !== "string"
      || typeof payload.orgMembershipId !== "string"
      || typeof payload.providerId !== "string"
      || (payload.binding !== undefined && typeof payload.binding !== "string")
      || (payload.version !== undefined && payload.version !== 1 && payload.version !== 2)
      || (payload.callbackMode !== undefined && payload.callbackMode !== "shared-v1" && payload.callbackMode !== "isolated-v1" && payload.callbackMode !== "legacy-v1")
      || (payload.authorizationServerIssuer !== undefined && typeof payload.authorizationServerIssuer !== "string")
      || (payload.authorizationResponseIssuerRequired !== undefined && typeof payload.authorizationResponseIssuerRequired !== "boolean")
      || typeof payload.nonce !== "string"
      || (payload.iat !== undefined && typeof payload.iat !== "number")
      || typeof payload.exp !== "number"
      || payload.exp < nowSeconds
      || (payload.version === 2 && (
        typeof payload.binding !== "string"
        || (payload.callbackMode !== "shared-v1" && payload.callbackMode !== "isolated-v1" && payload.callbackMode !== "legacy-v1")
        || typeof payload.iat !== "number"
      ))
    ) {
      return null
    }
    return payload as OAuthStatePayload
  } catch {
    return null
  }
}
