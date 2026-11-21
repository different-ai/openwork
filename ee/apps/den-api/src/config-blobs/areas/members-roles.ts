import { allowedKeys, readPermissionSetStates } from "@openwork-ee/den-db/permissions"
import { and, asc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { PermissionSetTable, PermissionSetTeamTable, TeamTable } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  PERMISSION_DEFAULT_SET_KEYS,
  PERMISSION_DEFAULT_SET_LABELS,
  PERMISSION_KEYS,
  isPermissionKey,
  type PermissionDefaultSetKey,
} from "@openwork/types/den/permissions"
import { z } from "zod"
import { currentAuditChangeCapture } from "../../audit/request-capture.js"
import { ensureCurrentDefaultPermissionSets } from "../../permissions/default-sets.js"
import {
  archivePermissionSetAction,
  createPermissionSetAction,
  renamePermissionSetAction,
  setTeamPermissionSetAction,
  updatePermissionSetPermissionsAction,
} from "../../routes/org/permissions.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import { ConfigApplyError, applyWithSteps, configRouteContext, expectRouteOk, isJsonObject, resolvedRefIds, specObject, specRefSchema, stringField, teamRef, touches } from "./route-support.js"

const AREA = "members.roles"

const roleSpecSchema = z.object({
  builtIn: z.enum(PERMISSION_DEFAULT_SET_KEYS).nullable().default(null),
  allow: z.array(z.string().min(1).max(128)).max(1000),
  teams: z.array(specRefSchema).max(500).default([]),
}).strict()

const roleApplyFieldsSchema = z.object({
  builtIn: z.enum(PERMISSION_DEFAULT_SET_KEYS).nullable(),
  allow: z.array(z.string().min(1).max(128)).max(1000),
}).passthrough()

function normalizedName(name: string): string {
  return name.trim().toLowerCase()
}

function builtInOf(item: ConfigItem): string | null {
  return typeof item.spec.builtIn === "string" ? item.spec.builtIn : null
}

async function activeTeamIdsBySet(ctx: ConfigAreaContext, setIds: readonly string[]) {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const out = new Map<string, Array<{ id: string; name: string }>>()
  if (setIds.length === 0) return out
  const rows = await ctx.db
    .select({ permissionSetId: PermissionSetTeamTable.permissionSetId, teamId: PermissionSetTeamTable.teamId, teamName: TeamTable.name })
    .from(PermissionSetTeamTable)
    .innerJoin(TeamTable, and(eq(TeamTable.id, PermissionSetTeamTable.teamId), eq(TeamTable.organizationId, PermissionSetTeamTable.organizationId)))
    .where(and(
      eq(PermissionSetTeamTable.organizationId, organizationId),
      inArray(PermissionSetTeamTable.permissionSetId, setIds.map((id) => normalizeDenTypeId("permissionSet", id))),
      isNull(PermissionSetTeamTable.removedAt),
    ))
  for (const row of rows) {
    const list = out.get(row.permissionSetId) ?? []
    list.push({ id: row.teamId, name: row.teamName })
    out.set(row.permissionSetId, list)
  }
  return out
}

function preferredSetId(id: string | undefined) {
  if (!id) return undefined
  try {
    return normalizeDenTypeId("permissionSet", id)
  } catch {
    return undefined
  }
}

function splitAllowed(allow: readonly string[]) {
  const known = [...new Set(allow.filter(isPermissionKey))]
  const unknown = [...new Set(allow.filter((key) => !isPermissionKey(key)))]
  return { known, unknown }
}

