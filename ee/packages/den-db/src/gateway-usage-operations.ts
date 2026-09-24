import { randomUUID } from "node:crypto"
import { and, asc, eq, lte, or } from "drizzle-orm"
import {
  gatewayUsageTimeframes,
  gatewayUsagePeriod,
} from "@openwork/types/den/gateway-usage-limits"
import { GatewayRequestLogTable as Log } from "./schema/inference"
import {
  GatewayUsageEventTable as E,
  GatewayUsageTrackingTable as T,
  GatewayUsageBucketTable as B,
  GatewayUsageAuditTable as H,
} from "./schema/gateway-usage-limits"
import {
  activeUsageMember,
  bucketWindow,
  usageFail,
  type GatewayUsageDb,
  type GatewayUsageScope,
} from "./gateway-usage-read"
import { lockUsageMembers } from "./gateway-usage-entitlements"
import { validUsageDate, validateUsageSnapshot, snapshotAdmission } from "./gateway-usage-snapshot"
import { recoverGatewayUsageRequest } from "./gateway-usage-settlement"

function reference(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    return usageFail("invalid_operation", 400, "A review reference is required.")
}
export async function listPendingGatewayUsageRequests(
  db: GatewayUsageDb,
  input: {
    actor: GatewayUsageScope
    memberId: GatewayUsageScope["memberId"]
    before: string
    limit?: number
  },
) {
  const limit = input.limit ?? 100
  if (!validUsageDate(input.before) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    return usageFail("invalid_operation", 400, "Use an ISO cutoff and a limit of 1–100.")
  return db.transaction(async (tx) => {
    await activeUsageMember(tx, input.actor, true)
    return tx
      .select({ requestId: E.id, admittedAt: E.admittedAt, trackingVersion: E.trackingVersion })
      .from(E)
      .where(
        and(
          eq(E.organizationId, input.actor.organizationId),
          eq(E.memberId, input.memberId),
          eq(E.pendingCounted, true),
          lte(E.admittedAt, new Date(input.before)),
        ),
      )
      .orderBy(asc(E.admittedAt), asc(E.id))
      .limit(limit)
  })
}

export async function recoverGatewayUsageRequests(
  db: GatewayUsageDb,
  input: {
    actor: GatewayUsageScope
    requestIds: string[]
    abandonedBefore: string
    reviewReference: string
    apply?: boolean
  },
  clock = () => new Date(),
) {
  reference(input.reviewReference)
  if (
    !Array.isArray(input.requestIds) ||
    input.requestIds.length < 1 ||
    input.requestIds.length > 100 ||
    input.requestIds.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id)) ||
    !validUsageDate(input.abandonedBefore)
  )
    return usageFail(
      "invalid_operation",
      400,
      "Supply 1–100 request IDs and an explicit abandonment cutoff.",
    )
  const results = []
  for (const requestId of [...new Set(input.requestIds)]) {
    results.push(
      await db.transaction(async (tx) => {
        await activeUsageMember(tx, input.actor, true, input.apply === true)
        const [event] = await tx.select().from(E).where(eq(E.id, requestId))
        const [raw] = event
          ? []
          : await tx.select().from(Log).where(eq(Log.openwork_request_id, requestId))
        const organizationId = event?.organizationId ?? raw?.organization_id
        const memberId = event?.memberId ?? raw?.org_membership_id
        if (!memberId || !organizationId) return { requestId, status: "missing" }
        if (organizationId !== input.actor.organizationId)
          return usageFail("forbidden", 403, "Recovery request is outside the organization.")
        const storedSnapshot = event?.admissionSnapshot ?? raw?.metadata?.gateway_usage
        const startedAt = event?.requestStartedAt ?? raw?.started_at ?? event?.admittedAt
        const snapshot =
          storedSnapshot == null || !startedAt
            ? null
            : validateUsageSnapshot(storedSnapshot, { organizationId, memberId }, startedAt)
        const admittedAt =
          event?.admittedAt ??
          (snapshot && startedAt ? snapshotAdmission(snapshot, startedAt) : raw?.started_at)
        const pending = event
          ? event.pendingCounted || !event.finalized
          : raw?.metadata?.gateway_usage_pending === true
        if (!admittedAt || admittedAt > new Date(input.abandonedBefore) || !pending)
          return { requestId, status: "not_abandoned" }
        if (!input.apply) return { requestId, status: "eligible" }
        const changed = await recoverGatewayUsageRequest(
          tx,
          { organizationId, memberId },
          requestId,
          new Date(input.abandonedBefore),
          clock(),
        )
        if (changed)
          await tx.insert(H).values({
            id: randomUUID(),
            organizationId,
            actorId: input.actor.memberId,
            subjectId: requestId,
            action: "abandoned_request_recovered",
            details: { reviewReference: input.reviewReference },
            createdAt: clock(),
          })
        return { requestId, status: changed ? "recovered" : "unchanged" }
      }),
    )
  }
  return { applied: input.apply === true, results }
}

