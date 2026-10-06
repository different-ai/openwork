// FUTURE(modules/enterprise-auth/scim): a mapped SCIM team projection is not
// itself authority. Registered as a `member.authorityExclusion` with
// `security: true`: it can only remove authority, so it runs whatever the
// module state (orphaned projections must never become authority).
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ScimGroupMemberTable, ScimGroupTable, ScimProviderTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { authorityCandidateKey, CORE_HOOK_ORDER, type AuthorityCandidate, type AuthorityExclusion, type AuthorityQuery } from "./core/hook-seams.js"
import { ADMIN_TEAM_ELEVATION_KIND } from "./teams-authority.js"

export type ScimProjectionRow = {
  teamId: string | null
  groupMappingMode: string | null
  member: { teamMemberId: string | null; orgMembershipId: string | null; remoteUserId: string | null } | null
}

// A team mapped to a SCIM group grants authority only when the provider is in
// metadata_only mode, or in create_teams mode with a scim_group_member row
// confirming this exact team membership. Orphaned projections (no provider)
// fail closed; unmapped teams are untouched.
export function scimProjectionDrops(candidates: readonly AuthorityCandidate[], rows: readonly ScimProjectionRow[]) {
  const dropped = new Set<string>()
  for (const candidate of candidates) {
    const { kind, id, teamMemberId } = candidate.elevation.source
    if (kind !== ADMIN_TEAM_ELEVATION_KIND) continue
    const projections = rows.filter((row) => row.teamId === id)
    if (projections.length === 0) continue
    const backed = projections.some((row) =>
      row.groupMappingMode === "metadata_only"
      || (row.groupMappingMode === "create_teams"
        && row.member !== null
        && teamMemberId !== undefined
        && candidate.userId !== null
        && row.member.teamMemberId === teamMemberId
        && row.member.orgMembershipId === candidate.memberId
        && row.member.remoteUserId === candidate.userId))
    if (!backed) dropped.add(authorityCandidateKey(candidate))
  }
  return dropped
}

export async function listScimProjectionRows(query: AuthorityQuery, candidates: readonly AuthorityCandidate[]): Promise<ScimProjectionRow[]> {
  const teamIds = new Set<string>()
  const teamMemberIds = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.elevation.source.kind !== ADMIN_TEAM_ELEVATION_KIND) continue
    teamIds.add(candidate.elevation.source.id)
    if (candidate.elevation.source.teamMemberId) teamMemberIds.add(candidate.elevation.source.teamMemberId)
  }
  const teams = [...teamIds].filter((id) => isDenTypeId("team", id))
  if (teams.length === 0) return []
  const confirmed = [...teamMemberIds].filter((id) => isDenTypeId("teamMember", id))
  const rows = query.database.select({
    teamId: ScimGroupTable.teamId,
    groupMappingMode: ScimProviderTable.groupMappingMode,
    teamMemberId: ScimGroupMemberTable.teamMemberId,
    orgMembershipId: ScimGroupMemberTable.orgMembershipId,
    remoteUserId: ScimGroupMemberTable.remoteUserId,
    scimGroupMemberId: ScimGroupMemberTable.id,
  })
    .from(ScimGroupTable)
    .leftJoin(ScimProviderTable, and(
      eq(ScimProviderTable.providerId, ScimGroupTable.providerId),
      eq(ScimProviderTable.organizationId, query.organizationId),
    ))
    .leftJoin(ScimGroupMemberTable, and(
      eq(ScimGroupMemberTable.groupId, ScimGroupTable.id),
      eq(ScimGroupMemberTable.providerId, ScimProviderTable.providerId),
      eq(ScimGroupMemberTable.organizationId, query.organizationId),
      // Narrows the scan; scimProjectionDrops still checks every identity column.
      confirmed.length > 0 ? inArray(ScimGroupMemberTable.teamMemberId, confirmed) : undefined,
    ))
    .where(and(
      eq(ScimGroupTable.organizationId, query.organizationId),
      inArray(ScimGroupTable.teamId, teams),
    ))
  const projections = await (query.lock === "share" ? rows.for("share") : rows)
  return projections.map((row) => ({
    teamId: row.teamId,
    groupMappingMode: row.groupMappingMode,
    member: row.scimGroupMemberId === null ? null : {
      teamMemberId: row.teamMemberId,
      orgMembershipId: row.orgMembershipId,
      remoteUserId: row.remoteUserId,
    },
  }))
}

export const scimProjectionAuthorityExclusion: AuthorityExclusion = {
  id: "enterprise-auth-scim/projection-not-authority",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.security,
  security: true,
  exclude: async (query, candidates) => scimProjectionDrops(candidates, await listScimProjectionRows(query, candidates)),
}
