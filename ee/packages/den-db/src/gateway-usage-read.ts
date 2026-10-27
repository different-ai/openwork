import { createHash } from "node:crypto"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm"
import {
  GATEWAY_DEFAULT_USAGE_SCOPE,
  gatewaySafeMoney,
  gatewayUsagePeriod,
  gatewayUsageTimeframes,
  gatewayWinningPoliciesByScope,
  type GatewayProviderUsage,
  type GatewayUsageLimitPolicy,
  type GatewayUsageStatus,
  type GatewayUsageProvenance,
} from "@openwork/types/den/gateway-usage-limits"
import type { createDenDb } from "./client"
import { GatewayUsageError } from "./gateway-usage-errors"
import { GatewayProviderTable } from "./schema/inference-providers"
import { MemberTable } from "./schema/org"
import { TeamMemberTable, TeamTable } from "./schema/teams"
import {
  GatewayUsagePolicyTable as P,
  GatewayUsageLimitTable as L,
  GatewayUsageAssignmentTable as A,
  GatewayUsageBucketTable as B,
  GatewayUsageResetTable as R,
  GatewayUsageTrackingTable as T,
} from "./schema/gateway-usage-limits"

export type GatewayUsageDb = ReturnType<typeof createDenDb>["db"]
export type UsageTx = Parameters<Parameters<GatewayUsageDb["transaction"]>[0]>[0]
export type UsageReader = Pick<GatewayUsageDb, "select">
export type GatewayUsageScope = {
  organizationId: typeof MemberTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}
export type UsageBucket = typeof B.$inferSelect
import type { GatewayUsageSnapshot } from "./gateway-usage-snapshot"
export type { GatewayUsageSnapshot, UsageBucketSnapshot } from "./gateway-usage-snapshot"

export function usageFail(
  code: string,
  status: 400 | 403 | 404 | 409 | 503,
  message: string,
): never {
  throw new GatewayUsageError(code, status, message)
}

/**
 * The member row when it is active in the organization (optionally share-locked).
 * Authorization is the caller's job: Den routes check the catalog permission
 * (gateway_limits.view / gateway_limits.manage) before calling in, so a team
 * permission set can grant usage-limit management without an admin role.
 *
 * Pass `lock` whenever the caller's membership gates organization-wide data
 * (policies, assignments, other members, their usage and requests) or a write:
 * the share lock keeps a concurrent removal of the caller from landing between
 * this check and the read. Only a member reading their own data skips it.
 */
export async function activeUsageMember(
  tx: UsageReader,
  scope: GatewayUsageScope,
  lock = false,
) {
  const query = tx
    .select()
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.id, scope.memberId),
        eq(MemberTable.organizationId, scope.organizationId),
        isNull(MemberTable.removedAt),
        isNotNull(MemberTable.userId),
      ),
    )
  const [member] = await (lock ? query.for("share") : query)
  if (!member) return usageFail("member_not_found", 404, "Current organization member not found.")
  return member
}

export async function usagePolicies(
  tx: UsageReader,
  organizationId: GatewayUsageScope["organizationId"],
) {
  const rows = await tx
    .select()
    .from(P)
    .where(eq(P.organizationId, organizationId))
    .orderBy(asc(P.id))
  if (!rows.length) return []
  const ids = rows.map((row) => row.id)
  const limits = await tx.select().from(L).where(inArray(L.policyId, ids))
  const assignments = await tx
    .select()
    .from(A)
    .where(and(eq(A.organizationId, organizationId), inArray(A.policyId, ids)))
  return rows.map(
    ({ inferenceProviderId, ...row }): GatewayUsageLimitPolicy => ({
      ...row,
      providerId: inferenceProviderId ?? null,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      limits: limits
        .filter((entry) => entry.policyId === row.id)
        .map(({ timeframe, costLimitMicroUsd }) => ({ timeframe, costLimitMicroUsd })),
      assignments: assignments
        .filter((entry) => entry.policyId === row.id)
        .map(({ id, memberId, teamId, organization }) => ({
          id,
          memberId,
          teamId,
          organization: organization === true,
        })),
    }),
  )
}

