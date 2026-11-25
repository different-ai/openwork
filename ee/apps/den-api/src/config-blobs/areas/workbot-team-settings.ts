import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { TeamTable, WorkbotTeamSettingTable } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { configRefSchema, type ConfigApplyStep } from "@openwork/types/den/config-blobs"
import {
  readWorkbotTeamSettings,
  workbotTeamModelSchema,
  workbotTeamNameSchema,
  type WorkbotTeamSettingsWrite,
  type WorkbotTeamStoredSettings,
} from "@openwork/types/den/workbot-team-settings"
import { z } from "zod"
import { RUNNER_UNAVAILABLE_MESSAGE } from "../../routes/org/workbot-settings.js"
import { checkWorkbotTeamModel, saveWorkbotTeamSettingsChange } from "../../routes/org/workbot-team-settings.js"
import { defineConfigArea, type ConfigApplyOp, type ConfigAreaContext, type ConfigItem } from "../area.js"
import {
  describeGatewayModel,
  gatewayModelHintSchema,
  gatewayModelLabel,
  localGatewayModel,
  modelNotUsable,
  readGatewayModelHint,
  resolvedProviderId,
} from "./gateway-model-ref.js"
import {
  applyFailure,
  asItemError,
  changesScope,
  previousScopeSpec,
  requireActorPermission,
  resolveItemScope,
  sameScope,
  scopeNaturalKey,
  scopeUniqueKey,
} from "./members-scope-support.js"
import { touches } from "./org-singleton.js"
import { specObject, teamRef } from "./route-support.js"

const AREA = "workbot.team-settings"
const PROVIDERS_AREA = "ai-gateway.providers"
const SETTING_KEYS = ["model", "name", "enabled"] as const
type SettingKey = (typeof SETTING_KEYS)[number]

const settingsSchema = z.strictObject({
  model: workbotTeamModelSchema.optional(),
  name: workbotTeamNameSchema.optional(),
  enabled: z.boolean().optional(),
  maxSteps: z.unknown().optional(),
})

const specSchema = z.object({
  team: configRefSchema,
  settings: settingsSchema,
  provider: configRefSchema.nullable().optional(),
  gatewayModel: gatewayModelHintSchema.nullable().optional(),
}).strict()

type TeamSettings = z.infer<typeof settingsSchema>

function exportedSettings(stored: WorkbotTeamStoredSettings): TeamSettings {
  return {
    ...(stored.model !== undefined ? { model: stored.model } : {}),
    ...(stored.name !== undefined ? { name: stored.name } : {}),
    ...(stored.enabled !== undefined ? { enabled: stored.enabled } : {}),
  }
}

async function readRows(ctx: ConfigAreaContext, ids?: string[]): Promise<ConfigItem[]> {
  const rowIds = ids?.flatMap((id) => {
    try {
      return [normalizeDenTypeId("workbotTeamSetting", id)]
    } catch {
      return []
    }
  })
  if (rowIds && rowIds.length === 0) return []
  const rows = await ctx.db
    .select({ id: WorkbotTeamSettingTable.id, teamId: WorkbotTeamSettingTable.teamId, settings: WorkbotTeamSettingTable.settings, teamName: TeamTable.name })
    .from(WorkbotTeamSettingTable)
    .innerJoin(TeamTable, eq(TeamTable.id, WorkbotTeamSettingTable.teamId))
    .where(and(
      eq(WorkbotTeamSettingTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId)),
      ...(rowIds ? [inArray(WorkbotTeamSettingTable.id, rowIds)] : []),
    ))
    .orderBy(asc(TeamTable.name), asc(WorkbotTeamSettingTable.id))
  const items: ConfigItem[] = []
  for (const row of rows) {
    const settings = exportedSettings(readWorkbotTeamSettings(row.settings))
    if (Object.keys(settings).length === 0) continue
    const gateway = await describeGatewayModel(ctx, settings.model)
    items.push({
      id: row.id,
      name: row.teamName,
      spec: {
        team: teamRef(row.teamId, row.teamName),
        settings,
        ...(gateway ? { provider: gateway.provider } : {}),
        ...(gateway?.gatewayModel ? { gatewayModel: gateway.gatewayModel } : {}),
      },
    })
  }
  return items
}

async function currentRow(ctx: ConfigAreaContext, teamId: string) {
  const [row] = await ctx.db
    .select({ id: WorkbotTeamSettingTable.id, settings: WorkbotTeamSettingTable.settings })
    .from(WorkbotTeamSettingTable)
    .where(and(
      eq(WorkbotTeamSettingTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId)),
      eq(WorkbotTeamSettingTable.teamId, normalizeDenTypeId("team", teamId)),
    ))
    .limit(1)
  return row ? { id: row.id, settings: exportedSettings(readWorkbotTeamSettings(row.settings)) } : null
}

