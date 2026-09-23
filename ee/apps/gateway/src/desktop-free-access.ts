import { DESKTOP_FREE_PROOF_HEADER } from "@openwork/types/desktop-free-access"
import { verifyDesktopFreeProof, type DesktopFreeBinding, type VerifiedDesktopFreeProof } from "./desktop-free-proof.js"
import { compareDesktopVersions, desktopFreeVersionError, lowestDesktopVersion, supportedDesktopReleases, type DesktopRelease } from "./desktop-free-version.js"
import type { FreeAllowanceStore } from "./free-allowance.js"
import type { AutoConfig } from "./free-config.js"
import { freeError } from "./free-dispatch.js"
import { releaseSecretCandidates } from "./free-release.js"

export type DesktopFreeGateDependencies = {
  releases: () => Promise<DesktopRelease[] | null>;
  consumeNonce: FreeAllowanceStore["consumeNonce"];
  config: Pick<AutoConfig, "releaseKey" | "releaseKeyPrevious" | "devReleaseSecret" | "firstReleaseTagVersion" | "supportedReleaseCount" | "supportedReleaseMinDays" | "blockedReleases">;
  now?: () => number;
}
export const desktopFreeGateError = freeError

/** v2 proofs (no release tag) are accepted only while a release that predates tags is still supported. */
export function releaseTagRequired(supported: readonly string[], firstReleaseTagVersion: string | null) {
  if (!firstReleaseTagVersion) return false
  return supported.every((version) => (compareDesktopVersions(version, firstReleaseTagVersion) ?? -1) >= 0)
}

type GateResult = { error: Response; proof?: undefined }
  | { error?: undefined; proof: VerifiedDesktopFreeProof; minimumVersion: string | null; versionError: ReturnType<typeof desktopFreeVersionError> }

export async function checkDesktopFreeRequest(request: Request, bodyHash: string, ipHash: string,
  dependencies: DesktopFreeGateDependencies, binding?: DesktopFreeBinding): Promise<GateResult> {
  const url = new URL(request.url)
  const { config } = dependencies
  const proof = verifyDesktopFreeProof({ header: request.headers.get(DESKTOP_FREE_PROOF_HEADER), method: request.method,
    path: url.pathname + url.search, bodyHash, authorization: request.headers.get("authorization") ?? "", binding,
    releaseSecrets: (appVersion) => releaseSecretCandidates(config, appVersion), now: dependencies.now?.() })
  if (!proof) return { error: desktopFreeGateError(401, "invalid_desktop_proof") }
  try {
    const nonce = await dependencies.consumeNonce(proof, ipHash)
    if (nonce !== "accepted") return { error: desktopFreeGateError(nonce === "replay" ? 401 : 503,
      nonce === "replay" ? "desktop_proof_replayed" : "desktop_proof_unavailable") }
    const releases = await dependencies.releases().catch(() => null)
    const supported = releases ? supportedDesktopReleases(releases, { count: config.supportedReleaseCount, minDays: config.supportedReleaseMinDays, blocked: config.blockedReleases }, dependencies.now?.()) : null
    const minimumVersion = supported ? lowestDesktopVersion(supported) : null
    // A dev-secret proof comes from an unversioned developer build; it is not held to the release window.
    let versionError = proof.releaseSource === "dev" ? null : desktopFreeVersionError(proof.appVersion, supported)
    if (!versionError && proof.version === 2 && supported && releaseTagRequired(supported, config.firstReleaseTagVersion)) {
      versionError = { code: "desktop_update_required", currentVersion: proof.appVersion, minimumVersion,
        message: `Update OpenWork Desktop to ${minimumVersion} or newer to use Auto.` }
    }
    if (request.signal.aborted) return { error: desktopFreeGateError(503, "desktop_proof_unavailable") }
    return { proof, minimumVersion, versionError }
  } catch { return { error: desktopFreeGateError(503, "desktop_proof_unavailable") } }
}
