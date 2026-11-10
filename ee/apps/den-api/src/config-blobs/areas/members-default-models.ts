/**
 * Config-blob area `members.default-models`: the Models tab of Everyone and
 * of each team (the model new desktop chats start with).
 *
 * - One item per stored choice: the organization default (key `everyone`) or
 *   one team's override (`team` references `members.teams`).
 * - `provider` is `"openwork"` (OpenWork Models) or a reference to the
 *   provider: `ai-gateway.byok/<lpr_…>` or `ai-gateway.providers/<ipr_…>`,
 *   so it is remapped to the target's provider on import.
 * - Apply checks the model against the target's own models exactly as the
 *   routes do (routes/org/default-model.ts: checkDefaultModelChoice over
 *   listDefaultModelOptions) and writes through saveDefaultModel.
 */
import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderTable, LlmProviderTable, OrgDefaultModelTable, TeamTable } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { configRefSchema, type ConfigApplyStep, type ConfigRef } from "@openwork/types/den/config-blobs"
import { DEFAULT_MODEL_EVERYONE_SCOPE, type DefaultModelChoice } from "@openwork/types/den/default-model"
import { z } from "zod"
import { checkDefaultModelChoice, listDefaultModelOptions, OPENWORK_MODELS_PROVIDER_ID, saveDefaultModel } from "../../default-model.js"
import { DEFAULT_MODEL_SOURCE_UNAVAILABLE_MESSAGE, UNKNOWN_DEFAULT_MODEL_MESSAGE } from "../../routes/org/default-model.js"
import { isDuplicateEntry } from "../../routes/org/declarative.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import {
  applyFailure,
  asItemError,
  changesScope,
  requireActorPermission,
  resolveItemScope,
  sameScope,
  scopeLabel,
  scopeNaturalKey,
  scopeUniqueKey,
  previousScopeSpec,
  type TeamScope,
} from "./members-scope-support.js"
import { isJsonObject, specObject, teamRef } from "./route-support.js"

const AREA = "members.default-models"
const BYOK_AREA = "ai-gateway.byok"
const GATEWAY_AREA = "ai-gateway.providers"

const specSchema = z.object({
  /** null: the organization default. Otherwise the team whose override this is. */
  team: configRefSchema.nullable().default(null),
  /** `openwork` (OpenWork Models), or the organization's provider (`ai-gateway.byok/…`) or AI Gateway provider (`ai-gateway.providers/…`). */
  provider: z.union([z.literal(OPENWORK_MODELS_PROVIDER_ID), configRefSchema]),
  /** The model id; for the AI Gateway, the catalog model id. */
  modelId: z.string().trim().min(1).max(255),
}).strict()

function providerRef(providerId: string, names: Map<string, string>): ConfigRef | typeof OPENWORK_MODELS_PROVIDER_ID | null {
  if (providerId === OPENWORK_MODELS_PROVIDER_ID) return OPENWORK_MODELS_PROVIDER_ID
  const area = providerId.startsWith(`${denTypeIdPrefixes.llmProvider}_`) ? BYOK_AREA
    : providerId.startsWith(`${denTypeIdPrefixes.inferenceProvider}_`) ? GATEWAY_AREA
      : null
  if (!area) return null
  const name = names.get(providerId)
  return name ? { $ref: `${area}/${providerId}`, name } : { $ref: `${area}/${providerId}` }
}

async function providerNames(ctx: ConfigAreaContext, providerIds: string[]): Promise<Map<string, string>> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const llm = providerIds.flatMap((id) => (id.startsWith(`${denTypeIdPrefixes.llmProvider}_`) ? [normalizeDenTypeId("llmProvider", id)] : []))
  const gateway = providerIds.flatMap((id) => (id.startsWith(`${denTypeIdPrefixes.inferenceProvider}_`) ? [normalizeDenTypeId("inferenceProvider", id)] : []))
  const [llmRows, gatewayRows] = await Promise.all([
    llm.length > 0
      ? ctx.db.select({ id: LlmProviderTable.id, name: LlmProviderTable.name }).from(LlmProviderTable).where(and(eq(LlmProviderTable.organizationId, organizationId), inArray(LlmProviderTable.id, llm)))
      : Promise.resolve([]),
    gateway.length > 0
      ? ctx.db.select({ id: GatewayProviderTable.id, name: GatewayProviderTable.name }).from(GatewayProviderTable).where(and(eq(GatewayProviderTable.organization_id, organizationId), inArray(GatewayProviderTable.id, gateway)))
      : Promise.resolve([]),
  ])
  return new Map<string, string>([...llmRows, ...gatewayRows].map((row) => [row.id, row.name]))
}

