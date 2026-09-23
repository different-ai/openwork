import { DESKTOP_FREE_PROOF_HEADER } from "@openwork/types/desktop-free-access"
import { verifyDesktopFreeProof, type DesktopFreeBinding } from "./desktop-free-proof.js"
import { desktopFreeVersionError } from "./desktop-free-version.js"
import type { FreeAllowanceStore } from "./free-allowance.js"
import { freeError } from "./free-dispatch.js"

export type DesktopFreeGateDependencies = {
  latestVersion: () => Promise<string | null>;
  consumeNonce: FreeAllowanceStore["consumeNonce"];
}
export const desktopFreeGateError = freeError
export async function checkDesktopFreeRequest(request: Request, bodyHash: string, ipHash: string,
  dependencies: DesktopFreeGateDependencies, binding?: DesktopFreeBinding) {
  const url = new URL(request.url)
  const proof = verifyDesktopFreeProof({ header: request.headers.get(DESKTOP_FREE_PROOF_HEADER), method: request.method,
    path: url.pathname + url.search, bodyHash, authorization: request.headers.get("authorization") ?? "", binding })
  if (!proof) return { error: desktopFreeGateError(401, "invalid_desktop_proof") }
  try {
    const nonce = await dependencies.consumeNonce(proof, ipHash)
    if (nonce !== "accepted") return { error: desktopFreeGateError(nonce === "replay" ? 401 : 503,
      nonce === "replay" ? "desktop_proof_replayed" : "desktop_proof_unavailable") }
    const minimumVersion = await dependencies.latestVersion().catch(() => null)
    const versionError = desktopFreeVersionError(proof.appVersion, minimumVersion)
    if (request.signal.aborted) return { error: desktopFreeGateError(503, "desktop_proof_unavailable") }
    return { proof, minimumVersion, versionError }
  } catch { return { error: desktopFreeGateError(503, "desktop_proof_unavailable") } }
}
