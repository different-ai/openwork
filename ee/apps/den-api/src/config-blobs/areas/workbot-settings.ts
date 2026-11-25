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
  model: z.string().trim().min(1).max(255).nullable().default(null),
  provider: configRefSchema.nullable().default(null),
  gatewayModel: gatewayModelHintSchema.nullable().optional(),
  maxSteps: z.unknown().optional(),
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
  tables: [],
  naturalKeys: [ORG_SINGLETON_NATURAL_KEY],
  secretFields: [],
  informationalFields: ["provider", "gatewayModel"],
  transactional: false,
  protectedFromDelete: () => "Workbot settings can't be deleted.",
  irreversible: () => [],

  exportItems,
  readItems: (ctx, ids) => readSingleton(ctx, ids, exportItems),

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
