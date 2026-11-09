/**
 * Config-blob area `members.teams`: the organization's teams.
 *
 * - Spec: whether the team is an Admin team, and who manages it (`scim` when
 *   the identity provider owns its membership). Team membership is NOT here:
 *   it is carried per person by `members.people`.
 * - Identity: `externalKey` as the item key, then the team name (unique per
 *   organization).
 * - Apply goes through the team routes' own functions (routes/org/teams.ts
 *   createTeam / updateTeam / deleteTeam) with an in-process route context, so
 *   the Admin-team rules, the "can't grant more than you hold" rule and the
 *   SCIM guard are exactly the dashboard's.
 */
import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { TeamTable } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { configItemKeySchema } from "@openwork/types/den/config-blobs"
import { z } from "zod"
import { createTeam, deleteTeam, updateTeam } from "../../routes/org/teams.js"
import { getScimManagedTeamIds } from "../../scim-groups.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import { ConfigApplyError, applyWithSteps, configRouteContext, expectRouteOk, specObject, stringField, touches } from "./route-support.js"

const AREA = "members.teams"

const teamSpecSchema = z.object({
  grantsOrganizationAdmin: z.boolean(),
  /** `scim`: the identity provider owns the team's name and membership on the source. Hand-written blobs may leave it out. */
  managedBy: z.enum(["manual", "scim"]).default("manual"),
}).strict()

const teamSpecFieldsSchema = teamSpecSchema.partial({ managedBy: true })

function normalizedName(name: string): string {
  return name.trim().toLowerCase()
}

function preferredTeamId(id: string | undefined) {
  if (!id) return undefined
  try {
    return normalizeDenTypeId("team", id)
  } catch {
    return undefined
  }
}

