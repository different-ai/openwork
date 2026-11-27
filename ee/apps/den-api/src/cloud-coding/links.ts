import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import { CloudCodingAccessGrantTable as Grants, CloudCodingGithubLinkTable as Links, CloudCodingInstallationTable as Installations, CloudCodingPushApprovalTable as Approvals, CloudCodingRepositoryTable as Repositories, CloudCodingPullRequestTable as PullRequests, CloudCodingTaskTable as Tasks, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { peopleMemberCondition } from "../setup-agent-members.js"
import { cloudCodingAppConfig } from "./config.js"
import { CloudCodingGithubError, refreshUserToken, revokeUserToken, type CloudCodingGithubUser, type CloudCodingOAuthToken } from "./github-api.js"
import { duplicateCloudCodingEntry } from "./installation.js"
import { closeCloudCodingTasksForMember } from "./tasks.js"

export type CloudCodingMemberScope = { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }
const identity = { githubUserId: Links.githubUserId, githubLogin: Links.githubLogin, githubName: Links.githubName, commitEmail: Links.commitEmail, linkedAt: Links.linkedAt }
export type CloudCodingMemberGithubLink = Pick<typeof Links.$inferSelect, keyof typeof identity>
type LinkHook = (tx: AuditTx, link: CloudCodingMemberGithubLink) => Promise<unknown>

function scope(input: CloudCodingMemberScope) {
  return and(eq(Links.organizationId, input.organizationId), eq(Links.orgMembershipId, input.memberId))
}

export async function getMemberGithubLink(input: CloudCodingMemberScope): Promise<CloudCodingMemberGithubLink | null> {
  const [row] = await db.$primary.select(identity).from(Links).where(scope(input)).limit(1)
  return row ?? null
}

function tokenFields(tokens: CloudCodingOAuthToken, now = Date.now()) {
  return {
    accessToken: tokens.access_token, accessTokenExpiresAt: new Date(now + tokens.expires_in * 1000),
    refreshToken: tokens.refresh_token, refreshTokenExpiresAt: new Date(now + tokens.refresh_token_expires_in * 1000),
  }
}

export async function saveMemberGithubLink(input: CloudCodingMemberScope & { user: CloudCodingGithubUser; tokens: CloudCodingOAuthToken; onLinked?: LinkHook }): Promise<{ ok: true; link: CloudCodingMemberGithubLink } | { ok: false; error: "account_in_use" | "not_allowed" }> {
  const { user } = input
  const link = { githubUserId: user.id, githubLogin: user.login, githubName: user.name, commitEmail: `${user.id}+${user.login}@users.noreply.github.com`, linkedAt: new Date() }
  const changes = { ...link, ...tokenFields(input.tokens) }
  try {
    return await db.transaction(async tx => {
      const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(
        eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), peopleMemberCondition(),
      )).for("update")
      if (!member) return { ok: false, error: "not_allowed" }
      const [existing] = await tx.select({ id: Links.id, githubUserId: Links.githubUserId }).from(Links).where(scope(input)).for("update")
      if (existing) {
        await tx.update(Links).set(changes).where(eq(Links.id, existing.id))
        if (existing.githubUserId !== user.id) await closeMemberTasks(tx, input, "account_unlinked")
      } else {
        await tx.insert(Links).values({ id: createDenTypeId("cloudCodingGithubLink"), organizationId: input.organizationId, orgMembershipId: input.memberId, ...changes })
      }
      await input.onLinked?.(tx, link)
      return { ok: true, link }
    })
  } catch (error) {
    if (duplicateCloudCodingEntry(error)) return { ok: false, error: "account_in_use" }
    throw error
  }
}

export async function getMemberGithubAccessToken(input: CloudCodingMemberScope): Promise<string | null> {
  const config = cloudCodingAppConfig()
  if (!config) return null
  return db.transaction(async tx => {
    const [link] = await tx.select().from(Links).where(scope(input)).for("update")
    if (!link) return null
    const now = Date.now()
    if (!link.accessTokenExpiresAt || link.accessTokenExpiresAt.getTime() > now + 300_000) return link.accessToken
    if (link.refreshToken && (!link.refreshTokenExpiresAt || link.refreshTokenExpiresAt.getTime() > now)) {
      try {
        const tokens = await refreshUserToken({ config, refreshToken: link.refreshToken })
        await tx.update(Links).set(tokenFields(tokens)).where(eq(Links.id, link.id))
        return tokens.access_token
      } catch (error) {
        if (!(error instanceof CloudCodingGithubError) || ![400, 401, 403, 422].includes(error.status)) throw error
      }
    }
    await tx.delete(Links).where(eq(Links.id, link.id))
    await closeMemberTasks(tx, input, "account_unlinked")
    return null
  })
}

