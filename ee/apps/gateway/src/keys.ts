import { timingSafeEqual } from "node:crypto"
import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { GatewayKeyTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db"
import { findActiveInferenceKeyByBearer } from "@openwork-ee/den-db/inference-keys"
import { assertManagedModelsAllowed, ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { gatewayBearerKeyLookupDigest, type GatewayBearerKey } from "@openwork-ee/utils/gateway-bearer-key"
import type { InferenceBearerKey } from "@openwork-ee/utils/inference-bearer-key"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

export function constantTimeEquals(a: string, b: string) {
  const left = new Uint8Array(Buffer.from(a))
  const right = new Uint8Array(Buffer.from(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function findActiveInferenceKey(key: InferenceBearerKey) {
  if (key.value.startsWith("ow_gw_")) return null
  return findActiveInferenceKeyByBearer(db, key)
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

export async function findActiveGatewayKey(key: GatewayBearerKey): Promise<Pick<typeof GatewayKeyTable.$inferSelect, "id" | "organization_id" | "org_membership_id"> | null> {
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
