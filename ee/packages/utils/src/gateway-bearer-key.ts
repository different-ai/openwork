import { randomBytes, timingSafeEqual, webcrypto } from "node:crypto"

export const GATEWAY_BEARER_KEY_RANDOM_BYTES = 32
export const GATEWAY_BEARER_KEY_PREFIX = "ow_gw_"
const gatewayBearerKeyLookupKey = webcrypto.subtle.importKey(
  "raw",
  new TextEncoder().encode("openwork-gateway-bearer-key-lookup-v1"),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
)

export type GatewayBearerKey = Readonly<{
  purpose: "gateway-bearer-key"
  value: string
}>

/** Reject Models keys, malformed input and noncanonical base64url encodings. */
export function gatewayBearerKey(value: string): GatewayBearerKey {
  if (value.length !== 49 || !/^ow_gw_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) {
    throw new Error("Invalid Gateway bearer key")
  }
  return { purpose: "gateway-bearer-key", value }
}

export function createGatewayBearerKey(): GatewayBearerKey {
  return gatewayBearerKey(`${GATEWAY_BEARER_KEY_PREFIX}${randomBytes(GATEWAY_BEARER_KEY_RANDOM_BYTES).toString("base64url")}`)
}

/** Domain-separated lookup of a CSPRNG-generated 256-bit key, not a password hash. */
export async function gatewayBearerKeyLookupDigest(key: GatewayBearerKey): Promise<string> {
  const validated = gatewayBearerKey(key.value)
  const tag = await webcrypto.subtle.sign(
    "HMAC",
    await gatewayBearerKeyLookupKey,
    new TextEncoder().encode(validated.value),
  )
  return Buffer.from(tag).toString("hex")
}

// New store only: no inference/SHA-only compatibility digest or cross-store lookup.
export const gatewayBearerKeyStorageDigest = gatewayBearerKeyLookupDigest

export async function gatewayBearerKeyLookupDigests(key: GatewayBearerKey): Promise<string[]> {
  return [await gatewayBearerKeyLookupDigest(key)]
}

export async function gatewayBearerKeyMatchesDigest(key: GatewayBearerKey, digest: string): Promise<boolean> {
  if (digest.length !== 64 || !/^[0-9a-f]{64}$/.test(digest)) return false
  return timingSafeEqual(
    new Uint8Array(Buffer.from(await gatewayBearerKeyLookupDigest(key), "hex")),
    new Uint8Array(Buffer.from(digest, "hex")),
  )
}

export function gatewayBearerKeyPrefix(key: GatewayBearerKey): string {
  return gatewayBearerKey(key.value).value.slice(0, 16)
}
