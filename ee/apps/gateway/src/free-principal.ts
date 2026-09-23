import { freeCredentialDigest, freeInferenceDigest } from "@openwork-ee/utils/free-inference-digest"
import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { InferenceFreeKeyTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db"
import { assertManagedModelsAllowed } from "@openwork/types/den/managed-models-policy"
import { freeInferenceOrganizationAllowed } from "@openwork/types/den/inference"
import { db } from "./db.js"

type MemberPrincipal = { kind: "member"; id: NonNullable<typeof MemberTable.$inferSelect.userId>;
  keyId: string; memberId: typeof MemberTable.$inferSelect.id; organizationId: typeof OrganizationTable.$inferSelect.id }
export type FreePrincipal = MemberPrincipal | { kind: "installation"; id: string }
type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]
export const freeIdentityHash = freeInferenceDigest
export function freePrincipalHash(principal: FreePrincipal) { return freeIdentityHash(principal.kind, principal.id) }

export async function findMemberFreePrincipal(bearer: string, database: Database = db): Promise<MemberPrincipal | null> {
  if (!/^ow_auto_[A-Za-z0-9_-]{43}$/.test(bearer)) return null
  const [key] = await database.select().from(InferenceFreeKeyTable)
    .where(and(eq(InferenceFreeKeyTable.key_hash, await freeCredentialDigest(bearer)), isNull(InferenceFreeKeyTable.revoked_at))).limit(1)
  if (!key) return null
  const principal: MemberPrincipal = { kind: "member", id: key.user_id, keyId: key.id,
    memberId: key.org_membership_id, organizationId: key.organization_id }
  return await memberFreePrincipalAllowed(principal, database) ? principal : null
}

export async function memberFreePrincipalAllowed(principal: FreePrincipal, database: Database = db): Promise<boolean> {
  if (principal.kind !== "member") return true
  const [row] = await database.select({ metadata: OrganizationTable.metadata }).from(InferenceFreeKeyTable)
    .innerJoin(MemberTable, and(eq(MemberTable.id, InferenceFreeKeyTable.org_membership_id), eq(MemberTable.organizationId, InferenceFreeKeyTable.organization_id), eq(MemberTable.userId, InferenceFreeKeyTable.user_id)))
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
    .where(and(eq(InferenceFreeKeyTable.id, principal.keyId), eq(InferenceFreeKeyTable.user_id, principal.id),
      eq(MemberTable.id, principal.memberId), eq(OrganizationTable.id, principal.organizationId),
      isNull(InferenceFreeKeyTable.revoked_at), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt),
      eq(InferenceFreeKeyTable.membership_joined_at, MemberTable.joinedAt))).limit(1)
  if (!row || !freeInferenceOrganizationAllowed(row.metadata)) return false
  assertManagedModelsAllowed(row.metadata)
  return true
}
