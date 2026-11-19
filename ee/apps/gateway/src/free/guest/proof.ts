import { createPublicKey, verify } from "node:crypto"
import { z } from "zod"
import { DESKTOP_FREE_ARCHES, DESKTOP_FREE_MACHINE_ID_PATTERN, DESKTOP_FREE_PLATFORMS, DESKTOP_FREE_PROOF_CLOCK_SKEW_MS, DESKTOP_FREE_PROOF_MAX_BYTES,
  DESKTOP_FREE_RELEASE_TAG_PATTERN, desktopFreeProofMessage, type DesktopFreeProofClaims } from "@openwork/free-auto"
import { matchReleaseTag, sha256Hex } from "@openwork/free-auto/node"
import type { ReleaseSecretCandidate } from "./release-secrets.js"

const claims = {
  publicKey: z.string().length(60).regex(/^[A-Za-z0-9+/]+=$/),
  machineId: z.string().regex(DESKTOP_FREE_MACHINE_ID_PATTERN),
  appVersion: z.string().min(1).max(128), platform: z.enum(DESKTOP_FREE_PLATFORMS), arch: z.enum(DESKTOP_FREE_ARCHES),
  timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), nonce: z.string().uuid(),
  signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/),
}
const proofSchema = z.discriminatedUnion("version", [
  z.strictObject({ version: z.literal(2), ...claims }),
  z.strictObject({ version: z.literal(3), releaseTag: z.string().regex(DESKTOP_FREE_RELEASE_TAG_PATTERN), ...claims }),
])
/** What a guest token is bound to: the signing key, the machine and the app build. */
export type DesktopFreeBinding = Pick<DesktopFreeProofClaims, "machineId" | "appVersion" | "platform" | "arch"> & { keyThumbprint: string }
export type VerifiedDesktopFreeProof = DesktopFreeProofClaims & DesktopFreeBinding & {
  /** Which secret tagged a v3 proof; null for a v2 proof from a release that predates release tags. */
  releaseSource: ReleaseSecretCandidate["source"] | null
}

export function verifyDesktopFreeProof(input: {
  header: string | null; method: string; path: string; bodyHash: string; authorization: string;
  /** Secrets the gateway accepts for the claimed app version. Absent means release tags are not checked (tests). */
  releaseSecrets?: (appVersion: string) => ReleaseSecretCandidate[];
  binding?: DesktopFreeBinding; now?: number;
}): VerifiedDesktopFreeProof | null {
  try {
    if (!input.header || input.header.length > DESKTOP_FREE_PROOF_MAX_BYTES || !/^[A-Za-z0-9_-]+$/.test(input.header)) return null
    const encoded = Buffer.from(input.header, "base64url")
    if (encoded.toString("base64url") !== input.header) return null
    const parsed = proofSchema.safeParse(JSON.parse(encoded.toString("utf8")))
    if (!parsed.success) return null
    const { signature, ...proof } = parsed.data
    if (Math.abs((input.now ?? Date.now()) - proof.timestamp) > DESKTOP_FREE_PROOF_CLOCK_SKEW_MS) return null
    const der = Buffer.from(proof.publicKey, "base64")
    if (der.toString("base64") !== proof.publicKey) return null
    const key = createPublicKey({ key: der, format: "der", type: "spki" })
    if (key.asymmetricKeyType !== "ed25519" || key.export({ format: "der", type: "spki" }).toString("base64") !== proof.publicKey) return null
    const keyThumbprint = sha256Hex(Uint8Array.from(der))
    if (input.binding && (input.binding.keyThumbprint !== keyThumbprint || input.binding.machineId !== proof.machineId || input.binding.appVersion !== proof.appVersion
      || input.binding.platform !== proof.platform || input.binding.arch !== proof.arch)) return null
    const signatureBytes = Buffer.from(signature, "base64url")
    if (signatureBytes.toString("base64url") !== signature) return null
    const request = { method: input.method, path: input.path, bodyHash: input.bodyHash, authorizationHash: sha256Hex(input.authorization) }
    let releaseSource: VerifiedDesktopFreeProof["releaseSource"] = null
    if (proof.version === 3 && input.releaseSecrets) {
      // The tag is checked before the signature so a wrong-release secret is never mistaken for a bad signature.
      const matched = matchReleaseTag(proof.releaseTag, input.releaseSecrets(proof.appVersion), { ...proof, ...request })
      if (!matched) return null
      releaseSource = matched.source
    }
    const message = desktopFreeProofMessage({ ...proof, ...request })
    if (!verify(null, new TextEncoder().encode(message), key, Uint8Array.from(signatureBytes))) return null
    return { ...proof, keyThumbprint, releaseSource }
  } catch { return null }
}