export async function rotateGatewayUsageEpoch(
  db: GatewayUsageDb,
  input: {
    actor: GatewayUsageScope
    members: { memberId: GatewayUsageScope["memberId"]; expectedVersion: number }[]
    action: "suspend" | "resume"
    reviewReference: string
    apply?: boolean
  },
  clock = () => new Date(),
) {
  reference(input.reviewReference)
  if (
    !Array.isArray(input.members) ||
    !input.members.length ||
    input.members.length > 100 ||
    new Set(input.members.map((m) => m.memberId)).size !== input.members.length ||
    input.members.some(
      (m) =>
        !Number.isInteger(m.expectedVersion) ||
        m.expectedVersion < 0 ||
        m.expectedVersion >= 2147483647,
    ) ||
    !["suspend", "resume"].includes(input.action)
  )
    return usageFail(
      "invalid_operation",
      400,
      "Supply 1–100 unique members and expected capture versions.",
    )
  const results = []
  for (const member of input.members)
    results.push(
      await db.transaction(async (tx) => {
        if (input.apply)
          await lockUsageMembers(tx, input.actor.organizationId, [
            input.actor.memberId,
            member.memberId,
          ])
        await activeUsageMember(tx, input.actor, true, input.apply === true)
        await activeUsageMember(tx, { ...input.actor, memberId: member.memberId })
        const query = tx
          .select()
          .from(T)
          .where(
            and(eq(T.memberId, member.memberId), eq(T.organizationId, input.actor.organizationId)),
          )
        const [current] = await (input.apply ? query.for("update") : query)
        if ((current?.epochVersion ?? 0) !== member.expectedVersion)
          return usageFail(
            "capture_version_conflict",
            409,
            "Capture version changed; inspect and retry explicitly.",
          )
        if (input.action === "resume" && (!current || current.captureEnabled))
          return usageFail(
            "capture_not_suspended",
            409,
            "Suspend capture before resuming a verified writer deployment.",
          )
        const now = clock(),
          epochVersion = member.expectedVersion + 1,
          captureEnabled = input.action === "resume"
        if (input.apply) {
          if (current)
            await tx
              .update(T)
              .set({ epochVersion, captureEnabled, trackingStartedAt: now })
              .where(eq(T.memberId, member.memberId))
          else
            await tx.insert(T).values({
              organizationId: input.actor.organizationId,
              memberId: member.memberId,
              epochVersion,
              captureEnabled,
              trackingStartedAt: now,
            })
          await tx
            .update(B)
            .set({ historyUnknown: true })
            .where(
              or(
                ...gatewayUsageTimeframes.map((frame) =>
                  bucketWindow(
                    { ...input.actor, memberId: member.memberId },
                    frame,
                    gatewayUsagePeriod(frame, now).start,
                  ),
                ),
              ),
            )
          await tx.insert(H).values({
            id: randomUUID(),
            organizationId: input.actor.organizationId,
            actorId: input.actor.memberId,
            subjectId: member.memberId,
            action: `capture_${input.action}`,
            details: {
              previousVersion: member.expectedVersion,
              epochVersion,
              reviewReference: input.reviewReference,
            },
            createdAt: now,
          })
        }
        return {
          memberId: member.memberId,
          epochVersion,
          captureEnabled,
          trackingStartedAt: now.toISOString(),
        }
      }),
    )
  return { applied: input.apply === true, results }
}
