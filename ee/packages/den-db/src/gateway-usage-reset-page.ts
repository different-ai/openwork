import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm"
import {
  gatewaySafeMoney,
  gatewayUsagePeriod,
  gatewayUsageResetListOptionsSchema,
  gatewayUsageResetCursorSchema,
  gatewayWinningPolicies,
  type GatewayUsageLimitPolicy,
  type GatewayUsageResetListOptions,
  type GatewayUsageResetPage,
  type GatewayUsageResetRequest,
} from "@openwork/types/den/gateway-usage-limits"
import type { createDenDb } from "./client"
import { GatewayUsageError } from "./gateway-usage-errors"
import { AuthUserTable } from "./schema/auth"
import { MemberTable } from "./schema/org"
import { TeamMemberTable, TeamTable } from "./schema/teams"
import {
  GatewayUsageAssignmentTable as Assignment,
  GatewayUsageBucketTable as Bucket,
  GatewayUsageLimitTable as Limit,
  GatewayUsagePolicyTable as Policy,
  GatewayUsageResetTable as Reset,
} from "./schema/gateway-usage-limits"

type Db = ReturnType<typeof createDenDb>["db"]
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Scope = {
  organizationId: typeof MemberTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}

function readCursor(
  value: string | undefined,
  scope: Scope,
  own: boolean,
  view: "pending" | "history",
) {
  if (!value) return null
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error()
    const cursor = gatewayUsageResetCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    )
    if (
      cursor.organizationId !== scope.organizationId ||
      cursor.memberId !== (own ? scope.memberId : null) ||
      cursor.view !== view
    )
      throw new Error()
    return cursor
  } catch {
    throw new GatewayUsageError(
      "invalid_cursor",
      400,
      "Cursor does not match this usage request list.",
    )
  }
}

async function pageWinners(tx: Transaction, scope: Scope, memberIds: Scope["memberId"][]) {
  const winners = new Map<string, ReturnType<typeof gatewayWinningPolicies>>()
  if (memberIds.length === 0) return winners
  const memberships = await tx
    .select({ memberId: TeamMemberTable.orgMembershipId, teamId: TeamTable.id })
    .from(TeamMemberTable)
    .innerJoin(
      TeamTable,
      and(
        eq(TeamTable.id, TeamMemberTable.teamId),
        eq(TeamTable.organizationId, scope.organizationId),
      ),
    )
    .where(inArray(TeamMemberTable.orgMembershipId, memberIds))
  const teamIds = [...new Set(memberships.map((membership) => membership.teamId))]
  const rows = await tx
    .select({ assignment: Assignment, policy: Policy, limit: Limit })
    .from(Assignment)
    .innerJoin(
      Policy,
      and(
        eq(Policy.id, Assignment.policyId),
        eq(Policy.organizationId, scope.organizationId),
        isNull(Policy.archivedAt),
      ),
    )
    .innerJoin(Limit, eq(Limit.policyId, Policy.id))
    .where(
      and(
        eq(Assignment.organizationId, scope.organizationId),
        or(
          eq(Assignment.organization, true),
          inArray(Assignment.memberId, memberIds),
          teamIds.length > 0 ? inArray(Assignment.teamId, teamIds) : undefined,
        ),
      ),
    )
  for (const memberId of memberIds) {
    const teams = new Set(
      memberships
        .filter((membership) => membership.memberId === memberId)
        .map((membership) => membership.teamId),
    )
    const candidates = new Map<string, GatewayUsageLimitPolicy>()
    for (const { assignment, policy, limit } of rows) {
      if (
        assignment.organization !== true &&
        assignment.memberId !== memberId &&
        (assignment.teamId === null || !teams.has(assignment.teamId))
      )
        continue
      let candidate = candidates.get(policy.id)
      if (!candidate) {
        candidate = {
          id: policy.id,
          name: policy.name,
          revision: policy.revision,
          hardLimit: policy.hardLimit,
          allowRequestReset: policy.allowRequestReset,
          limits: [],
          assignments: [],
        }
        candidates.set(policy.id, candidate)
      }
      if (!candidate.limits.some((existing) => existing.timeframe === limit.timeframe))
        candidate.limits.push({
          timeframe: limit.timeframe,
          costLimitMicroUsd: limit.costLimitMicroUsd,
        })
    }
    winners.set(memberId, gatewayWinningPolicies([...candidates.values()]))
  }
  return winners
}

