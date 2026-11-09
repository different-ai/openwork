/**
 * Config-blob area `workbot.settings` (Manage › Workbot): one item, the
 * organization's default model for its cloud agents (Workbot, the Slack
 * assistant and cloud Automations set to the cloud default), stored in
 * `organization.metadata.workbot.model`.
 *
 * - `model`: the saved model id, or null for the default. It is an AI
 *   Gateway alias (`gwm_<group>_<set>_<model>`, which survives a move
 *   because `ai-gateway.providers` reuses its TypeIDs) or a managed OpenWork
 *   model id.
 * - `provider`: for an AI Gateway alias, a reference to the AI Gateway
 *   provider serving it. It orders the import after that provider and tells
 *   readers where the model comes from; apply does not write it.
 * - Never carried: the Workbot Slack installation (signing secret, bot token
 *   and workspace binding), the model test results and the readiness checks
 *   (runtime). The proactive agent settings are `workbot.proactive`.
 *
 * Apply goes through PUT /v1/org/workbot-settings's own function
 * (`saveWorkbotDefaultModel`): the applier's own servable models only, the
 * managed Luna starter saved as the default.
 */
import { eq } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderModelTable, GatewayProviderTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { parseGatewayModelAlias } from "@openwork-ee/utils/gateway-routing"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { configRefSchema, type ConfigRef } from "@openwork/types/den/config-blobs"
import { readWorkbotModel } from "@openwork/types/den/workbot-settings"
import { z } from "zod"
import { RUNNER_UNAVAILABLE_MESSAGE, UNKNOWN_MODEL_MESSAGE, saveWorkbotDefaultModel } from "../../routes/org/workbot-settings.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
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
}).strict()

const applySpecSchema = z.object({
  model: z.string().trim().min(1).max(255).nullable().default(null),
  provider: z.unknown().optional(),
}).strict()

async function providerRef(ctx: ConfigAreaContext, model: string | null): Promise<ConfigRef | null> {
  const alias = model ? parseGatewayModelAlias(model) : null
  if (!alias) return null
  const [row] = await ctx.db
    .select({ id: GatewayProviderTable.id, name: GatewayProviderTable.name })
    .from(GatewayProviderModelTable)
    .innerJoin(GatewayProviderTable, eq(GatewayProviderTable.id, GatewayProviderModelTable.gateway_provider_id))
    .where(eq(GatewayProviderModelTable.id, alias.gatewayProviderModelId))
    .limit(1)
  if (!row) return null
  return { $ref: `${PROVIDERS_AREA}/${row.id}`, name: row.name }
}

async function exportItems(ctx: ConfigAreaContext): Promise<ConfigItem[]> {
  const [row] = await ctx.db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", ctx.organizationId)))
    .limit(1)
  if (!row) return []
  const model = readWorkbotModel(row.metadata)
  return [{ id: ctx.organizationId, name: ITEM_NAME, spec: { model, provider: await providerRef(ctx, model) } }]
}

export const workbotSettingsArea = defineConfigArea({
  key: AREA,
  label: "Workbot",
  path: ["Manage", "Workbot"],
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
  informationalFields: ["provider"],
  // saveWorkbotDefaultModel reads the applier's Gateway catalog and writes through updateOrganizationMetadata (global db).
  transactional: false,
  protectedFromDelete: () => "Workbot settings can't be deleted.",
  irreversible: () => [],

  exportItems,
  readItems: (ctx, ids) => readSingleton(ctx, ids, exportItems),

  async apply(ctx, op) {
    const steps = new ApplySteps()
    if (op.kind === "delete") throw steps.fail("not_deletable", "Workbot settings can't be deleted.")
    const localId = ctx.organizationId
    const parsed = applySpecSchema.safeParse(specObject(op.item.spec))
    if (!parsed.success) throw steps.fail("invalid_spec", parsed.error.issues[0]?.message ?? "Invalid Workbot settings.", "model")
    const next = parsed.data.model
    if (!touches(op, "model")) return { localId, steps: [] }
    const [current] = await exportItems(ctx)
    if (!current) throw steps.fail("organization_not_found", "The organization no longer exists.", undefined, 404)
    if (current.spec.model === next) return { localId, steps: [] }

    await steps.run({ action: "set", target: "model", detail: next ?? "default" }, "model", async () => {
      await requireActorPermission(ctx, "inference.manage")
      const saved = await saveWorkbotDefaultModel({ organizationId: normalizeDenTypeId("organization", ctx.organizationId), userId: ctx.actor.userId, model: next })
      if (saved.choice === "runner_unavailable") throw new ConfigApplyError("workbot_runner_unavailable", RUNNER_UNAVAILABLE_MESSAGE, 503)
      if (saved.choice === "unknown_model") {
        throw new ConfigApplyError("unknown_model", `${UNKNOWN_MODEL_MESSAGE} (${next ?? "default"} isn't one of the models you can use in this organization.)`, 400)
      }
    })
    return { localId, steps: steps.done }
  },
})
