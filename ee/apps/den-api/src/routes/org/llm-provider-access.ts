import { and, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import { LlmProviderAccessTable, LlmProviderTable, MemberTable, TeamMemberTable } from "@openwork-ee/den-db/schema"
import { db } from "../../db.js"

type MemberId = NonNullable<typeof LlmProviderAccessTable.$inferSelect.orgMembershipId>
type TeamId = NonNullable<typeof LlmProviderAccessTable.$inferSelect.teamId>

export async function listAccessibleLlmProviderAccess(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  currentMemberId: MemberId
  teamIds: TeamId[]
}) {
  return db
    .select({
      id: LlmProviderAccessTable.id,
      llmProviderId: LlmProviderAccessTable.llmProviderId,
      orgMembershipId: LlmProviderAccessTable.orgMembershipId,
      teamId: LlmProviderAccessTable.teamId,
      createdAt: LlmProviderAccessTable.createdAt,
    })
    .from(LlmProviderAccessTable)
    .innerJoin(LlmProviderTable, eq(LlmProviderAccessTable.llmProviderId, LlmProviderTable.id))
    .where(and(
      eq(LlmProviderTable.organizationId, input.organizationId),
      or(
        eq(LlmProviderAccessTable.orgMembershipId, input.currentMemberId),
        ...(input.teamIds.length > 0 ? [inArray(LlmProviderAccessTable.teamId, input.teamIds)] : []),
        and(
          isNull(LlmProviderAccessTable.orgMembershipId),
          isNull(LlmProviderAccessTable.teamId),
        ),
      ),
    ))
}

export async function listGrantedLlmProviderMemberIds(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  llmProviderId: typeof LlmProviderTable.$inferSelect.id
}) {
  const rows = await db
    .selectDistinct({ id: MemberTable.id })
    .from(MemberTable)
    .leftJoin(TeamMemberTable, eq(TeamMemberTable.orgMembershipId, MemberTable.id))
    .innerJoin(LlmProviderAccessTable, or(
      eq(LlmProviderAccessTable.orgMembershipId, MemberTable.id),
      eq(LlmProviderAccessTable.teamId, TeamMemberTable.teamId),
      and(
        isNull(LlmProviderAccessTable.orgMembershipId),
        isNull(LlmProviderAccessTable.teamId),
      ),
    ))
    .where(and(
      eq(MemberTable.organizationId, input.organizationId),
      isNull(MemberTable.removedAt),
      eq(LlmProviderAccessTable.llmProviderId, input.llmProviderId),
    ))

  return rows.map((row) => row.id)
}
