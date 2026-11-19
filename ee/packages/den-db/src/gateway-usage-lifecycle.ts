import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { gatewaySafeMoney } from "@openwork/types/den/gateway-usage-limits"
import { MemberTable } from "./schema/org"
import { lockUsageOrganization } from "./gateway-usage-entitlements"
import { GatewayRequestLogTable as Log } from "./schema/inference"
import {
  GatewayUsageTrackingTable as T,
  GatewayUsageResetTable as R,
  GatewayUsageEventTable as E,
} from "./schema/gateway-usage-limits"
import { usageFail, type GatewayUsageScope, type UsageTx } from "./gateway-usage-read"
import {
  validateUsageSnapshot,
  snapshotAdmission,
  sameUsageSnapshot,
} from "./gateway-usage-snapshot"

export async function guardUsageMember(tx: UsageTx, scope: GatewayUsageScope, starting = false) {
  const [located] = await tx
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(
      and(eq(MemberTable.id, scope.memberId), eq(MemberTable.organizationId, scope.organizationId)),
    )
  if (!located) return false
  const [member] = await tx
    .select()
    .from(MemberTable)
    .where(
      and(eq(MemberTable.id, located.id), eq(MemberTable.organizationId, scope.organizationId)),
    )
    .for("share")
  return !!member && (!starting || (member.userId !== null && member.removedAt === null))
}

export async function fenceUsageOrganizationDeletion(
  tx: UsageTx,
  organizationId: GatewayUsageScope["organizationId"],
) {
  await lockUsageOrganization(tx, organizationId)
  return tx
    .select({ id: MemberTable.id, userId: MemberTable.userId })
    .from(MemberTable)
    .where(eq(MemberTable.organizationId, organizationId))
    .orderBy(asc(MemberTable.id))
    .for("update")
}

export async function expireUsageRequestsForMembers(
  tx: UsageTx,
  memberIds: GatewayUsageScope["memberId"][],
) {
  if (!memberIds.length) return
  await tx
    .update(R)
    .set({ status: "expired", pendingBucketId: null })
    .where(and(inArray(R.memberId, memberIds), eq(R.status, "pending")))
}

export async function lockUsageTracking(tx: UsageTx, memberId: GatewayUsageScope["memberId"]) {
  const [located] = await tx
    .select({ memberId: T.memberId })
    .from(T)
    .where(eq(T.memberId, memberId))
  if (!located) return undefined
  const [tracking] = await tx.select().from(T).where(eq(T.memberId, memberId)).for("update")
  return tracking
}

export async function retainUsageStart(
  tx: UsageTx,
  canonical: typeof Log.$inferSelect,
  tracking: typeof T.$inferSelect | undefined,
) {
  const scope = { organizationId: canonical.organization_id, memberId: canonical.org_membership_id }
  const snapshot = validateUsageSnapshot(
    canonical.metadata?.gateway_usage,
    scope,
    canonical.started_at,
  )
  if (!snapshot.buckets.length)
    return usageFail("missing_attribution", 409, "Pending request requires retained attribution.")
  await tx
    .insert(E)
    .values({
      id: canonical.openwork_request_id,
      ...scope,
      admittedAt: snapshotAdmission(snapshot, canonical.started_at),
      requestStartedAt: canonical.started_at,
      admissionSnapshot: snapshot,
      trackingVersion: tracking?.epochVersion ?? null,
      source: "pending",
    })
    .onDuplicateKeyUpdate({ set: { id: sql`${E.id}` } })
  const [event] = await tx
    .select()
    .from(E)
    .where(eq(E.id, canonical.openwork_request_id))
    .for("update")
  if (!event || event.organizationId !== scope.organizationId || event.memberId !== scope.memberId)
    return usageFail("request_identity_conflict", 409, "Durable request belongs to another member.")
  if (event.admittedAt.getTime() !== snapshotAdmission(snapshot, canonical.started_at).getTime())
    return usageFail(
      "attribution_conflict",
      409,
      "Durable admission time differs from the canonical snapshot.",
    )
  if (event.admissionSnapshot != null) {
    const stored = validateUsageSnapshot(
      event.admissionSnapshot,
      scope,
      event.requestStartedAt ?? canonical.started_at,
    )
    if (!sameUsageSnapshot(stored, snapshot))
      return usageFail("attribution_conflict", 409, "Canonical and durable admission differ.")
  } else {
    await tx
      .update(E)
      .set({
        requestStartedAt: canonical.started_at,
        admissionSnapshot: snapshot,
        trackingVersion: tracking?.epochVersion ?? null,
      })
      .where(eq(E.id, event.id))
  }
  return event
}