/** One scope's winners (the default scope unless `providerScope` is given). */
export async function effectiveUsagePolicies(
  tx: UsageReader,
  scope: GatewayUsageScope,
  lock = false,
  providerScope: string = GATEWAY_DEFAULT_USAGE_SCOPE,
) {
  return (await effectiveUsagePolicyScopes(tx, scope, lock)).get(providerScope) ?? []
}

/**
 * Winners for every scope the member has policies in, keyed by scope
 * ('' = default, otherwise the Gateway provider id). Scopes never mix.
 */
export async function effectiveUsagePolicyScopes(
  tx: UsageReader,
  scope: GatewayUsageScope,
  lock = false,
) {
  const teamsQuery = tx
    .select({ id: TeamTable.id, name: TeamTable.name })
    .from(TeamMemberTable)
    .innerJoin(
      TeamTable,
      and(
        eq(TeamTable.id, TeamMemberTable.teamId),
        eq(TeamTable.organizationId, scope.organizationId),
      ),
    )
    .where(eq(TeamMemberTable.orgMembershipId, scope.memberId))
  const teams = await (lock ? teamsQuery.for("share") : teamsQuery)
  const names = new Map<string, string>(teams.map((team) => [team.id, team.name]))
  const query = tx
    .select({ assignment: A, policy: P, limit: L })
    .from(A)
    .innerJoin(
      P,
      and(eq(P.id, A.policyId), eq(P.organizationId, scope.organizationId), isNull(P.archivedAt)),
    )
    .innerJoin(L, eq(L.policyId, P.id))
    .where(
      and(
        eq(A.organizationId, scope.organizationId),
        or(
          eq(A.organization, true),
          eq(A.memberId, scope.memberId),
          teams.length
            ? inArray(
                A.teamId,
                teams.map((team) => team.id),
              )
            : undefined,
        ),
      ),
    )
  const rows = await (lock ? query.for("share") : query)
  const candidates = new Map<string, GatewayUsageLimitPolicy>()
  for (const { assignment, policy, limit } of rows) {
    let entry = candidates.get(policy.id)
    if (!entry) {
      const { inferenceProviderId, ...fields } = policy
      entry = {
        ...fields,
        providerId: inferenceProviderId ?? null,
        archivedAt: null,
        limits: [],
        assignments: [],
      }
      candidates.set(policy.id, entry)
    }
    if (!entry.limits.some((item) => item.timeframe === limit.timeframe))
      entry.limits.push({
        timeframe: limit.timeframe,
        costLimitMicroUsd: gatewaySafeMoney(limit.costLimitMicroUsd),
      })
    if (!entry.assignments.some((item) => item.id === assignment.id))
      entry.assignments.push({
        id: assignment.id,
        memberId: assignment.memberId,
        teamId: assignment.teamId,
        organization: assignment.organization === true,
      })
  }
  const byScope = new Map<string, UsageWinner[]>()
  for (const [key, winners] of gatewayWinningPoliciesByScope([...candidates.values()]))
    byScope.set(
      key,
      winners.map((winner) => withProvenance(winner, scope.memberId, names)),
    )
  return byScope
}

export type UsageWinner = ReturnType<typeof withProvenance>

function withProvenance(
  winner: { policy: GatewayUsageLimitPolicy; limit: GatewayUsageLimitPolicy["limits"][number] },
  memberId: GatewayUsageScope["memberId"],
  names: Map<string, string>,
) {
  return {
    ...winner,
    provenance: winner.policy.assignments
      .map(
        (assignment): GatewayUsageProvenance =>
          assignment.organization
            ? {
                kind: "organization",
                assignmentId: assignment.id,
                memberId: null,
                teamId: null,
              }
            : assignment.teamId === null
              ? {
                  kind: "direct",
                  assignmentId: assignment.id,
                  memberId,
                  teamId: null,
                }
              : {
                  kind: "team",
                  assignmentId: assignment.id,
                  memberId: null,
                  teamId: assignment.teamId,
                  teamName: names.get(assignment.teamId) ?? "",
                },
      )
      .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId)),
  }
}

