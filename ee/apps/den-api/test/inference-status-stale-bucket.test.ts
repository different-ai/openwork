import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"

// Regression test: the dashboard status read must never report an expired
// usage bucket. A user exhausted their five-hour window, came back days later,
// and the dashboard still showed 0% remaining with a reset time in the past
// because status reads never rolled activity-based buckets forward.

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const policyId = createDenTypeId("inferenceOrgLimitPolicy")
const staleBucketId = createDenTypeId("inferenceOrgUsageBucket")

let db: typeof import("../src/db.js").db | null = null
let schema: typeof import("@openwork-ee/den-db/schema") | null = null
let drizzle: typeof import("@openwork-ee/den-db/drizzle") | null = null
let inference: typeof import("../src/inference.js") | null = null

async function cleanup() {
  if (!db || !schema || !drizzle) {
    return
  }
  await db.delete(schema.InferenceOrgUsageBucketTable).where(drizzle.eq(schema.InferenceOrgUsageBucketTable.organization_id, organizationId))
  await db.delete(schema.InferenceOrgLimitPolicyTable).where(drizzle.eq(schema.InferenceOrgLimitPolicyTable.organization_id, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

beforeAll(async () => {
  seedRequiredEnv()
  db = (await import("../src/db.js")).db
  schema = await import("@openwork-ee/den-db/schema")
  drizzle = await import("@openwork-ee/den-db/drizzle")
  inference = await import("../src/inference.js")
  await cleanup()

  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Stale Bucket Test Org",
    slug: `stale-bucket-test-${organizationId}`,
    metadata: { inference: { enabled: true, tier: "tier1" } },
  })
  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "Stale Bucket Tester",
    email: `stale-bucket+${userId}@inference.test`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: "owner",
  })

  // An exhausted five-hour bucket whose window ended four days ago, still
  // referenced as the policy's current bucket (the exact stale state).
  const windowEndAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
  const windowStartAt = new Date(windowEndAt.getTime() - 5 * 60 * 60 * 1000)
  await db.insert(schema.InferenceOrgLimitPolicyTable).values({
    id: policyId,
    organization_id: organizationId,
    window_type: "five_hour",
    reset_strategy: "activity_based",
    anchor_at: windowStartAt,
    current_bucket_id: staleBucketId,
  })
  await db.insert(schema.InferenceOrgUsageBucketTable).values({
    id: staleBucketId,
    organization_id: organizationId,
    policy_id: policyId,
    window_start_at: windowStartAt,
    window_end_at: windowEndAt,
    limit_amount: 100_000_000,
    used_amount: 101_954_838,
  })
})

afterAll(async () => {
  await cleanup()
})

test("status read rolls an expired five-hour bucket forward instead of reporting it", async () => {
  if (!inference) {
    throw new Error("inference module not loaded")
  }

  const status = await inference.getInferenceStatus(organizationId)
  expect(status.enabled).toBe(true)

  const fiveHour = status.buckets.find((bucket) => bucket.windowType === "five_hour")
  if (!fiveHour) {
    throw new Error("expected a five_hour bucket in status")
  }

  // The reported window must include "now" — never a reset time in the past.
  expect(new Date(fiveHour.windowEndAt).getTime()).toBeGreaterThan(Date.now())
  expect(new Date(fiveHour.windowStartAt).getTime()).toBeLessThanOrEqual(Date.now())
  // The fresh window starts unused.
  expect(fiveHour.usedAmount).toBe(0)
  expect(fiveHour.limitAmount).toBeGreaterThan(0)
})
