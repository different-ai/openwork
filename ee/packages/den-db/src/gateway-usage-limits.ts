import { randomUUID } from "node:crypto"
import { and, asc, eq, isNull, or, sql } from "drizzle-orm"
import {
  gatewaySafeMoney,
  gatewayUsdToMicroUsd,
  type GatewayUsagePolicyWrite,
  type GatewayUsageResetRequest,
  type GatewayUsageResetListOptions,
} from "@openwork/types/den/gateway-usage-limits"
import {
  withGatewayUsageEntitlementMutation,
  usagePolicyMembers,
  usageOrganizationMembers,
  lockUsageOrganization,
  lockUsageMembers,
} from "./gateway-usage-entitlements"
import { isGatewayUsageDeadlock } from "./gateway-usage-errors"
import { readGatewayUsageResetPage } from "./gateway-usage-reset-page"
import {
  activeUsageMember,
  usagePolicies,
  currentUsage,
  readUsageStatus,
  usageFail as fail,
  type GatewayUsageDb,
  type GatewayUsageScope,
  type UsageTx,
} from "./gateway-usage-read"
import { settleGatewayUsage, type UsageLogRow } from "./gateway-usage-settlement"
import { AuthUserTable } from "./schema/auth"
import { MemberTable } from "./schema/org"
import { TeamMemberTable, TeamTable } from "./schema/teams"
import {
  GatewayUsagePolicyTable as P,
  GatewayUsageLimitTable as L,
  GatewayUsageAssignmentTable as A,
  GatewayUsageBucketTable as B,
  GatewayUsageResetTable as R,
  GatewayUsageAuditTable as H,
} from "./schema/gateway-usage-limits"

export { GatewayUsageError, safeUsageDatabaseCode } from "./gateway-usage-errors"
export { withGatewayUsageEntitlementMutation } from "./gateway-usage-entitlements"
export { deleteGatewayUsageForOrganization } from "./gateway-usage-erasure"
export { reconcileGatewayUsageBatch } from "./gateway-usage-reconciliation"
export { listPendingGatewayUsageRequests, recoverGatewayUsageRequests, rotateGatewayUsageEpoch } from "./gateway-usage-operations"
export {
  startGatewayUsageLog,
  assertUsageRetentionSafe,
  expireUsageRequestsForMembers,
  fenceUsageOrganizationDeletion,
} from "./gateway-usage-lifecycle"
export type { GatewayUsageDb, GatewayUsageScope, GatewayUsageSnapshot } from "./gateway-usage-read"