/**
 * One member's bucket for a timeframe window. `providerScope` null matches every
 * scope (used to mark history for the member as a whole); '' is the default.
 */
export function bucketWindow(
  scope: GatewayUsageScope,
  timeframe: UsageBucket["timeframe"],
  start: Date,
  providerScope: string | null = GATEWAY_DEFAULT_USAGE_SCOPE,
) {
  return and(
    eq(B.organizationId, scope.organizationId),
    eq(B.memberId, scope.memberId),
    providerScope === null ? undefined : eq(B.providerScope, providerScope),
    eq(B.timeframe, timeframe),
    eq(B.startAt, start),
  )
}

export function projectedBucket(
  scope: GatewayUsageScope,
  timeframe: UsageBucket["timeframe"],
  now: Date,
  providerScope: string = GATEWAY_DEFAULT_USAGE_SCOPE,
): UsageBucket {
  const period = gatewayUsagePeriod(timeframe, now)
  return {
    // Default bucket ids keep their pre-provider shape.
    id: createHash("sha256")
      .update(
        `${scope.organizationId}/${scope.memberId}/${timeframe}/${period.start.toISOString()}${providerScope ? `/${providerScope}` : ""}`,
      )
      .digest("hex"),
    organizationId: scope.organizationId,
    memberId: scope.memberId,
    providerScope,
    timeframe,
    startAt: period.start,
    resetAt: period.end,
    policyId: "unlimited",
    policyName: "Unlimited",
    policyRevision: 0,
    baseAllowanceMicroUsd: 0,
    hardLimit: false,
    allowRequestReset: false,
    usedMicroUsd: 0,
    unpricedRequests: 0,
    incompleteRequests: 0,
    historyUnknown: true,
    extensionMicroUsd: 0,
    extensionUsed: false,
  }
}

export async function currentUsage(
  tx: UsageReader,
  scope: GatewayUsageScope,
  now: Date,
  lock = false,
  readUnlimitedCounters = true,
  providerScope: string = GATEWAY_DEFAULT_USAGE_SCOPE,
  knownWinners?: UsageWinner[],
) {
  const winners = knownWinners ?? (await effectiveUsagePolicies(tx, scope, lock, providerScope))
  const windows = gatewayUsageTimeframes.map((frame) =>
    projectedBucket(scope, frame, now, providerScope),
  )
  if (!winners.length && !readUnlimitedCounters) return { winners, buckets: windows, stored: [] }
  const query = tx
    .select()
    .from(B)
    .where(
      or(
        ...windows.map((bucket) =>
          bucketWindow(scope, bucket.timeframe, bucket.startAt, providerScope),
        ),
      ),
    )
  const stored = await (lock
    ? query.orderBy(asc(B.timeframe), asc(B.startAt)).for("update")
    : query)
  const buckets = windows.map((window) => {
    const existing = stored.find((row) => row.timeframe === window.timeframe)
    const bucket = existing ?? window
    const winner = winners.find(({ limit }) => limit.timeframe === bucket.timeframe)
    if (!winner)
      return {
        ...bucket,
        policyId: "unlimited",
        policyName: "Unlimited",
        policyRevision: 0,
        baseAllowanceMicroUsd: 0,
        hardLimit: false,
        allowRequestReset: false,
        extensionMicroUsd: 0,
      }
    const { policy, limit } = winner
    return {
      ...bucket,
      policyId: policy.id,
      policyName: policy.name,
      policyRevision: policy.revision,
      baseAllowanceMicroUsd: limit.costLimitMicroUsd,
      hardLimit: policy.hardLimit,
      allowRequestReset: policy.allowRequestReset,
      extensionMicroUsd:
        existing?.policyId === policy.id && existing.policyRevision === policy.revision
          ? existing.extensionMicroUsd
          : 0,
    }
  })
  return { winners, buckets, stored }
}

