/**
 * Config-blob area `workbot.team-settings` (Members › Teams › a team ›
 * Workbot, the `workbotTeamSettings` feature): a team's own Workbot settings
 * on top of the organization's (`workbot.settings`), one item per team that
 * has any (`workbot_team_setting`).
 *
 * - `team` references `members.teams`; items match across organizations by
 *   the team's name (lowercased), like `members.default-models`.
 * - `settings` holds only what the team overrides, as stored
 *   (packages/types/src/den/workbot-team-settings.ts): `model` (an AI Gateway
 *   alias or managed model id; null is the deployment's default), `name`,
 *   `enabled` and `maxSteps` (null is the deployment's default, 0 no limit).
 *   A key that is absent means the team uses the organization's value.
 *   Stored keys a server doesn't know yet are not carried.
 * - `maxSteps` is always exported as stored, and only applied where
 *   `workbotStepLimit` is on; otherwise it is skipped with a warning.
 * - Apply goes through PUT /v1/org/workbot-settings/teams/:teamId's own
 *   functions (`checkWorkbotTeamModel`, `saveWorkbotTeamSettingsChange`): the
 *   applier's own servable models only, the managed Luna starter saved as the
 *   default, and only the keys the plan changes. A delete removes the team's
 *   row, so the team uses the organization's settings again.
 */
import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { TeamTable, WorkbotTeamSettingTable } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { configRefSchema, type ConfigApplyStep } from "@openwork/types/den/config-blobs"
import {
  readWorkbotTeamSettings,
  workbotTeamMaxStepsSchema,
  workbotTeamModelSchema,
  workbotTeamNameSchema,
  type WorkbotTeamSettingsWrite,
  type WorkbotTeamStoredSettings,
} from "@openwork/types/den/workbot-team-settings"
import { z } from "zod"
import { organizationFeatureEnabled } from "../../features.js"
import { RUNNER_UNAVAILABLE_MESSAGE, UNKNOWN_MODEL_MESSAGE } from "../../routes/org/workbot-settings.js"
import { checkWorkbotTeamModel, saveWorkbotTeamSettingsChange } from "../../routes/org/workbot-team-settings.js"
import { defineConfigArea, type ConfigApplyOp, type ConfigAreaContext, type ConfigItem } from "../area.js"
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
const SETTING_KEYS = ["model", "name", "enabled", "maxSteps"] as const
type SettingKey = (typeof SETTING_KEYS)[number]

const settingsSchema = z.strictObject({
  /** The team's own default model; null is the deployment's default model. */
  model: workbotTeamModelSchema.optional(),
  /** The team's own Workbot name. */
  name: workbotTeamNameSchema.optional(),
  /** Whether Workbot is on for the team's members. */
  enabled: z.boolean().optional(),
  /** The team's step limit: null is the deployment's default, 0 no limit. Applied only where workbotStepLimit is on. */
  maxSteps: workbotTeamMaxStepsSchema.optional(),
})

const specSchema = z.object({
  team: configRefSchema,
  settings: settingsSchema,
}).strict()

type TeamSettings = z.infer<typeof settingsSchema>

