import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { organizationAllowsManagedModels } from "../inference-shared/public.js"
import { readInferenceMetadata } from "./metadata.js"
import { repairMemberInferenceAccessIfNeeded } from "./member-keys.js"
import { deleteOpenWorkProviders } from "./provider-projection.js"
import { syncInferenceLimitPolicies } from "./service.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

/** Runs after `aiGatewayMemberChanged`, so a removed member's keys are already revoked when their provider rows go. */
export async function openworkModelsMemberChanged(input: {
  organizationId: OrgId
  memberId: MemberId
  memberCount: number
  change: "added" | "removed"
}) {
  if (input.change === "removed") {
    await deleteOpenWorkProviders({ organizationId: input.organizationId, memberId: input.memberId })
  } else {
    const [member] = await db.select({ userId: MemberTable.userId }).from(MemberTable)
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
    // Invitations reserve an unbound member row; issuance happens when the user joins.
    if (!member?.userId) return
  }

  if (!await organizationAllowsManagedModels(input.organizationId)) return

  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.organizationId))
    .limit(1)
  const inference = readInferenceMetadata(organization?.metadata ?? null)
  if (!inference) {
    return
  }

  await syncInferenceLimitPolicies({ organizationId: input.organizationId, tier: inference.tier, memberCount: input.memberCount })

  if (input.change === "added") {
    await repairMemberInferenceAccessIfNeeded({ organizationId: input.organizationId, memberId: input.memberId })
  }
}