export function usageSnapshot(
  buckets: UsageBucket[],
  admittedAt: Date,
  trackingVersion = 0,
): GatewayUsageSnapshot {
  return {
    version: 2,
    admittedAt: admittedAt.toISOString(),
    trackingVersion,
    buckets: buckets.map(
      ({
        usedMicroUsd,
        unpricedRequests,
        incompleteRequests,
        historyUnknown,
        extensionMicroUsd,
        extensionUsed,
        providerScope,
        ...bucket
      }) => ({
        ...bucket,
        // Default snapshots stay identical to the pre-provider shape for older readers.
        ...(providerScope ? { providerScope } : {}),
        startAt: bucket.startAt.toISOString(),
        resetAt: bucket.resetAt.toISOString(),
      }),
    ),
  }
}

export function usageState(
  views: GatewayUsageStatus["buckets"],
): GatewayUsageStatus["state"] {
  return !views.length
    ? "unlimited"
    : views.some((b) => b.hardLimit && b.usedMicroUsd >= b.allowanceMicroUsd)
      ? "blocked"
      : views.some((b) => b.usedMicroUsd >= b.allowanceMicroUsd)
        ? "over_limit"
        : "within_limit"
}

export async function readUsageStatus(
  tx: UsageReader,
  scope: GatewayUsageScope,
  now: Date,
  lock = false,
  admission = false,
  providerScope: string = GATEWAY_DEFAULT_USAGE_SCOPE,
  knownWinners?: UsageWinner[],
) {
  await activeUsageMember(tx, scope, lock)
  const current = await currentUsage(
    tx,
    scope,
    now,
    lock,
    !admission,
    providerScope,
    knownWinners,
  )
  const [tracking] = await tx
    .select()
    .from(T)
    .where(and(eq(T.memberId, scope.memberId), eq(T.organizationId, scope.organizationId)))
  const views: GatewayUsageStatus["buckets"] = []
  for (const { policy, limit, provenance } of current.winners) {
    const bucket = current.buckets.find((row) => row.timeframe === limit.timeframe)
    if (!bucket) return usageFail("bucket_missing", 503, "Current usage bucket missing.")
    const [request] = admission
      ? []
      : await tx
          .select()
          .from(R)
          .where(eq(R.bucketId, bucket.id))
          .orderBy(desc(R.createdAt), desc(R.id))
          .limit(1)
    const requestStatus =
      request?.status === "pending" &&
      (request.policyId !== policy.id ||
        request.policyRevision !== policy.revision ||
        request.resetAt <= now)
        ? "expired"
        : (request?.status ?? null)
    const allowanceMicroUsd = gatewaySafeMoney(
      bucket.baseAllowanceMicroUsd + bucket.extensionMicroUsd,
    )
    views.push({
      id: bucket.id,
      timeframe: bucket.timeframe,
      policyId: policy.id,
      policyName: policy.name,
      policyRevision: policy.revision,
      provenance,
      baseAllowanceMicroUsd: bucket.baseAllowanceMicroUsd,
      extensionMicroUsd: bucket.extensionMicroUsd,
      allowanceMicroUsd,
      usedMicroUsd: bucket.usedMicroUsd,
      remainingMicroUsd: allowanceMicroUsd - bucket.usedMicroUsd,
      resetAt: bucket.resetAt.toISOString(),
      hardLimit: policy.hardLimit,
      allowRequestReset: policy.allowRequestReset,
      canRequestReset:
        policy.allowRequestReset &&
        bucket.baseAllowanceMicroUsd > 0 &&
        bucket.usedMicroUsd >= allowanceMicroUsd &&
        requestStatus !== "pending",
      resetRequestStatus: requestStatus,
      ...(providerScope ? { providerId: providerScope } : {}),
    })
  }
  const oldest = [...current.buckets].sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0]
  const historicalUnknownReason =
    !tracking || !tracking.captureEnabled
      ? "tracking_not_started"
      : oldest && oldest.startAt < tracking.trackingStartedAt
        ? "period_predates_tracking"
        : current.stored.some((bucket) => bucket.historyUnknown)
          ? "legacy_counter"
          : null
  const incompleteRequests = oldest?.incompleteRequests ?? 0
  const settlementReady = tracking !== undefined && tracking.pendingRequests === 0
  const usage: GatewayUsageStatus = {
    serverTime: now.toISOString(),
    organizationId: scope.organizationId,
    memberId: scope.memberId,
    state: usageState(views),
    coverage: {
      complete: historicalUnknownReason === null && incompleteRequests === 0 && settlementReady,
      unpricedRequests: oldest?.unpricedRequests ?? 0,
      historicalCoverage: historicalUnknownReason === null ? "tracked_since_epoch" : "unknown",
      historicalUnknownReason,
      trackingStartedAt: tracking?.trackingStartedAt.toISOString() ?? null,
      trackingVersion: tracking?.epochVersion ?? 0,
      captureEnabled: tracking?.captureEnabled ?? true,
      pendingRequests: tracking?.pendingRequests ?? null,
      incompleteRequests,
      lastSettlementAt: tracking?.lastSettlementAt?.toISOString() ?? null,
      lastSettlementRequestId: tracking?.lastSettlementRequestId ?? null,
      settlementReady,
    },
    buckets: views,
  }
  return { usage, snapshot: usageSnapshot(current.buckets, now, tracking?.epochVersion ?? 0) }
}

