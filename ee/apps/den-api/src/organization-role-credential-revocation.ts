import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { revokeOrganizationApiKeysForMember } from "./api-keys.js"
import { revokeMembershipSessionCredentials } from "./credential-revocation.js"
import { db } from "./db.js"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId

export type OrganizationRoleCredentialRevocationCounts = {
  members: number
  apiKeys: number
  sessions: number
  oauthAccessTokens: number
  oauthRefreshTokens: number
}

function splitRoleValue(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export async function revokeCredentialsForOrganizationRoleMembers(input: {
  organizationId: OrganizationId
  role: string
}): Promise<OrganizationRoleCredentialRevocationCounts> {
  const members = await db
    .select({
      id: MemberTable.id,
      role: MemberTable.role,
      userId: MemberTable.userId,
    })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))

  const counts: OrganizationRoleCredentialRevocationCounts = {
    members: 0,
    apiKeys: 0,
    sessions: 0,
    oauthAccessTokens: 0,
    oauthRefreshTokens: 0,
  }

  for (const member of members) {
    if (!splitRoleValue(member.role).includes(input.role)) {
      continue
    }

    counts.members += 1
    counts.apiKeys += await revokeOrganizationApiKeysForMember({
      organizationId: input.organizationId,
      orgMembershipId: member.id,
      userId: member.userId,
    })

    const credentials = await revokeMembershipSessionCredentials({
      organizationId: input.organizationId,
      userId: member.userId,
    })
    counts.sessions += credentials.sessions
    counts.oauthAccessTokens += credentials.oauthAccessTokens
    counts.oauthRefreshTokens += credentials.oauthRefreshTokens
  }

  return counts
}
