import { DESKTOP_FREE_PROOF_HEADER, desktopFreeVersionError, lowestDesktopVersion, supportedDesktopReleases,
  type DesktopRelease } from "@openwork/free-auto"
import { verifyDesktopFreeProof, type DesktopFreeBinding, type VerifiedDesktopFreeProof } from "./proof.js"
import type { FreeAllowanceStore } from "../shared/allowance.js"
import type { AutoConfig } from "../shared/config.js"
import { freeError } from "../shared/errors.js"
import { releaseSecretCandidates } from "./release-secrets.js"

export type DesktopFreeGateDependencies = {
  releases: () => Promise<DesktopRelease[] | null>;
  consumeNonce: FreeAllowanceStore["consumeNonce"];
  config: Pick<AutoConfig, "releaseKey" | "releaseKeyPrevious" | "devReleaseSecret" | "supportedReleaseCount" | "supportedReleaseMinDays" | "blockedReleases">;
  now?: () => number;
}
export const desktopFreeGateError = freeError


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
    // No released build ever sent an untagged (v2) proof, so one only comes from an unkeyed or forged client.
    if (!versionError && proof.version === 2) {
      versionError = { code: "desktop_update_required", currentVersion: proof.appVersion, minimumVersion,
        message: `Update OpenWork Desktop to ${minimumVersion} or newer to use Auto.` }
    }
    if (request.signal.aborted) return { error: desktopFreeGateError(503, "desktop_proof_unavailable") }
    return { proof, minimumVersion, versionError }
  } catch { return { error: desktopFreeGateError(503, "desktop_proof_unavailable") } }
}
