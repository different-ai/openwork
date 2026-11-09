/**
 * Config-blob area `members.prompts`: the system prompts on the Prompts tab
 * of Everyone and of each team.
 *
 * - One item per prompt (`org_prompt`), with its text and who it applies to
 *   (`org_prompt_access`): everyone, teams (refs to `members.teams`) and
 *   people (`people/<email>`). The dashboard makes one prompt per scope; a
 *   prompt assigned to several is carried as it is.
 * - The text is encrypted at rest because it is confidential, not a
 *   credential: it IS exported (decision D1), and the area says so.
 * - Matched by scope (Everyone, or the one team it is for) when it has one.
 * - Apply writes on `ctx.db` in one transaction, locking the organization's
 *   prompts as prompts.ts does: the text and name only when they changed, and
 *   one access row per assignment added or removed. Prompts record no domain
 *   audit change of their own (the routes rely on request evidence), so
 *   neither does the apply.
 */
import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { OrgPromptAccessTable, OrgPromptTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigApplyStep } from "@openwork/types/den/config-blobs"
import { ORG_PROMPT_MAX_LENGTH, orgPromptWriteSchema } from "@openwork/types/den/prompts"
import { z } from "zod"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import { applyFailure, asItemError, EVERYONE_SCOPE, requireActorPermission } from "./members-scope-support.js"
import {
  audienceRefs,
  isJsonObject,
  loadMemberEmails,
  loadTeamNames,
  resolvedRefIds,
  setSteps,
  specObject,
  specRefSchema,
  touches,
} from "./route-support.js"

const AREA = "members.prompts"

const specSchema = z.object({
  /** The prompt text members' agents follow. Confidential: encrypted at rest on both sides. */
  content: z.string().max(ORG_PROMPT_MAX_LENGTH).refine((value) => value.trim().length > 0, { message: "Write a prompt." }),
  assignment: z.object({
    everyone: z.boolean().default(false),
    teams: z.array(specRefSchema).max(500).default([]),
    members: z.array(specRefSchema).max(500).default([]),
  }).strict(),
}).strict()

type Assignment = { everyone: boolean; teamIds: string[]; memberIds: string[] }

async function readPrompts(ctx: ConfigAreaContext, ids?: string[]): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const promptIds = ids?.flatMap((id) => {
    try {
      return [normalizeDenTypeId("orgPrompt", id)]
    } catch {
      return []
    }
  })
  if (promptIds && promptIds.length === 0) return []
  const rows = await ctx.db
    .select({ id: OrgPromptTable.id, name: OrgPromptTable.name, content: OrgPromptTable.content, createdAt: OrgPromptTable.createdAt })
    .from(OrgPromptTable)
    .where(and(eq(OrgPromptTable.organizationId, organizationId), ...(promptIds ? [inArray(OrgPromptTable.id, promptIds)] : [])))
    .orderBy(asc(OrgPromptTable.createdAt), asc(OrgPromptTable.id))
  if (rows.length === 0) return []
  const access = await ctx.db
    .select({ promptId: OrgPromptAccessTable.promptId, orgWide: OrgPromptAccessTable.orgWide, teamId: OrgPromptAccessTable.teamId, memberId: OrgPromptAccessTable.orgMembershipId })
    .from(OrgPromptAccessTable)
    .where(and(eq(OrgPromptAccessTable.organizationId, organizationId), inArray(OrgPromptAccessTable.promptId, rows.map((row) => row.id))))
  const teamIds = access.flatMap((grant) => (grant.teamId ? [grant.teamId] : []))
  const memberIds = access.flatMap((grant) => (grant.memberId ? [grant.memberId] : []))
  const [teamNames, memberEmails] = await Promise.all([
    loadTeamNames(ctx.db, ctx.organizationId, teamIds),
    loadMemberEmails(ctx.db, ctx.organizationId, memberIds),
  ])
  return rows.map((row): ConfigItem => {
    const grants = access.filter((grant) => grant.promptId === row.id)
    const refs = audienceRefs({
      // Grants to a team or member that no longer exists are left out.
      teamIds: grants.flatMap((grant) => (grant.teamId && teamNames.has(grant.teamId) ? [grant.teamId] : [])),
      memberIds: grants.flatMap((grant) => (grant.memberId ? [grant.memberId] : [])),
      teamNames,
      memberEmails,
    })
    return {
      id: row.id,
      key: null,
      name: row.name,
      spec: { content: row.content, assignment: { everyone: grants.some((grant) => grant.orgWide), teams: refs.teams, members: refs.members } },
    }
  })
}

