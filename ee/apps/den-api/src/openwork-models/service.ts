import { peopleMemberCondition } from "../setup-agent-members.js"
import { and, asc, eq, isNotNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  InferenceOrgLimitPolicyTable,
  InferenceOrgUsageBucketTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE,
  INFERENCE_TIER_LIMITS,
  INFERENCE_WINDOW_DURATIONS_MS,
  INFERENCE_WINDOW_TYPES,
  withFreeInferenceOfferAllowed,
} from "@openwork/types/den/inference"
import type { InferenceTier, InferenceWindowType } from "@openwork/types/den/inference"
import { assertManagedModelsAllowed } from "@openwork/types/den/managed-models-policy"
import { db } from "../db.js"
import { env } from "../env.js"
import { assertOrganizationManagedModelsAllowed, updateOrganizationMetadata } from "../organization-metadata.js"
import { organizationAllowsManagedModels, revokeInferenceKeysForOrganization } from "../inference-shared/public.js"
import { isRecord, readInferenceMetadata, setInferenceMetadata } from "./metadata.js"
import { repairMemberInferenceAccessIfNeeded } from "./member-keys.js"
import { ensureOrgUpstreamProviderKey, revokeOrgUpstreamProviderKeys } from "./openrouter-keys.js"
import { deleteOpenWorkProviders } from "./provider-projection.js"

type OrgId = typeof OrganizationTable.$inferSelect.id

async function activeMemberCount(organizationId: OrgId) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), peopleMemberCondition()))
  return Math.max(0, Number(row?.count ?? 0))
}

async function listOrgMembers(organizationId: OrgId) {
  return db.select({ id: MemberTable.id }).from(MemberTable).where(and(eq(MemberTable.organizationId, organizationId), peopleMemberCondition(), isNotNull(MemberTable.userId)))
}

function addWindow(start: Date, windowType: InferenceWindowType) {
  return new Date(start.getTime() + INFERENCE_WINDOW_DURATIONS_MS[windowType])
}

function currentWindow(input: { anchorAt: Date | null; currentEnd: Date | null; windowType: InferenceWindowType; now: Date }) {
  let start = input.currentEnd ?? input.anchorAt ?? input.now
  let end = addWindow(start, input.windowType)
  while (end <= input.now) {
    start = end
    end = addWindow(start, input.windowType)
  }
  return { start, end }
}

export async function syncInferenceForOrganizationMembers(input: { organizationId: OrgId }) {
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

  const members = await listOrgMembers(input.organizationId)
  await syncInferenceLimitPolicies({ organizationId: input.organizationId, tier: inference.tier, memberCount: members.length })

  for (const member of members) {
    await repairMemberInferenceAccessIfNeeded({
      organizationId: input.organizationId,
      memberId: member.id,
    })
  }
}

export async function syncInferenceLimitPolicies(input: { organizationId: OrgId; tier: InferenceTier; memberCount: number }) {
  await db.transaction(async (tx) => {
    const anchorAt = new Date()
    for (const windowType of Object.keys(INFERENCE_TIER_LIMITS[input.tier])) {
      await tx
        .insert(InferenceOrgLimitPolicyTable)
        .values({
          id: createDenTypeId("inferenceOrgLimitPolicy"),
          organization_id: input.organizationId,
          window_type: windowType as keyof typeof INFERENCE_TIER_LIMITS[InferenceTier],
          reset_strategy: INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE[windowType as keyof typeof INFERENCE_TIER_LIMITS[InferenceTier]],
          anchor_at: anchorAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            reset_strategy: INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE[windowType as keyof typeof INFERENCE_TIER_LIMITS[InferenceTier]],
          },
        })
    }

    const policies = await tx
      .select({
        id: InferenceOrgLimitPolicyTable.id,
        windowType: InferenceOrgLimitPolicyTable.window_type,
        resetStrategy: InferenceOrgLimitPolicyTable.reset_strategy,
        anchorAt: InferenceOrgLimitPolicyTable.anchor_at,
        currentBucketId: InferenceOrgLimitPolicyTable.current_bucket_id,
      })
      .from(InferenceOrgLimitPolicyTable)
      .where(eq(InferenceOrgLimitPolicyTable.organization_id, input.organizationId))
      .orderBy(asc(InferenceOrgLimitPolicyTable.window_type))
      .for("update")
    const now = new Date()

    for (const policy of policies) {
      const limitAmount = INFERENCE_TIER_LIMITS[input.tier][policy.windowType] * input.memberCount
      const currentBucket = policy.currentBucketId
        ? (await tx.select().from(InferenceOrgUsageBucketTable).where(eq(InferenceOrgUsageBucketTable.id, policy.currentBucketId)).limit(1).for("update"))[0]
        : null

      if (currentBucket && currentBucket.window_start_at <= now && currentBucket.window_end_at > now) {
        await tx
          .update(InferenceOrgUsageBucketTable)
          .set({ limit_amount: limitAmount })
          .where(eq(InferenceOrgUsageBucketTable.id, currentBucket.id))
        continue
      }

      const window = policy.resetStrategy === "anchored"
        ? currentWindow({
            anchorAt: policy.anchorAt,
            currentEnd: currentBucket?.window_end_at ?? null,
            windowType: policy.windowType,
            now,
          })
        : { start: now, end: addWindow(now, policy.windowType) }
      const bucketId = createDenTypeId("inferenceOrgUsageBucket")
      await tx.insert(InferenceOrgUsageBucketTable).values({
        id: bucketId,
        organization_id: input.organizationId,
        policy_id: policy.id,
        window_start_at: window.start,
        window_end_at: window.end,
        limit_amount: limitAmount,
        used_amount: 0,
      })
      await tx
        .update(InferenceOrgLimitPolicyTable)
        .set({ current_bucket_id: bucketId })
        .where(eq(InferenceOrgLimitPolicyTable.id, policy.id))
    }
  })
}

