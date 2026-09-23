import { createHmac, timingSafeEqual } from "node:crypto"
import { DESKTOP_FREE_RELEASE_TAG_PATTERN, desktopFreeReleaseTagMessage } from "@openwork/types/desktop-free-access"
import type { AutoConfig } from "./free-config.js"

/**
 * Each stable desktop release carries HMAC(master key, version), derived in CI.
 * The gateway derives the same secret from the version a proof claims, so a
 * secret lifted from one release cannot be presented as another.
 */
export function deriveReleaseSecret(masterKey: string, version: string): Uint8Array {
  return Uint8Array.from(createHmac("sha256", masterKey).update(version).digest())
}

export type ReleaseSecretCandidate = { secret: Uint8Array; source: "release" | "previous" | "dev" }

/** Candidates the gateway accepts for a claimed version, in preference order. */
export function releaseSecretCandidates(config: Pick<AutoConfig, "releaseKey" | "releaseKeyPrevious" | "devReleaseSecret">, version: string): ReleaseSecretCandidate[] {
  const candidates: ReleaseSecretCandidate[] = []
  if (config.releaseKey) candidates.push({ secret: deriveReleaseSecret(config.releaseKey, version), source: "release" })
  if (config.releaseKeyPrevious) candidates.push({ secret: deriveReleaseSecret(config.releaseKeyPrevious, version), source: "previous" })
  if (config.devReleaseSecret) candidates.push({ secret: new TextEncoder().encode(config.devReleaseSecret), source: "dev" })
  return candidates
}

export function releaseTag(secret: Uint8Array, message: Parameters<typeof desktopFreeReleaseTagMessage>[0]): string {
  return createHmac("sha256", secret).update(desktopFreeReleaseTagMessage(message)).digest("hex")
}

export function matchReleaseTag(tag: string, candidates: ReleaseSecretCandidate[], message: Parameters<typeof desktopFreeReleaseTagMessage>[0]): ReleaseSecretCandidate | null {
  if (!DESKTOP_FREE_RELEASE_TAG_PATTERN.test(tag)) return null
  const supplied = Uint8Array.from(Buffer.from(tag, "hex"))
  for (const candidate of candidates) {
    const expected = Uint8Array.from(Buffer.from(releaseTag(candidate.secret, message), "hex"))
    if (timingSafeEqual(supplied, expected)) return candidate
  }
  return null
}
