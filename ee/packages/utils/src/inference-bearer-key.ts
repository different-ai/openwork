import { randomBytes, webcrypto } from "node:crypto"

export const INFERENCE_BEARER_KEY_RANDOM_BYTES = 32
const INFERENCE_BEARER_KEY_PREFIX = "ow_inf_"
const INFERENCE_BEARER_KEY_LOOKUP_DOMAIN = new TextEncoder().encode("openwork-inference-bearer-key-lookup-v1")
const inferenceBearerKeyLookupKey = webcrypto.subtle.importKey(
  "raw",
  INFERENCE_BEARER_KEY_LOOKUP_DOMAIN,
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
)

export type InferenceBearerKey = Readonly<{
  purpose: "inference-bearer-key"
  value: string
}>

export function inferenceBearerKey(value: string): InferenceBearerKey {
  return { purpose: "inference-bearer-key", value }
}

export function createInferenceBearerKey(): InferenceBearerKey {
  return inferenceBearerKey(`${INFERENCE_BEARER_KEY_PREFIX}${randomBytes(INFERENCE_BEARER_KEY_RANDOM_BYTES).toString("base64url")}`)
}

/** Fast domain-separated database lookup tag for a CSPRNG-generated 256-bit bearer key. */
export async function inferenceBearerKeyLookupDigest(key: InferenceBearerKey): Promise<string> {
  const lookupKey = await inferenceBearerKeyLookupKey
  const tag = await webcrypto.subtle.sign("HMAC", lookupKey, new TextEncoder().encode(key.value))
  return Buffer.from(tag).toString("hex")
}

/** Compatibility tag for keys issued before domain-separated lookup tags. */
export async function legacyInferenceBearerKeyLookupDigest(key: InferenceBearerKey): Promise<string> {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(key.value))
  return Buffer.from(digest).toString("hex")
}

/**
 * Storage digest kept compatible with SHA-256-only readers during the staged
 * HMAC rollout. Switch this only after old inference deployments and rollback
 * versions have been retired.
 */
export async function inferenceBearerKeyStorageDigest(key: InferenceBearerKey): Promise<string> {
  return legacyInferenceBearerKeyLookupDigest(key)
}

export async function inferenceBearerKeyLookupDigests(key: InferenceBearerKey): Promise<string[]> {
  return Promise.all([
    inferenceBearerKeyLookupDigest(key),
    legacyInferenceBearerKeyLookupDigest(key),
  ])
}

export function inferenceBearerKeyPrefix(key: InferenceBearerKey): string {
  return key.value.slice(0, 16)
}
