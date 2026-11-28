import { and, asc, eq, inArray, sql } from "@openwork-ee/den-db/drizzle"
import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import { CloudCodingInstallationTable as Installations, CloudCodingRepositoryTable as Repositories, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { peopleMemberCondition } from "../setup-agent-members.js"
import { cloudCodingAppConfig, type CloudCodingAppConfig } from "./config.js"
import { CloudCodingGithubError, createInstallationToken, getInstallation, getRepositoryById, listInstallationRepositories, type CloudCodingGithubInstallation, type CloudCodingGithubRepository } from "./github-api.js"

export type CloudCodingInstallationRow = typeof Installations.$inferSelect
export type CloudCodingRepositoryRow = typeof Repositories.$inferSelect
type OrgId = DenTypeId<"organization">
type InstallationHook = (tx: AuditTx, row: CloudCodingInstallationRow) => Promise<unknown>
type RepoScope = { organizationId: OrgId; githubRepositoryId: number }

export function duplicateCloudCodingEntry(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (("code" in current && current.code === "ER_DUP_ENTRY") || ("errno" in current && current.errno === 1062) || /Duplicate entry|errno 1062/.test(current.message)) return true
  }
  return false
}

export async function getCloudCodingInstallation(organizationId: OrgId): Promise<CloudCodingInstallationRow | null> {
  const [row] = await db.$primary.select().from(Installations).where(eq(Installations.organizationId, organizationId)).limit(1)
  return row ?? null
}

export async function getCloudCodingInstallationByGithubId(id: number): Promise<CloudCodingInstallationRow | null> {
  const [row] = await db.$primary.select().from(Installations).where(eq(Installations.githubInstallationId, id)).limit(1)
  return row ?? null
}

export async function availableCloudCodingInstallations(organizationId: OrgId, choices: CloudCodingGithubInstallation[]) {
  if (!choices.length) return []
  const rows = await db.$primary.select().from(Installations).where(inArray(Installations.githubInstallationId, choices.map(row => row.id)))
  const boundElsewhere = new Set(rows.filter(row => row.organizationId !== organizationId).map(row => row.githubInstallationId))
  return choices.filter(row => !boundElsewhere.has(row.id))
}

export function listCloudCodingRepositories(organizationId: OrgId): Promise<CloudCodingRepositoryRow[]> {
  return db.$primary.select().from(Repositories).where(eq(Repositories.organizationId, organizationId)).orderBy(asc(Repositories.fullName))
}

export async function findCloudCodingRepository({ organizationId, fullName }: { organizationId: OrgId; fullName: string }): Promise<CloudCodingRepositoryRow | null> {
  const name = fullName.toLowerCase()
  const matches = (await listCloudCodingRepositories(organizationId)).filter(row => {
    const candidate = row.fullName.toLowerCase()
    return name.includes("/") ? candidate === name : candidate.split("/").at(-1) === name
  })
  return matches.length === 1 ? matches[0] ?? null : null
}

function installationFields(installation: CloudCodingGithubInstallation) {
  return {
    accountId: installation.account.id, accountLogin: installation.account.login, accountType: installation.account.type,
    repositorySelection: installation.repository_selection, suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
  }
}

async function readMirror(config: CloudCodingAppConfig, installation: CloudCodingGithubInstallation) {
  if (installation.suspended_at) return null
  const { token } = await createInstallationToken({ config, installationId: installation.id, permissions: { metadata: "read" } })
  return listInstallationRepositories({ config, token })
}

async function writeMirror(tx: AuditTx, row: CloudCodingInstallationRow, repositories: CloudCodingGithubRepository[]) {
  if (repositories.length) {
    const values = repositories.map(repo => ({
      id: createDenTypeId("cloudCodingRepository"), organizationId: row.organizationId, installationId: row.id,
      githubRepositoryId: repo.id, fullName: repo.full_name, defaultBranch: repo.default_branch, isPrivate: repo.private,
    }))
    for (let start = 0; start < values.length; start += 500) {
      await tx.insert(Repositories).values(values.slice(start, start + 500)).onDuplicateKeyUpdate({ set: {
        fullName: sql`VALUES(full_name)`, defaultBranch: sql`VALUES(default_branch)`, isPrivate: sql`VALUES(is_private)`,
      } })
    }
  }
  await tx.delete(Repositories).where(and(eq(Repositories.installationId, row.id),
    repositories.length ? sql`NOT (${inArray(Repositories.githubRepositoryId, repositories.map(repo => repo.id))})` : undefined))
}

async function deleteInstallation(tx: AuditTx, row: CloudCodingInstallationRow) {
  await tx.delete(Repositories).where(eq(Repositories.installationId, row.id))
  await tx.delete(Installations).where(eq(Installations.id, row.id))
}

