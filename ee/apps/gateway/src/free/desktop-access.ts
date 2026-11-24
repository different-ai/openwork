import { freeAutoDesktopProofRequired } from "@openwork-ee/den-db/organization-features"
import { DESKTOP_FREE_UPDATE_CODE } from "@openwork/free-auto"
import { freeAutoDatabase } from "../db.js"
import { env } from "../env.js"

export async function desktopProofRequired(organizationId: string | null) {
  return freeAutoDesktopProofRequired(freeAutoDatabase().$primary, organizationId, env.features)
}

export function desktopChallenge(minimumVersion: string | null = null) {
  return Response.json({ error: {
    code: DESKTOP_FREE_UPDATE_CODE, desktopProof: "required", minimumVersion,
    message: "Update OpenWork to keep using OpenWork Free.",
  } }, { status: 426, headers: { "cache-control": "no-store" } })
}
