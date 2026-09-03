// Access resolution for gateway providers: a member may use a provider when
// an `inference_provider_access` row names them, one of their teams, or is
// the org-wide grant (both columns null).
import { and, eq, isNotNull } from "@openwork-ee/den-db/drizzle"
import { InferenceProviderAccessTable, TeamMemberTable } from "@openwork-ee/den-db"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"

export type ProviderAccessRow = {
  orgMembershipId: string | null
  teamId: string | null
}

export type ProviderAccessInput = {
  inferenceProviderId: string
  orgMembershipId: string
}

export type HasProviderAccess = (input: ProviderAccessInput) => Promise<boolean>

export type ProviderAccessQueries = {
  listAccessRows(inferenceProviderId: string): Promise<ProviderAccessRow[]>
  listMemberTeamIds(orgMembershipId: string): Promise<string[]>
}

export function createProviderAccessChecker(queries: ProviderAccessQueries): HasProviderAccess {
  return async (input) => {
    const rows = await queries.listAccessRows(input.inferenceProviderId)
    if (rows.some((row) => row.orgMembershipId === null && row.teamId === null)) return true
    if (rows.some((row) => row.orgMembershipId === input.orgMembershipId)) return true
    const teamIds = rows.flatMap((row) => (row.teamId ? [row.teamId] : []))
    if (teamIds.length === 0) return false
    const memberTeamIds = new Set(await queries.listMemberTeamIds(input.orgMembershipId))
    return teamIds.some((teamId) => memberTeamIds.has(teamId))
  }
}

export const dbProviderAccessQueries: ProviderAccessQueries = {
  async listAccessRows(inferenceProviderId) {
    const { db } = await import("./db.js")
    return db
      .select({
        orgMembershipId: InferenceProviderAccessTable.org_membership_id,
        teamId: InferenceProviderAccessTable.team_id,
      })
      .from(InferenceProviderAccessTable)
      .where(eq(InferenceProviderAccessTable.inference_provider_id, normalizeDenTypeId("inferenceProvider", inferenceProviderId)))
  },
  async listMemberTeamIds(orgMembershipId) {
    const { db } = await import("./db.js")
    const rows = await db
      .select({ teamId: TeamMemberTable.teamId })
      .from(TeamMemberTable)
      .where(and(
        eq(TeamMemberTable.orgMembershipId, normalizeDenTypeId("member", orgMembershipId)),
        isNotNull(TeamMemberTable.teamId),
      ))
    return rows.map((row) => row.teamId)
  },
}

export const hasProviderAccessFromDb = createProviderAccessChecker(dbProviderAccessQueries)
