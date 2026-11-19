import { createHash, createHmac, timingSafeEqual } from "node:crypto"

// Testing an unsaved AI Gateway provider is a Den decision: Den checks that the
// caller may manage providers, then signs the exact request it forwards. The
// gateway serves a test only with that signature, for the same organization and
// member as the Gateway key, so holding a Gateway key alone cannot aim a test.
// The signing key is derived from the database encryption key Den and the
// gateway already share, under its own label.

export const PROVIDER_TEST_SIGNATURE_HEADER = "x-openwork-provider-test-signature"
/** A signature older or newer than this is refused. */
export const PROVIDER_TEST_SIGNATURE_MAX_AGE_SECONDS = 60

export type ProviderTestSignatureScope = { organizationId: string; memberId: string; body: string }

function signingKey(sharedSecret: string) {
  return createHmac("sha256", sharedSecret).update("openwork-provider-test-signing-key-v1").digest()
}

function digest(sharedSecret: string, scope: ProviderTestSignatureScope, timestamp: number) {
  const bodyHash = createHash("sha256").update(scope.body).digest("base64url")
  return createHmac("sha256", new Uint8Array(signingKey(sharedSecret)))
    .update(`openwork-provider-test-v1:${timestamp}:${scope.organizationId}:${scope.memberId}:${bodyHash}`)
    .digest("base64url")
}

/** `t=<unix seconds>,v1=<base64url HMAC-SHA256>` vouching for one exact test request. */
export function signProviderTest(sharedSecret: string, scope: ProviderTestSignatureScope, now = Date.now()): string {
  const timestamp = Math.floor(now / 1000)
  return `t=${timestamp},v1=${digest(sharedSecret, scope, timestamp)}`
}

/** True only for a fresh signature made for exactly this organization, member and body. */
export function verifyProviderTestSignature(sharedSecret: string, scope: ProviderTestSignatureScope, signature: string, now = Date.now()): boolean {
  const match = /^t=(\d{1,12}),v1=([A-Za-z0-9_-]{43})$/.exec(signature.trim())
  if (!match?.[1] || !match[2]) return false
  const timestamp = Number(match[1])
  if (Math.abs(Math.floor(now / 1000) - timestamp) > PROVIDER_TEST_SIGNATURE_MAX_AGE_SECONDS) return false
  const expected = Buffer.from(digest(sharedSecret, scope, timestamp))
  const actual = Buffer.from(match[2])
  return expected.length === actual.length && timingSafeEqual(new Uint8Array(expected), new Uint8Array(actual))
}
