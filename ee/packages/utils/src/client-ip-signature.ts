import { createHmac, timingSafeEqual } from "node:crypto"

// Den Web forwards sign-in and API calls from a host whose outgoing addresses
// change (Vercel), so Den API cannot trust it as a proxy by address. Instead Den
// Web signs the address its platform saw for the person, and Den API accepts
// that address only with a fresh signature made with the shared secret.

export const SIGNED_CLIENT_IP_HEADER = "x-openwork-client-ip"
export const CLIENT_IP_SIGNATURE_HEADER = "x-openwork-client-ip-signature"
/** A signature older or newer than this is refused, so a captured one stops working quickly. */
export const CLIENT_IP_SIGNATURE_MAX_AGE_SECONDS = 300
export const CLIENT_IP_SECRET_MIN_LENGTH = 32

function digest(secret: string, ip: string, timestamp: number) {
  return createHmac("sha256", secret).update(`openwork-client-ip-v1:${timestamp}:${ip}`).digest("base64url")
}

/** `t=<unix seconds>,v1=<base64url HMAC-SHA256>` vouching for one address. */
export function signClientIp(secret: string, ip: string, now = Date.now()): string {
  const timestamp = Math.floor(now / 1000)
  return `t=${timestamp},v1=${digest(secret, ip, timestamp)}`
}

/** True only for a signature made with `secret` for exactly `ip` within the allowed window. */
export function verifyClientIpSignature(secret: string, ip: string, signature: string, now = Date.now()): boolean {
  const match = /^t=(\d{1,12}),v1=([A-Za-z0-9_-]{43})$/.exec(signature.trim())
  if (!match?.[1] || !match[2]) return false
  const timestamp = Number(match[1])
  if (Math.abs(Math.floor(now / 1000) - timestamp) > CLIENT_IP_SIGNATURE_MAX_AGE_SECONDS) return false
  const expected = Buffer.from(digest(secret, ip, timestamp))
  const actual = Buffer.from(match[2])
  return expected.length === actual.length && timingSafeEqual(new Uint8Array(expected), new Uint8Array(actual))
}
