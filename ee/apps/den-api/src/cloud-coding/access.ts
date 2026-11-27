import { and, eq, inArray, isNotNull } from "@openwork-ee/den-db/drizzle"
import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import { CloudCodingAccessGrantTable as Grants, CloudCodingInstallationTable as Installations, MemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId } from "@openwork-ee/utils/typeid"
import type { CloudCodingAccess, CloudCodingReadiness } from "@openwork/types/den/cloud-coding"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"
import { listTeamsForMember } from "../member-teams.js"
import { peopleMemberCondition } from "../setup-agent-members.js"
import { cloudCodingAppConfig } from "./config.js"
import { getCloudCodingInstallation, type CloudCodingInstallationRow } from "./installation.js"
import { getMemberGithubLink, type CloudCodingMemberScope } from "./links.js"

export type CloudCodingReadinessResult = { readiness: Exclude<CloudCodingReadiness, "ready"> } | {
  readiness: "ready"
  installation: CloudCodingInstallationRow
  link: { githubUserId: number; githubLogin: string; githubName: string | null; commitEmail: string; authorName: string }
}

export async function readAccess(installation: CloudCodingInstallationRow | null): Promise<CloudCodingAccess> {
  if (!installation) return { orgWide: true, memberIds: [], teamIds: [] }
  const rows = await db.$primary.select().from(Grants).where(eq(Grants.organizationId, installation.organizationId))
  return { orgWide: installation.accessOrgWide, memberIds: rows.flatMap(row => row.orgMembershipId ? [row.orgMembershipId] : []), teamIds: rows.flatMap(row => row.teamId ? [row.teamId] : []) }
}

export async function memberCanUseCloudCoding(input: CloudCodingMemberScope, access?: CloudCodingAccess): Promise<boolean> {
  if (!access) {
    const installation = await getCloudCodingInstallation(input.organizationId)
    if (!installation) return false
    access = await readAccess(installation)
  }
  if (access.orgWide || access.memberIds.includes(input.memberId)) return true
  return access.teamIds.length > 0 && (await listTeamsForMember(input)).some(team => access?.teamIds.includes(team.id))
}

export async function writeAccess(tx: AuditTx, input: CloudCodingMemberScope & { access: CloudCodingAccess }): Promise<boolean> {
  const { organizationId, memberId, access } = input
  const memberIds = [...new Set(access.memberIds)].filter(id => isDenTypeId("member", id))
  const teamIds = [...new Set(access.teamIds)].filter(id => isDenTypeId("team", id))
  if (memberIds.length !== new Set(access.memberIds).size || teamIds.length !== new Set(access.teamIds).size) return false
  const people = memberIds.length ? await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.organizationId, organizationId), inArray(MemberTable.id, memberIds), isNotNull(MemberTable.userId), peopleMemberCondition(),
  )).for("share") : []
  const teams = teamIds.length ? await tx.select({ id: TeamTable.id }).from(TeamTable).where(and(eq(TeamTable.organizationId, organizationId), inArray(TeamTable.id, teamIds))).for("share") : []
  if (people.length !== memberIds.length || teams.length !== teamIds.length) return false
  await tx.update(Installations).set({ accessOrgWide: access.orgWide }).where(eq(Installations.organizationId, organizationId))
  await tx.delete(Grants).where(eq(Grants.organizationId, organizationId))
  const values = [
    ...memberIds.map(orgMembershipId => ({ orgMembershipId, teamId: null })),
    ...teamIds.map(teamId => ({ teamId, orgMembershipId: null })),
  ].map(grant => ({ ...grant, id: createDenTypeId("cloudCodingAccessGrant"), organizationId, createdByOrgMembershipId: memberId }))
  if (values.length) await tx.insert(Grants).values(values)
  return true
}

export async function getCloudCodingReadiness(input: CloudCodingMemberScope & { userId: string }): Promise<CloudCodingReadinessResult> {
  if (!await organizationFeatureEnabled(input.organizationId, "cloudCoding", { userId: input.userId })) return { readiness: "feature_disabled" }
  if (!cloudCodingAppConfig()) return { readiness: "not_configured" }
  const installation = await getCloudCodingInstallation(input.organizationId)
  if (!installation) return { readiness: "github_not_connected" }
  if (!installation.enabled) return { readiness: "turned_off" }
  if (!await memberCanUseCloudCoding(input, await readAccess(installation))) return { readiness: "not_allowed" }
  if (installation.suspendedAt) return { readiness: "github_suspended" }
  const link = await getMemberGithubLink(input)
  if (!link) return { readiness: "account_not_linked" }
  return { readiness: "ready", installation, link: { githubUserId: link.githubUserId, githubLogin: link.githubLogin, githubName: link.githubName, commitEmail: link.commitEmail, authorName: link.githubName || link.githubLogin } }
}