async function getActiveUsageBuckets(organizationId: OrgId) {
  const rows = await db
    .select({
      windowType: InferenceOrgLimitPolicyTable.window_type,
      windowStartAt: InferenceOrgUsageBucketTable.window_start_at,
      windowEndAt: InferenceOrgUsageBucketTable.window_end_at,
      limitAmount: InferenceOrgUsageBucketTable.limit_amount,
      usedAmount: InferenceOrgUsageBucketTable.used_amount,
    })
    .from(InferenceOrgUsageBucketTable)
    .innerJoin(
      InferenceOrgLimitPolicyTable,
      eq(InferenceOrgUsageBucketTable.id, InferenceOrgLimitPolicyTable.current_bucket_id),
    )
    .where(eq(InferenceOrgUsageBucketTable.organization_id, organizationId))

  // Row order is unspecified without ORDER BY; keep status responses stable.
  rows.sort((left, right) => INFERENCE_WINDOW_TYPES.indexOf(left.windowType) - INFERENCE_WINDOW_TYPES.indexOf(right.windowType))
  return rows.map((row) => ({
    windowType: row.windowType,
    windowStartAt: row.windowStartAt.toISOString(),
    windowEndAt: row.windowEndAt.toISOString(),
    limitAmount: Number(row.limitAmount ?? 0),
    usedAmount: Number(row.usedAmount ?? 0),
  }))
}

export async function getInferenceStatus(organizationId: OrgId) {
  const managedModelsAllowed = await organizationAllowsManagedModels(organizationId)
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  const memberCount = await activeMemberCount(organizationId)
  const inference = managedModelsAllowed ? readInferenceMetadata(organization?.metadata ?? null) : null
  // Admin status reads are a natural repair point: org can show ENABLED in Den
  // while individual members are missing keys/providers after manual deletes.
  if (inference?.enabled === true) {
    try {
      const members = await listOrgMembers(organizationId)
      for (const member of members) {
        await repairMemberInferenceAccessIfNeeded({
          organizationId,
          memberId: member.id,
        })
      }
    } catch {
      // Status should still return even if upstream key provisioning fails.
    }
  }
  const buckets = inference?.enabled === true ? await getActiveUsageBuckets(organizationId) : []
  return {
    enabled: inference?.enabled === true,
    tier: inference?.tier ?? "tier1",
    memberCount,
    proxyBaseUrl: env.inferenceProxyBaseUrl,
    upstreamProviderConfigured: Boolean(env.openRouterManagementApiKey),
    buckets,
  }
}

/** An admin turning Models on before subscribing lifts an earlier free Auto opt-out; paid Models still wait for checkout. */
export async function allowFreeInferenceOffer(organizationId: OrgId) {
  await updateOrganizationMetadata(organizationId, (metadata) => isRecord(metadata.inferenceFree) && metadata.inferenceFree.offerAllowed === false
    ? withFreeInferenceOfferAllowed(metadata, true) : metadata)
}

export async function setInferenceEnabled(input: { organizationId: OrgId; enabled: boolean; tier?: InferenceTier; source?: "admin" }) {
  if (!input.enabled) {
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(OrganizationTable).where(eq(OrganizationTable.id, input.organizationId)).for("update")
      if (!current) return
      const cleared = setInferenceMetadata(current.metadata, null)
      // Keys are revoked below either way; an admin opt-out also stops free Auto re-issuing them.
      const metadata = input.source === "admin" ? withFreeInferenceOfferAllowed(cleared, false) : cleared
      await tx.update(OrganizationTable).set({ metadata }).where(eq(OrganizationTable.id, input.organizationId))
      await revokeInferenceKeysForOrganization(tx, input.organizationId)
    })
    await revokeOrgUpstreamProviderKeys(input.organizationId)
    await deleteOpenWorkProviders({ organizationId: input.organizationId })
    return getInferenceStatus(input.organizationId)
  }

  await assertOrganizationManagedModelsAllowed(input.organizationId)
  await ensureOrgUpstreamProviderKey(input.organizationId)
  await updateOrganizationMetadata(input.organizationId, (metadata) => {
    assertManagedModelsAllowed(metadata)
    const tier = input.tier ?? readInferenceMetadata(metadata)?.tier ?? "tier1"
    const next = setInferenceMetadata(metadata, { enabled: true, tier })
    return input.source === "admin" ? withFreeInferenceOfferAllowed(next, true) : next
  })
  await syncInferenceForOrganizationMembers({ organizationId: input.organizationId })
  return getInferenceStatus(input.organizationId)
}
