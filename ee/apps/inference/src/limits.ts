import { and, eq, isNull, sql } from "drizzle-orm"
import { InferenceOrgLimitPolicyTable, InferenceOrgUsageBucketTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_TIER_LIMITS, INFERENCE_WINDOW_DURATIONS_MS } from "@openwork/types/den/inference"
import type { InferenceTier, InferenceWindowType } from "@openwork/types/den/inference"
import { db } from "./db.js"

export type BucketMetadata = Partial<Record<string, DenTypeId<"inferenceOrgUsageBucket">>>
export type BucketLimitMetadata = Partial<Record<string, number>>

function addWindow(start: Date, windowType: InferenceWindowType) {
  return new Date(start.getTime() + INFERENCE_WINDOW_DURATIONS_MS[windowType])
}

function nextAnchoredWindow(input: { anchorAt: Date | null; currentEnd: Date | null; windowType: InferenceWindowType; now: Date }) {
  let start = input.currentEnd ?? input.anchorAt ?? input.now
  let end = addWindow(start, input.windowType)
  while (end <= input.now) {
    start = end
    end = addWindow(start, input.windowType)
  }
  return { start, end }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readInferenceTier(metadata: Record<string, unknown> | null): InferenceTier | null {
  if (!isRecord(metadata?.inference)) return null
  const tier = metadata.inference.tier
  return tier === "tier1" || tier === "tier2" ? tier : null
}

async function getEffectiveLimits(organizationId: DenTypeId<"organization">) {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  const tier = readInferenceTier(organization?.metadata ?? null)
  if (!tier) return null

  const [memberCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
  const memberCount = Math.max(0, Number(memberCountRow?.count ?? 0))

  return Object.fromEntries(
    Object.entries(INFERENCE_TIER_LIMITS[tier]).map(([windowType, limit]) => [windowType, limit * memberCount]),
  ) as Record<InferenceWindowType, number>
}

async function ensureBucket(policy: typeof InferenceOrgLimitPolicyTable.$inferSelect, now: Date, effectiveLimit: number) {
  const current = policy.current_bucket_id
    ? (await db.select().from(InferenceOrgUsageBucketTable).where(eq(InferenceOrgUsageBucketTable.id, policy.current_bucket_id)).limit(1))[0]
    : null
  if (current && current.window_start_at <= now && current.window_end_at > now) {
    if (current.limit_amount !== effectiveLimit) {
      await db.update(InferenceOrgUsageBucketTable).set({ limit_amount: effectiveLimit }).where(eq(InferenceOrgUsageBucketTable.id, current.id))
      current.limit_amount = effectiveLimit
    }
    return current
  }

  const window = policy.reset_strategy === "anchored"
    ? nextAnchoredWindow({
        anchorAt: policy.anchor_at,
        currentEnd: current?.window_end_at ?? null,
        windowType: policy.window_type,
        now,
      })
    : { start: now, end: addWindow(now, policy.window_type) }
  const id = createDenTypeId("inferenceOrgUsageBucket")

  await db.insert(InferenceOrgUsageBucketTable).values({
    id,
    organization_id: policy.organization_id,
    policy_id: policy.id,
    window_start_at: window.start,
    window_end_at: window.end,
    limit_amount: effectiveLimit,
    used_amount: 0,
  })
  await db.update(InferenceOrgLimitPolicyTable).set({ current_bucket_id: id }).where(eq(InferenceOrgLimitPolicyTable.id, policy.id))

  return (await db.select().from(InferenceOrgUsageBucketTable).where(eq(InferenceOrgUsageBucketTable.id, id)).limit(1))[0]
}

export async function ensureUsableBuckets(organizationId: string, now = new Date()) {
  const orgId = normalizeDenTypeId("organization", organizationId)
  const effectiveLimits = await getEffectiveLimits(orgId)
  if (!effectiveLimits) {
    return { ok: false as const, bucketIds: {}, bucketLimits: {}, limitedBy: "inference_metadata", windowType: "monthly" as const }
  }

  const policies = await db.select().from(InferenceOrgLimitPolicyTable).where(eq(InferenceOrgLimitPolicyTable.organization_id, orgId))
  const bucketIds: BucketMetadata = {}
  const bucketLimits: BucketLimitMetadata = {}

  for (const policy of policies) {
    const effectiveLimit = effectiveLimits[policy.window_type]
    const bucket = await ensureBucket(policy, now, effectiveLimit)
    if (!bucket) {
      continue
    }
    const remaining = effectiveLimit - bucket.used_amount
    if (remaining <= 0) {
      return {
        ok: false as const,
        bucketIds,
        bucketLimits,
        limitedBy: bucket.id,
        windowType: policy.window_type,
        limitedBucket: {
          limitAmount: effectiveLimit,
          usedAmount: bucket.used_amount,
          windowEndAt: bucket.window_end_at,
        },
      }
    }
    bucketIds[policy.window_type] = bucket.id
    bucketLimits[policy.window_type] = effectiveLimit
  }

  return { ok: true as const, bucketIds, bucketLimits }
}
