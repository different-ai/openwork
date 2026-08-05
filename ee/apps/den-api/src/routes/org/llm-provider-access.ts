import { and, eq, inArray, isNull, or } from "@micx-ee/den-db/drizzle"
import { LlmProviderAccessTable, LlmProviderTable } from "@micx-ee/den-db/schema"
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
