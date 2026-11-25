import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { OpenWorkWebAccessRequiredError } from "./openwork-web-access-error.js"
import { getOpenWorkWebAccess } from "./stripe-billing.js"

export {
  OPENWORK_WEB_ACCESS_REQUIRED_CODE,
  OPENWORK_WEB_ACCESS_REQUIRED_MESSAGE,
  OpenWorkWebAccessRequiredError,
  openWorkWebAccessRequiredPayload,
} from "./openwork-web-access-error.js"

export type OpenWorkWebRuntimeAccess = {
  hasAccess: boolean
}

export type OpenWorkWebMember = { userId: string } | { memberId: string }

export type OpenWorkWebRuntimeAccessResolver = (
  organizationId: string,
  member?: OpenWorkWebMember,
) => Promise<OpenWorkWebRuntimeAccess>

export async function memberHasOpenWorkWeb(organizationId: string, member: OpenWorkWebMember) {
  const orgId = normalizeDenTypeId("organization", organizationId)
  const memberCondition = "memberId" in member
    ? eq(MemberTable.id, normalizeDenTypeId("member", member.memberId))
    : eq(MemberTable.userId, normalizeDenTypeId("user", member.userId))
  const rows = await db
    .select({ openworkWeb: MemberTable.openworkWeb })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, orgId), memberCondition, isNull(MemberTable.removedAt)))
    .limit(1)
  return rows[0]?.openworkWeb === true
}

export const getOpenWorkWebRuntimeAccess: OpenWorkWebRuntimeAccessResolver = async (organizationId, member) => {
  const [access, assigned] = await Promise.all([
    getOpenWorkWebAccess(normalizeDenTypeId("organization", organizationId)),
    member ? memberHasOpenWorkWeb(organizationId, member) : Promise.resolve(true),
  ])
  return { hasAccess: access.hasAccess && assigned }
}

export async function requireOpenWorkWebRuntimeAccess(
  organizationId: string,
  resolveAccess: OpenWorkWebRuntimeAccessResolver = getOpenWorkWebRuntimeAccess,
  member?: OpenWorkWebMember,
) {
  const access = await resolveAccess(organizationId, member)
  if (!access.hasAccess) {
    throw new OpenWorkWebAccessRequiredError()
  }
  return access
}