/** Display names for Gateway providers in one organization; removed providers are absent. */
export async function usageProviderNames(
  tx: UsageReader,
  organizationId: GatewayUsageScope["organizationId"],
  providerIds: string[],
) {
  const ids = [
    ...new Set(providerIds.filter((id) => isDenTypeId("inferenceProvider", id))),
  ]
  if (!ids.length) return new Map<string, string>()
  const rows = await tx
    .select({ id: GatewayProviderTable.id, name: GatewayProviderTable.name })
    .from(GatewayProviderTable)
    .where(
      and(
        eq(GatewayProviderTable.organization_id, organizationId),
        inArray(GatewayProviderTable.id, ids),
      ),
    )
  return new Map<string, string>(rows.map((row) => [row.id, row.name]))
}

/**
 * The member's default status plus one entry per provider limit that governs
 * them. Provider limits are available on every deployment.
 */
export async function readUsageStatusWithProviders(
  tx: UsageReader,
  scope: GatewayUsageScope,
  now: Date,
  options: { lock?: boolean } = {},
): Promise<GatewayUsageStatus> {
  const lock = options.lock ?? false
  const scopes = await effectiveUsagePolicyScopes(tx, scope, lock)
  const { usage } = await readUsageStatus(
    tx,
    scope,
    now,
    lock,
    false,
    GATEWAY_DEFAULT_USAGE_SCOPE,
    scopes.get(GATEWAY_DEFAULT_USAGE_SCOPE) ?? [],
  )
  const providerIds = [...scopes.keys()].filter((key) => key !== GATEWAY_DEFAULT_USAGE_SCOPE).sort()
  const names = await usageProviderNames(tx, scope.organizationId, providerIds)
  const providers: GatewayProviderUsage[] = []
  for (const providerId of providerIds) {
    const status = (
      await readUsageStatus(tx, scope, now, lock, false, providerId, scopes.get(providerId))
    ).usage
    const state = status.state
    if (state === "unlimited") continue
    providers.push({
      providerId,
      providerName: names.get(providerId) ?? "Removed provider",
      state,
      buckets: status.buckets,
    })
  }
  return { ...usage, providers }
}
