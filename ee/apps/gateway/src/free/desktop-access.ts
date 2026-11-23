import { readFeatures } from "@openwork-ee/den-db/organization-features"
import { DESKTOP_FREE_REQUIRED_CODE } from "@openwork/free-auto"
import { freeAutoDatabase } from "../db.js"
import { env } from "../env.js"
import { crossOrgBudgetsEnabled } from "./member/shared-budget.js"
import { freeError } from "./shared/errors.js"

export async function desktopProofRequired(organizationId: string | null) {
  const database = freeAutoDatabase().$primary
  if (organizationId && await crossOrgBudgetsEnabled(database)) return true
  return (await readFeatures(database, organizationId, env.features)).desktopOnlyFreeAuto
}

export function desktopChallenge() {
  return freeError(403, DESKTOP_FREE_REQUIRED_CODE, "Use an up-to-date OpenWork desktop app for free model access.")
}
