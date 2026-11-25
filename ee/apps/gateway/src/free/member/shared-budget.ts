import { and, eq, gte, lt, sql } from "@openwork-ee/den-db/drizzle"
import { FreeAutoOrgFounderTable as Founder, InferenceFreeUsageBucketTable as Bucket, InferenceFreeUsageTable as Usage } from "@openwork-ee/den-db"
import { freeUsageAmount } from "@openwork/free-auto/accounting"
import { freeInferenceWindow, INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"
import type { db } from "../../db.js"
import { freeIdentityHash, freePrincipalHash, type MemberPrincipal } from "../shared/principal.js"
import type { FreeUsageReceipt } from "../shared/allowance.js"
import type { AutoConfig } from "../shared/config.js"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type MemberBudgetScope = { desktopHash?: string }

export function maximumCompletionCost(config: AutoConfig, choices: number) {
  if (config.upstreamModel !== "gpt-6-luna" || choices !== 1) return null
  return freeUsageAmount(config, 1_050_000, 128_000)
}

export function fitsBudget(used: number, reserved: number, limit: number) {
  return [used, reserved, limit].every(n => Number.isSafeInteger(n) && n >= 0) && used + reserved <= limit
}

function personBucket(principal: MemberPrincipal, date: Date, config: AutoConfig) {
  const identity = freePrincipalHash(principal)
  const week = freeInferenceWindow(date)
  return { id: freeIdentityHash("free", ["usage", "member", identity, "weekly", week.start.toISOString()].join(":")), identity_hash: identity,
    window_start_at: week.start, window_end_at: week.end, limit_amount: config.member.weeklyLimitAmount }
}

export async function memberSharedLimit(tx: Tx, principal: MemberPrincipal, config: AutoConfig, amount: number, now: Date, scope: MemberBudgetScope = {}) {
  const week = freeInferenceWindow(now)
  const dayStart = new Date(now)
  dayStart.setUTCHours(0, 0, 0, 0)
  const total = { amount: sql<string>`coalesce(sum(${Usage.amount}), 0)` }
  const [platform] = await tx.select(total).from(Usage).where(gte(Usage.created_at, dayStart))
  const [org] = await tx.select(total).from(Usage).where(and(eq(Usage.organization_id, principal.organizationId),
    gte(Usage.created_at, week.start), lt(Usage.created_at, week.end)))
  if (!fitsBudget(Number(platform.amount), amount, config.memberGlobalDailyAmount)) return "free_platform_budget_exhausted"
  if (!fitsBudget(Number(org.amount), amount, config.orgWeeklyAmount)) return "free_org_budget_exhausted"
  const inWeek = and(gte(Usage.created_at, week.start), lt(Usage.created_at, week.end))
  const [founder] = await tx.select({ userId: Founder.founder_user_id }).from(Founder)
    .where(eq(Founder.organization_id, principal.organizationId))
  if (founder) {
    const [founderUsage] = await tx.select(total).from(Founder).innerJoin(Usage, eq(Usage.organization_id, Founder.organization_id))
      .where(and(eq(Founder.founder_user_id, founder.userId), inWeek))
    if (!fitsBudget(Number(founderUsage.amount), amount, config.orgWeeklyAmount)) return "free_founder_budget_exhausted"
  }
  if (scope.desktopHash) {
    const [desktop] = await tx.select(total).from(Usage).where(and(eq(Usage.desktop_hash, scope.desktopHash), inWeek))
    if (!fitsBudget(Number(desktop.amount), amount, config.member.weeklyLimitAmount)) return "free_desktop_budget_exhausted"
  }
  return null
}

export async function reserveMemberBudget(tx: Tx, principal: MemberPrincipal, config: AutoConfig, requestId: string, amount: number, scope: MemberBudgetScope = {}) {
  const lockId = freeIdentityHash("member-budget", "admission-lock")
  const epoch = new Date("2000-01-01T00:00:00Z")
  await tx.insert(Bucket).values({ id: lockId, identity_hash: lockId, window_start_at: epoch,
    window_end_at: epoch, used_amount: 0, limit_amount: 0 }).onDuplicateKeyUpdate({ set: { id: lockId } })
  const now = new Date()
  const bucket = personBucket(principal, now, config)
  const sharedLimit = await memberSharedLimit(tx, principal, config, amount, now, scope)
  if (sharedLimit) return sharedLimit
  await tx.insert(Bucket).values({ ...bucket, used_amount: 0 }).onDuplicateKeyUpdate({ set: { limit_amount: bucket.limit_amount } })
  const [person] = await tx.select().from(Bucket).where(eq(Bucket.id, bucket.id)).for("update")
  if (!fitsBudget(person.used_amount, amount, bucket.limit_amount)) return "anonymous_limit_exceeded"
  await tx.insert(Usage).values({ request_id: requestId, desktop_hash: scope.desktopHash, principal_hash: bucket.identity_hash, organization_id: principal.organizationId,
    org_membership_id: principal.memberId, inference_key_id: principal.inferenceKeyId, model_id: INFERENCE_FREE_MODEL_ID,
    created_at: now, amount, estimated: true })
  await tx.update(Bucket).set({ used_amount: sql`${Bucket.used_amount} + ${amount}` }).where(eq(Bucket.id, bucket.id))
  return null
}

export async function settleMemberBudget(tx: Tx, principal: MemberPrincipal, config: AutoConfig, requestId: string, receipt: FreeUsageReceipt | null, release: boolean) {
  if (!receipt && !release) return
  const [held] = await tx.select({ estimated: Usage.estimated, created_at: Usage.created_at, amount: Usage.amount }).from(Usage).where(eq(Usage.request_id, requestId)).for("update")
  if (!held || !held.estimated) return
  const amount = receipt?.amount ?? 0
  await tx.update(Usage).set({ estimated: false, amount, completion_id: receipt?.eventId ?? null,
    input_tokens: receipt?.inputTokens ?? null, cached_input_tokens: receipt?.cachedInputTokens ?? null,
    output_tokens: receipt?.outputTokens ?? null }).where(eq(Usage.request_id, requestId))
  const bucket = personBucket(principal, held.created_at, config)
  await tx.update(Bucket).set({ used_amount: sql`${Bucket.used_amount} + ${amount - held.amount}` }).where(eq(Bucket.id, bucket.id))
}
