import { deriveReleaseSecret } from "@openwork/free-auto/node"
import type { AutoConfig } from "../shared/config.js"

export type ReleaseSecretCandidate = { secret: Uint8Array; source: "release" | "previous" | "dev" }

/** Secrets accepted for a claimed version, in preference order: current key, rotation overlap, dev builds. */
export function releaseSecretCandidates(config: Pick<AutoConfig, "releaseKey" | "releaseKeyPrevious" | "devReleaseSecret">, version: string): ReleaseSecretCandidate[] {
  const candidates: ReleaseSecretCandidate[] = []
  if (config.releaseKey) candidates.push({ secret: deriveReleaseSecret(config.releaseKey, version), source: "release" })
  if (config.releaseKeyPrevious) candidates.push({ secret: deriveReleaseSecret(config.releaseKeyPrevious, version), source: "previous" })
  if (config.devReleaseSecret) candidates.push({ secret: new TextEncoder().encode(config.devReleaseSecret), source: "dev" })
  return candidates
}