export function createGatewayUsageLimits(db: GatewayUsageDb, clock = () => new Date()) {
  async function transaction<T>(run: (tx: UsageTx, now: Date) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.transaction((tx) => run(tx, clock()))
      } catch (error) {
        if (!isGatewayUsageDeadlock(error) || attempt >= 2) throw error
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)))
      }
    }
  }
  async function audit(
    tx: UsageTx,
    scope: GatewayUsageScope,
    subjectId: string,
    action: string,
    details: Record<string, unknown>,
    now: Date,
  ) {
    await tx.insert(H).values({
      id: randomUUID(),
      organizationId: scope.organizationId,
      actorId: scope.memberId,
      subjectId,
      action,
      details,
      createdAt: now,
    })
  }
  async function policyById(tx: UsageTx, scope: GatewayUsageScope, id: string) {
    const [policy] = await tx
      .select()
      .from(P)
      .where(and(eq(P.id, id), eq(P.organizationId, scope.organizationId)))
      .for("update")
    if (!policy) return fail("policy_not_found", 404, "Policy not found.")
    return policy
  }
  async function policyView(tx: UsageTx, scope: GatewayUsageScope, id: string) {
    const policy = (await usagePolicies(tx, scope.organizationId)).find((row) => row.id === id)
    if (!policy) return fail("policy_not_found", 404, "Policy not found.")
    return policy
  }
  async function expire(tx: UsageTx, bucketId: string) {
    await tx
      .update(R)
      .set({ status: "expired", pendingBucketId: null })
      .where(and(eq(R.bucketId, bucketId), eq(R.status, "pending")))
  }
  async function requestView(
    tx: UsageTx,
    row: typeof R.$inferSelect,
  ): Promise<GatewayUsageResetRequest> {
    const [user] = await tx
      .select({ name: AuthUserTable.name, email: AuthUserTable.email })
      .from(MemberTable)
      .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(
        and(eq(MemberTable.id, row.memberId), eq(MemberTable.organizationId, row.organizationId)),
      )
    const [bucket] = await tx.select().from(B).where(eq(B.id, row.bucketId))
    return {
      id: row.id,
      memberId: row.memberId,
      memberName: user?.name ?? "Removed member",
      memberEmail: user?.email ?? "",
      bucketId: row.bucketId,
      timeframe: row.timeframe,
      policyName: row.policyName,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      baseAllowanceMicroUsd: row.baseAllowanceMicroUsd,
      allowanceMicroUsd:
        row.status === "pending" && bucket
          ? gatewaySafeMoney(bucket.baseAllowanceMicroUsd + bucket.extensionMicroUsd)
          : row.allowanceMicroUsd,
      usedMicroUsd: row.status === "pending" && bucket ? bucket.usedMicroUsd : row.usedMicroUsd,
      resetAt: row.resetAt.toISOString(),
    }
  }
  return {
    listPolicies(scope: GatewayUsageScope) {
      return transaction(async (tx) => {
        await activeUsageMember(tx, scope, true)
        return { policies: await usagePolicies(tx, scope.organizationId) }
      })
    },
    savePolicy(
      scope: GatewayUsageScope,
      input: GatewayUsagePolicyWrite,
      id?: string,
      revision?: number,
    ) {
      return transaction(async (tx, now) => {
        const members = id ? await usagePolicyMembers(tx, scope.organizationId, id) : []
        return withGatewayUsageEntitlementMutation(
          tx,
          scope.organizationId,
          async () => {
            await activeUsageMember(tx, scope, true, true)
            const policyId = id ?? randomUUID()
            const previous = id ? await policyById(tx, scope, id) : null
            if (previous && (previous.archivedAt || previous.revision !== revision))
              return fail("policy_revision_conflict", 409, "Policy changed. Reload before editing.")
            const nextRevision = previous ? previous.revision + 1 : 1
            if (nextRevision > 2_147_483_647)
              return fail("policy_revision_overflow", 409, "Policy revision exhausted.")
            const fields = {
              name: input.name,
              hardLimit: input.hardLimit,
              allowRequestReset: input.allowRequestReset,
              revision: nextRevision,
              updatedAt: now,
            }
            if (previous) {
              await tx.update(P).set(fields).where(eq(P.id, policyId))
              await tx.delete(L).where(eq(L.policyId, policyId))
            } else
              await tx.insert(P).values({
                id: policyId,
                organizationId: scope.organizationId,
                createdAt: now,
                createdBy: scope.memberId,
                ...fields,
              })
            await tx.insert(L).values(
              input.limits.map((limit) => ({
                policyId,
                timeframe: limit.timeframe,
                costLimitMicroUsd: gatewayUsdToMicroUsd(limit.costUsd),
              })),
            )
            await audit(
              tx,
              scope,
              policyId,
              previous ? "policy_updated" : "policy_created",
              { previous, ...fields, limits: input.limits },
              now,
            )
            return policyView(tx, scope, policyId)
          },
          members,
          now,
        )
      })
    },
    archivePolicy(scope: GatewayUsageScope, id: string, revision: number) {
      return transaction(async (tx, now) =>
        withGatewayUsageEntitlementMutation(
          tx,
          scope.organizationId,
          async () => {
            await activeUsageMember(tx, scope, true, true)
            const policy = await policyById(tx, scope, id)
            if (policy.revision !== revision)
              return fail(
                "policy_revision_conflict",
                409,
                "Policy changed. Reload before archiving.",
              )
            if (!policy.archivedAt) {
              await tx
                .update(P)
                .set({ archivedAt: now, updatedAt: now, revision: revision + 1 })
                .where(eq(P.id, id))
              await audit(tx, scope, id, "policy_archived", { revision }, now)
            }
            return policyView(tx, scope, id)
          },
          await usagePolicyMembers(tx, scope.organizationId, id),
          now,
        ),
      )
    },
    restorePolicy(scope: GatewayUsageScope, id: string, revision: number) {
      return transaction(async (tx, now) =>
        withGatewayUsageEntitlementMutation(
          tx,
          scope.organizationId,
          async () => {
            await activeUsageMember(tx, scope, true, true)
            const policy = await policyById(tx, scope, id)
            if (policy.revision !== revision)
              return fail(
                "policy_revision_conflict",
                409,
                "Policy changed. Reload before restoring.",
              )
            if (policy.archivedAt) {
              await tx
                .update(P)
                .set({ archivedAt: null, updatedAt: now, revision: revision + 1 })
                .where(eq(P.id, id))
              await audit(tx, scope, id, "policy_restored", { revision }, now)
            }
            return policyView(tx, scope, id)
          },
          await usagePolicyMembers(tx, scope.organizationId, id),
          now,
        ),
      )
    },
    assign(
      scope: GatewayUsageScope,
      policyId: string,
      target:
        | { organization: true }
        | { memberId: GatewayUsageScope["memberId"] }
        | { teamId: typeof TeamTable.$inferSelect.id },
    ) {
      return transaction(async (tx, now) => {
        await lockUsageOrganization(tx, scope.organizationId)
        const members =
          "organization" in target
            ? await usageOrganizationMembers(tx, scope.organizationId)
            : "memberId" in target
              ? [target.memberId]
              : (
                  await tx
                    .select({ id: TeamMemberTable.orgMembershipId })
                    .from(TeamMemberTable)
                    .innerJoin(
                      TeamTable,
                      and(
                        eq(TeamTable.id, TeamMemberTable.teamId),
                        eq(TeamTable.organizationId, scope.organizationId),
                      ),
                    )
                    .where(eq(TeamMemberTable.teamId, target.teamId))
                    .for("share")
                ).flatMap((row) => (row.id ? [row.id] : []))
        return withGatewayUsageEntitlementMutation(
          tx,
          scope.organizationId,
          async () => {
            await activeUsageMember(tx, scope, true, true)
            const policy = await policyById(tx, scope, policyId)
            if (policy.archivedAt)
              return fail("policy_archived", 409, "Archived policies cannot be assigned.")
            const memberId = "memberId" in target ? target.memberId : null
            const teamId = "teamId" in target ? target.teamId : null
            if (memberId) await activeUsageMember(tx, { ...scope, memberId }, false, true)
            if (teamId) {
              const [team] = await tx
                .select()
                .from(TeamTable)
                .where(
                  and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, scope.organizationId)),
                )
                .for("share")
              if (!team) return fail("team_not_found", 404, "Organization team not found.")
            }
            await tx
              .insert(A)
              .values({
                id: randomUUID(),
                policyId,
                organizationId: scope.organizationId,
                memberId,
                teamId,
                organization: "organization" in target ? true : null,
                createdAt: now,
              })
              .onDuplicateKeyUpdate({ set: { policyId } })
            await audit(tx, scope, policyId, "policy_assigned", target, now)
            return policyView(tx, scope, policyId)
          },
          members,
          now,
        )
      })
    },
    unassign(scope: GatewayUsageScope, policyId: string, assignmentId: string) {
      return transaction(async (tx, now) =>
        withGatewayUsageEntitlementMutation(
          tx,
          scope.organizationId,
          async () => {
            await activeUsageMember(tx, scope, true, true)
            await policyById(tx, scope, policyId)
            await tx
              .delete(A)
              .where(
                and(
                  eq(A.id, assignmentId),
                  eq(A.policyId, policyId),
                  eq(A.organizationId, scope.organizationId),
                ),
              )
            await audit(tx, scope, policyId, "policy_unassigned", { assignmentId }, now)
            return policyView(tx, scope, policyId)
          },
          await usagePolicyMembers(tx, scope.organizationId, policyId),
          now,
        ),
      )
    },
    members(scope: GatewayUsageScope, query = "") {
      return transaction(async (tx) => {
        await activeUsageMember(tx, scope, true)
        return {
          members: await tx
            .select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email })
            .from(MemberTable)
            .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
            .where(
              and(
                eq(MemberTable.organizationId, scope.organizationId),
                isNull(MemberTable.removedAt),
                query
                  ? or(
                      sql`locate(${query}, ${AuthUserTable.name}) > 0`,
                      sql`locate(${query}, ${AuthUserTable.email}) > 0`,
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(AuthUserTable.name), asc(MemberTable.id))
            .limit(100),
        }
      })
    },
    getStatus(scope: GatewayUsageScope, memberId?: GatewayUsageScope["memberId"]) {
      return transaction(async (tx, now) => {
        if (memberId !== undefined) await activeUsageMember(tx, scope, true)
        return (await readUsageStatus(tx, { ...scope, memberId: memberId ?? scope.memberId }, now))
          .usage
      })
    },
    admit(
      scope: GatewayUsageScope,
      _requestId: string,
      accountable: boolean,
      _requestStartedAt?: Date,
    ) {
      return transaction(async (tx, admittedAt) => {
        const { usage, snapshot } = await readUsageStatus(tx, scope, admittedAt, false, true)
        const accountingUnavailable =
          usage.coverage.captureEnabled === false || (!accountable && usage.buckets.some((bucket) => bucket.hardLimit))
        return {
          usage,
          snapshot,
          admitted: usage.state !== "blocked" && !accountingUnavailable,
          accountingUnavailable,
        }
      })
    },
    record(row: UsageLogRow) {
      if (row.route !== "org_provider") return Promise.resolve(false)
      return transaction((tx, now) => settleGatewayUsage(tx, row, now))
    },
    submitReset(scope: GatewayUsageScope, bucketId: string, reason: string) {
      return transaction(async (tx, now) => {
        await lockUsageMembers(tx, scope.organizationId, [scope.memberId])
        const { usage } = await readUsageStatus(tx, scope, now, true)
        const view = usage.buckets.find((bucket) => bucket.id === bucketId)
        if (!view) return fail("bucket_not_found", 404, "Current own bucket not found.")
        const [pending] = await tx
          .select()
          .from(R)
          .where(eq(R.pendingBucketId, bucketId))
          .for("update")
        if (
          pending &&
          pending.policyId === view.policyId &&
          pending.policyRevision === view.policyRevision
        )
          return requestView(tx, pending)
        if (pending) await expire(tx, bucketId)
        if (!view.canRequestReset)
          return fail("reset_not_allowed", 409, "This bucket is not eligible for an extension.")
        if (!reason.trim() || reason.length > 2000)
          return fail("invalid_reason", 400, "A reason of 1–2000 characters is required.")
        const [bucket] = await tx.select().from(B).where(eq(B.id, bucketId)).for("update")
        if (!bucket) return fail("bucket_not_found", 404, "Bucket not found.")
        await tx
          .update(B)
          .set({
            policyId: view.policyId,
            policyName: view.policyName,
            policyRevision: view.policyRevision,
            baseAllowanceMicroUsd: view.baseAllowanceMicroUsd,
            extensionMicroUsd: view.extensionMicroUsd,
            hardLimit: view.hardLimit,
            allowRequestReset: view.allowRequestReset,
          })
          .where(eq(B.id, bucketId))
        if (view.policyRevision === undefined)
          return fail("policy_revision_missing", 503, "Policy revision missing.")
        const row: typeof R.$inferSelect = {
          id: randomUUID(),
          ...scope,
          bucketId,
          policyId: view.policyId,
          policyRevision: view.policyRevision,
          timeframe: view.timeframe,
          policyName: view.policyName,
          reason: reason.trim(),
          status: "pending",
          pendingBucketId: bucketId,
          baseAllowanceMicroUsd: view.baseAllowanceMicroUsd,
          allowanceMicroUsd: view.allowanceMicroUsd,
          usedMicroUsd: bucket.usedMicroUsd,
          resetAt: bucket.resetAt,
          createdAt: now,
          reviewedAt: null,
          reviewedBy: null,
          denialNote: null,
        }
        await tx.insert(R).values(row)
        await audit(tx, scope, row.id, "reset_submitted", { bucketId }, now)
        return requestView(tx, row)
      })
    },
    listResets(scope: GatewayUsageScope, own: boolean, options: GatewayUsageResetListOptions = {}) {
      return transaction(async (tx, now) => {
        await activeUsageMember(tx, scope, !own)
        return readGatewayUsageResetPage(tx, scope, own, options, now)
      })
    },
    reviewReset(
      scope: GatewayUsageScope,
      id: string,
      decision: "approved" | "denied",
      denialNote?: string,
    ) {
      return transaction(async (tx, now) => {
        const [subject] = await tx
          .select({ memberId: R.memberId })
          .from(R)
          .where(and(eq(R.id, id), eq(R.organizationId, scope.organizationId)))
        if (!subject) return fail("reset_not_found", 404, "Increase request not found.")
        await lockUsageMembers(tx, scope.organizationId, [subject.memberId, scope.memberId])
        await activeUsageMember(tx, scope, true, true)
        const [row] = await tx
          .select()
          .from(R)
          .where(and(eq(R.id, id), eq(R.organizationId, scope.organizationId)))
          .for("update")
        if (!row) return fail("reset_not_found", 404, "Increase request not found.")
        if (row.status !== "pending") return requestView(tx, row)
        const [member] = await tx
          .select()
          .from(MemberTable)
          .where(
            and(
              eq(MemberTable.id, row.memberId),
              eq(MemberTable.organizationId, row.organizationId),
            ),
          )
          .for("share")
        const current =
          member?.userId && !member.removedAt
            ? await currentUsage(tx, { ...scope, memberId: row.memberId }, now, true)
            : { buckets: [], winners: [] }
        const bucket = current.buckets.find(
          (bucket) =>
            bucket.id === row.bucketId &&
            bucket.policyId === row.policyId &&
            bucket.policyRevision === row.policyRevision &&
            bucket.baseAllowanceMicroUsd === row.baseAllowanceMicroUsd &&
            bucket.allowRequestReset &&
            bucket.resetAt > now &&
            current.winners.some(
              (winner) =>
                winner.policy.id === row.policyId && winner.limit.timeframe === row.timeframe,
            ),
        )
        if (!bucket) {
          await expire(tx, row.bucketId)
          return requestView(tx, { ...row, status: "expired", pendingBucketId: null })
        }
        const extension =
          decision === "approved"
            ? gatewaySafeMoney(bucket.extensionMicroUsd + Math.ceil(bucket.baseAllowanceMicroUsd / 4))
            : bucket.extensionMicroUsd
        const allowanceMicroUsd = gatewaySafeMoney(bucket.baseAllowanceMicroUsd + extension)
        if (decision === "approved")
          await tx
            .update(B)
            .set({ extensionMicroUsd: extension, extensionUsed: true })
            .where(eq(B.id, bucket.id))
        const updated = {
          ...row,
          status: decision,
          pendingBucketId: null,
          reviewedBy: scope.memberId,
          reviewedAt: now,
          allowanceMicroUsd,
          usedMicroUsd: bucket.usedMicroUsd,
          denialNote: denialNote ?? null,
        }
        await tx.update(R).set(updated).where(eq(R.id, id))
        await audit(
          tx,
          scope,
          id,
          `reset_${decision}`,
          {
            bucketId: bucket.id,
            previousAllowance: row.allowanceMicroUsd,
            allowanceMicroUsd,
            usedMicroUsd: bucket.usedMicroUsd,
          },
          now,
        )
        return requestView(tx, updated)
      })
    },
  }
}
