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
 *   alias or managed model id; null is the deployment's default), `name`
 *   and `enabled`. A key that is absent means the team uses the
 *   organization's value. Stored keys a server doesn't know yet are not
 *   carried.
 * - `provider` and `gatewayModel`: when the team's model is an AI Gateway
 *   alias, the provider serving it (a reference) and what the alias names
 *   in words, as in `workbot.settings`: an import into an organization whose
 *   provider rows have other ids rebuilds the alias from them, and the model
 *   is compared by them (areas/gateway-model-ref.ts). Absent otherwise.
 * - `maxSteps` is in files exported while teams had a step limit. It is read
 *   so those files still import; never applied and no longer exported.
 * - Apply goes through PUT /v1/org/workbot-settings/teams/:teamId's own
 *   functions (`checkWorkbotTeamModel`, `saveWorkbotTeamSettingsChange`): the
 *   applier's own servable models only, the managed Luna starter saved as the
 *   default, and only the keys the plan changes. A delete removes the team's
 *   row, so the team uses the organization's settings again.
 * - A model the applier can't use here yet (typically: its provider was
 *   imported without its key) is left out with a warning, so the rest of the
 *   import still runs; importing again once the model is usable sets it.
 */
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
  /** The team's own default model; null is the deployment's default model. */
  model: workbotTeamModelSchema.optional(),
  /** The team's own Workbot name. */
  name: workbotTeamNameSchema.optional(),
  /** Whether Workbot is on for the team's members. */
  enabled: z.boolean().optional(),
  /** From files exported while teams had a step limit: read, never applied. */
  maxSteps: z.unknown().optional(),
})

const specSchema = z.object({
  team: configRefSchema,
  settings: settingsSchema,
  /** The AI Gateway provider serving `settings.model`; informational, names where the model is found on import. */
  provider: configRefSchema.nullable().optional(),
  /** What an AI Gateway `settings.model` names (group, credential set, catalog model id), so it is found again where ids differ. */
  gatewayModel: gatewayModelHintSchema.nullable().optional(),
}).strict()

type TeamSettings = z.infer<typeof settingsSchema>

/** The readable overrides of a stored row, in the spec's key order. */
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
    // A row with nothing readable overrides nothing (the routes show it as the organization's).
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

/**
 * The change to write: each key the plan names whose value differs from the target's, as the route's write
 * (`{ inherit: true }` when the team should use the organization's again). Keys whose feature is off here are
 * left out with a warning; a set model is checked against the applier's own models first, and one they can't use
 * here (yet) is left out with a warning too. `next.model` is already the alias as this organization names it.
 */
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
  // A team's model is an AI Gateway alias or a managed model: imported after the providers that serve it.
  dependsOn: ["members.teams", PROVIDERS_AREA],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "inference.view",
  managePermission: "inference.manage",
  tables: ["workbot_team_setting"],
  naturalKeys: [{ label: "team", get: scopeNaturalKey }],
  uniqueFields: [{ label: "team", get: scopeUniqueKey }],
  informationalName: true,
  secretFields: [],
  // The settings are a team's: there is nothing to write without it.
  requiredRefs: ["team"],
  // `gatewayModel` only explains the model, which is compared as written (see workbot-settings).
  informationalFields: ["provider", "gatewayModel"],
  // The model check reads the applier's Gateway catalog; saves use the global db.
  transactional: false,
  irreversible: () => [],

  exportItems: (ctx) => readRows(ctx),
  readItems: (ctx, ids) => readRows(ctx, ids),

  /**
   * Plan time: an item that would write nothing is skipped with the reason,
   * and a model that will be left out is said before approval. The model is
   * only judged when its provider already exists here: one this same plan
   * creates has no models to look at yet, so the apply reports it.
   */
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
        // Only what this area carries goes back to the organization's. A team's own members'-agents policy is not
        // part of it and stays; a row left with nothing is removed by the save.
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
      // An AI Gateway alias from another organization is rebuilt against the provider it resolved to here.
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
          // Everything the item sets was left out with a reason (a model the applier can't use here yet): nothing
          // is created, the report says why, and importing again once it can be set creates it.
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
