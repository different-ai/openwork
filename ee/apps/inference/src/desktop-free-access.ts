import type { Context } from "hono"
import { DESKTOP_FREE_PROOF_HEADER, DESKTOP_FREE_TOKEN_HEADER, type DesktopFreeVersionError } from "@openwork/types/desktop-free-access"
import { resolveAnonymousClientAddress, verifyAnonymousToken } from "./anonymous-identity.js"
import type { consumeDesktopFreeNonce } from "./anonymous-limits.js"
import { verifyDesktopFreeProof, type DesktopFreeBinding } from "./desktop-free-proof.js"
import { createDesktopFreeVersionSource, desktopFreeVersionError } from "./desktop-free-version.js"
import { env } from "./env.js"

export type DesktopFreeGateDependencies = {
  latestVersion: () => Promise<string | null>
  consumeNonce: typeof consumeDesktopFreeNonce
}

type DesktopFreeGateResult = { error: Response } | {
  proof: NonNullable<ReturnType<typeof verifyDesktopFreeProof>>
  minimumVersion: string | null
  versionError: DesktopFreeVersionError | null
}

const defaultDependencies: DesktopFreeGateDependencies = {
  latestVersion: createDesktopFreeVersionSource({ url: env.desktopFreeAppVersionUrl }),
  async consumeNonce(proof) {
    const limits = await import("./anonymous-limits.js")
    return limits.consumeDesktopFreeNonce(proof)
  },
}

export function desktopFreeGateError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } })
}

export function desktopFreeVersionResponse(error: DesktopFreeVersionError) {
  return Response.json({ error }, {
    status: error.code === "desktop_update_required" ? 426 : 503,
    headers: { "cache-control": "no-store" },
  })
}

export async function checkDesktopFreeRequest(
  request: Request,
  bodyHash: string,
  binding?: DesktopFreeBinding,
  dependencies: DesktopFreeGateDependencies = defaultDependencies,
): Promise<DesktopFreeGateResult> {
  const url = new URL(request.url)
  const proof = verifyDesktopFreeProof({
    header: request.headers.get(DESKTOP_FREE_PROOF_HEADER), method: request.method,
    path: url.pathname + url.search, bodyHash, authorization: request.headers.get("authorization") ?? "", binding,
  })
  if (!proof) return { error: desktopFreeGateError(401, "invalid_desktop_proof", "A valid native desktop signature is required for free Luna.") }
  try {
    const minimumVersion = await dependencies.latestVersion().catch(() => null)
    const versionError = desktopFreeVersionError(proof.appVersion, minimumVersion)
    // Consume even status proofs and blocked-version proofs. Nonces are shared
    // across session, anonymous, and member-free routes and every replica.
    const nonce = await dependencies.consumeNonce(proof)
    if (nonce !== "accepted") return { error: desktopFreeGateError(nonce === "replay" ? 401 : 503,
      nonce === "replay" ? "desktop_proof_replayed" : "desktop_proof_unavailable",
      nonce === "replay" ? "This desktop proof has already been used." : "Desktop proof verification is temporarily unavailable.") }
    if (request.signal.aborted) return { error: desktopFreeGateError(503, "desktop_proof_unavailable", "The request was cancelled.") }
    return { proof, minimumVersion: versionError ? versionError.minimumVersion : minimumVersion, versionError }
  } catch {
    return { error: desktopFreeGateError(503, "desktop_proof_unavailable", "Desktop proof verification is temporarily unavailable.") }
  }
}

export async function requireMemberFreeDesktop(c: Context, bodyHash: string,
  dependencies?: DesktopFreeGateDependencies & { clientAddress: (c: Context) => string | null },
) {
  // Member Bearer remains the canonical authorization string. Never substitute
  // the guest credential before signature verification or touch member billing.
  const bearer = c.req.raw.headers.get("authorization")
  const guest = c.req.raw.headers.get(DESKTOP_FREE_TOKEN_HEADER)
  if (!bearer?.toLowerCase().startsWith("bearer ") || !guest) {
    return desktopFreeGateError(401, "invalid_desktop_proof", "Free Luna requires a desktop credential and signature.")
  }
  try {
    const address = (dependencies?.clientAddress ?? resolveAnonymousClientAddress)(c)
    const token = address ? verifyAnonymousToken(guest, address) : null
    if (!token) return desktopFreeGateError(401, "invalid_anonymous_token", "The desktop credential is invalid or expired.")
    const result = await checkDesktopFreeRequest(c.req.raw, bodyHash, token, dependencies)
    if ("error" in result) return result.error
    return result.versionError ? desktopFreeVersionResponse(result.versionError) : null
  } catch {
    return desktopFreeGateError(503, "desktop_proof_unavailable", "Desktop proof verification is temporarily unavailable.")
  }
}
