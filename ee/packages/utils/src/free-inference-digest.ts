import { createHmac, webcrypto } from "node:crypto"

/**
 * Domain-separated lookup tags for free Auto identities and credentials.
 *
 * Identities (member ids, installation thumbprints, bucket keys) are not
 * secrets and use a keyed SHA-256 tag. Free credentials (`ow_auto_…`) are
 * CSPRNG-generated 256-bit keys, not passwords: their lookup tag is an HMAC
 * computed through WebCrypto, matching the Gateway bearer-key store. Den and
 * the Gateway must derive the same tags.
 */
const FREE_INFERENCE_DIGEST_DOMAIN = "openwork-free-inference-digest-v1"
const FREE_CREDENTIAL_LOOKUP_DOMAIN = new TextEncoder().encode("openwork-free-credential-lookup-v1")
const credentialLookupKey = webcrypto.subtle.importKey("raw", FREE_CREDENTIAL_LOOKUP_DOMAIN, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])

export function freeInferenceDigest(kind: string, value: string): string {
  return createHmac("sha256", FREE_INFERENCE_DIGEST_DOMAIN).update(`${kind}:${value}`).digest("hex")
}

export async function freeCredentialDigest(credential: string): Promise<string> {
  const tag = await webcrypto.subtle.sign("HMAC", await credentialLookupKey, new TextEncoder().encode(credential))
  return Buffer.from(tag).toString("hex")
}
