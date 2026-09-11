import { timingSafeEqual } from "node:crypto"
import { and, eq, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { GatewayKeyTable, InferenceKeyTable, InferenceOrgUpstreamProviderKeyTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db"
import { assertManagedModelsAllowed, ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { gatewayBearerKeyLookupDigest, type GatewayBearerKey } from "@openwork-ee/utils/gateway-bearer-key"
import {
  inferenceBearerKeyLookupDigests,
  type InferenceBearerKey,
} from "@openwork-ee/utils/inference-bearer-key"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

export function constantTimeEquals(a: string, b: string) {
  const left = new Uint8Array(Buffer.from(a))
  const right = new Uint8Array(Buffer.from(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function findActiveInferenceKey(key: InferenceBearerKey) {
  if (key.value.startsWith("ow_gw_")) return null
  const keyHashes = await inferenceBearerKeyLookupDigests(key)
  const [row] = await db
    .select({ inferenceKey: InferenceKeyTable })
    .from(InferenceKeyTable)
    .innerJoin(MemberTable, eq(InferenceKeyTable.org_membership_id, MemberTable.id))
    .where(and(
      inArray(InferenceKeyTable.key_hash, keyHashes),
      eq(InferenceKeyTable.status, "active"),
      eq(MemberTable.organizationId, InferenceKeyTable.organization_id),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  if (!row) {
    return null
  }
  return row.inferenceKey
}

export async function assertOrganizationManagedModelsAllowed(organizationId: string): Promise<void> {
  try {
    const [organization] = await db.select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
      .limit(1)
    if (!organization) throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
    assertManagedModelsAllowed(organization.metadata)
  } catch (error) {
    if (error instanceof ManagedModelsPolicyError) throw error
    throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
  }
}

export async function findActiveGatewayKey(key: GatewayBearerKey) {
  const digest = await gatewayBearerKeyLookupDigest(key)
  const [row] = await db.select({
    id: GatewayKeyTable.id,
    organization_id: GatewayKeyTable.organization_id,
    org_membership_id: GatewayKeyTable.org_membership_id,
  }).from(GatewayKeyTable)
    .innerJoin(MemberTable, and(eq(MemberTable.id, GatewayKeyTable.org_membership_id), eq(MemberTable.organizationId, GatewayKeyTable.organization_id)))
    .where(and(eq(GatewayKeyTable.key_hash, digest), eq(GatewayKeyTable.status, "active"), isNull(GatewayKeyTable.revoked_at),
      isNull(MemberTable.removedAt), isNotNull(MemberTable.userId)))
    .limit(1)
  return row ?? null
}

export async function getOpenRouterProviderKey(organizationId: string) {
  const rows = await db.select().from(InferenceOrgUpstreamProviderKeyTable)
    .where(and(
      eq(InferenceOrgUpstreamProviderKeyTable.organization_id, normalizeDenTypeId("organization", organizationId)),
      eq(InferenceOrgUpstreamProviderKeyTable.provider, "openrouter"),
      eq(InferenceOrgUpstreamProviderKeyTable.status, "active"),
    ))
    .limit(1)
  return rows[0] ?? null
}
