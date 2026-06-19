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