async function readChoices(ctx: ConfigAreaContext, ids?: string[]): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const rowIds = ids?.flatMap((id) => {
    try {
      return [normalizeDenTypeId("orgDefaultModel", id)]
    } catch {
      return []
    }
  })
  if (rowIds && rowIds.length === 0) return []
  const rows = await ctx.db
    .select({
      id: OrgDefaultModelTable.id,
      teamId: OrgDefaultModelTable.teamId,
      scopeKey: OrgDefaultModelTable.scopeKey,
      providerId: OrgDefaultModelTable.providerId,
      modelId: OrgDefaultModelTable.modelId,
      teamName: TeamTable.name,
    })
    .from(OrgDefaultModelTable)
    .leftJoin(TeamTable, eq(OrgDefaultModelTable.teamId, TeamTable.id))
    .where(and(eq(OrgDefaultModelTable.organizationId, organizationId), ...(rowIds ? [inArray(OrgDefaultModelTable.id, rowIds)] : [])))
    .orderBy(asc(OrgDefaultModelTable.scopeKey), asc(OrgDefaultModelTable.id))
  const names = await providerNames(ctx, rows.map((row) => row.providerId))
  const items = rows.flatMap((row): ConfigItem[] => {
    const provider = providerRef(row.providerId, names)
    // A provider id the area can't reference (not openwork / lpr_ / ipr_) has nothing to remap it to.
    if (provider === null) return []
    if (row.scopeKey === DEFAULT_MODEL_EVERYONE_SCOPE) {
      return [{ id: row.id, key: DEFAULT_MODEL_EVERYONE_SCOPE, name: "Everyone", spec: { team: null, provider, modelId: row.modelId } }]
    }
    if (!row.teamId || row.teamName === null) return []
    return [{ id: row.id, key: null, name: row.teamName, spec: { team: teamRef(row.teamId, row.teamName), provider, modelId: row.modelId } }]
  })
  return items.sort((left, right) => (left.key === DEFAULT_MODEL_EVERYONE_SCOPE ? -1 : right.key === DEFAULT_MODEL_EVERYONE_SCOPE ? 1 : left.name.localeCompare(right.name) || left.id.localeCompare(right.id)))
}

function choiceOf(spec: { [key: string]: unknown }): DefaultModelChoice {
  const modelId = typeof spec.modelId === "string" ? spec.modelId.trim() : ""
  if (!modelId || modelId.length > 255) applyFailure({ code: "invalid_spec", message: "A default model needs a model id.", field: "modelId" })
  const provider = spec.provider
  if (provider === OPENWORK_MODELS_PROVIDER_ID) return { providerId: OPENWORK_MODELS_PROVIDER_ID, modelId }
  if (!isJsonObject(provider) || typeof provider.$ref !== "string") {
    applyFailure({ code: "invalid_spec", message: `provider must be "${OPENWORK_MODELS_PROVIDER_ID}" or a provider reference.`, field: "provider" })
  }
  if (typeof provider.id !== "string" || !provider.id) {
    applyFailure({ code: "ref_unresolved", message: `The provider reference ${provider.$ref} was not resolved.`, field: "provider" })
  }
  return { providerId: provider.id, modelId }
}

async function currentRow(ctx: ConfigAreaContext, scope: TeamScope) {
  const [row] = await ctx.db
    .select({ id: OrgDefaultModelTable.id, providerId: OrgDefaultModelTable.providerId, modelId: OrgDefaultModelTable.modelId })
    .from(OrgDefaultModelTable)
    .where(and(
      eq(OrgDefaultModelTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId)),
      eq(OrgDefaultModelTable.scopeKey, scope.kind === "everyone" ? DEFAULT_MODEL_EVERYONE_SCOPE : scope.teamId),
    ))
    .limit(1)
  return row ?? null
}

/** The route's check: only models the target organization has. */
async function checkChoice(ctx: ConfigAreaContext, choice: DefaultModelChoice) {
  const check = checkDefaultModelChoice(choice, await listDefaultModelOptions(normalizeDenTypeId("organization", ctx.organizationId)))
  if (check === "unknown_model") {
    applyFailure({ code: "unknown_model", message: `${choice.modelId}: ${UNKNOWN_DEFAULT_MODEL_MESSAGE}`, field: "modelId", status: 400 })
  }
  if (check === "source_unavailable") {
    applyFailure({ code: "model_source_unavailable", message: DEFAULT_MODEL_SOURCE_UNAVAILABLE_MESSAGE, field: "provider", status: 503 })
  }
}

