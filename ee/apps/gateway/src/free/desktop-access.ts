import { DESKTOP_FREE_UPDATE_CODE } from "@openwork/free-auto"
import type { AutoConfig } from "./shared/config.js"

export function desktopProofRequired(config: Pick<AutoConfig, "minimumVersion">) {
  return config.minimumVersion !== null
}

export function desktopChallenge(minimumVersion: string | null = null) {
  return Response.json({ error: {
    code: DESKTOP_FREE_UPDATE_CODE, desktopProof: "required", minimumVersion,
    message: "Update OpenWork to keep using OpenWork Free.",
  } }, { status: 426, headers: { "cache-control": "no-store" } })
}
