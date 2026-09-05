import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { OrgCloudTrialTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

export const CLOUD_TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000

export async function getCloudTrial(organizationId: DenTypeId<"organization">) {
  const [trial] = await db.select().from(OrgCloudTrialTable)
    .where(eq(OrgCloudTrialTable.organization_id, organizationId)).limit(1)
  return trial ?? null
}

export async function hasUsedCloudTrial(userId: DenTypeId<"user">) {
  const [trial] = await db.select({ organizationId: OrgCloudTrialTable.organization_id })
    .from(OrgCloudTrialTable).where(eq(OrgCloudTrialTable.started_by_user_id, userId)).limit(1)
  return Boolean(trial)
}

export function serializeCloudTrial(trial: typeof OrgCloudTrialTable.$inferSelect | null, eligible: boolean, covered = false) {
  return {
    status: covered ? "ineligible" : trial ? (trial.expires_at.getTime() > Date.now() ? "active" : "expired") : eligible ? "eligible" : "ineligible",
    startedAt: trial?.started_at.toISOString() ?? null,
    expiresAt: trial?.expires_at.toISOString() ?? null,
  }
}

export async function startCloudTrial(organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) {
  const now = new Date()
  // Both unique keys are deliberate: retries cannot extend an org trial, and
  // starting another org cannot give the same person another free week.
  await db.insert(OrgCloudTrialTable).values({
    organization_id: organizationId,
    started_by_user_id: userId,
    started_at: now,
    expires_at: new Date(now.getTime() + CLOUD_TRIAL_DURATION_MS),
  }).onDuplicateKeyUpdate({ set: { organization_id: sql`${OrgCloudTrialTable.organization_id}` } })
  return getCloudTrial(organizationId)
}
