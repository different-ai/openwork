import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { OrgPromptAccessTable, OrgPromptTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  resolveMemberPrompts,
  type MemberPrompt,
  type OrgPrompt,
  type OrgPromptSettings,
  type ResolvablePrompt,
} from "@openwork/types/den/prompts"
import { db } from "./db.js"

type OrganizationId = DenTypeId<"organization">
type TeamId = DenTypeId<"team">
type MemberId = DenTypeId<"member">
type Database = typeof db | Parameters<Parameters<typeof db["transaction"]>[0]>[0]

/** Where the Den web UI keeps a prompt: the Everyone page or one team's page. */
export type PromptScope = { kind: "everyone" } | { kind: "team"; teamId: TeamId; teamName: string }

type PromptRow = typeof OrgPromptTable.$inferSelect
type AccessRow = typeof OrgPromptAccessTable.$inferSelect

type StoredPrompt = ResolvablePrompt & { row: PromptRow }

function toStoredPrompts(rows: PromptRow[], access: AccessRow[]): StoredPrompt[] {
  return rows.map((row) => {
    const grants = access.filter((grant) => grant.promptId === row.id)
    return {
      id: row.id,
      content: row.content,
      createdAt: row.createdAt,
      row,
      assignment: {
        everyone: grants.some((grant) => grant.orgWide),
        teamIds: grants.flatMap((grant) => grant.teamId ? [grant.teamId] : []),
        memberIds: grants.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : []),
      },
    }
  }).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
}

async function readOrganizationPrompts(database: Database, organizationId: OrganizationId): Promise<StoredPrompt[]> {
  // Sequential on purpose: saves and removals call this inside a transaction,
  // and a PlanetScale transaction runs one query at a time; overlapping queries
  // fail with "transaction ... in use" (a 500).
  const rows = await database.select().from(OrgPromptTable).where(eq(OrgPromptTable.organizationId, organizationId))
  const access = await database.select().from(OrgPromptAccessTable).where(eq(OrgPromptAccessTable.organizationId, organizationId))
  return toStoredPrompts(rows, access)
}

function serializePrompt(prompt: StoredPrompt): OrgPrompt {
  return {
    id: prompt.id,
    name: prompt.row.name,
    content: prompt.content,
    assignment: prompt.assignment,
    updatedAt: prompt.row.updatedAt.toISOString(),
  }
}

/** The prompt a scope's page edits: the oldest one assigned to everyone, or to the team and not to everyone. */
function scopePrompt(prompts: StoredPrompt[], scope: { kind: "everyone" } | { kind: "team"; teamId: string }): StoredPrompt | null {
  return prompts.find((prompt) => scope.kind === "everyone"
    ? prompt.assignment.everyone
    : !prompt.assignment.everyone && prompt.assignment.teamIds.includes(scope.teamId)) ?? null
}

/** The prompt for everyone and each team's own prompt, teams by name. */
export async function listPromptSettings(organizationId: OrganizationId): Promise<Omit<OrgPromptSettings, "canEdit">> {
  const [prompts, teams] = await Promise.all([
    readOrganizationPrompts(db, organizationId),
    db.select({ id: TeamTable.id, name: TeamTable.name }).from(TeamTable).where(eq(TeamTable.organizationId, organizationId)).orderBy(asc(TeamTable.name)),
  ])
  const everyone = scopePrompt(prompts, { kind: "everyone" })
  return {
    everyone: everyone ? serializePrompt(everyone) : null,
    teams: teams.map((team) => {
      const prompt = scopePrompt(prompts, { kind: "team", teamId: team.id })
      return { teamId: team.id, name: team.name, prompt: prompt ? serializePrompt(prompt) : null }
    }),
  }
}

export async function findOrganizationTeamForPrompt(organizationId: OrganizationId, teamId: TeamId) {
  const [team] = await db
    .select({ id: TeamTable.id, name: TeamTable.name })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamTable.id, teamId)))
    .limit(1)
  return team ?? null
}

function scopeName(scope: PromptScope): string {
  return scope.kind === "everyone" ? "Everyone" : scope.teamName
}

/**
 * Sets the scope's prompt text. The first save creates the prompt and assigns
 * it to the scope (everyone, or the team); later saves update that prompt.
 */