export async function assertUsageRetentionSafe(tx: UsageTx, ids: (typeof Log.$inferSelect.id)[]) {
  if (!ids.length) return
  const rows = await tx.select().from(Log).where(inArray(Log.id, ids)).for("update")
  const pending = rows.filter(
    (row) => row.route === "org_provider" && row.metadata?.gateway_usage_pending === true,
  )
  if (!pending.length) return
  const events = await tx
    .select()
    .from(E)
    .where(
      inArray(
        E.id,
        pending.map((row) => row.openwork_request_id),
      ),
    )
  for (const row of pending) {
    const event = events.find((event) => event.id === row.openwork_request_id)
    if (!event?.pendingCounted || !event.requestStartedAt || event.admissionSnapshot == null)
      return usageFail(
        "pending_recovery_required",
        409,
        "Transfer legacy pending identities before raw retention.",
      )
    const scope = { organizationId: row.organization_id, memberId: row.org_membership_id }
    if (
      event.organizationId !== scope.organizationId ||
      event.memberId !== scope.memberId ||
      !sameUsageSnapshot(
        validateUsageSnapshot(event.admissionSnapshot, scope, event.requestStartedAt),
        validateUsageSnapshot(row.metadata?.gateway_usage, scope, row.started_at),
      )
    )
      return usageFail(
        "attribution_conflict",
        409,
        "Raw retention requires matching durable attribution.",
      )
  }
}

export async function startGatewayUsageLog(
  tx: UsageTx,
  row: typeof Log.$inferInsert,
  now = new Date(),
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const scope = { organizationId: row.organization_id, memberId: row.org_membership_id }
  if (!(await guardUsageMember(tx, scope, true)))
    return usageFail("member_erased", 409, "Request member no longer exists or is inactive.")
  const attribution =
    row.metadata?.gateway_usage === undefined
      ? null
      : validateUsageSnapshot(row.metadata.gateway_usage, scope, row.started_at)
  if (attribution?.version === 2) {
    await tx
      .insert(T)
      .values({ ...scope, trackingStartedAt: now, captureEnabled: true })
      .onDuplicateKeyUpdate({ set: { memberId: sql`${T.memberId}` } })
  }
  const [tracking] =
    attribution?.version === 2
      ? await tx.select().from(T).where(eq(T.memberId, scope.memberId)).for("update")
      : [await lockUsageTracking(tx, scope.memberId)]
  if (tracking && tracking.organizationId !== scope.organizationId)
    return usageFail("tracking_scope", 409, "Tracking row belongs to another organization.")
  if (tracking && !tracking.captureEnabled)
    return usageFail("capture_suspended", 503, "Usage capture is suspended for a reviewed cutover.")
  if (
    attribution?.version === 2 &&
    tracking &&
    attribution.trackingVersion !== tracking.epochVersion &&
    !(attribution.trackingVersion === 0 && tracking.epochVersion === 1)
  )
    return usageFail("capture_epoch_changed", 409, "Admission predates the current capture epoch.")
  signal?.throwIfAborted()
  await tx
    .insert(Log)
    .values({ ...row, metadata: { ...row.metadata, gateway_usage_pending: false } })
    .onDuplicateKeyUpdate({ set: { id: sql`${Log.id}` } })
  const [canonical] = await tx
    .select()
    .from(Log)
    .where(eq(Log.openwork_request_id, row.openwork_request_id))
    .for("update")
  if (
    !canonical ||
    canonical.organization_id !== scope.organizationId ||
    canonical.org_membership_id !== scope.memberId
  )
    return usageFail(
      "request_identity_conflict",
      409,
      "Request identity belongs to another member.",
    )
  if (canonical.completed_at || attribution?.version !== 2) return
  if (!tracking) return usageFail("tracking_missing", 503, "Request tracking row is missing.")
  const event = await retainUsageStart(tx, canonical, tracking)
  if (event.finalized)
    return usageFail("request_already_settled", 409, "Request identity is already settled.")
  if (!event.pendingCounted) {
    if (canonical.metadata?.gateway_usage_pending !== true) {
      gatewaySafeMoney(tracking.pendingRequests + 1)
      await tx
        .update(T)
        .set({ pendingRequests: sql`${T.pendingRequests} + 1` })
        .where(eq(T.memberId, scope.memberId))
    }
    await tx.update(E).set({ pendingCounted: true }).where(eq(E.id, event.id))
  }
  await tx
    .update(Log)
    .set({ metadata: { ...canonical.metadata, gateway_usage_pending: true } })
    .where(eq(Log.id, canonical.id))
  signal?.throwIfAborted()
}
