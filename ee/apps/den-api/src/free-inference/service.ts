import { and, eq, gte, lt, inArray, isNotNull, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  InferenceFreeUsageBucketTable,
  InferenceFreeUsageTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { inferenceBearerKey, inferenceBearerKeyLookupDigests } from "@openwork-ee/utils/inference-bearer-key"
import {
  freeInferenceAccess, freeInferenceWindow, freeInferenceOrganizationAllowed, freeInferenceDefaultPinned, managedModelCatalog,
  INFERENCE_USAGE_CONVERSION_FACTOR,
  type InferenceAccess, type FreeInferenceProviderSummary,
} from "@openwork/types/den/inference"
import { assertManagedModelsAllowed, ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { freeInferenceDigest } from "@openwork-ee/utils/free-inference-digest"
import { MEMBER_FREE_STATUS_PATH } from "@openwork/free-auto"
import { db } from "../db.js"
import { env } from "../env.js"
import { calculateDesktopPolicyForOrgMember } from "../desktop-policies.js"
import { findActiveMemberInferenceKey, mintMemberInferenceKey, rotateMemberInferenceKey } from "../inference-shared/public.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

type FreeMemberInput = { organizationId: OrgId; memberId: MemberId; userId: NonNullable<typeof MemberTable.$inferSelect.userId> }
const freeHash = freeInferenceDigest

/**
 * Free Auto follows Den's "Free starter model (Auto)" switch, stored as `allowZenModel`: off means no free Auto,
 * whether or not members may add their own providers. Read from the member's effective policy in Den, so it
 * holds whether or not the desktop app enforces the policy locally.
 */
export async function freeAutoBlockedByDesktopPolicy(input: Pick<FreeMemberInput, "organizationId" | "memberId">): Promise<boolean> {
  const policy = await calculateDesktopPolicyForOrgMember({ organizationId: input.organizationId, orgMemberId: input.memberId })
  return policy.allowZenModel === false
}

export async function getMemberInferenceAccess(input: FreeMemberInput): Promise<InferenceAccess> {
  let defaultPinned: boolean | undefined
  const unavailable = (reason: "not_eligible" | "admin_disabled" | "accounting_unavailable") => ({
    ...freeInferenceAccess({ config: env.inferenceFree, reason }), defaultPinned, usedUsd: null, remainingUsd: null,
  })
  try {
    const [row] = await db.select({ metadata: OrganizationTable.metadata, nowMs: sql<number>`unix_timestamp(current_timestamp(3)) * 1000` })
      .from(MemberTable).innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId),
        eq(MemberTable.userId, input.userId), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt))).limit(1)
    if (!row) return unavailable("not_eligible")
    defaultPinned = freeInferenceDefaultPinned(row.metadata)
    assertManagedModelsAllowed(row.metadata)
    if (!freeInferenceOrganizationAllowed(row.metadata)) return unavailable("admin_disabled")
    const now = new Date(Number(row.nowMs))
    if (!env.inferenceFree.enabled) return { ...freeInferenceAccess({ config: env.inferenceFree, now, reason: "free_disabled" }), defaultPinned }
    if (await freeAutoBlockedByDesktopPolicy(input)) return unavailable("admin_disabled")
    const identity = freeHash("member", input.userId)
    const [bucket] = await db.select({ used_amount: InferenceFreeUsageBucketTable.used_amount }).from(InferenceFreeUsageBucketTable).where(and(
      eq(InferenceFreeUsageBucketTable.identity_hash, identity), eq(InferenceFreeUsageBucketTable.window_start_at, freeInferenceWindow(now).start))).limit(1)
    return { ...freeInferenceAccess({ config: env.inferenceFree, now, bucket }), defaultPinned }
  } catch (error) {
    return unavailable(error instanceof ManagedModelsPolicyError && error.code === "managed_models_disabled_for_dpa" ? "admin_disabled" : "accounting_unavailable")
  }
}