export const membersTeamsArea = defineConfigArea({
  key: AREA,
  label: "Teams",
  path: ["Members", "Teams"],
  idPrefix: denTypeIdPrefixes.team,
  specVersion: 1,
  specSchema: teamSpecSchema,
  dependsOn: [],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "teams.view",
  managePermission: "teams.manage",
  tables: ["team"],
  naturalKeys: [{ label: "name", get: (item) => normalizedName(item.name) || null }],
  uniqueFields: [{ label: "name", get: (item) => normalizedName(item.name) || null }],
  secretFields: [],
  // createTeam / updateTeam / deleteTeam open their own organization-locked transactions on the global db.
  transactional: false,
  protectedFromDelete: (item) => item.spec.managedBy === "scim"
    ? "This team is managed by your identity provider (SCIM). Turn off SCIM team mapping before deleting it."
    : null,

  irreversible: (op) => {
    if (op.kind !== "delete") return []
    return [
      `Everything given to "${op.previous.name}" (connector, AI provider, desktop policy, collection and plugin access, usage limits, prompts, default model, agent permissions and its roles) is removed with the team; restoring the team only gives back what the restore carries.`,
      `Pending invitations into "${op.previous.name}" no longer add people to it.`,
    ]
  },

  async exportItems(ctx) {
    return readTeams(ctx, null)
  },

  async readItems(ctx, ids) {
    return readTeams(ctx, ids)
  },

  async apply(ctx, op) {
    return applyWithSteps(async (log) => {
      const { c, payload } = await configRouteContext(ctx)

      if (op.kind === "delete") {
        await log.run({ action: "delete", target: "team", detail: op.previous.name }, async () => {
          await expectRouteOk(await deleteTeam(c, payload, op.targetId), `Delete team "${op.previous.name}"`)
        })
        return { localId: op.targetId }
      }

      const spec = teamSpecFieldsSchema.parse(specObject(op.item.spec))
      const name = op.item.name.trim()
      if (!name) throw new ConfigApplyError("invalid_spec", "A team needs a name.", 400, "name")

      if (op.kind === "create") {
        const warnings: string[] = []
        if (spec.managedBy === "scim") warnings.push(`"${name}" is managed by SCIM on the source; it was created as a regular team here.`)
        const key = op.item.key ? configItemKeySchema.safeParse(op.item.key) : null
        if (key && !key.success) throw new ConfigApplyError("invalid_spec", `Team key "${op.item.key}" is not a valid key.`, 400, "key")
        const localId = await log.run({ action: "create", target: "team", detail: name }, async () => {
          const response = await createTeam(c, payload, {
            name,
            memberIds: [],
            // Only sent when on: sending false still needs Manage Admin teams.
            ...(spec.grantsOrganizationAdmin ? { grantsOrganizationAdmin: true } : {}),
          }, key?.data ?? undefined, { teamId: preferredTeamId(op.preferredId) })
          return stringField(await expectRouteOk(response, `Create team "${name}"`), "team", "id")
        })
        return { localId, warnings }
      }

      // update: only the name and the Admin flag are written, and only when the plan changes them.
      const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
      const [current] = await ctx.db
        .select({ id: TeamTable.id, name: TeamTable.name, externalKey: TeamTable.externalKey, grantsOrganizationAdmin: TeamTable.grantsOrganizationAdmin })
        .from(TeamTable)
        .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamTable.id, normalizeDenTypeId("team", op.targetId))))
        .limit(1)
      if (!current) throw new ConfigApplyError("team_not_found", `Team "${op.previous.name}" no longer exists.`, 404)

      const warnings: string[] = []
      if (touches(op.changes, "key") && (op.item.key ?? null) !== current.externalKey) {
        warnings.push(`The key of "${current.name}" stays "${current.externalKey ?? "(none)"}": team keys are only set when a team is created.`)
      }
      if (touches(op.changes, "managedBy")) warnings.push(`Who manages "${current.name}" (SCIM or by hand) is decided by this organization's identity provider; it was not changed.`)
      const renames = touches(op.changes, "name") && current.name !== name
      const changesAdmin = touches(op.changes, "grantsOrganizationAdmin") && current.grantsOrganizationAdmin !== spec.grantsOrganizationAdmin
      if (!renames && !changesAdmin) return { localId: current.id, warnings }
      if (renames && (await getScimManagedTeamIds(organizationId, ctx.db)).has(current.id)) {
        throw new ConfigApplyError("scim_managed_team", `"${current.name}" is managed by your identity provider (SCIM); rename it there.`, 409, "name")
      }
      const step = renames && !changesAdmin
        ? { action: "set" as const, target: "name", detail: name }
        : changesAdmin && !renames
          ? { action: "set" as const, target: "grantsOrganizationAdmin", detail: String(spec.grantsOrganizationAdmin) }
          : { action: "update" as const, target: "team", detail: "name and Admin team" }
      // One updateTeam call: it writes both fields in one locked transaction.
      await log.run(step, async () => {
        await expectRouteOk(await updateTeam(c, payload, current.id, {
          ...(renames ? { name } : {}),
          ...(changesAdmin ? { grantsOrganizationAdmin: spec.grantsOrganizationAdmin } : {}),
        }), `Update team "${current.name}"`)
      }, renames && !changesAdmin ? "name" : "grantsOrganizationAdmin")
      return { localId: current.id, warnings }
    })
  },
})

async function readTeams(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const teamIds = ids?.flatMap((id) => preferredTeamId(id) ?? []) ?? null
  if (teamIds && teamIds.length === 0) return []
  const [rows, scimTeamIds] = await Promise.all([
    ctx.db
      .select({ id: TeamTable.id, name: TeamTable.name, externalKey: TeamTable.externalKey, grantsOrganizationAdmin: TeamTable.grantsOrganizationAdmin })
      .from(TeamTable)
      .where(and(eq(TeamTable.organizationId, organizationId), teamIds ? inArray(TeamTable.id, teamIds) : undefined))
      .orderBy(asc(TeamTable.name), asc(TeamTable.id)),
    getScimManagedTeamIds(organizationId, ctx.db),
  ])
  return rows.map((row): ConfigItem => ({
    id: row.id,
    key: row.externalKey,
    name: row.name,
    spec: { grantsOrganizationAdmin: row.grantsOrganizationAdmin, managedBy: scimTeamIds.has(row.id) ? "scim" : "manual" },
  }))
}
