import { createHmac } from "node:crypto"

const FREE_INFERENCE_DIGEST_DOMAIN = "openwork-free-inference-digest-v1"

export function freeInferenceDigest(kind: string, value: string): string {
  return createHmac("sha256", FREE_INFERENCE_DIGEST_DOMAIN).update(`${kind}:${value}`).digest("hex")
}