export const membersRolesArea = defineConfigArea({
  key: AREA,
  label: "Roles",
  path: ["Members", "Roles"],
  idPrefix: denTypeIdPrefixes.permissionSet,
  specVersion: 1,
  specSchema: roleSpecSchema,
  dependsOn: ["members.teams"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "permissions.view",
  managePermission: "permissions.manage",
  tables: ["permission_set", "permission_set_permission", "permission_set_team", "organization_role"],
  naturalKeys: [
    { label: "built-in role", get: (item) => builtInOf(item) },
    { label: "name", get: (item) => builtInOf(item) ? null : normalizedName(item.name) || null },
  ],
  secretFields: [],
  transactional: false,
  protectedFromDelete: (item) => {
    const builtIn = builtInOf(item)
    return builtIn ? `${item.name} permissions are built in and can't be deleted.` : null
  },

  irreversible: (op) => op.kind === "delete"
    ? [`"${op.previous.name}" is archived with its permission history; a restore creates a new role with a new id.`]
    : [],

  async exportItems(ctx) {
    return readRoles(ctx, null)
  },

  async readItems(ctx, ids) {
    return readRoles(ctx, ids)
  },

  async apply(ctx, op) {
    return applyWithSteps(async (log) => {
      const { c, payload } = await configRouteContext(ctx)
      const capture = currentAuditChangeCapture(ctx.organizationId)
      const organizationId = normalizeDenTypeId("organization", ctx.organizationId)

      if (op.kind === "delete") {
        if (builtInOf(op.previous)) throw new ConfigApplyError("default_permission_set", `${op.previous.name} permissions can't be deleted.`, 400)
        await log.run({ action: "delete", target: "role", detail: op.previous.name }, async () => {
          await expectRouteOk(await archivePermissionSetAction(c, payload, op.targetId, capture), `Delete role "${op.previous.name}"`)
        })
        return { localId: op.targetId }
      }

      const raw = specObject(op.item.spec)
      const spec = roleApplyFieldsSchema.parse(raw)
      const teamIds = [...new Set(resolvedRefIds(raw.teams, `Role "${op.item.name}" teams`).map((id) => normalizeDenTypeId("team", id)))]
      const { known, unknown } = splitAllowed(spec.allow)
      const warnings = unknown.length > 0
        ? [`Not on this server, skipped: ${unknown.join(", ")}.`]
        : []
      if (spec.builtIn && teamIds.length > 0) {
        throw new ConfigApplyError("invalid_spec", `${PERMISSION_DEFAULT_SET_LABELS[spec.builtIn]} permissions can't be given to teams; make the team an Admin team instead.`, 400, "teams")
      }

      if (op.kind === "create") {
        if (spec.builtIn) {
          throw new ConfigApplyError("default_permission_set", `${PERMISSION_DEFAULT_SET_LABELS[spec.builtIn]} permissions always exist and can only be updated.`, 400)
        }
        const name = op.item.name.trim()
        const localId = await log.run({ action: "create", target: "role", detail: name }, async () => {
          const response = await createPermissionSetAction(c, payload, {
            name,
            teamIds,
            permissions: known.map((key) => ({ key, status: "allow" as const })),
          }, capture, { permissionSetId: preferredSetId(op.preferredId) })
          return stringField(await expectRouteOk(response, `Create role "${name}"`), "set", "id")
        })
        return { localId, warnings }
      }

      const setId = normalizeDenTypeId("permissionSet", op.targetId)
      const [set] = await ctx.db
        .select({ id: PermissionSetTable.id, name: PermissionSetTable.name, defaultKey: PermissionSetTable.defaultKey, archivedAt: PermissionSetTable.archivedAt })
        .from(PermissionSetTable)
        .where(and(eq(PermissionSetTable.organizationId, organizationId), eq(PermissionSetTable.id, setId)))
        .limit(1)
      if (!set || set.archivedAt) throw new ConfigApplyError("permission_set_not_found", `Role "${op.previous.name}" no longer exists.`, 404)
      if ((spec.builtIn ?? null) !== set.defaultKey) {
        throw new ConfigApplyError("invalid_spec", `"${set.name}" can't change between a built-in and a custom role.`, 400, "builtIn")
      }

      const name = op.item.name.trim()
      if (touches(op.changes, "name")) {
        if (set.defaultKey === null && name && name !== set.name) {
          await log.run({ action: "set", target: "name", detail: name }, async () => {
            await expectRouteOk(await renamePermissionSetAction(c, payload, set.id, name, capture), `Rename role "${set.name}"`)
          })
        } else if (set.defaultKey !== null && name !== set.name) {
          warnings.push(`${set.name} permissions keep their name.`)
        }
      }

      if (touches(op.changes, "allow")) {
        if (set.defaultKey !== null) await ensureCurrentDefaultPermissionSets(organizationId)
        const current = allowedKeys((await readPermissionSetStates(ctx.db, [set.id])).get(set.id))
        const wanted = new Set<string>(known)
        const changes = PERMISSION_KEYS.flatMap((key) => {
          const allowNow = current.has(key)
          const allowNext = wanted.has(key)
          return allowNow === allowNext ? [] : [{ key, status: allowNext ? "allow" as const : "deny" as const }]
        })
        if (changes.length > 0) {
          const detail = changes.map((change) => `${change.status === "allow" ? "+" : "-"}${change.key}`).join(", ")
          await log.run({ action: "update", target: "allow", detail }, async () => {
            await expectRouteOk(await updatePermissionSetPermissionsAction(c, payload, set.id, changes, capture), `Change permissions of "${set.name}"`)
          })
        }
      }

      if (set.defaultKey === null && touches(op.changes, "teams")) {
        const current = (await activeTeamIdsBySet(ctx, [set.id])).get(set.id) ?? []
        const currentTeams = new Set(current.map((team) => team.id))
        const wantedTeams = new Set<string>(teamIds)
        const teamName = (id: string) => current.find((team) => team.id === id)?.name ?? refName(raw.teams, id) ?? id
        for (const teamId of wantedTeams) {
          if (currentTeams.has(teamId)) continue
          await log.run({ action: "add", target: "teams", detail: teamName(teamId) }, async () => {
            await expectRouteOk(await setTeamPermissionSetAction(c, payload, teamId, set.id, capture), `Give role "${set.name}" to a team`)
          })
        }
        for (const teamId of currentTeams) {
          if (wantedTeams.has(teamId)) continue
          await log.run({ action: "remove", target: "teams", detail: teamName(teamId) }, async () => {
            await expectRouteOk(await setTeamPermissionSetAction(c, payload, teamId, null, capture), `Take role "${set.name}" from a team`)
          })
        }
      }
      return { localId: set.id, warnings }
    })
  },
})

function refName(refs: unknown, id: string): string | null {
  if (!Array.isArray(refs)) return null
  for (const ref of refs) {
    if (isJsonObject(ref) && ref.id === id && typeof ref.name === "string") return ref.name
  }
  return null
}

async function readRoles(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const setIdFilter = ids?.flatMap((id) => preferredSetId(id) ?? []) ?? null
  if (setIdFilter && setIdFilter.length === 0) return []
  await ensureCurrentDefaultPermissionSets(organizationId)
  const sets = (await ctx.db
    .select({ id: PermissionSetTable.id, name: PermissionSetTable.name, defaultKey: PermissionSetTable.defaultKey })
    .from(PermissionSetTable)
    .where(and(
      eq(PermissionSetTable.organizationId, organizationId),
      isNull(PermissionSetTable.archivedAt),
      setIdFilter ? inArray(PermissionSetTable.id, setIdFilter) : undefined,
    ))
    .orderBy(asc(PermissionSetTable.name), asc(PermissionSetTable.id)))
  const setIds = sets.map((set) => set.id)
  const [states, teamsBySet] = await Promise.all([
    readPermissionSetStates(ctx.db, setIds),
    activeTeamIdsBySet(ctx, setIds),
  ])
  const rank = (key: PermissionDefaultSetKey | null) => key === null ? PERMISSION_DEFAULT_SET_KEYS.length : PERMISSION_DEFAULT_SET_KEYS.indexOf(key)
  return sets
    .sort((left, right) => rank(left.defaultKey) - rank(right.defaultKey))
    .map((set): ConfigItem => ({
      id: set.id,
      key: set.defaultKey,
      name: set.name,
      spec: {
        builtIn: set.defaultKey,
        allow: [...allowedKeys(states.get(set.id))].sort(),
        teams: set.defaultKey !== null
          ? []
          : [...(teamsBySet.get(set.id) ?? [])].sort((left, right) => left.id.localeCompare(right.id)).map((team) => teamRef(team.id, team.name)),
      },
    }))
}