function parseSettings(spec: { [key: string]: unknown }): TeamSettings {
  const parsed = settingsSchema.safeParse(spec.settings ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path[0]
    applyFailure({ code: "invalid_spec", message: issue?.message ?? "Invalid Workbot settings.", field: typeof at === "string" ? `settings.${at}` : "settings" })
  }
  return parsed.data
}

function describe(key: SettingKey, settings: TeamSettings, modelLabel?: string): string {
  if (!(key in settings)) return "the organization's"
  const value = settings[key]
  if (key === "model") return value === null ? "default" : modelLabel ?? String(value)
  return String(value)
}

async function buildChange(ctx: ConfigAreaContext, op: ConfigApplyOp, next: TeamSettings, current: TeamSettings, teamName: string, modelLabel: string) {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const warnings: string[] = []
  const keys = SETTING_KEYS.filter((key) => touches(op, `settings.${key}`) && JSON.stringify(next[key]) !== JSON.stringify(current[key]))
  const change: WorkbotTeamSettingsWrite = {}
  for (const key of keys) {
    if (key === "model") {
      if (next.model === undefined) change.model = { inherit: true }
      else if (next.model === null) change.model = { inherit: false, value: null }
      else {
        const checked = await checkWorkbotTeamModel({ organizationId, userId: ctx.actor.userId, model: next.model })
        if (checked.choice === "runner_unavailable") applyFailure({ code: "workbot_runner_unavailable", message: RUNNER_UNAVAILABLE_MESSAGE, field: "settings.model", status: 503 })
        if (checked.choice === "unknown_model") warnings.push(`${teamName}'s Workbot model was not changed: ${modelNotUsable(modelLabel)}`)
        else change.model = { inherit: false, value: checked.model }
      }
    }
    if (key === "name") change.name = next.name === undefined ? { inherit: true } : { inherit: false, value: next.name }
    if (key === "enabled") change.enabled = next.enabled === undefined ? { inherit: true } : { inherit: false, value: next.enabled }
  }
  const written = SETTING_KEYS.filter((key) => change[key] !== undefined)
  return { change, written, warnings }
}

function preferredRowId(id: string | undefined) {
  if (!id) return undefined
  try {
    return normalizeDenTypeId("workbotTeamSetting", id)
  } catch {
    return undefined
  }
}

