import { createHmac } from "node:crypto"

/**
 * Domain-separated lookup tags for free Auto identities (member user ids,
 * machine-derived installation ids, bucket keys). These are not secrets; Den
 * and the Gateway must derive the same tags.
 */
const FREE_INFERENCE_DIGEST_DOMAIN = "openwork-free-inference-digest-v1"

export function freeInferenceDigest(kind: string, value: string): string {
  return createHmac("sha256", FREE_INFERENCE_DIGEST_DOMAIN).update(`${kind}:${value}`).digest("hex")
}
