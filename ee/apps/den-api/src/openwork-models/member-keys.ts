import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { inferenceBearerKey, inferenceBearerKeyLookupDigests } from "@openwork-ee/utils/inference-bearer-key"
import { assertManagedModelsAllowed, ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { db } from "../db.js"
import { assertOrganizationManagedModelsAllowed } from "../organization-metadata.js"
import {
  backfillInferenceKeyValue,
  findActiveMemberInferenceKey,
  mintMemberInferenceKey,
  organizationAllowsManagedModels,
  rotateMemberInferenceKey,
} from "../inference-shared/public.js"
import { readInferenceMetadata } from "./metadata.js"
import { ensureOpenWorkLlmProviderForMember, findOpenWorkLlmProviderApiKey, memberHasOpenWorkInferenceAccess } from "./provider-projection.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

/**
 * Return a tier-entitled member's Models-only `ow_inf_` key.
 *
 * Legacy rows minted before `encrypted_key` existed only carried the raw
 * value on the synthetic OpenWork Models provider row; when that row is still
 * present its value is backfilled, otherwise the key is rotated.
 */
export async function ensureMemberInferenceKey(input: { organizationId: OrgId; memberId: MemberId }): Promise<string> {
  return db.transaction(async (tx) => {
    const [organization] = await tx.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, input.organizationId)).for("update")
    if (!readInferenceMetadata(organization?.metadata ?? null)) throw new Error("inference_not_enabled")
    assertManagedModelsAllowed(organization?.metadata)
    // Lock a stable row even when no key exists. Removal takes this same lock.
    const [member] = await tx.select({ id: MemberTable.id, userId: MemberTable.userId }).from(MemberTable)
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
      .for("update")
    if (!member?.userId) throw new Error("member_not_found")
    const existing = await findActiveMemberInferenceKey(tx, input)
    if (existing) {
      const legacyKey = existing.encryptedKey ?? await findOpenWorkLlmProviderApiKey(tx, input)
      if (legacyKey && (await inferenceBearerKeyLookupDigests(inferenceBearerKey(legacyKey))).includes(existing.keyHash)) {
        if (!existing.encryptedKey) await backfillInferenceKeyValue(tx, { id: existing.id, value: legacyKey })
        return legacyKey
      }
      return (await rotateMemberInferenceKey(tx, input)).value
    }
    return (await mintMemberInferenceKey(tx, input)).value
  })
}

async function ensureMemberInferenceAccess(input: { organizationId: OrgId; memberId: MemberId }) {
  await assertOrganizationManagedModelsAllowed(input.organizationId)
  const rawKey = await ensureMemberInferenceKey(input)
  await ensureOpenWorkLlmProviderForMember({ ...input, rawKey })
}

/**
 * Re-provision this member's OpenWork Models key + LLM provider when the org
 * has inference enabled but the member row was deleted or never created.
 * Safe to call from member-facing list endpoints (self-heal).
 */
export async function repairMemberInferenceAccessIfNeeded(input: {
  organizationId: OrgId
  memberId: MemberId
}): Promise<boolean> {
  if (!await organizationAllowsManagedModels(input.organizationId)) return false
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.organizationId))
    .limit(1)

  const inference = readInferenceMetadata(organization?.metadata ?? null)
  if (!inference) {
    return false
  }

  if (await memberHasOpenWorkInferenceAccess(input)) {
    return false
  }

  try {
    await ensureMemberInferenceAccess(input)
    return true
  } catch (error) {
    if (error instanceof ManagedModelsPolicyError) return false
    throw error
  }
}
