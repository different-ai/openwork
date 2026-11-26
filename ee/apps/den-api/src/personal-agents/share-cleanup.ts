import { and, eq } from "@openwork-ee/den-db/drizzle"
import { PersonalAgentAudienceTable, PersonalAgentSharedLoginTable, PersonalAgentShareTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentTransaction } from "./access.js"

export async function deletePersonalAgentLoans(tx: PersonalAgentTransaction, organizationId: DenTypeId<"organization">, memberId?: DenTypeId<"member">, agentId?: DenTypeId<"personalAgent">) {
  await tx.delete(PersonalAgentSharedLoginTable).where(and(eq(PersonalAgentSharedLoginTable.organization_id, organizationId),
    memberId ? eq(PersonalAgentSharedLoginTable.member_id, memberId) : undefined,
    agentId ? eq(PersonalAgentSharedLoginTable.agent_id, agentId) : undefined))
}

export async function removeMemberPersonalAgentShares(tx: PersonalAgentTransaction, organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">) {
  await deletePersonalAgentLoans(tx, organizationId, memberId)
  await tx.delete(PersonalAgentShareTable).where(and(eq(PersonalAgentShareTable.organization_id, organizationId), eq(PersonalAgentShareTable.member_id, memberId)))
}

export async function removeTeamPersonalAgentAudiences(tx: PersonalAgentTransaction, organizationId: DenTypeId<"organization">, teamId: DenTypeId<"team">) {
  await tx.delete(PersonalAgentAudienceTable).where(and(eq(PersonalAgentAudienceTable.organization_id, organizationId), eq(PersonalAgentAudienceTable.team_id, teamId)))
}
