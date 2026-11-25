import { freeInferenceDigest } from "@openwork-ee/utils/free-inference-digest"
import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { FreeRequestError } from "./errors.js"
import { AuthUserTable, InferenceKeyTable, MemberTable, OrganizationTable, readDesktopPolicyForOrgMember, sandboxFreeAutoStopped } from "@openwork-ee/den-db"
import { assertManagedModelsAllowed } from "@openwork/types/den/managed-models-policy"
import { freeInferenceDefaultPinned, freeInferenceOrganizationAllowed } from "@openwork/types/den/inference"
import { db, freeAutoDatabase } from "../../db.js"

type InferenceKeyRow = typeof InferenceKeyTable.$inferSelect
export type GuestPrincipal = { kind: "installation"; id: string; untaggedIpHash?: string;
  journeyHash?: string;
  observationRateHash?: string;
  deviceless?: true }
export type MemberPrincipal = { kind: "member"; id: NonNullable<typeof MemberTable.$inferSelect.userId>;
  inferenceKeyId: InferenceKeyRow["id"]; memberId: InferenceKeyRow["org_membership_id"]; organizationId: InferenceKeyRow["organization_id"] }
export type FreePrincipal = GuestPrincipal | MemberPrincipal
type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]
export const freeIdentityHash = freeInferenceDigest
export function freePrincipalHash(principal: FreePrincipal) { return freeIdentityHash(principal.kind, principal.id) }
export const freeSafetyIdentifier = freePrincipalHash

async function memberFreePrincipalRow(principal: Pick<MemberPrincipal, "inferenceKeyId" | "memberId" | "organizationId">, database: Pick<Database, "select">) {
  const [row] = await database.select({ userId: MemberTable.userId, emailVerified: AuthUserTable.emailVerified, metadata: OrganizationTable.metadata }).from(InferenceKeyTable)
    .innerJoin(MemberTable, and(eq(MemberTable.id, InferenceKeyTable.org_membership_id), eq(MemberTable.organizationId, InferenceKeyTable.organization_id)))
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
    .where(and(eq(InferenceKeyTable.id, principal.inferenceKeyId), eq(InferenceKeyTable.status, "active"),
      eq(MemberTable.id, principal.memberId), eq(OrganizationTable.id, principal.organizationId),
      isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt), isNotNull(MemberTable.userId))).limit(1)
  return row
}

function freeOrganization(metadata: Record<string, unknown> | null) {
  if (!freeInferenceOrganizationAllowed(metadata)) return false
  assertManagedModelsAllowed(metadata)
  return true
}

async function freePolicyAllowed(identity: Pick<MemberPrincipal, "memberId" | "organizationId">, database: Database) {
  const policy = await readDesktopPolicyForOrgMember(database, { organizationId: identity.organizationId, orgMemberId: identity.memberId })
  if (policy.allowZenModel === false) return false
  if (await sandboxFreeAutoStopped(database, identity.organizationId)) {
    throw new FreeRequestError(403, "free_sandbox_ended", "This sandbox trial has ended. Ask a platform admin to reopen it to use OpenWork Free.")
  }
  return true
}

function requireVerifiedEmail(verified: boolean) {
  if (!verified) throw new FreeRequestError(403, "email_verification_required", "Verify your account email to use OpenWork Free.")
}

export async function findMemberFreePrincipal(key: Pick<InferenceKeyRow, "id" | "org_membership_id" | "organization_id">, database: typeof db = freeAutoDatabase()): Promise<MemberPrincipal | null> {
  const identity = { inferenceKeyId: key.id, memberId: key.org_membership_id, organizationId: key.organization_id }
  const row = await memberFreePrincipalRow(identity, database.$primary)
  if (!row?.userId || !freeOrganization(row.metadata) || !await freePolicyAllowed(identity, database)) return null
  requireVerifiedEmail(row.emailVerified)
  return { kind: "member", id: row.userId, ...identity }
}

export async function memberFreePrincipalAllowed(principal: FreePrincipal, database: Database = db): Promise<boolean> {
  if (principal.kind !== "member") return true
  const row = await memberFreePrincipalRow(principal, database)
  if (!row || row.userId !== principal.id || !freeOrganization(row.metadata) || !await freePolicyAllowed(principal, database)) return false
  requireVerifiedEmail(row.emailVerified)
  return true
}

export async function readFreePrincipalDefaultPinned(principal: FreePrincipal, database: Database = freeAutoDatabase()): Promise<boolean> {
  if (principal.kind !== "member") return true
  const row = await memberFreePrincipalRow(principal, database)
  if (!row || row.userId !== principal.id || !freeOrganization(row.metadata) || !await freePolicyAllowed(principal, database)) throw new Error("free_principal_rejected")
  return freeInferenceDefaultPinned(row.metadata)
}
