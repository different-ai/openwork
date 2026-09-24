import { and, eq, inArray, or, sql } from "drizzle-orm"
import { gatewaySafeMoney, gatewayUsageTimeframes } from "@openwork/types/den/gateway-usage-limits"
import { GatewayRequestLogTable as Log } from "./schema/inference"
import {
  GatewayUsageBucketTable as B,
  GatewayUsageEventTable as E,
  GatewayUsageChargeTable as C,
  GatewayUsageQuarantineTable as Q,
  GatewayUsageTrackingTable as T,
} from "./schema/gateway-usage-limits"
import {
  bucketWindow,
  usageFail,
  type GatewayUsageScope,
  type UsageBucketSnapshot,
  type UsageTx,
} from "./gateway-usage-read"
import {
  validateUsageSnapshot,
  snapshotAdmission,
  sameUsageSnapshot,
} from "./gateway-usage-snapshot"
import { guardUsageMember, lockUsageTracking, retainUsageStart } from "./gateway-usage-lifecycle"

export type UsageLogRow = typeof Log.$inferInsert

function costFact(row: UsageLogRow) {
  const rejected = row.outcome === "rejected"
  const costMicroUsd = rejected ? 0 : (row.cost_micro_usd ?? null)
  if (costMicroUsd !== null) gatewaySafeMoney(costMicroUsd)
  return {
    costMicroUsd,
    unpricedRequests: costMicroUsd === null ? 1 : 0,
    complete: row.completed_at != null && (rejected || row.metadata?.cost_complete === true),
    finalized: row.completed_at != null,
    source: rejected
      ? "not_dispatched"
      : row.metadata?.cost_source === "upstream"
        ? "upstream"
        : row.metadata?.cost_source === "catalog_estimate"
          ? "catalog_estimate"
          : "unknown",
  }
}

async function applyCharges(
  tx: UsageTx,
  event: typeof E.$inferSelect,
  targets: UsageBucketSnapshot[],
  trackingStartedAt?: Date,
) {
  if (!targets.length) return
  const ordered = [...targets].sort(
    (a, b) =>
      gatewayUsageTimeframes.indexOf(a.timeframe) - gatewayUsageTimeframes.indexOf(b.timeframe),
  )
  for (const target of ordered)
    await tx
      .insert(B)
      .values({
        ...target,
        startAt: new Date(target.startAt),
        resetAt: new Date(target.resetAt),
        historyUnknown: !trackingStartedAt || trackingStartedAt > new Date(target.startAt),
      })
      .onDuplicateKeyUpdate({ set: { id: sql`${B.id}` } })
  const buckets = await tx
    .select()
    .from(B)
    .where(
      or(
        ...ordered.map((target) => bucketWindow(event, target.timeframe, new Date(target.startAt))),
      ),
    )
    .for("update")
  if (buckets.length !== targets.length)
    return usageFail("bucket_missing", 503, "Settlement bucket missing.")
  const receipts = ordered.map((target) => {
    const bucket = buckets.find((bucket) => bucket.timeframe === target.timeframe)
    if (!bucket) return usageFail("bucket_missing", 503, "Settlement bucket missing.")
    return {
      eventId: event.id,
      bucketId: bucket.id,
      policyId: target.policyId,
      policyRevision: target.policyRevision,
      amount: 0,
      unpricedRequests: 0,
      incompleteRequests: 0,
    }
  })
  await tx
    .insert(C)
    .values(receipts)
    .onDuplicateKeyUpdate({ set: { eventId: sql`${C.eventId}` } })
  const charges = await tx
    .select()
    .from(C)
    .where(
      and(
        eq(C.eventId, event.id),
        inArray(
          C.bucketId,
          receipts.map((row) => row.bucketId),
        ),
      ),
    )
    .for("update")
  const amount = event.costMicroUsd ?? 0,
    incompleteRequests = event.complete ? 0 : 1
  const changed: string[] = []
  for (const receipt of receipts) {
    const bucket = buckets.find((row) => row.id === receipt.bucketId),
      charge = charges.find((row) => row.bucketId === receipt.bucketId)
    if (!bucket || !charge) return usageFail("charge_missing", 503, "Settlement receipt missing.")
    const delta = amount - charge.amount,
      unpricedDelta = event.unpricedRequests - charge.unpricedRequests,
      incompleteDelta = incompleteRequests - charge.incompleteRequests
    if (delta < 0)
      return usageFail("cost_conflict", 409, "Previously charged cost cannot be reduced.")
    gatewaySafeMoney(bucket.usedMicroUsd + delta)
    gatewaySafeMoney(bucket.unpricedRequests + unpricedDelta)
    gatewaySafeMoney(bucket.incompleteRequests + incompleteDelta)
    if (delta || unpricedDelta || incompleteDelta) {
      await tx
        .update(B)
        .set({
          usedMicroUsd: sql`${B.usedMicroUsd} + ${delta}`,
          unpricedRequests: sql`${B.unpricedRequests} + ${unpricedDelta}`,
          incompleteRequests: sql`${B.incompleteRequests} + ${incompleteDelta}`,
        })
        .where(eq(B.id, bucket.id))
      changed.push(bucket.id)
    }
  }
  if (changed.length)
    await tx
      .update(C)
      .set({ amount, unpricedRequests: event.unpricedRequests, incompleteRequests })
      .where(and(eq(C.eventId, event.id), inArray(C.bucketId, changed)))
}