/** The readable overrides of a stored row, in the spec's key order. */
function exportedSettings(stored: WorkbotTeamStoredSettings): TeamSettings {
  return {
    ...(stored.model !== undefined ? { model: stored.model } : {}),
    ...(stored.name !== undefined ? { name: stored.name } : {}),
    ...(stored.enabled !== undefined ? { enabled: stored.enabled } : {}),
    ...(stored.maxSteps !== undefined ? { maxSteps: stored.maxSteps } : {}),
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
  return rows.flatMap((row): ConfigItem[] => {
    const settings = exportedSettings(readWorkbotTeamSettings(row.settings))
    // A row with nothing readable overrides nothing (the routes show it as the organization's).
    if (Object.keys(settings).length === 0) return []
    return [{ id: row.id, name: row.teamName, spec: { team: teamRef(row.teamId, row.teamName), settings } }]
  })
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

function describe(key: SettingKey, settings: TeamSettings): string {
  if (!(key in settings)) return "the organization's"
  const value = settings[key]
  if (key === "maxSteps") return value === null ? "default" : value === 0 ? "no limit" : String(value)
  if (key === "model") return value === null ? "default" : String(value)
  return String(value)
}

/**
 * The change to write: each key the plan names whose value differs from the target's, as the route's write
 * (`{ inherit: true }` when the team should use the organization's again). Keys whose feature is off here are
 * left out with a warning; a set model is checked against the applier's own models first.
 */
async function buildChange(ctx: ConfigAreaContext, op: ConfigApplyOp, next: TeamSettings, current: TeamSettings) {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const warnings: string[] = []
  const keys = SETTING_KEYS.filter((key) => touches(op, `settings.${key}`) && JSON.stringify(next[key]) !== JSON.stringify(current[key]))
  const change: WorkbotTeamSettingsWrite = {}
  for (const key of keys) {
    if (key === "maxSteps" && !await organizationFeatureEnabled(ctx.organizationId, "workbotStepLimit", { userId: ctx.actor.userId })) {
      warnings.push("The team's Workbot step limit wasn't changed: the step limit isn't on for this organization.")
      continue
    }
    if (key === "model") {
      if (next.model === undefined) change.model = { inherit: true }
      else if (next.model === null) change.model = { inherit: false, value: null }
      else {
        const checked = await checkWorkbotTeamModel({ organizationId, userId: ctx.actor.userId, model: next.model })
        if (checked.choice === "runner_unavailable") applyFailure({ code: "workbot_runner_unavailable", message: RUNNER_UNAVAILABLE_MESSAGE, field: "settings.model", status: 503 })
        if (checked.choice === "unknown_model") {
          applyFailure({ code: "unknown_model", message: `${UNKNOWN_MODEL_MESSAGE} (${next.model} isn't one of the models you can use in this organization.)`, field: "settings.model", status: 400 })
        }
        change.model = { inherit: false, value: checked.model }
      }
    }
    if (key === "name") change.name = next.name === undefined ? { inherit: true } : { inherit: false, value: next.name }
    if (key === "enabled") change.enabled = next.enabled === undefined ? { inherit: true } : { inherit: false, value: next.enabled }
    if (key === "maxSteps") change.maxSteps = next.maxSteps === undefined ? { inherit: true } : { inherit: false, value: next.maxSteps }
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
  // A team's model is an AI Gateway alias or a managed model: imported after the providers that serve it.
  dependsOn: ["members.teams", PROVIDERS_AREA],
  deployments: ["cloud", "self_hosted"],
  feature: "workbotTeamSettings",
  viewPermission: "inference.view",
  managePermission: "inference.manage",
  tables: ["workbot_team_setting"],
  naturalKeys: [{ label: "team", get: scopeNaturalKey }],
  uniqueFields: [{ label: "team", get: scopeUniqueKey }],
  informationalName: true,
  secretFields: [],
  // The model check reads the applier's Gateway catalog; saves use the global db.
  transactional: false,
  irreversible: () => [],

  exportItems: (ctx) => readRows(ctx),
  readItems: (ctx, ids) => readRows(ctx, ids),

  async preflight(ctx, op) {
    if (op.kind !== "create") return null
    const settings = settingsSchema.safeParse(specObject(op.item.spec).settings)
    if (!settings.success) return null
    const keys = Object.keys(settings.data)
    if (keys.length > 0 && keys.every((key) => key === "maxSteps") && !await organizationFeatureEnabled(ctx.organizationId, "workbotStepLimit", { userId: ctx.actor.userId })) {
      return { skip: "only a step limit, and Workbot's step limit isn't on here" }
    }
    return null
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
        // Only what this area carries goes back to the organization's. A team's own members'-agents policy is not
        // part of it and stays; a row left with nothing is removed by the save.
        await saveWorkbotTeamSettingsChange({
          organizationId: normalizeDenTypeId("organization", ctx.organizationId),
          teamId: normalizeDenTypeId("team", scope.teamId),
          change: { model: { inherit: true }, name: { inherit: true }, enabled: { inherit: true }, maxSteps: { inherit: true } },
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
      const next = parseSettings(spec)
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
        const { change, written, warnings } = await buildChange(ctx, op, next, {})
        if (written.length === 0) {
          applyFailure({ code: "feature_disabled", message: `Nothing in ${scope.teamName}'s Workbot settings can be set here: ${warnings.join(" ") || "no setting given."}`, field: "settings" })
        }
        const step: ConfigApplyStep = { action: "create", target: scope.teamName, detail: written.map((key) => `${key}: ${describe(key, next)}`).join(", ") }
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
      const { change, written, warnings } = await buildChange(ctx, op, next, current.settings)
      if (written.length === 0) return { localId: current.id, steps, ...(warnings.length ? { warnings } : {}) }
      const done: ConfigApplyStep[] = written.map((key) => ({ action: "set", target: `settings.${key}`, detail: describe(key, next) }))
      await save(change).catch((error: unknown) => applyFailure({ code: "write_failed", message: errorMessage(error), step: done[0] }))
      steps.push(...done)
      // Every override cleared: the route removed the row, and the team uses the organization's settings.
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
