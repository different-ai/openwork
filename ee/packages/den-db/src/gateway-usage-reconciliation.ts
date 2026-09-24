import { randomUUID } from "node:crypto"
import { and, eq, gte, lt, or, sql } from "drizzle-orm"
import { gatewaySafeMoney, gatewayUsageTimeframes } from "@openwork/types/den/gateway-usage-limits"
import { GatewayRequestLogTable as Log } from "./schema/inference"
import {
  GatewayUsageEventTable as E,
  GatewayUsageSubjectTable as S,
  GatewayUsageQuarantineTable as Q,
  GatewayUsageAuditTable as H,
  GatewayUsageBucketTable as B,
  GatewayUsageChargeTable as C,
} from "./schema/gateway-usage-limits"
import {
  activeUsageMember,
  bucketWindow,
  usageFail,
  type GatewayUsageDb,
  type GatewayUsageScope,
  type GatewayUsageSnapshot,
  type UsageTx,
  type UsageBucketSnapshot,
} from "./gateway-usage-read"
import { validateUsageSnapshot, validUsageDate } from "./gateway-usage-snapshot"
import { guardUsageMember, lockUsageTracking } from "./gateway-usage-lifecycle"
import { settleGatewayUsage } from "./gateway-usage-settlement"

export type GatewayUsageReconciliationEntry = {
  requestId: string
  startedAt: string
  snapshot: GatewayUsageSnapshot
}
export type GatewayUsageReconciliationInput = {
  actor: GatewayUsageScope
  entries: GatewayUsageReconciliationEntry[]
  uncoveredSince: string
  reviewReference: string
  apply?: boolean
}
type Status =
  | "missing"
  | "already_attributed"
  | "not_finalized"
  | "legacy_event"
  | "quarantined"
  | "pre_cutover"
  | "indeterminate_overlap"
  | "eligible"
  | "applied"
const maximumProofReceipts = 1000

async function validatedRow(
  tx: UsageTx,
  input: GatewayUsageReconciliationInput,
  entry: GatewayUsageReconciliationEntry,
  lock: boolean,
) {
  const [located] = await tx.select().from(Log).where(eq(Log.openwork_request_id, entry.requestId))
  if (!located) return null
  const scope = { organizationId: located.organization_id, memberId: located.org_membership_id }
  if (scope.organizationId !== input.actor.organizationId || located.route !== "org_provider")
    return usageFail(
      "reconciliation_scope",
      403,
      "Reconciliation request is outside the organization.",
    )
  if (lock) {
    if (!(await guardUsageMember(tx, scope))) return null
    await lockUsageTracking(tx, scope.memberId)
  }
  const [row] = lock
    ? await tx.select().from(Log).where(eq(Log.id, located.id)).for("update")
    : [located]
  if (!row) return null
  if (
    row.started_at.toISOString() !== entry.startedAt ||
    row.started_at < new Date(input.uncoveredSince)
  )
    return usageFail(
      "reconciliation_window",
      409,
      "Reconciliation request is outside the reviewed window.",
    )
  const snapshot = validateUsageSnapshot(entry.snapshot, scope, row.started_at)
  const recorded =
    row.metadata?.gateway_usage === undefined
      ? null
      : validateUsageSnapshot(row.metadata.gateway_usage, scope, row.started_at)
  const recordedAdmission =
    recorded?.version === 2 ? recorded.admittedAt : row.started_at.toISOString()
  if (snapshot.version === 2 && snapshot.admittedAt !== recordedAdmission)
    return usageFail(
      "reconciliation_attribution",
      409,
      "Reviewed admission time must match retained server evidence.",
    )
  if (!snapshot.buckets.length)
    return usageFail("reconciliation_attribution", 409, "Reviewed attribution cannot be empty.")
  return { row, scope, snapshot }
}

async function counterProof(
  tx: UsageTx,
  scope: GatewayUsageScope,
  target: UsageBucketSnapshot,
  apply: boolean,
) {
  const start = new Date(target.startAt),
    end = new Date(target.resetAt)
  const events = await tx
    .select({ id: E.id, source: E.source })
    .from(E)
    .where(
      and(
        eq(E.organizationId, scope.organizationId),
        eq(E.memberId, scope.memberId),
        gte(E.admittedAt, start),
        lt(E.admittedAt, end),
      ),
    )
    .limit(maximumProofReceipts + 1)
  if (
    events.length > maximumProofReceipts ||
    events.some((event) => event.source === "historical_rollup" || event.id.startsWith("history:"))
  )
    return null
  if (apply)
    await tx
      .insert(B)
      .values({ ...target, startAt: start, resetAt: end, historyUnknown: true })
      .onDuplicateKeyUpdate({ set: { id: sql`${B.id}` } })
  const query = tx
    .select()
    .from(B)
    .where(bucketWindow(scope, target.timeframe, start))
  const [bucket] = await (apply ? query.for("update") : query)
  if (!bucket) return { timeframe: target.timeframe, kind: "empty_counter", amount: 0, receipts: 0 }
  const receipts = await tx
    .select({ charge: C, event: E })
    .from(C)
    .leftJoin(E, eq(E.id, C.eventId))
    .where(eq(C.bucketId, bucket.id))
    .limit(maximumProofReceipts + 1)
  if (receipts.length > maximumProofReceipts) return null
  let amount = 0
  for (const { charge, event } of receipts) {
    if (
      !event ||
      event.organizationId !== scope.organizationId ||
      event.memberId !== scope.memberId ||
      event.admittedAt < start ||
      event.admittedAt >= end ||
      event.source === "historical_rollup" ||
      event.id.startsWith("history:") ||
      charge.amount !== (event.costMicroUsd ?? 0)
    )
      return null
    amount = gatewaySafeMoney(amount + charge.amount)
  }
  if (amount !== bucket.usedMicroUsd) return null
  return {
    timeframe: target.timeframe,
    kind: "receipt_complete_counter",
    amount,
    receipts: receipts.length,
  }
}