async function save(ctx: ConfigAreaContext, scope: TeamScope, model: DefaultModelChoice | null, id?: string) {
  const write = () => saveDefaultModel({
    organizationId: normalizeDenTypeId("organization", ctx.organizationId),
    teamId: scope.kind === "team" ? normalizeDenTypeId("team", scope.teamId) : null,
    model,
    updatedByOrgMemberId: normalizeDenTypeId("member", ctx.actor.memberId),
    ...(id ? { id: normalizeDenTypeId("orgDefaultModel", id) } : {}),
  })
  try {
    await write()
  } catch (error) {
    // As the route: a concurrent first save of the same scope created the row; replace it.
    if (!isDuplicateEntry(error)) throw error
    await write()
  }
}

function preferredRowId(id: string | undefined) {
  if (!id) return undefined
  try {
    return normalizeDenTypeId("orgDefaultModel", id)
  } catch {
    return undefined
  }
}

function describeChoice(choice: DefaultModelChoice) {
  return `${choice.providerId === OPENWORK_MODELS_PROVIDER_ID ? "OpenWork Models" : choice.providerId} / ${choice.modelId}`
}

export const membersDefaultModelsArea = defineConfigArea({
  key: AREA,
  label: "Default models",
  path: ["Members", "Teams", "Models"],
  idPrefix: denTypeIdPrefixes.orgDefaultModel,
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams", BYOK_AREA, GATEWAY_AREA],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "inference.view",
  managePermission: "inference.manage",
  tables: ["org_default_model"],
  naturalKeys: [{ label: "scope", get: scopeNaturalKey }],
  uniqueFields: [{ label: "scope", get: scopeUniqueKey }],
  informationalName: true,
  secretFields: [],
  // saveDefaultModel and the model check read and write the global db.
  transactional: false,
  irreversible: () => [],

  exportItems: (ctx) => readChoices(ctx),
  readItems: (ctx, ids) => readChoices(ctx, ids),

  async apply(ctx, op) {
    const steps: ConfigApplyStep[] = []
    try {
      await requireActorPermission(ctx, "inference.manage")

      if (op.kind === "delete") {
        const scope = await resolveItemScope(ctx, previousScopeSpec(op.previous))
        const current = await currentRow(ctx, scope)
        if (!current) return { localId: op.targetId, steps }
        const step: ConfigApplyStep = { action: "delete", target: scopeLabel(scope), detail: describeChoice(current) }
        await save(ctx, scope, null).catch((error: unknown) => applyFailure({ code: "write_failed", message: errorMessage(error), step }))
        steps.push(step)
        return { localId: op.targetId, steps }
      }

      const spec = specObject(op.item.spec)
      const scope = await resolveItemScope(ctx, spec)
      const choice = choiceOf(spec)
      const current = await currentRow(ctx, scope)

      if (op.kind === "create") {
        if (current) {
          applyFailure({ code: "default_model_exists", message: `${scopeLabel(scope)} already has a default model here; match this item to it instead of creating one.`, field: "team", status: 409 })
        }
        await checkChoice(ctx, choice)
        const id = preferredRowId(op.preferredId)
        const step: ConfigApplyStep = { action: "create", target: scopeLabel(scope), detail: describeChoice(choice) }
        await save(ctx, scope, choice, id).catch((error: unknown) => applyFailure({ code: "write_failed", message: errorMessage(error), step }))
        steps.push(step)
        const created = await currentRow(ctx, scope)
        if (!created) applyFailure({ code: "unexpected_state", message: `${scopeLabel(scope)}'s default model was not saved.` }, steps)
        return { localId: created.id, steps }
      }

      if (changesScope(op.changes) || !sameScope(scope, previousScopeSpec(op.previous))) {
        applyFailure({ code: "scope_changed", message: "A default model can't move to another team; remove it there and set it on the other team.", field: "team" })
      }
      if (!current || current.id !== op.targetId) {
        applyFailure({ code: "default_model_not_found", message: `${scopeLabel(scope)}'s default model changed since the plan; analyze again.`, status: 409 })
      }
      if (current.providerId === choice.providerId && current.modelId === choice.modelId) return { localId: current.id, steps }
      await checkChoice(ctx, choice)
      const step: ConfigApplyStep = { action: "update", target: scopeLabel(scope), detail: describeChoice(choice) }
      await save(ctx, scope, choice).catch((error: unknown) => applyFailure({ code: "write_failed", message: errorMessage(error), step }))
      steps.push(step)
      return { localId: current.id, steps }
    } catch (error) {
      throw asItemError(error, steps)
    }
  },
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The default model could not be saved."
}
