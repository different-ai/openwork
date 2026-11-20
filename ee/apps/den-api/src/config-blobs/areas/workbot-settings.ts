/**
 * Config-blob area `workbot.settings` (Manage › Workbot): one item, the
 * organization's default model for its cloud agents (Workbot, the Slack
 * assistant and cloud Automations set to the cloud default), stored in
 * `organization.metadata.workbot.model`.
 *
 * - `model`: the saved model id, or null for the default. It is an AI
 *   Gateway alias (`gwm_<group>_<set>_<model>`: row ids, which
 *   `ai-gateway.providers` only keeps when they are free on the instance) or
 *   a managed OpenWork model id.
 * - `provider`: for an AI Gateway alias, a reference to the AI Gateway
 *   provider serving it. It orders the import after that provider and names
 *   the provider the model is found in on import; apply does not write it.
 * - `gatewayModel`: for an AI Gateway alias, what it names in words (model
 *   group, credential set, catalog model id). An import into an organization
 *   whose provider rows have other ids (a copy on the same instance) rebuilds
 *   the alias from it; the model is compared by it, so the copy reads as
 *   unchanged. Absent in files exported before it existed: those keep the
 *   alias as written (areas/gateway-model-ref.ts).
 * - `maxSteps`: in files exported while Workbot had a step limit. Read so
 *   those files still import; never applied and no longer exported.
 * - `enabled`: whether Workbot is on for everyone whose teams don't say
 *   otherwise (`organization.metadata.workbot.enabled`, absent = on). Always
 *   exported as stored; only applied where `workbotTeamSettings` is on (its
 *   route, PUT /v1/org/workbot-settings/everyone, needs it), otherwise skipped
 *   with a warning. Teams' own settings are `workbot.team-settings`.
 * - Never carried: the Workbot Slack installation (signing secret, bot token
 *   and workspace binding), the model test results and the readiness checks
 *   (runtime). The proactive agent settings are `workbot.proactive`.
 *
 * Apply goes through PUT /v1/org/workbot-settings's own function
 * (`saveWorkbotDefaultModel`; `enabled` through `saveWorkbotEnabledForEveryone`): the applier's own servable models only, the
 * managed Luna starter saved as the default. A model the applier can't use
 * here yet (typically: its provider was imported without its key) is left as
 * it is with a warning, at plan time when it can be known, so the rest of the
 * import still runs; importing again once the model is usable sets it.
 */
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { configRefSchema } from "@openwork/types/den/config-blobs"
import { readWorkbotModel } from "@openwork/types/den/workbot-settings"
import { readWorkbotEnabled } from "@openwork/types/den/workbot-team-settings"
import { z } from "zod"
import { RUNNER_UNAVAILABLE_MESSAGE, saveWorkbotDefaultModel } from "../../routes/org/workbot-settings.js"
import { saveWorkbotEnabledForEveryone } from "../../routes/org/workbot-team-settings.js"
import { checkWorkbotModelChoice, workbotModelCatalog } from "../../workbot/model.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import {
  describeGatewayModel,
  gatewayModelHintSchema,
  gatewayModelLabel,
  localGatewayModel,
  modelNotUsable,
  readGatewayModelHint,
  resolvedProviderId,
} from "./gateway-model-ref.js"
import { ApplySteps, ORG_SINGLETON_NATURAL_KEY, readSingleton, requireActorPermission, touches } from "./org-singleton.js"
import { ConfigApplyError, specObject } from "./route-support.js"

const AREA = "workbot.settings"
const ITEM_NAME = "Workbot settings"
const PROVIDERS_AREA = "ai-gateway.providers"

const workbotSettingsSpecSchema = z.object({
  /** Null: Workbot's default (managed Luna, else the AI Gateway default). */
  model: z.string().trim().min(1).max(255).nullable().default(null),
  /** The AI Gateway provider serving `model`; informational, orders the import after it. */
  provider: configRefSchema.nullable().default(null),
  /** What an AI Gateway `model` names (group, credential set, catalog model id), so it is found again where ids differ. */
  gatewayModel: gatewayModelHintSchema.nullable().optional(),
  /** From files exported while Workbot had a step limit: read, never applied. */
  maxSteps: z.unknown().optional(),
  /** Whether Workbot is on for everyone whose teams don't set their own (workbotTeamSettings). */
  enabled: z.boolean().default(true),
}).strict()

const applySpecSchema = z.object({
  model: z.string().trim().min(1).max(255).nullable().default(null),
  provider: z.unknown().optional(),
  gatewayModel: z.unknown().optional(),
  maxSteps: z.unknown().optional(),
  enabled: z.boolean().default(true),
}).strict()

async function exportItems(ctx: ConfigAreaContext): Promise<ConfigItem[]> {
  const [row] = await ctx.db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", ctx.organizationId)))
    .limit(1)
  if (!row) return []
  const model = readWorkbotModel(row.metadata)
  const gateway = await describeGatewayModel(ctx, model)
  return [{
    id: ctx.organizationId,
    name: ITEM_NAME,
    spec: {
      model,
      provider: gateway?.provider ?? null,
      ...(gateway?.gatewayModel ? { gatewayModel: gateway.gatewayModel } : {}),
      enabled: readWorkbotEnabled(row.metadata),
    },
  }]
}