/** Everyone, or `team:<name>` for a prompt for exactly one team (how the dashboard makes them). */
function promptScopeKey(item: ConfigItem): string | null {
  const assignment = isJsonObject(item.spec.assignment) ? item.spec.assignment : {}
  const teams = Array.isArray(assignment.teams) ? assignment.teams : []
  const members = Array.isArray(assignment.members) ? assignment.members : []
  if (members.length > 0) return null
  if (assignment.everyone === true) return teams.length === 0 ? EVERYONE_SCOPE : null
  if (teams.length !== 1) return null
  const team = teams[0]
  const name = isJsonObject(team) && typeof team.name === "string" ? team.name : item.name
  return name.trim() ? `team:${name.trim().toLowerCase()}` : null
}

function parseApplySpec(spec: { [key: string]: unknown }, name: string): { content: string; assignment: Assignment } {
  const content = orgPromptWriteSchema.safeParse({ content: spec.content })
  if (!content.success) applyFailure({ code: "invalid_spec", message: `Prompt "${name}": ${content.error.issues[0]?.message ?? "the text is not valid."}`, field: "content" })
  const assignment = isJsonObject(spec.assignment) ? spec.assignment : {}
  if (assignment.everyone !== undefined && typeof assignment.everyone !== "boolean") {
    applyFailure({ code: "invalid_spec", message: "assignment.everyone must be true or false.", field: "assignment.everyone" })
  }
  let teamIds: string[]
  let memberIds: string[]
  try {
    teamIds = [...new Set(resolvedRefIds(assignment.teams, "assignment.teams").map((id) => normalizeDenTypeId("team", id)))]
    memberIds = [...new Set(resolvedRefIds(assignment.members, "assignment.members").map((id) => normalizeDenTypeId("member", id)))]
  } catch (error) {
    throw asItemError(error, [])
  }
  return { content: content.data.content, assignment: { everyone: assignment.everyone === true, teamIds, memberIds } }
}

type Tx = Parameters<Parameters<ConfigAreaContext["db"]["transaction"]>[0]>[0]

/** Locks the organization's prompts, as prompts.ts does before it writes one. */
async function lockPrompts(tx: Tx, organizationId: ReturnType<typeof normalizeDenTypeId<"organization">>) {
  await tx.select({ id: OrgPromptTable.id }).from(OrgPromptTable).where(eq(OrgPromptTable.organizationId, organizationId)).for("update")
}

async function readAccess(tx: Tx, promptId: ReturnType<typeof normalizeDenTypeId<"orgPrompt">>) {
  return tx
    .select({ id: OrgPromptAccessTable.id, orgWide: OrgPromptAccessTable.orgWide, teamId: OrgPromptAccessTable.teamId, memberId: OrgPromptAccessTable.orgMembershipId })
    .from(OrgPromptAccessTable)
    .where(eq(OrgPromptAccessTable.promptId, promptId))
}

function preferredPromptId(id: string | undefined) {
  if (!id) return undefined
  try {
    return normalizeDenTypeId("orgPrompt", id)
  } catch {
    return undefined
  }
}