export async function getFreeInferenceProviderSummary(organizationId: OrgId): Promise<FreeInferenceProviderSummary> {
  const [organization] = await db.select({ metadata: OrganizationTable.metadata, nowMs: sql<number>`unix_timestamp(current_timestamp(3)) * 1000` })
    .from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
  if (!organization) throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
  const now = new Date(Number(organization.nowMs))
  if (!Number.isFinite(now.getTime())) throw new Error("free_accounting_unavailable")
  const window = freeInferenceWindow(now)
  const members = await db.select({ userId: MemberTable.userId }).from(MemberTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt), isNotNull(MemberTable.userId)))
  const identities = [...new Set(members.flatMap((member) => member.userId ? [freeHash("member", member.userId)] : []))]
  let reason: InferenceAccess["reason"] = env.inferenceFree.enabled ? null : "free_disabled"
  try { assertManagedModelsAllowed(organization.metadata) } catch (error) {
    if (!(error instanceof ManagedModelsPolicyError) || error.code !== "managed_models_disabled_for_dpa") throw error
    reason = "admin_disabled"
  }
  if (!freeInferenceOrganizationAllowed(organization.metadata)) reason = "admin_disabled"
  const summary: FreeInferenceProviderSummary = {
    state: reason ? "disabled" : "available", reason,
    defaultPinned: freeInferenceDefaultPinned(organization.metadata),
    modelGroup: { id: "free", name: "Free" }, catalog: managedModelCatalog(),
    allowance: { usageScope: "organization", allowanceScope: "person", windowStartAt: window.start.toISOString(), resetsAt: window.end.toISOString(),
      weeklyLimitUsd: env.inferenceFree.weeklyBudgetUsd, joinedMembers: identities.length, eligibleMembers: reason ? 0 : identities.length,
      exhaustedMembers: null, usedUsd: null, requestCount: null },
  }
  if (reason) return summary
  const buckets = identities.length ? await db.select({ identity_hash: InferenceFreeUsageBucketTable.identity_hash, used_amount: InferenceFreeUsageBucketTable.used_amount })
    .from(InferenceFreeUsageBucketTable).where(and(inArray(InferenceFreeUsageBucketTable.identity_hash, identities),
      eq(InferenceFreeUsageBucketTable.window_start_at, window.start))) : []
  const [usage] = await db.select({
    usedAmount: sql<number | string>`coalesce(sum(${InferenceFreeUsageTable.amount}), 0)`,
    requestCount: sql<number | string>`count(*)`,
  }).from(InferenceFreeUsageTable)
    .where(and(eq(InferenceFreeUsageTable.organization_id, organizationId),
      gte(InferenceFreeUsageTable.created_at, window.start), lt(InferenceFreeUsageTable.created_at, window.end)))
  const bucketsByIdentity = new Map(buckets.map((bucket) => [bucket.identity_hash, bucket]))
  const accesses = identities.map((identity) => freeInferenceAccess({ config: env.inferenceFree, now, bucket: bucketsByIdentity.get(identity) }))
  if (!usage || accesses.some((access) => access.reason === "accounting_unavailable")
    || Object.values(usage).some((amount) => !Number.isSafeInteger(Number(amount)) || Number(amount) < 0)) {
    return { ...summary, state: "unavailable", reason: "accounting_unavailable" }
  }
  return { ...summary, allowance: { ...summary.allowance,
    exhaustedMembers: accesses.filter((access) => access.kind === "exhausted").length,
    usedUsd: Number(usage.usedAmount) / INFERENCE_USAGE_CONVERSION_FACTOR,
    requestCount: Number(usage.requestCount),
  } }
}

/**
 * Signed-in members of unsubscribed organizations use a regular OpenWork Models
 * (`ow_inf_`) key. The Gateway serves only free Auto on it until the organization
 * subscribes, when the same key starts reaching paid Models.
 */
/** Why a member gets no free Auto key, in terms the app can explain. */
export type FreeCredentialRefusal = "free_disabled" | "free_not_offered" | "not_eligible"

/**
 * Issues or reuses the member's OpenWork Models key for free Auto. Organizations that pay for OpenWork Models
 * get it too: the Gateway serves Auto on the same key from the member's free weekly allowance, never billed to them.
 */
export async function issueMemberFreeInferenceCredential(input: FreeMemberInput): Promise<{ credential: { apiKey: string; baseURL: string; statusURL: string; modelID: string } } | { refusal: FreeCredentialRefusal }> {
  if (!env.inferenceFree.enabled) return { refusal: "free_disabled" }
  if (await freeAutoBlockedByDesktopPolicy(input)) return { refusal: "free_not_offered" }
  const result = await db.transaction(async (tx): Promise<{ apiKey: string } | { refusal: FreeCredentialRefusal }> => {
    const [organization] = await tx.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, input.organizationId)).limit(1).for("update")
    if (!organization) return { refusal: "not_eligible" }
    assertManagedModelsAllowed(organization.metadata)
    if (!freeInferenceOrganizationAllowed(organization.metadata)) return { refusal: "free_not_offered" }
    const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(eq(MemberTable.id, input.memberId),
      eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt))).limit(1).for("update")
    if (!member) return { refusal: "not_eligible" }
    const existing = await findActiveMemberInferenceKey(tx, input)
    if (existing?.encryptedKey && (await inferenceBearerKeyLookupDigests(inferenceBearerKey(existing.encryptedKey))).includes(existing.keyHash)) return { apiKey: existing.encryptedKey }
    const key = existing ? await rotateMemberInferenceKey(tx, input) : await mintMemberInferenceKey(tx, input)
    return { apiKey: key.value }
  })
  if ("refusal" in result) return result
  const base = env.modelsPublicBaseUrl.replace(/\/+$/, "")
  return { credential: { apiKey: result.apiKey, baseURL: `${base}/api/v1`, statusURL: `${base}${MEMBER_FREE_STATUS_PATH}`, modelID: env.inferenceFree.modelID } }
}

export async function ensureMemberFreeInferenceCredential(input: FreeMemberInput) {
  const result = await issueMemberFreeInferenceCredential(input)
  return "credential" in result ? result.credential : null
}
