import { and, eq, isNull } from "drizzle-orm"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { FeatureDatabase } from "./organization-features"
import { FundedModelSuspensionTable as Holds } from "./schema/inference"
import { MemberTable } from "./schema/org"
import { SandboxOrganizationTable } from "./schema/sandbox-organizations"

export async function fundedUserSuspended(primary: FeatureDatabase, userId: string) {
  const [row] = await primary.select({ id: Holds.reference_hash }).from(Holds)
    .where(and(eq(Holds.user_id, normalizeDenTypeId("user", userId)), isNull(Holds.released_at))).limit(1)
  return Boolean(row)
}

export type FundedRoute = { kind: "managed" } | { kind: "sandbox"; credentialSetId?: string }

export async function fundedMemberSuspended(primary: FeatureDatabase, identity: { organizationId: string; orgMembershipId: string | null }, route: FundedRoute) {
  const organizationId = normalizeDenTypeId("organization", identity.organizationId)
  if (route.kind === "sandbox") {
    const [sandbox] = await primary.select({ set: SandboxOrganizationTable.sponsoredSetId }).from(SandboxOrganizationTable)
      .where(eq(SandboxOrganizationTable.organizationId, organizationId)).limit(1)
    if (!sandbox || (route.credentialSetId && sandbox.set && route.credentialSetId !== sandbox.set)) return false
  }
  if (!identity.orgMembershipId) throw new Error("funded_model_identity_unavailable")
  const [member] = await primary.select({ userId: MemberTable.userId }).from(MemberTable)
    .where(and(eq(MemberTable.id, normalizeDenTypeId("member", identity.orgMembershipId)), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt))).limit(1)
  if (!member?.userId) throw new Error("funded_model_identity_unavailable")
  return fundedUserSuspended(primary, member.userId)
}
