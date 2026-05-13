import { eq } from "drizzle-orm"
import { InferenceOrgLimitPolicyTable, InferenceOrgUsageBucketTable } from "@openwork-ee/den-db"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_WINDOW_DURATIONS_MS } from "@openwork/types/den/inference"
import type { InferenceWindowType } from "@openwork/types/den/inference"
import { db } from "./db.js"

export type BucketMetadata = Partial<Record<string, DenTypeId<"inferenceOrgUsageBucket">>>

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

async function ensureBucket(policy: typeof InferenceOrgLimitPolicyTable.$inferSelect, now: Date) {
  const current = policy.current_bucket_id
    ? (await db.select().from(InferenceOrgUsageBucketTable).where(eq(InferenceOrgUsageBucketTable.id, policy.current_bucket_id)).limit(1))[0]
    : null
  if (current && current.window_start_at <= now && current.window_end_at > now) {
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
    limit_amount: policy.limit_amount,
    used_amount: 0,
  })
  await db.update(InferenceOrgLimitPolicyTable).set({ current_bucket_id: id }).where(eq(InferenceOrgLimitPolicyTable.id, policy.id))

  return (await db.select().from(InferenceOrgUsageBucketTable).where(eq(InferenceOrgUsageBucketTable.id, id)).limit(1))[0]
}

export async function ensureUsableBuckets(organizationId: string, now = new Date()) {
  const orgId = normalizeDenTypeId("organization", organizationId)
  const policies = await db.select().from(InferenceOrgLimitPolicyTable).where(eq(InferenceOrgLimitPolicyTable.organization_id, orgId))
  const bucketIds: BucketMetadata = {}

  for (const policy of policies) {
    const bucket = await ensureBucket(policy, now)
    if (!bucket) {
      continue
    }
    const remaining = bucket.limit_amount - bucket.used_amount
    if (remaining <= 0) {
      return { ok: false as const, bucketIds, limitedBy: bucket.id, windowType: policy.window_type }
    }
    bucketIds[policy.window_type] = bucket.id
  }

  return { ok: true as const, bucketIds }
}