export const membersPromptsArea = defineConfigArea({
  key: AREA,
  label: "Prompts",
  path: ["Members", "Teams", "Prompts"],
  idPrefix: denTypeIdPrefixes.orgPrompt,
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams", "members.people"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "prompts.view",
  managePermission: "prompts.manage",
  tables: ["org_prompt", "org_prompt_access"],
  naturalKeys: [{ label: "scope", get: promptScopeKey }],
  secretFields: [],
  containsConfidentialContent: true,
  // Every write goes through ctx.db in one transaction.
  transactional: true,
  irreversible: () => [],

  exportItems: (ctx) => readPrompts(ctx),
  readItems: (ctx, ids) => readPrompts(ctx, ids),

  async apply(ctx, op) {
    try {
      await requireActorPermission(ctx, "prompts.manage")
    } catch (error) {
      throw asItemError(error, [])
    }
    const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
    const memberId = normalizeDenTypeId("member", ctx.actor.memberId)
    const steps: ConfigApplyStep[] = []
    const now = new Date()

    if (op.kind === "delete") {
      const promptId = normalizeDenTypeId("orgPrompt", op.targetId)
      try {
        await ctx.db.transaction(async (tx) => {
          await lockPrompts(tx, organizationId)
          await tx.delete(OrgPromptAccessTable).where(eq(OrgPromptAccessTable.promptId, promptId))
          await tx.delete(OrgPromptTable).where(and(eq(OrgPromptTable.organizationId, organizationId), eq(OrgPromptTable.id, promptId)))
        })
      } catch (error) {
        throw asItemError(error, [])
      }
      return { localId: promptId, steps: [{ action: "delete", target: "prompt", detail: op.previous.name }] }
    }

    const name = op.item.name.trim().slice(0, 255)
    if (!name) applyFailure({ code: "invalid_spec", message: "A prompt needs a name." })
    const spec = parseApplySpec(specObject(op.item.spec), name)

    if (op.kind === "create") {
      const promptId = preferredPromptId(op.preferredId) ?? createDenTypeId("orgPrompt")
      const grants = [
        ...(spec.assignment.everyone ? [{ orgWide: true, teamId: null, orgMembershipId: null }] : []),
        ...spec.assignment.teamIds.map((teamId) => ({ orgWide: false, teamId: normalizeDenTypeId("team", teamId), orgMembershipId: null })),
        ...spec.assignment.memberIds.map((id) => ({ orgWide: false, teamId: null, orgMembershipId: normalizeDenTypeId("member", id) })),
      ]
      try {
        await ctx.db.transaction(async (tx) => {
          await lockPrompts(tx, organizationId)
          await tx.insert(OrgPromptTable).values({
            id: promptId,
            organizationId,
            name,
            content: spec.content,
            createdByOrgMemberId: memberId,
            updatedByOrgMemberId: memberId,
            createdAt: now,
            updatedAt: now,
          })
          if (grants.length > 0) {
            await tx.insert(OrgPromptAccessTable).values(grants.map((grant) => ({ id: createDenTypeId("orgPromptAccess"), organizationId, promptId, createdAt: now, ...grant })))
          }
        })
      } catch (error) {
        throw asItemError(error, [])
      }
      steps.push({ action: "create", target: "prompt", detail: name })
      steps.push(...setSteps("assignment", [
        ...(spec.assignment.everyone ? ["Everyone"] : []),
        ...spec.assignment.teamIds,
        ...spec.assignment.memberIds,
      ], []))
      return { localId: promptId, steps }
    }

    // update: only the fields the plan names.
    const promptId = normalizeDenTypeId("orgPrompt", op.targetId)
    const writeContent = touches(op.changes, "content")
    const writeEveryone = touches(op.changes, "assignment.everyone")
    const writeTeams = touches(op.changes, "assignment.teams")
    const writeMembers = touches(op.changes, "assignment.members")
    try {
      await ctx.db.transaction(async (tx) => {
        await lockPrompts(tx, organizationId)
        const [current] = await tx
          .select({ id: OrgPromptTable.id, name: OrgPromptTable.name, content: OrgPromptTable.content })
          .from(OrgPromptTable)
          .where(and(eq(OrgPromptTable.organizationId, organizationId), eq(OrgPromptTable.id, promptId)))
          .limit(1)
        if (!current) applyFailure({ code: "prompt_not_found", message: `Prompt "${op.previous.name}" no longer exists.`, status: 404 })

        const patch: { name?: string; content?: string } = {}
        if (current.name !== name) patch.name = name
        if (writeContent && current.content !== spec.content) patch.content = spec.content
        if (patch.name !== undefined || patch.content !== undefined) {
          await tx.update(OrgPromptTable).set({ ...patch, updatedByOrgMemberId: memberId, updatedAt: now }).where(eq(OrgPromptTable.id, promptId))
          if (patch.name !== undefined) steps.push({ action: "set", target: "name", detail: name })
          if (patch.content !== undefined) steps.push({ action: "update", target: "content", detail: `${spec.content.length} characters` })
        }

        if (!writeEveryone && !writeTeams && !writeMembers) return
        const access = await readAccess(tx, promptId)
        const insert = async (grant: { orgWide: boolean; teamId: string | null; orgMembershipId: string | null }) => {
          await tx.insert(OrgPromptAccessTable).values({
            id: createDenTypeId("orgPromptAccess"),
            organizationId,
            promptId,
            orgWide: grant.orgWide,
            teamId: grant.teamId ? normalizeDenTypeId("team", grant.teamId) : null,
            orgMembershipId: grant.orgMembershipId ? normalizeDenTypeId("member", grant.orgMembershipId) : null,
            createdAt: now,
          })
        }
        const removeRows = async (ids: string[]) => {
          if (ids.length > 0) await tx.delete(OrgPromptAccessTable).where(inArray(OrgPromptAccessTable.id, ids.map((id) => normalizeDenTypeId("orgPromptAccess", id))))
        }

        if (writeEveryone) {
          const orgWide = access.filter((grant) => grant.orgWide)
          if (spec.assignment.everyone && orgWide.length === 0) {
            await insert({ orgWide: true, teamId: null, orgMembershipId: null })
            steps.push({ action: "add", target: "assignment.everyone", detail: "Everyone" })
          } else if (!spec.assignment.everyone && orgWide.length > 0) {
            await removeRows(orgWide.map((grant) => grant.id))
            steps.push({ action: "remove", target: "assignment.everyone", detail: "Everyone" })
          }
        }
        if (writeTeams) {
          const current = new Map<string, string>(access.flatMap((grant) => (grant.teamId ? [[grant.teamId, grant.id] as const] : [])))
          const desired = new Set(spec.assignment.teamIds)
          const added = [...desired].filter((id) => !current.has(id))
          const removed = [...current.keys()].filter((id) => !desired.has(id))
          for (const teamId of added) await insert({ orgWide: false, teamId, orgMembershipId: null })
          await removeRows(removed.flatMap((id) => { const row = current.get(id); return row ? [row] : [] }))
          steps.push(...setSteps("assignment.teams", added, removed))
        }
        if (writeMembers) {
          const current = new Map<string, string>(access.flatMap((grant) => (grant.memberId ? [[grant.memberId, grant.id] as const] : [])))
          const desired = new Set(spec.assignment.memberIds)
          const added = [...desired].filter((id) => !current.has(id))
          const removed = [...current.keys()].filter((id) => !desired.has(id))
          for (const id of added) await insert({ orgWide: false, teamId: null, orgMembershipId: id })
          await removeRows(removed.flatMap((id) => { const row = current.get(id); return row ? [row] : [] }))
          steps.push(...setSteps("assignment.members", added, removed))
        }
      })
    } catch (error) {
      // The transaction rolled back: nothing of this item was written.
      throw asItemError(error, [])
    }
    return { localId: promptId, steps }
  },
})