export async function savePromptForScope(input: {
  organizationId: OrganizationId
  scope: PromptScope
  content: string
  updatedByOrgMemberId: MemberId
}): Promise<void> {
  const now = new Date()
  await db.transaction(async (tx) => {
    // Lock the organization's prompts so two first saves of one scope cannot both create one.
    await tx.select({ id: OrgPromptTable.id }).from(OrgPromptTable).where(eq(OrgPromptTable.organizationId, input.organizationId)).for("update")
    const existing = scopePrompt(await readOrganizationPrompts(tx, input.organizationId), input.scope)
    if (existing) {
      await tx
        .update(OrgPromptTable)
        .set({ content: input.content, name: scopeName(input.scope), updatedByOrgMemberId: input.updatedByOrgMemberId, updatedAt: now })
        .where(eq(OrgPromptTable.id, existing.row.id))
      return
    }
    const promptId = createDenTypeId("orgPrompt")
    await tx.insert(OrgPromptTable).values({
      id: promptId,
      organizationId: input.organizationId,
      name: scopeName(input.scope),
      content: input.content,
      createdByOrgMemberId: input.updatedByOrgMemberId,
      updatedByOrgMemberId: input.updatedByOrgMemberId,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(OrgPromptAccessTable).values({
      id: createDenTypeId("orgPromptAccess"),
      organizationId: input.organizationId,
      promptId,
      orgWide: input.scope.kind === "everyone",
      teamId: input.scope.kind === "team" ? input.scope.teamId : null,
      orgMembershipId: null,
      createdAt: now,
    })
  })
}

/** Removes the scope's prompt; false when it had none. */
export async function removePromptForScope(input: { organizationId: OrganizationId; scope: PromptScope }): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.select({ id: OrgPromptTable.id }).from(OrgPromptTable).where(eq(OrgPromptTable.organizationId, input.organizationId)).for("update")
    const existing = scopePrompt(await readOrganizationPrompts(tx, input.organizationId), input.scope)
    if (!existing) return false
    const promptId = existing.row.id
    await tx.delete(OrgPromptAccessTable).where(eq(OrgPromptAccessTable.promptId, promptId))
    await tx.delete(OrgPromptTable).where(eq(OrgPromptTable.id, promptId))
    return true
  })
}

/** Removes a team's assignments inside the transaction that deletes the team, and prompts left assigned to no one. */
export async function deleteTeamPrompts(database: Database, teamId: TeamId): Promise<void> {
  const grants = await database.select({ promptId: OrgPromptAccessTable.promptId }).from(OrgPromptAccessTable).where(eq(OrgPromptAccessTable.teamId, teamId))
  if (grants.length === 0) return
  await database.delete(OrgPromptAccessTable).where(eq(OrgPromptAccessTable.teamId, teamId))
  const promptIds = [...new Set(grants.map((grant) => grant.promptId))]
  const stillAssigned = await database
    .select({ promptId: OrgPromptAccessTable.promptId })
    .from(OrgPromptAccessTable)
    .where(inArray(OrgPromptAccessTable.promptId, promptIds))
  const keep = new Set(stillAssigned.map((grant) => grant.promptId))
  const orphaned = promptIds.filter((id) => !keep.has(id))
  if (orphaned.length > 0) await database.delete(OrgPromptTable).where(inArray(OrgPromptTable.id, orphaned))
}

/** Removes every prompt of an organization inside the transaction that deletes it. */
export async function deleteOrganizationPrompts(database: Database, organizationId: OrganizationId): Promise<void> {
  await database.delete(OrgPromptAccessTable).where(eq(OrgPromptAccessTable.organizationId, organizationId))
  await database.delete(OrgPromptTable).where(eq(OrgPromptTable.organizationId, organizationId))
}

/** The prompts that apply to one member, in the order their desktop appends them. */
export async function readPromptsForMember(input: { organizationId: OrganizationId; memberId: MemberId }): Promise<MemberPrompt[]> {
  const prompts = await readOrganizationPrompts(db, input.organizationId)
  if (prompts.length === 0) return []
  const teams = await db
    .select({ id: TeamTable.id, name: TeamTable.name })
    .from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(eq(TeamTable.organizationId, input.organizationId), eq(TeamMemberTable.orgMembershipId, input.memberId)))
  return resolveMemberPrompts({ prompts, memberId: input.memberId, teams })
}
