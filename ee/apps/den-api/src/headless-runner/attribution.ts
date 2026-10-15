import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { HeadlessRunnerActor, ModelAttribution } from "@openwork-ee/headless-protocol"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"

type AttributionDeps = {
  enabled: (organizationId: string) => Promise<boolean>
  member: (actor: HeadlessRunnerActor) => Promise<{ memberId: string; email: string } | undefined>
}

async function readMember({ organizationId, userId }: HeadlessRunnerActor) {
  const [member] = await db.select({ memberId: MemberTable.id, email: AuthUserTable.email })
    .from(MemberTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.organizationId, normalizeDenTypeId("organization", organizationId)), eq(MemberTable.userId, normalizeDenTypeId("user", userId)), isNull(MemberTable.removedAt)))
    .limit(1)
  return member
}

/** Resolve from authoritative membership, never from a request's claimed member id or email. */
export async function headlessModelAttribution(actor: HeadlessRunnerActor, deps: AttributionDeps = {
  enabled: (organizationId) => organizationFeatureEnabled(organizationId, "headlessModelAttribution"),
  member: readMember,
}): Promise<ModelAttribution | undefined> {
  if (!(await deps.enabled(actor.organizationId))) return undefined
  const organizationId = normalizeDenTypeId("organization", actor.organizationId)
  const userId = normalizeDenTypeId("user", actor.userId)
  const member = await deps.member({ organizationId, userId })
  if (!member) throw new Error("Headless attribution requires an active membership")
  // Non-ASCII email addresses are valid accounts, but not HTTP header values. Omit rather than changing identity.
  const email = /^[\x21-\x7e]{1,512}$/.test(member.email) ? member.email : undefined
  return { memberId: member.memberId, userId, organizationId, ...(email ? { email } : {}) }
}
