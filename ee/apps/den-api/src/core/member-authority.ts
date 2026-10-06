import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { adminTeamsFromElevations, computeEffectiveRole } from "./effective-role.js"
import { registeredAuthorityHooks, runAuthorityPipeline, type AuthorityElevation, type AuthorityQuery } from "./hook-seams.js"
import type { CoreReader } from "./types.js"

export { adminTeamsFromElevations, computeEffectiveRole, type OrganizationAdminTeam } from "./effective-role.js"
export type { AuthorityElevation } from "./hook-seams.js"

type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">

function runRegisteredAuthority(query: AuthorityQuery) {
  const { contributors, exclusions, moduleState } = registeredAuthorityHooks()
  return runAuthorityPipeline({ contributors, exclusions }, query, moduleState)
}

// Never cache authority: IdP removals and designation changes apply on the next check.
export function listOrganizationAuthority(input: { organizationId: OrganizationId; database?: CoreReader }) {
  return runRegisteredAuthority({ organizationId: input.organizationId, database: input.database ?? db })
}

export async function listAuthorityElevations(input: {
  organizationId: OrganizationId
  memberId: MemberId
  database?: CoreReader
  lock?: "share"
}): Promise<AuthorityElevation[]> {
  const byMember = await runRegisteredAuthority({ ...input, database: input.database ?? db })
  return byMember.get(input.memberId) ?? []
}

export async function resolveMemberAuthority(input: {
  organizationId: OrganizationId
  memberId: MemberId
  database?: CoreReader
  lock?: "share"
}) {
  const database = input.database ?? db
  const members = database.select().from(MemberTable).where(and(
    eq(MemberTable.id, input.memberId),
    eq(MemberTable.organizationId, input.organizationId),
    isNull(MemberTable.removedAt),
  )).limit(1)
  const memberRows = () => input.lock === "share" ? members.for("share") : members
  const elevationRows = () => listAuthorityElevations({ ...input, database })
  // Inside a caller's transaction, keep statements sequential on its connection.
  if (input.database) return memberAuthority(await memberRows(), await elevationRows())
  const [rows, elevations] = await Promise.all([memberRows(), elevationRows()])
  return memberAuthority(rows, elevations)
}

function memberAuthority(rows: Array<typeof MemberTable.$inferSelect>, elevations: AuthorityElevation[]) {
  const member = rows[0]
  if (!member?.userId) return null
  return {
    ...member,
    directRole: member.role,
    role: computeEffectiveRole(member.role, elevations),
    adminTeams: adminTeamsFromElevations(elevations),
  }
}
