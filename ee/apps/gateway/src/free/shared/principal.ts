import { freeInferenceDigest } from "@openwork-ee/utils/free-inference-digest"
import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { InferenceKeyTable, MemberTable, OrganizationTable, OrgSubscriptionTable } from "@openwork-ee/den-db"
import { assertManagedModelsAllowed } from "@openwork/types/den/managed-models-policy"
import { freeInferenceOrganizationAllowed, inferenceSubscribed, inferenceSubscriptionLive } from "@openwork/types/den/inference"
import { db } from "../../db.js"

type InferenceKeyRow = typeof InferenceKeyTable.$inferSelect
/** Signed-out desktop: the id is the keyed hash of the machine identifier. */
export type GuestPrincipal = { kind: "installation"; id: string }
/** Signed-in, unsubscribed member using their OpenWork Models key. The allowance is per person. */
export type MemberPrincipal = { kind: "member"; id: NonNullable<typeof MemberTable.$inferSelect.userId>;
  inferenceKeyId: InferenceKeyRow["id"]; memberId: InferenceKeyRow["org_membership_id"]; organizationId: InferenceKeyRow["organization_id"] }
export type FreePrincipal = GuestPrincipal | MemberPrincipal
type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]
export const freeIdentityHash = freeInferenceDigest
export function freePrincipalHash(principal: FreePrincipal) { return freeIdentityHash(principal.kind, principal.id) }

async function memberFreePrincipalRow(principal: Pick<MemberPrincipal, "inferenceKeyId" | "memberId" | "organizationId">, database: Database) {
  const [row] = await database.select({ userId: MemberTable.userId, metadata: OrganizationTable.metadata, subscription: OrgSubscriptionTable.status }).from(InferenceKeyTable)
    .innerJoin(MemberTable, and(eq(MemberTable.id, InferenceKeyTable.org_membership_id), eq(MemberTable.organizationId, InferenceKeyTable.organization_id)))
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
    .leftJoin(OrgSubscriptionTable, and(eq(OrgSubscriptionTable.organization_id, OrganizationTable.id), eq(OrgSubscriptionTable.type, "inference")))
    .where(and(eq(InferenceKeyTable.id, principal.inferenceKeyId), eq(InferenceKeyTable.status, "active"),
      eq(MemberTable.id, principal.memberId), eq(OrganizationTable.id, principal.organizationId),
      isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt), isNotNull(MemberTable.userId))).limit(1)
  return row
}

/**
 * Free Auto is only for joined members of unsubscribed organizations that have not opted out. An organization
 * Stripe still collects for is never downgraded to free, even if its metadata says Models are off: members keep
 * getting `inference_disabled`, which support can see, instead of a silent $5 allowance.
 */
function freeOrganization(metadata: Record<string, unknown> | null, subscription: string | null) {
  if (inferenceSubscribed(metadata) || inferenceSubscriptionLive(subscription) || !freeInferenceOrganizationAllowed(metadata)) return false
  assertManagedModelsAllowed(metadata)
  return true
}

export async function findMemberFreePrincipal(key: Pick<InferenceKeyRow, "id" | "org_membership_id" | "organization_id">, database: Database = db): Promise<MemberPrincipal | null> {
  const identity = { inferenceKeyId: key.id, memberId: key.org_membership_id, organizationId: key.organization_id }
  const row = await memberFreePrincipalRow(identity, database)
  if (!row?.userId || !freeOrganization(row.metadata, row.subscription)) return null
  return { kind: "member", id: row.userId, ...identity }
}

export async function memberFreePrincipalAllowed(principal: FreePrincipal, database: Database = db): Promise<boolean> {
  if (principal.kind !== "member") return true
  const row = await memberFreePrincipalRow(principal, database)
  return Boolean(row && row.userId === principal.id && freeOrganization(row.metadata, row.subscription))
}