async function reconcileOne(
  tx: UsageTx,
  input: GatewayUsageReconciliationInput,
  entry: GatewayUsageReconciliationEntry,
): Promise<{ status: Status; proof?: Awaited<ReturnType<typeof counterProof>>[] }> {
  await activeUsageMember(tx, input.actor, true, input.apply === true)
  const validated = await validatedRow(tx, input, entry, input.apply === true)
  if (!validated) return { status: "missing" }
  const { row, scope, snapshot } = validated
  if (row.metadata?.gateway_usage !== undefined) {
    const previous = validateUsageSnapshot(row.metadata.gateway_usage, scope, row.started_at)
    if (previous.buckets.length) return { status: "already_attributed" }
  }
  if (!row.completed_at) return { status: "not_finalized" }
  const [event] = await tx.select({ id: E.id }).from(E).where(eq(E.id, entry.requestId))
  if (event) return { status: "legacy_event" }
  const [quarantine] = await tx.select({ id: Q.id }).from(Q).where(eq(Q.id, entry.requestId))
  if (quarantine) return { status: "quarantined" }
  const [subject] = await tx.select().from(S).where(eq(S.memberId, scope.memberId))
  if (subject && row.started_at < subject.initializedAt) return { status: "pre_cutover" }
  const ordered = [...snapshot.buckets].sort(
    (a, b) =>
      gatewayUsageTimeframes.indexOf(a.timeframe) - gatewayUsageTimeframes.indexOf(b.timeframe),
  )
  const proof = []
  for (const target of ordered) {
    const verified = await counterProof(tx, scope, target, false)
    if (!verified) return { status: "indeterminate_overlap" }
    proof.push(verified)
  }
  if (!input.apply) return { status: "eligible", proof }
  for (const target of ordered) {
    if (!(await counterProof(tx, scope, target, true)))
      return usageFail(
        "reconciliation_changed",
        409,
        "Counter evidence changed during reconciliation.",
      )
  }
  await tx
    .update(B)
    .set({ historyUnknown: true })
    .where(
      or(
        ...ordered.map((target) => bucketWindow(scope, target.timeframe, new Date(target.startAt))),
      ),
    )
  const attributed = { ...row, metadata: { ...row.metadata, gateway_usage: snapshot } }
  await tx.update(Log).set({ metadata: attributed.metadata }).where(eq(Log.id, row.id))
  await settleGatewayUsage(tx, attributed, new Date())
  await tx.insert(H).values({
    id: randomUUID(),
    organizationId: input.actor.organizationId,
    actorId: input.actor.memberId,
    subjectId: entry.requestId,
    action: "request_reconciled",
    details: {
      reviewReference: input.reviewReference,
      uncoveredSince: input.uncoveredSince,
      proof,
    },
    createdAt: new Date(),
  })
  return { status: "applied", proof }
}

export async function reconcileGatewayUsageBatch(
  db: GatewayUsageDb,
  input: GatewayUsageReconciliationInput,
) {
  if (
    !input ||
    !Array.isArray(input.entries) ||
    !input.entries.length ||
    input.entries.length > 100 ||
    typeof input.reviewReference !== "string" ||
    !input.reviewReference.trim() ||
    input.reviewReference.length > 200 ||
    !validUsageDate(input.uncoveredSince)
  )
    return usageFail(
      "invalid_reconciliation",
      400,
      "Supply a reviewed manifest of 1–100 requests, an explicit window and a review reference.",
    )
  for (const entry of input.entries) {
    if (
      !entry ||
      typeof entry.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(entry.requestId) ||
      !validUsageDate(entry.startedAt)
    )
      return usageFail(
        "invalid_reconciliation",
        400,
        "Invalid request identity or timestamp in manifest.",
      )
  }
  await db.transaction(async (tx) => {
    await activeUsageMember(tx, input.actor, true)
    for (const entry of input.entries) {
      if (!(await validatedRow(tx, input, entry, false)))
        return usageFail(
          "reconciliation_missing",
          409,
          "Every manifest entry must have a retained canonical request.",
        )
    }
  })
  const results = []
  for (const entry of input.entries)
    results.push({
      requestId: entry.requestId,
      ...(await db.transaction((tx) => reconcileOne(tx, input, entry))),
    })
  return { applied: input.apply === true, results, coverageComplete: false }
}