export const workbotSettingsArea = defineConfigArea({
  key: AREA,
  label: "Workbot",
  path: ["Manage", "Workbot", "Settings"],
  specVersion: 1,
  specSchema: workbotSettingsSpecSchema,
  dependsOn: [PROVIDERS_AREA],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "inference.view",
  managePermission: "inference.manage",
  // organization.metadata.workbot.model (the organization table is owned by settings.general).
  tables: [],
  naturalKeys: [ORG_SINGLETON_NATURAL_KEY],
  secretFields: [],
  // `gatewayModel` only explains `model`. The model itself is compared as written, so the hash of an item is what
  // it was before the hint existed; the same model under another organization's ids is settled by `preflight`.
  informationalFields: ["provider", "gatewayModel"],
  // saveWorkbotDefaultModel reads the applier's Gateway catalog and writes through updateOrganizationMetadata (global db).
  transactional: false,
  protectedFromDelete: () => "Workbot settings can't be deleted.",
  irreversible: () => [],

  exportItems,
  readItems: (ctx, ids) => readSingleton(ctx, ids, exportItems),

  /**
   * Plan time: a model change that would write nothing (the model is already
   * saved here, or the applier can't use it here yet) is said before approval,
   * and skipped when the model is all the item changes. Only when the
   * provider already exists here: one this same plan creates has no models
   * to look at yet, so the apply reports it.
   */
  async preflight(ctx, op, info) {
    if (op.kind === "delete" || !touches(op, "model")) return null
    const parsed = applySpecSchema.safeParse(specObject(op.item.spec))
    if (!parsed.success || parsed.data.model === null) return null
    const provider = info.refs?.find((ref) => ref.path === "provider")
    if (provider && provider.resolution !== "target") return null
    const hint = readGatewayModelHint(parsed.data.gatewayModel)
    const next = await localGatewayModel(ctx, { model: parsed.data.model, providerId: provider?.id ?? null, hint })
    const onlyModel = op.kind === "update" && op.secretPaths.length === 0 && op.changes.length > 0 && op.changes.every((change) => change.path === "model")
    const [current] = await exportItems(ctx)
    if (current && current.spec.model === next) return onlyModel ? { skip: "Workbot already uses this model here." } : null
    const catalog = await workbotModelCatalog({ organizationId: normalizeDenTypeId("organization", ctx.organizationId), userId: ctx.actor.userId }).catch(() => null)
    if (checkWorkbotModelChoice(next, catalog) !== "unknown_model") return null
    const label = gatewayModelLabel(parsed.data.model, parsed.data.provider, hint)
    return onlyModel ? { skip: modelNotUsable(label) } : { warnings: [`Workbot's model will not be changed: ${modelNotUsable(label)}`] }
  },

  async apply(ctx, op) {
    const steps = new ApplySteps()
    if (op.kind === "delete") throw steps.fail("not_deletable", "Workbot settings can't be deleted.")
    const localId = ctx.organizationId
    const parsed = applySpecSchema.safeParse(specObject(op.item.spec))
    if (!parsed.success) throw steps.fail("invalid_spec", parsed.error.issues[0]?.message ?? "Invalid Workbot settings.", "model")
    const warnings: string[] = []
    const wantsModel = touches(op, "model")
    const wantsEnabled = touches(op, "enabled")
    if (!wantsModel && !wantsEnabled) return { localId, steps: [] }
    const [current] = await exportItems(ctx)
    if (!current) throw steps.fail("organization_not_found", "The organization no longer exists.", undefined, 404)
    // An AI Gateway alias from another organization is rebuilt against the provider it resolved to here.
    const hint = readGatewayModelHint(parsed.data.gatewayModel)
    const next = parsed.data.model === null || !wantsModel
      ? parsed.data.model
      : await localGatewayModel(ctx, { model: parsed.data.model, providerId: resolvedProviderId(parsed.data.provider), hint })
    const label = parsed.data.model === null ? "default" : gatewayModelLabel(parsed.data.model, parsed.data.provider, hint)
    const modelChanges = wantsModel && current.spec.model !== next
    const nextEnabled = parsed.data.enabled
    const enabledChanges = wantsEnabled && current.spec.enabled !== nextEnabled

    if (modelChanges) {
      const step = { action: "set" as const, target: "model", detail: label }
      let usable = true
      await steps.run(step, "model", async () => {
        await requireActorPermission(ctx, "inference.manage")
        const saved = await saveWorkbotDefaultModel({ organizationId: normalizeDenTypeId("organization", ctx.organizationId), userId: ctx.actor.userId, model: next })
        if (saved.choice === "runner_unavailable") throw new ConfigApplyError("workbot_runner_unavailable", RUNNER_UNAVAILABLE_MESSAGE, 503)
        usable = saved.choice !== "unknown_model"
      })
      // A model the applier can't use here (yet) is not worth the rest of the import: nothing was written for it,
      // the model stays as it is and the report says so.
      if (!usable) {
        steps.done.splice(steps.done.indexOf(step), 1)
        warnings.push(`Workbot's model was not changed: ${modelNotUsable(label)}`)
      }
    }
    if (enabledChanges) {
      await steps.run({ action: "set", target: "enabled", detail: nextEnabled ? "on" : "off" }, "enabled", async () => {
        await requireActorPermission(ctx, "inference.manage")
        await saveWorkbotEnabledForEveryone(normalizeDenTypeId("organization", ctx.organizationId), nextEnabled)
      })
    }
    return { localId, steps: steps.done, ...(warnings.length ? { warnings } : {}) }
  },
})
