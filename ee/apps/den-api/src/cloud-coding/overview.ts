import { and, asc, count, desc, eq } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, CloudCodingGithubLinkTable as Links, CloudCodingPullRequestTable as Pulls } from "@openwork-ee/den-db/schema"
import type { CloudCodingOverview } from "@openwork/types/den/cloud-coding"
import { db } from "../db.js"
import { peopleMemberCondition } from "../setup-agent-members.js"
import { memberCanUseCloudCoding, readAccess } from "./access.js"
import { cloudCodingAppConfig } from "./config.js"
import { getCloudCodingInstallation, listCloudCodingRepositories } from "./installation.js"
import type { CloudCodingMemberScope } from "./links.js"

export async function cloudCodingOverview(input: CloudCodingMemberScope & { canManage: boolean }): Promise<CloudCodingOverview> {
  const { organizationId, memberId, canManage } = input
  const me = { memberId, canUse: false, github: null }
  const config = cloudCodingAppConfig()
  if (!config) return { configured: false, canManage, connection: null, enabled: false, access: await readAccess(null), people: [], repositories: [], pullRequests: [], me }
  const installation = await getCloudCodingInstallation(organizationId)
  const [access, people, repositories, pulls, counts] = await Promise.all([
    readAccess(installation),
    db.$primary.select({ memberId: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email, login: Links.githubLogin, linkedAt: Links.linkedAt })
      .from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .leftJoin(Links, and(eq(Links.organizationId, organizationId), eq(Links.orgMembershipId, MemberTable.id)))
      .where(and(eq(MemberTable.organizationId, organizationId), peopleMemberCondition())).orderBy(asc(AuthUserTable.name), asc(MemberTable.id)),
    listCloudCodingRepositories(organizationId),
    db.$primary.select().from(Pulls).where(eq(Pulls.organizationId, organizationId)).orderBy(desc(Pulls.openedAt), desc(Pulls.id)).limit(20),
    db.$primary.select({ id: Pulls.githubRepositoryId, total: count() }).from(Pulls).where(eq(Pulls.organizationId, organizationId)).groupBy(Pulls.githubRepositoryId),
  ])
  const countsByRepo = new Map(counts.map(row => [row.id, row.total]))
  const members = await Promise.all(people.map(async row => ({
    memberId: row.memberId, name: row.name, email: row.email, isYou: row.memberId === memberId,
    canUse: Boolean(installation?.enabled) && await memberCanUseCloudCoding({ organizationId, memberId: row.memberId }, access),
    github: row.login && row.linkedAt ? { login: row.login, linkedAt: row.linkedAt.toISOString() } : null,
  })))
  const own = members.find(row => row.isYou)
  return {
    configured: true, canManage, enabled: installation?.enabled ?? false, access,
    connection: installation ? {
      accountLogin: installation.accountLogin, accountType: installation.accountType, repositorySelection: installation.repositorySelection,
      settingsUrl: `${config.webBaseUrl}${installation.accountType === "Organization" ? `/organizations/${encodeURIComponent(installation.accountLogin)}` : ""}/settings/installations/${installation.githubInstallationId}`,
      connectedAt: installation.createdAt.toISOString(), suspended: installation.suspendedAt !== null,
    } : null,
    people: members,
    me: own ? { memberId, canUse: own.canUse, github: own.github } : me,
    repositories: repositories.map(row => ({ id: row.id, fullName: row.fullName, private: row.isPrivate, defaultBranch: row.defaultBranch, pullRequestCount: countsByRepo.get(row.githubRepositoryId) ?? 0 })),
    pullRequests: pulls.map(row => ({ id: row.id, title: row.title, repositoryFullName: row.repositoryFullName, number: row.number, url: row.url, state: row.state, openedBy: { memberId: row.openedByOrgMembershipId, name: row.openedByName }, openedAt: row.openedAt.toISOString() })),
  }
}