export async function readGatewayUsageResetPage(
  tx: Transaction,
  scope: Scope,
  own: boolean,
  input: GatewayUsageResetListOptions,
  now: Date,
): Promise<GatewayUsageResetPage> {
  const parsed = gatewayUsageResetListOptionsSchema.safeParse(input)
  if (!parsed.success)
    throw new GatewayUsageError("invalid_query", 400, "Invalid usage request pagination options.")
  const { view, limit, cursor: encodedCursor } = parsed.data
  const cursor = readCursor(encodedCursor, scope, own, view)
  const subject = and(
    eq(Reset.organizationId, scope.organizationId),
    own ? eq(Reset.memberId, scope.memberId) : undefined,
  )
  const pending = and(eq(Reset.status, "pending"), gt(Reset.resetAt, now))
  const [counts] = await tx
    .select({ pendingCount: sql<string>`cast(count(*) as char)` })
    .from(Reset)
    .where(and(subject, pending))
  if (!counts)
    throw new GatewayUsageError(
      "accounting_unavailable",
      503,
      "Usage request counts are unavailable.",
    )
  const pendingCount = gatewaySafeMoney(Number(counts.pendingCount))
  const direction = view === "pending" ? asc : desc
  const compare = view === "pending" ? gt : lt
  const after = cursor
    ? or(
        compare(Reset.createdAt, new Date(cursor.createdAt)),
        and(eq(Reset.createdAt, new Date(cursor.createdAt)), compare(Reset.id, cursor.id)),
      )
    : undefined
  const found = await tx
    .select({
      request: Reset,
      bucket: Bucket,
      member: MemberTable,
      memberName: AuthUserTable.name,
      memberEmail: AuthUserTable.email,
    })
    .from(Reset)
    .leftJoin(
      Bucket,
      and(
        eq(Bucket.id, Reset.bucketId),
        eq(Bucket.organizationId, scope.organizationId),
        eq(Bucket.memberId, Reset.memberId),
      ),
    )
    .leftJoin(
      MemberTable,
      and(eq(MemberTable.id, Reset.memberId), eq(MemberTable.organizationId, scope.organizationId)),
    )
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(
      and(
        subject,
        view === "pending" ? pending : or(ne(Reset.status, "pending"), lte(Reset.resetAt, now)),
        after,
      ),
    )
    .orderBy(direction(Reset.createdAt), direction(Reset.id))
    .limit(limit + 1)
  const hasMore = found.length > limit
  const rows = found.slice(0, limit)
  const pendingMemberIds = [
    ...new Set(
      rows
        .filter(({ request }) => request.status === "pending" && request.resetAt > now)
        .map(({ request }) => request.memberId),
    ),
  ]
  const winners = await pageWinners(tx, scope, pendingMemberIds)
  const requests = rows.map(
    ({ request, bucket, member, memberName, memberEmail }): GatewayUsageResetRequest => {
      const winner = winners
        .get(request.memberId)
        ?.find(({ limit }) => limit.timeframe === request.timeframe)
      const period = gatewayUsagePeriod(request.timeframe, now)
      const eligible =
        request.status === "pending" &&
        request.resetAt > now &&
        member?.userId != null &&
        member.removedAt === null &&
        bucket !== null &&
        bucket.resetAt.getTime() === period.end.getTime() &&
        bucket.startAt.getTime() === period.start.getTime() &&
        bucket.policyId === request.policyId &&
        bucket.policyRevision === request.policyRevision &&
        bucket.baseAllowanceMicroUsd === request.baseAllowanceMicroUsd &&
        winner?.policy.id === request.policyId &&
        winner.policy.revision === request.policyRevision &&
        winner.limit.costLimitMicroUsd === request.baseAllowanceMicroUsd &&
        winner.policy.allowRequestReset
      const status = request.status === "pending" && !eligible ? "expired" : request.status
      return {
        id: request.id,
        memberId: request.memberId,
        memberName: memberName ?? "Removed member",
        memberEmail: memberEmail ?? "",
        bucketId: request.bucketId,
        timeframe: request.timeframe,
        policyName: request.policyName,
        reason: request.reason,
        status,
        createdAt: request.createdAt.toISOString(),
        reviewedBy: request.reviewedBy,
        reviewedAt: request.reviewedAt?.toISOString() ?? null,
        baseAllowanceMicroUsd: request.baseAllowanceMicroUsd,
        allowanceMicroUsd: eligible
          ? gatewaySafeMoney(request.baseAllowanceMicroUsd + (bucket?.extensionMicroUsd ?? 0))
          : request.allowanceMicroUsd,
        usedMicroUsd: eligible
          ? (bucket?.usedMicroUsd ?? request.usedMicroUsd)
          : request.usedMicroUsd,
        resetAt: request.resetAt.toISOString(),
      }
    },
  )
  const last = rows.at(-1)?.request
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            organizationId: scope.organizationId,
            memberId: own ? scope.memberId : null,
            view,
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          }),
        ).toString("base64url")
      : null
  return { requests, view, limit, pendingCount, hasMore, nextCursor }
}