async function legacyTargets(tx: UsageTx, event: typeof E.$inferSelect) {
  const charges = await tx.select().from(C).where(eq(C.eventId, event.id)).limit(4)
  if (charges.length > 3)
    return usageFail(
      "legacy_attribution_conflict",
      409,
      "Legacy attribution requires explicit reconciliation.",
    )
  const buckets = charges.length
    ? await tx
        .select()
        .from(B)
        .where(
          inArray(
            B.id,
            charges.map((charge) => charge.bucketId),
          ),
        )
    : []
  const targets = buckets.map((bucket) => ({
    id: bucket.id,
    organizationId: bucket.organizationId,
    memberId: bucket.memberId,
    timeframe: bucket.timeframe,
    policyName: bucket.policyName,
    baseAllowanceMicroUsd: bucket.baseAllowanceMicroUsd,
    hardLimit: bucket.hardLimit,
    allowRequestReset: bucket.allowRequestReset,
    startAt: bucket.startAt.toISOString(),
    resetAt: bucket.resetAt.toISOString(),
    policyId: charges.find((charge) => charge.bucketId === bucket.id)?.policyId ?? bucket.policyId,
    policyRevision:
      charges.find((charge) => charge.bucketId === bucket.id)?.policyRevision ??
      bucket.policyRevision,
  }))
  validateUsageSnapshot({ version: 1, buckets: targets }, event, event.admittedAt)
  return targets
}

