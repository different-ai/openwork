import { Buffer } from "node:buffer"
import { createHash, timingSafeEqual } from "node:crypto"

export const SCIM_TOKEN_STORAGE_STRATEGY = "hashed"

export function hashScimToken(scimToken: string) {
  return createHash("sha256").update(scimToken).digest("base64url")
}

export function verifyStoredScimToken(input: {
  storedToken: string
  rawToken: string
}) {
  const expectedToken = hashScimToken(input.rawToken)
  const storedBytes = Uint8Array.from(Buffer.from(input.storedToken))
  const expectedBytes = Uint8Array.from(Buffer.from(expectedToken))
  return storedBytes.length === expectedBytes.length && timingSafeEqual(storedBytes, expectedBytes)
}

export async function resolveStoredScimProvider<Provider extends { scimToken: string }>(
  bearerToken: string,
  lookup: (providerId: string, organizationId: string) => Promise<Provider | null>,
): Promise<Provider | null> {
  let decoded: string
  try {
    const normalized = bearerToken.replace(/-/g, "+").replace(/_/g, "/")
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4))
    decoded = Buffer.from(`${normalized}${padding}`, "base64").toString("utf8")
  } catch {
    return null
  }
  const [rawToken, providerId, ...organizationParts] = decoded.split(":")
  const organizationId = organizationParts.join(":")
  if (!rawToken || !providerId || !organizationId) return null
  // Decoded identifiers only select a row. No caller may use them as authority
  // until the stored token's hash matches in constant time.
  const provider = await lookup(providerId, organizationId)
  return provider && verifyStoredScimToken({ storedToken: provider.scimToken, rawToken }) ? provider : null
}
