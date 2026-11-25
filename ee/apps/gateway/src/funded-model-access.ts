import { fundedMemberSuspended, type FundedRoute } from "@openwork-ee/den-db"
import { db } from "./db.js"

export function fundedModelGuard(database = db) {
  return async (identity: { organizationId: string; orgMembershipId: string | null }, route: FundedRoute): Promise<Response | null> => {
    const suspended = await fundedMemberSuspended(database.$primary, identity, route).catch((error: unknown) => {
      console.warn("[funded-models] suspension check skipped", error instanceof Error ? error.message : "unknown error")
      return false
    })
    if (!suspended) return null
    return Response.json({ error: { code: "funded_model_account_suspended", message: "Your access to OpenWork-funded models is suspended. Contact OpenWork support." } }, { status: 403, headers: { "cache-control": "no-store" } })
  }
}

export const checkFundedModelAccess = fundedModelGuard()
export type FundedModelGuard = ReturnType<typeof fundedModelGuard>
