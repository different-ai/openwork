import { fundedMemberSuspended, type FundedRoute } from "@openwork-ee/den-db"
import { readFeatures } from "@openwork-ee/den-db/organization-features"
import { db } from "./db.js"
import { env } from "./env.js"

export function fundedModelGuard(database = db) {
  return async (identity: { organizationId: string; orgMembershipId: string | null }, route: FundedRoute): Promise<Response | null> => {
    try {
      const primary = database.$primary
      if (!(await readFeatures(primary, null, env.features)).fundedModelAccountSuspensions) return null
      if (!await fundedMemberSuspended(primary, identity, route)) return null
      return Response.json({ error: { code: "funded_model_account_suspended", message: "Your access to OpenWork-funded models is suspended. Contact OpenWork support." } }, { status: 403, headers: { "cache-control": "no-store" } })
    } catch {
      return Response.json({ error: { code: "funded_model_check_unavailable", message: "OpenWork could not verify model access. Try again shortly." } }, { status: 503, headers: { "cache-control": "no-store" } })
    }
  }
}

export const checkFundedModelAccess = fundedModelGuard()
export type FundedModelGuard = ReturnType<typeof fundedModelGuard>