export const workbotTeamSettingsArea = defineConfigArea({
  key: AREA,
  label: "Workbot per team",
  path: ["Members", "Teams", "Workbot"],
  idPrefix: denTypeIdPrefixes.workbotTeamSetting,
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams", PROVIDERS_AREA],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "inference.view",
  managePermission: "inference.manage",
  tables: ["workbot_team_setting"],
  naturalKeys: [{ label: "team", get: scopeNaturalKey }],
  uniqueFields: [{ label: "team", get: scopeUniqueKey }],
  informationalName: true,
  secretFields: [],
  requiredRefs: ["team"],
  informationalFields: ["provider", "gatewayModel"],
  transactional: false,
  irreversible: () => [],

  exportItems: (ctx) => readRows(ctx),
  readItems: (ctx, ids) => readRows(ctx, ids),

  async preflight(ctx, op, info) {
    if (op.kind === "delete") return null
    const spec = specObject(op.item.spec)
    const settings = settingsSchema.safeParse(spec.settings)
    if (!settings.success) return null
    const keys = Object.keys(settings.data)
    if (op.kind === "create" && keys.length > 0 && keys.every((key) => key === "maxSteps")) return { skip: "only a step limit, which Workbot no longer has" }
    const model = settings.data.model
    if (typeof model !== "string" || !touches(op, "settings.model")) return null
    const provider = info.refs?.find((ref) => ref.path === "provider")
    if (provider && provider.resolution !== "target") return null
    const hint = readGatewayModelHint(spec.gatewayModel)
    const next = await localGatewayModel(ctx, { model, providerId: provider?.id ?? null, hint })
    const onlyModel = op.kind === "update"
      ? op.secretPaths.length === 0 && op.changes.length > 0 && op.changes.every((change) => change.path === "settings.model")
      : keys.every((key) => key === "model" || key === "maxSteps")
    if (op.kind === "update" && specObject(specObject(op.previous.spec).settings).model === next) {
      return onlyModel ? { skip: "This team's Workbot already uses this model here." } : null
    }
    const checked = await checkWorkbotTeamModel({ organizationId: normalizeDenTypeId("organization", ctx.organizationId), userId: ctx.actor.userId, model: next })
    if (checked.choice !== "unknown_model") return null
    const label = gatewayModelLabel(model, spec.provider, hint)
    return onlyModel ? { skip: modelNotUsable(label) } : { warnings: [`${op.item.name}'s Workbot model will not be changed: ${modelNotUsable(label)}`] }
  },

  async apply(ctx, op) {
    const steps: ConfigApplyStep[] = []
    try {
      await requireActorPermission(ctx, "inference.manage")

      if (op.kind === "delete") {
        const scope = await resolveItemScope(ctx, previousScopeSpec(op.previous))
        if (scope.kind !== "team") applyFailure({ code: "invalid_spec", message: "Workbot settings per team need a team.", field: "team" })
        const current = await currentRow(ctx, scope.teamId)
        if (!current) return { localId: op.targetId, steps }
        const step: ConfigApplyStep = { action: "delete", target: scope.teamName, detail: "uses the organization's Workbot settings" }
        await saveWorkbotTeamSettingsChange({
          organizationId: normalizeDenTypeId("organization", ctx.organizationId),
          teamId: normalizeDenTypeId("team", scope.teamId),
          change: { model: { inherit: true }, name: { inherit: true }, enabled: { inherit: true } },
          updatedByOrgMemberId: normalizeDenTypeId("member", ctx.actor.memberId),
        })
          .catch((error: unknown) => applyFailure({ code: "write_failed", message: errorMessage(error), step }))
        steps.push(step)
        return { localId: op.targetId, steps }
      }

      const spec = specObject(op.item.spec)
      if (spec.team === null || spec.team === undefined) applyFailure({ code: "invalid_spec", message: "Workbot settings per team need a team.", field: "team" })
      const scope = await resolveItemScope(ctx, spec)
      if (scope.kind !== "team") applyFailure({ code: "invalid_spec", message: "Workbot settings per team need a team.", field: "team" })
      const written = parseSettings(spec)
      const hint = readGatewayModelHint(spec.gatewayModel)
      const modelLabel = typeof written.model === "string" ? gatewayModelLabel(written.model, spec.provider, hint) : "default"
      const next: TeamSettings = typeof written.model === "string" && touches(op, "settings.model")
        ? { ...written, model: await localGatewayModel(ctx, { model: written.model, providerId: resolvedProviderId(spec.provider), hint }) }
        : written
      const current = await currentRow(ctx, scope.teamId)
      const save = (change: WorkbotTeamSettingsWrite, id?: string) => saveWorkbotTeamSettingsChange({
        organizationId: normalizeDenTypeId("organization", ctx.organizationId),
        teamId: normalizeDenTypeId("team", scope.teamId),
        change,
        updatedByOrgMemberId: normalizeDenTypeId("member", ctx.actor.memberId),
        ...(preferredRowId(id) ? { id: preferredRowId(id) } : {}),
      })

      if (op.kind === "create") {
        if (current) {
          applyFailure({ code: "workbot_team_settings_exist", message: `${scope.teamName} already has its own Workbot settings here; match this item to them instead of creating new ones.`, field: "team", status: 409 })
        }
        const { change, written: keys, warnings } = await buildChange(ctx, op, next, {}, scope.teamName, modelLabel)
        if (keys.length === 0) {
          if (warnings.length) return { localId: op.item.sourceId ?? scope.teamId, steps, warnings }
          applyFailure({ code: "invalid_spec", message: `Nothing in ${scope.teamName}'s Workbot settings can be set here: no setting given.`, field: "settings" })
        }
        const step: ConfigApplyStep = { action: "create", target: scope.teamName, detail: keys.map((key) => `${key}: ${describe(key, next, modelLabel)}`).join(", ") }
        await save(change, op.preferredId).catch((error: unknown) => applyFailure({ code: "write_failed", message: errorMessage(error), step }))
        steps.push(step)
        const created = await currentRow(ctx, scope.teamId)
        if (!created) applyFailure({ code: "unexpected_state", message: `${scope.teamName}'s Workbot settings were not saved.` }, steps)
        return { localId: created.id, steps, ...(warnings.length ? { warnings } : {}) }
      }

      if (changesScope(op.changes) || !sameScope(scope, previousScopeSpec(op.previous))) {
        applyFailure({ code: "scope_changed", message: "A team's Workbot settings can't move to another team; remove them there and set them on the other team.", field: "team" })
      }
      if (!current || current.id !== op.targetId) {
        applyFailure({ code: "workbot_team_settings_not_found", message: `${scope.teamName}'s Workbot settings changed since the plan; analyze again.`, status: 409 })
      }
      const { change, written: keys, warnings } = await buildChange(ctx, op, next, current.settings, scope.teamName, modelLabel)
      if (keys.length === 0) return { localId: current.id, steps, ...(warnings.length ? { warnings } : {}) }
      const done: ConfigApplyStep[] = keys.map((key) => ({ action: "set", target: `settings.${key}`, detail: describe(key, next, modelLabel) }))
      await save(change).catch((error: unknown) => applyFailure({ code: "write_failed", message: errorMessage(error), step: done[0] }))
      steps.push(...done)
      const after = await currentRow(ctx, scope.teamId)
      return { localId: after?.id ?? current.id, steps, ...(warnings.length ? { warnings } : {}) }
    } catch (error) {
      throw asItemError(error, steps)
    }
  },
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The team's Workbot settings could not be saved."
}
