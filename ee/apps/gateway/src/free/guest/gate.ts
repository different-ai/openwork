import { DESKTOP_FREE_PROOF_HEADER, desktopFreeVersionError } from "@openwork/free-auto"
import { verifyDesktopFreeProof, type DesktopFreeBinding, type VerifiedDesktopFreeProof } from "./proof.js"
import type { FreeAllowanceStore } from "../shared/allowance.js"
import { untaggedAutoEnabled, type AutoConfig } from "../shared/config.js"
import { freeError } from "../shared/errors.js"
import { releaseSecretCandidates } from "./release-secrets.js"

export type DesktopFreeGateDependencies = {
  consumeNonce: FreeAllowanceStore["consumeNonce"];
  config: Pick<AutoConfig, "releaseKey" | "releaseKeyPrevious" | "devReleaseSecret" | "minimumVersion" | "blockedReleases"
    | "untaggedIpDailyAmount" | "untaggedGlobalDailyAmount">;
  now?: () => number;
}
export const desktopFreeGateError = freeError


type GateResult = { error: Response; proof?: undefined }
  | { error?: undefined; proof: VerifiedDesktopFreeProof; minimumVersion: string | null; versionError: ReturnType<typeof desktopFreeVersionError> }

export async function checkDesktopFreeRequest(request: Request, bodyHash: string,
  dependencies: DesktopFreeGateDependencies, binding?: DesktopFreeBinding): Promise<GateResult> {
  const url = new URL(request.url)
  const { config } = dependencies
  const proof = verifyDesktopFreeProof({ header: request.headers.get(DESKTOP_FREE_PROOF_HEADER), method: request.method,
    path: url.pathname + url.search, bodyHash, authorization: request.headers.get("authorization") ?? "", binding,
    releaseSecrets: (appVersion) => releaseSecretCandidates(config, appVersion), now: dependencies.now?.() })
  if (!proof) return { error: desktopFreeGateError(401, "invalid_desktop_proof") }
  try {
    const nonce = await dependencies.consumeNonce(proof)
    if (nonce !== "accepted") return { error: desktopFreeGateError(nonce === "replay" ? 401 : 503,
      nonce === "replay" ? "desktop_proof_replayed" : "desktop_proof_unavailable") }
    // The version comes from the signed proof, and a release tag binds it to the build. A dev-secret proof comes from
    // an unversioned developer build, so it is never asked to update.
    const minimumVersion = config.minimumVersion
    let versionError = proof.releaseSource === "dev" ? null
      : desktopFreeVersionError(proof.appVersion, { minimumVersion, blocked: config.blockedReleases })
    // An untagged (v2) proof comes from a build made without the release key (a local build, or an older alpha),
    // or from any other client. It may use Auto on the smaller untagged budgets; with those off, updating would not
    // help that build, so say it can't use Auto.
    if (!versionError && proof.version === 2 && !untaggedAutoEnabled(config)) {
      versionError = { code: "desktop_build_unverified", currentVersion: proof.appVersion, minimumVersion,
        message: "The OpenWork free model is currently unavailable." }
    }
    if (request.signal.aborted) return { error: desktopFreeGateError(503, "desktop_proof_unavailable") }
    return { proof, minimumVersion, versionError }
  } catch { return { error: desktopFreeGateError(503, "desktop_proof_unavailable") } }
}