async function settleReceipt(
  tx: UsageTx,
  scope: GatewayUsageScope,
  requestId: string,
  now: Date,
  input?: UsageLogRow,
  abandonedBefore?: Date,
): Promise<boolean> {
  if (!(await guardUsageMember(tx, scope))) return false
  const tracking = await lockUsageTracking(tx, scope.memberId)
  if (tracking && tracking.organizationId !== scope.organizationId)
    return usageFail("tracking_scope", 409, "Tracking row belongs to another organization.")
  const [located] = await tx
    .select({ id: Log.id })
    .from(Log)
    .where(eq(Log.openwork_request_id, requestId))
  const [canonical] = located
    ? await tx.select().from(Log).where(eq(Log.id, located.id)).for("update")
    : []
  if (
    canonical &&
    (canonical.organization_id !== scope.organizationId ||
      canonical.org_membership_id !== scope.memberId ||
      canonical.route !== "org_provider")
  )
    return usageFail("request_identity_conflict", 409, "Request belongs to another subject.")
  const canonicalSnapshot =
    canonical?.metadata?.gateway_usage === undefined
      ? null
      : validateUsageSnapshot(canonical.metadata.gateway_usage, scope, canonical.started_at)
  let ensured = false
  if (canonical && canonicalSnapshot?.buckets.length) {
    const [quarantined] = await tx.select({ id: Q.id }).from(Q).where(eq(Q.id, requestId))
    if (quarantined)
      return usageFail(
        "request_quarantined",
        409,
        "Quarantined request requires explicit recovery.",
      )
    if (canonical.metadata?.gateway_usage_pending === true) {
      const retained = await retainUsageStart(tx, canonical, tracking)
      if (!retained.pendingCounted && !retained.finalized) {
        if (!tracking || tracking.pendingRequests < 1)
          return usageFail(
            "pending_count_conflict",
            409,
            "Legacy pending count requires explicit recovery.",
          )
        await tx.update(E).set({ pendingCounted: true }).where(eq(E.id, requestId))
      }
    } else {
      await tx
        .insert(E)
        .values({
          id: requestId,
          ...scope,
          admittedAt: snapshotAdmission(canonicalSnapshot, canonical.started_at),
          requestStartedAt: canonical.started_at,
          admissionSnapshot: canonicalSnapshot,
          trackingVersion: tracking?.epochVersion ?? null,
          source: "pending",
        })
        .onDuplicateKeyUpdate({ set: { id: sql`${E.id}` } })
    }
    ensured = true
  }
  const [locatedEvent] = ensured
    ? [{ id: requestId }]
    : await tx.select({ id: E.id }).from(E).where(eq(E.id, requestId))
  const [previous] = locatedEvent
    ? await tx.select().from(E).where(eq(E.id, requestId)).for("update")
    : []
  if (
    previous &&
    (previous.organizationId !== scope.organizationId || previous.memberId !== scope.memberId)
  )
    return usageFail(
      "request_identity_conflict",
      409,
      "Durable request belongs to another subject.",
    )
  if (
    abandonedBefore &&
    (!previous ||
      previous.admittedAt > abandonedBefore ||
      (previous.finalized && !previous.pendingCounted))
  )
    return false
  const durableSnapshot =
    previous?.admissionSnapshot == null
      ? null
      : validateUsageSnapshot(
          previous.admissionSnapshot,
          scope,
          previous.requestStartedAt ?? previous.admittedAt,
        )
  if (
    durableSnapshot &&
    previous &&
    snapshotAdmission(
      durableSnapshot,
      previous.requestStartedAt ?? previous.admittedAt,
    ).getTime() !== previous.admittedAt.getTime()
  )
    return usageFail(
      "attribution_conflict",
      409,
      "Durable admission timestamp differs from its snapshot.",
    )
  if (
    durableSnapshot &&
    canonicalSnapshot &&
    !sameUsageSnapshot(durableSnapshot, canonicalSnapshot)
  )
    return usageFail("attribution_conflict", 409, "Canonical and durable admission differ.")
  let row: UsageLogRow | undefined = input
    ? canonical?.completed_at != null && canonical.cost_micro_usd !== null
      ? canonical
      : {
          ...input,
          ...(canonical
            ? {
                id: canonical.id,
                started_at: canonical.started_at,
                metadata: { ...input.metadata, gateway_usage: canonical.metadata?.gateway_usage },
              }
            : {}),
        }
    : canonical
  if (input && row?.outcome === "rejected")
    row = {
      ...row,
      cost_micro_usd: 0,
      metadata: { ...row.metadata, cost_source: "not_dispatched", cost_complete: true },
    }
  if (previous?.finalized && previous.costMicroUsd !== null) {
    if (
      canonical?.completed_at != null &&
      canonical.cost_micro_usd !== null &&
      canonical.cost_micro_usd !== previous.costMicroUsd
    )
      return usageFail(
        "cost_conflict",
        409,
        "Canonical and durable costs require explicit reconciliation.",
      )
    if (row)
      row = {
        ...row,
        cost_micro_usd: previous.costMicroUsd,
        metadata: {
          ...row.metadata,
          cost_source: previous.source,
          cost_complete: previous.complete,
        },
      }
  }
  if (canonical) {
    if (input && row)
      await tx
        .update(Log)
        .set({ ...row, metadata: { ...row.metadata, gateway_usage_pending: false } })
        .where(eq(Log.id, canonical.id))
    else
      await tx
        .update(Log)
        .set({ metadata: { ...canonical.metadata, gateway_usage_pending: false } })
        .where(eq(Log.id, canonical.id))
  }
  if (!previous) return canonical !== undefined
  const fact =
    previous.finalized && previous.costMicroUsd !== null
      ? {
          costMicroUsd: previous.costMicroUsd,
          unpricedRequests: previous.unpricedRequests,
          complete: previous.complete,
          finalized: true,
          source: previous.source,
        }
      : row && (input || (row.completed_at != null && row.cost_micro_usd !== null))
        ? costFact(row)
        : {
            costMicroUsd: null,
            unpricedRequests: 1,
            complete: false,
            finalized: true,
            source: "abandoned",
          }
  const changed =
    !previous.finalized ||
    previous.costMicroUsd !== fact.costMicroUsd ||
    previous.complete !== fact.complete
  const event: typeof E.$inferSelect = {
    ...previous,
    ...fact,
    pendingCounted: false,
    settledAt: changed ? now : previous.settledAt,
  }
  if (changed || previous.pendingCounted) await tx.update(E).set(event).where(eq(E.id, event.id))
  const targets = (durableSnapshot ?? canonicalSnapshot)?.buckets
  await applyCharges(
    tx,
    event,
    targets?.length ? targets : await legacyTargets(tx, event),
    tracking?.trackingStartedAt,
  )
  if (tracking && (previous.pendingCounted || changed)) {
    gatewaySafeMoney(tracking.pendingRequests - (previous.pendingCounted ? 1 : 0))
    await tx
      .update(T)
      .set({
        pendingRequests: sql`${T.pendingRequests} - ${previous.pendingCounted ? 1 : 0}`,
        lastSettlementAt: now,
        lastSettlementRequestId: requestId,
      })
      .where(eq(T.memberId, scope.memberId))
  }
  return true
}

export function settleGatewayUsage(tx: UsageTx, input: UsageLogRow, now: Date) {
  return settleReceipt(
    tx,
    { organizationId: input.organization_id, memberId: input.org_membership_id },
    input.openwork_request_id,
    now,
    input,
  )
}
export function recoverGatewayUsageRequest(
  tx: UsageTx,
  scope: GatewayUsageScope,
  requestId: string,
  abandonedBefore: Date,
  now: Date,
) {
  return settleReceipt(tx, scope, requestId, now, undefined, abandonedBefore)
}