export async function revokeCloudCodingTokens(tokens: readonly string[]): Promise<void> {
  const config = cloudCodingAppConfig()
  if (config) await Promise.allSettled(tokens.map(accessToken => revokeUserToken({ config, accessToken })))
}

async function deleteLink(tx: AuditTx, input: CloudCodingMemberScope, onUnlinked?: LinkHook) {
  const [link] = await tx.select().from(Links).where(scope(input)).for("update")
  if (!link) return []
  await tx.delete(Links).where(eq(Links.id, link.id))
  await onUnlinked?.(tx, link)
  return [link.accessToken]
}

async function closeMemberTasks(tx: AuditTx, input: CloudCodingMemberScope, failureCode: string) {
  await tx.update(Tasks).set({ status: "cancelled", failureCode, tokenHash: null, setupCodeHash: null }).where(and(
    eq(Tasks.organizationId, input.organizationId), eq(Tasks.orgMembershipId, input.memberId), inArray(Tasks.status, ["created", "running", "awaiting_approval", "pushed"]),
  ))
  await tx.update(Approvals).set({ status: "expired" }).where(and(
    eq(Approvals.organizationId, input.organizationId), eq(Approvals.orgMembershipId, input.memberId), inArray(Approvals.status, ["pending", "approved"]),
  ))
}

export async function removeMemberGithubLink(input: CloudCodingMemberScope, onUnlinked?: LinkHook): Promise<void> {
  const tokens = await db.transaction(async tx => {
    const tokens = await deleteLink(tx, input, onUnlinked)
    await closeMemberTasks(tx, input, "account_unlinked")
    return tokens
  })
  await revokeCloudCodingTokens(tokens)
}

export async function removeGithubLinksForGithubUser(githubUserId: number): Promise<void> {
  const links = await db.transaction(async tx => {
    const links = await tx.select({ organizationId: Links.organizationId, memberId: Links.orgMembershipId }).from(Links).where(eq(Links.githubUserId, githubUserId)).for("update")
    await tx.delete(Links).where(eq(Links.githubUserId, githubUserId))
    return links
  })
  await Promise.all(links.map(link => closeCloudCodingTasksForMember({ ...link, failureCode: "account_unlinked" })))
}

export async function deleteCloudCodingMemberData(input: CloudCodingMemberScope, tx?: AuditTx): Promise<string[]> {
  const remove = async (transaction: AuditTx) => {
    const tokens = await deleteLink(transaction, input)
    await transaction.delete(Grants).where(and(eq(Grants.organizationId, input.organizationId), eq(Grants.orgMembershipId, input.memberId)))
    await closeMemberTasks(transaction, input, "not_allowed")
    return tokens
  }
  if (tx) return remove(tx)
  await revokeCloudCodingTokens(await db.transaction(remove))
  return []
}

export async function deleteCloudCodingOrganizationData(organizationId: DenTypeId<"organization">, tx: AuditTx): Promise<string[]> {
  const links = await tx.select({ token: Links.accessToken }).from(Links).where(eq(Links.organizationId, organizationId)).for("update")
  await tx.delete(Links).where(eq(Links.organizationId, organizationId))
  await tx.delete(Grants).where(eq(Grants.organizationId, organizationId))
  await tx.delete(Repositories).where(eq(Repositories.organizationId, organizationId))
  await tx.delete(Installations).where(eq(Installations.organizationId, organizationId))
  await tx.delete(PullRequests).where(eq(PullRequests.organizationId, organizationId))
  await tx.update(Tasks).set({ status: "cancelled", failureCode: "not_allowed", tokenHash: null, setupCodeHash: null }).where(and(eq(Tasks.organizationId, organizationId), inArray(Tasks.status, ["created", "running", "awaiting_approval", "pushed"])))
  await tx.update(Approvals).set({ status: "expired" }).where(and(eq(Approvals.organizationId, organizationId), inArray(Approvals.status, ["pending", "approved"])))
  return links.map(row => row.token)
}