export async function removeCloudCodingInstallation(row: CloudCodingInstallationRow, onDisconnected?: InstallationHook): Promise<void> {
  await db.transaction(async tx => {
    const [current] = await tx.select().from(Installations).where(eq(Installations.id, row.id)).for("update")
    if (!current) return
    await deleteInstallation(tx, current)
    await onDisconnected?.(tx, current)
  })
}

export async function bindCloudCodingInstallation(input: { organizationId: OrgId; memberId: DenTypeId<"member">; installation: CloudCodingGithubInstallation; onConnected?: InstallationHook; onDisconnected?: InstallationHook }): Promise<{ ok: true; installation: CloudCodingInstallationRow } | { ok: false; error: "installation_in_use" | "not_allowed" }> {
  const config = cloudCodingAppConfig()
  if (!config) throw new CloudCodingGithubError(503)
  const remote = await getInstallation({ config, installationId: input.installation.id })
  const repositories = await readMirror(config, remote)
  try {
    return await db.transaction(async tx => {
      const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(
        eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), peopleMemberCondition(),
      )).for("share")
      if (!member) return { ok: false, error: "not_allowed" }
      const [organization] = await tx.select({ id: OrganizationTable.id }).from(OrganizationTable)
        .where(eq(OrganizationTable.id, input.organizationId)).for("update")
      if (!organization) return { ok: false, error: "not_allowed" }
      const [existing] = await tx.select({ id: Installations.id }).from(Installations)
        .where(eq(Installations.organizationId, input.organizationId))
      const [old] = existing ? await tx.select().from(Installations).where(eq(Installations.id, existing.id)).for("update") : []
      const fields = installationFields(remote)
      if (old?.githubInstallationId === remote.id) {
        await tx.update(Installations).set(fields).where(eq(Installations.id, old.id))
        const installation = { ...old, ...fields }
        if (repositories) await writeMirror(tx, installation, repositories)
        return { ok: true, installation }
      }
      if (old) {
        await deleteInstallation(tx, old)
        await input.onDisconnected?.(tx, old)
      }
      const id = createDenTypeId("cloudCodingInstallation")
      await tx.insert(Installations).values({ id, organizationId: input.organizationId, githubInstallationId: remote.id, connectedByOrgMembershipId: input.memberId, ...fields })
      const [installation] = await tx.select().from(Installations).where(eq(Installations.id, id))
      if (!installation) throw new Error("Cloud coding connection could not be saved.")
      if (repositories) await writeMirror(tx, installation, repositories)
      await input.onConnected?.(tx, installation)
      return { ok: true, installation }
    })
  } catch (error) {
    if (duplicateCloudCodingEntry(error)) return { ok: false, error: "installation_in_use" }
    throw error
  }
}

export async function syncCloudCodingInstallation(organizationId: OrgId, onDisconnected?: InstallationHook): Promise<void> {
  const config = cloudCodingAppConfig()
  const row = await getCloudCodingInstallation(organizationId)
  if (!config || !row) return
  let remote: CloudCodingGithubInstallation
  try {
    remote = await getInstallation({ config, installationId: row.githubInstallationId })
  } catch (error) {
    if (!(error instanceof CloudCodingGithubError) || error.status !== 404) throw error
    await removeCloudCodingInstallation(row, onDisconnected)
    return
  }
  const repositories = await readMirror(config, remote)
  await db.transaction(async tx => {
    const [current] = await tx.select().from(Installations).where(eq(Installations.id, row.id)).for("update")
    if (!current) return
    await tx.update(Installations).set(installationFields(remote)).where(eq(Installations.id, current.id))
    if (repositories) await writeMirror(tx, current, repositories)
  })
}

export async function createRepositoryReadToken(input: RepoScope): Promise<{ token: string; expiresAt: string } | null> {
  const config = cloudCodingAppConfig()
  if (!config) return null
  const [repo] = await db.$primary.select({ installationId: Installations.githubInstallationId, suspendedAt: Installations.suspendedAt })
    .from(Repositories).innerJoin(Installations, and(eq(Installations.id, Repositories.installationId), eq(Installations.organizationId, Repositories.organizationId)))
    .where(and(eq(Repositories.organizationId, input.organizationId), eq(Repositories.githubRepositoryId, input.githubRepositoryId))).limit(1)
  if (!repo || repo.suspendedAt) return null
  return createInstallationToken({ config, installationId: repo.installationId, repositoryIds: [input.githubRepositoryId], permissions: { contents: "read", metadata: "read" } })
}

export async function readInstalledRepository(input: RepoScope): Promise<{ fullName: string; defaultBranch: string; archived: boolean } | null> {
  const config = cloudCodingAppConfig()
  if (!config) return null
  try {
    const credential = await createRepositoryReadToken(input)
    if (!credential) return null
    const repo = await getRepositoryById({ config, token: credential.token, repositoryId: input.githubRepositoryId })
    return { fullName: repo.full_name, defaultBranch: repo.default_branch, archived: repo.archived }
  } catch (error) {
    if (error instanceof CloudCodingGithubError && [403, 404].includes(error.status)) return null
    throw error
  }
}
