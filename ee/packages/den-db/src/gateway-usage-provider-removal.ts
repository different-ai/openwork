import { randomUUID } from "node:crypto"
import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import {
  GATEWAY_PROVIDER_HAS_USAGE_LIMITS,
  type GatewayProviderRemovalLimitChoice,
  type GatewayProviderRemovalUsageLimit,
} from "@openwork/types/den/gateway-usage-limits"
import {
  lockUsageOrganization,
  usagePolicyMembers,
  withGatewayUsageEntitlementMutation,
} from "./gateway-usage-entitlements"
import { GatewayUsageError } from "./gateway-usage-errors"
import { usageFail, type GatewayUsageScope, type UsageTx } from "./gateway-usage-read"
import { GatewayProviderTable } from "./schema/inference-providers"
import {
  GatewayUsageAuditTable as H,
  GatewayUsageLimitTable as L,
  GatewayUsagePolicyTable as P,
} from "./schema/gateway-usage-limits"

/** Deleting a provider would orphan these active usage limits; the caller must choose move or archive. */
export class GatewayProviderUsageLimitsError extends GatewayUsageError {
  constructor(readonly usageLimits: GatewayProviderRemovalUsageLimit[]) {
    super(
      GATEWAY_PROVIDER_HAS_USAGE_LIMITS,
      409,
      `This provider has ${usageLimits.length === 1 ? "a usage limit" : `${usageLimits.length} usage limits`}. Move them to another provider or archive them, then delete the provider.`,
    )
  }
}

export type GatewayProviderRemovalLimitsResult = {
  action: GatewayProviderRemovalLimitChoice["action"] | null
  policyIds: string[]
}

/**
 * Settles the active usage limits scoped to a Gateway provider that is being
 * deleted, inside the caller's transaction, before the provider row goes.
 * Without a choice, any such limit is a 409 listing them. "move" re-scopes them
 * to another active provider of the same organization; "archive" archives them.
 * Both bump each policy's revision through the entitlement mutation, so pending
 * increase requests and extensions tied to the old winners expire as they would
 * for an edit. Call after locking the organization (lockUsageOrganization) and
 * before locking member rows, to keep the usage-limit lock order.
 */
export async function settleGatewayProviderUsageLimits(
  tx: UsageTx,
  scope: GatewayUsageScope,
  removedProviderId: string,
  choice: GatewayProviderRemovalLimitChoice | undefined,
  now = new Date(),
): Promise<GatewayProviderRemovalLimitsResult> {
  await lockUsageOrganization(tx, scope.organizationId)
  if (!isDenTypeId("inferenceProvider", removedProviderId))
    return usageFail("invalid_provider", 400, "Invalid provider ID.")
  const policies = await tx
    .select()
    .from(P)
    .where(
      and(
        eq(P.organizationId, scope.organizationId),
        eq(P.inferenceProviderId, removedProviderId),
        isNull(P.archivedAt),
      ),
    )
    .orderBy(asc(P.id))
    .for("update")
  if (!policies.length) return { action: null, policyIds: [] }
  if (!choice) {
    const limits = await tx
      .select()
      .from(L)
      .where(
        inArray(
          L.policyId,
          policies.map((policy) => policy.id),
        ),
      )
    throw new GatewayProviderUsageLimitsError(
      policies.map((policy) => ({
        id: policy.id,
        name: policy.name,
        revision: policy.revision,
        hardLimit: policy.hardLimit,
        limits: limits
          .filter((limit) => limit.policyId === policy.id)
          .map(({ timeframe, costLimitMicroUsd }) => ({ timeframe, costLimitMicroUsd })),
      })),
    )
  }
  let target: typeof GatewayProviderTable.$inferSelect.id | null = null
  if (choice.action === "move") {
    const targetId = choice.providerId
    if (!isDenTypeId("inferenceProvider", targetId) || targetId === removedProviderId)
      return usageFail(
        "invalid_usage_limit_provider",
        400,
        "Choose another provider for these usage limits.",
      )
    const [provider] = await tx
      .select({ id: GatewayProviderTable.id, status: GatewayProviderTable.status })
      .from(GatewayProviderTable)
      .where(
        and(
          eq(GatewayProviderTable.id, targetId),
          eq(GatewayProviderTable.organization_id, scope.organizationId),
        ),
      )
      .for("share")
    if (!provider)
      return usageFail(
        "usage_limit_provider_not_found",
        404,
        "The provider chosen for these usage limits was not found in this organization.",
      )
    if (provider.status !== "active")
      return usageFail(
        "usage_limit_provider_inactive",
        409,
        "The provider chosen for these usage limits is turned off. Choose an active provider.",
      )
    target = provider.id
  }
  if (policies.some((policy) => policy.revision >= 2_147_483_647))
    return usageFail("policy_revision_overflow", 409, "Policy revision exhausted.")
  const members = new Set<GatewayUsageScope["memberId"]>()
  for (const policy of policies)
    for (const memberId of await usagePolicyMembers(tx, scope.organizationId, policy.id))
      members.add(memberId)
  await withGatewayUsageEntitlementMutation(
    tx,
    scope.organizationId,
    async () => {
      for (const policy of policies) {
        const revision = policy.revision + 1
        if (target) {
          await tx
            .update(P)
            .set({ inferenceProviderId: target, revision, updatedAt: now })
            .where(eq(P.id, policy.id))
        } else {
          await tx
            .update(P)
            .set({ archivedAt: now, revision, updatedAt: now })
            .where(eq(P.id, policy.id))
        }
        await tx.insert(H).values({
          id: randomUUID(),
          organizationId: scope.organizationId,
          actorId: scope.memberId,
          subjectId: policy.id,
          action: target ? "policy_provider_moved" : "policy_archived",
          details: target
            ? { revision: policy.revision, reason: "provider_removed", fromProviderId: removedProviderId, toProviderId: target }
            : { revision: policy.revision, reason: "provider_removed", providerId: removedProviderId },
          createdAt: now,
        })
      }
    },
    [...members],
    now,
  )
  return { action: choice.action, policyIds: policies.map((policy) => policy.id) }
}
