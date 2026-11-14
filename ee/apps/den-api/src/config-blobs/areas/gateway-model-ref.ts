/**
 * A Workbot model that comes from the AI Gateway is saved as an alias,
 * `gwm_<model group>_<credential set>_<model>`: three row ids. Those ids only
 * survive an import when they are free on the whole instance (a cloud ↔
 * self-hosted move). Copying an organization to another one on the same
 * instance gives the provider's rows new ids, and the alias in the blob then
 * names nothing in the target.
 *
 * So the areas that carry such a model (`workbot.settings`,
 * `workbot.team-settings`) export, next to the alias, what it means in words:
 * the provider (a reference), the model group's and credential set's names
 * and the catalog model id. On import the alias is rebuilt from those against
 * the target's own provider. A blob without the hint (exported before it
 * existed, or hand-written) keeps the alias as written.
 *
 * The hint is informational: it is not diffed or hashed, and the alias is
 * compared as written, so an item's `rev` is what it was before the hint
 * existed (older files and before-snapshots still restore cleanly). The same
 * model under another organization's ids therefore plans as a model change;
 * each area's `preflight` rebuilds the alias and plans it as a skip when the
 * organization already uses that model.
 *
 * Nothing here decides whether the applier may use the model: that stays the
 * save's own check (`checkWorkbotModelChoice`).
 */
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { GatewayCredentialSetTable, GatewayModelGroupTable, GatewayProviderModelTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { createGatewayModelAlias, parseGatewayModelAlias } from "@openwork-ee/utils/gateway-routing"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigRef } from "@openwork/types/den/config-blobs"
import { z } from "zod"
import type { ConfigAreaContext } from "../area.js"
import { isJsonObject } from "./route-support.js"

const PROVIDERS_AREA = "ai-gateway.providers"

/** What an AI Gateway alias names, in terms that are the same in every organization. */
export const gatewayModelHintSchema = z.object({
  /** The model group's name within the provider. */
  modelGroup: z.string().trim().min(1).max(255),
  /** The credential set's name within the provider. */
  credentialSet: z.string().trim().min(1).max(255),
  /** The catalog model id within the provider (`gpt-5.5`), not a row id. */
  modelId: z.string().trim().min(1).max(255),
}).strict()

export type GatewayModelHint = z.infer<typeof gatewayModelHintSchema>

export type GatewayModelDescription = { provider: ConfigRef; gatewayModel: GatewayModelHint | null }

/**
 * Export: the provider serving an alias and what the alias names. Null when
 * `model` is not an alias or its model row is not one of this organization's;
 * no hint when the group or set is gone.
 */
export async function describeGatewayModel(ctx: ConfigAreaContext, model: string | null | undefined): Promise<GatewayModelDescription | null> {
  const alias = model ? parseGatewayModelAlias(model) : null
  if (!alias) return null
  const [row] = await ctx.db
    .select({ providerId: GatewayProviderTable.id, providerName: GatewayProviderTable.name, modelId: GatewayProviderModelTable.model_id })
    .from(GatewayProviderModelTable)
    .innerJoin(GatewayProviderTable, eq(GatewayProviderTable.id, GatewayProviderModelTable.gateway_provider_id))
    .where(and(
      eq(GatewayProviderModelTable.id, alias.gatewayProviderModelId),
      eq(GatewayProviderTable.organization_id, normalizeDenTypeId("organization", ctx.organizationId)),
    ))
    .limit(1)
  if (!row) return null
  const provider: ConfigRef = { $ref: `${PROVIDERS_AREA}/${row.providerId}`, name: row.providerName }
  const [group] = await ctx.db
    .select({ name: GatewayModelGroupTable.name })
    .from(GatewayModelGroupTable)
    .where(and(eq(GatewayModelGroupTable.id, alias.modelGroupId), eq(GatewayModelGroupTable.gateway_provider_id, row.providerId)))
    .limit(1)
  const [set] = await ctx.db
    .select({ name: GatewayCredentialSetTable.name })
    .from(GatewayCredentialSetTable)
    .where(and(eq(GatewayCredentialSetTable.id, alias.credentialSetId), eq(GatewayCredentialSetTable.gateway_provider_id, row.providerId)))
    .limit(1)
  const hint = group && set ? gatewayModelHintSchema.safeParse({ modelGroup: group.name, credentialSet: set.name, modelId: row.modelId }) : null
  return { provider, gatewayModel: hint?.success ? hint.data : null }
}

/** The hint in a spec value, or null when it is absent or not one. */
export function readGatewayModelHint(value: unknown): GatewayModelHint | null {
  const parsed = gatewayModelHintSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The local id the engine resolved a provider reference to (`{ $ref, id }` at apply time), or null. */
export function resolvedProviderId(value: unknown): string | null {
  return isJsonObject(value) && typeof value.id === "string" && value.id ? value.id : null
}

/** The row with this id, else the only row with this name. */
function pick<Row extends { id: string; name: string }>(rows: readonly Row[], id: string, name: string): Row | null {
  const same = rows.find((row) => row.id === id)
  if (same) return same
  const named = rows.filter((row) => row.name === name)
  return named.length === 1 ? named[0] ?? null : null
}

/**
 * Import: the alias that names, in this organization, what the blob's alias
 * named in its own. `providerId` is the target's provider the blob's provider
 * reference resolved to. The alias comes back as written when there is no
 * hint, no provider, or the provider here has no such group, set or model
 * (the save then answers as it would for any model it doesn't know).
 */
export async function localGatewayModel(ctx: ConfigAreaContext, input: { model: string; providerId: string | null; hint: GatewayModelHint | null }): Promise<string> {
  const alias = parseGatewayModelAlias(input.model)
  if (!alias || !input.hint || !input.providerId || !isDenTypeId("inferenceProvider", input.providerId)) return input.model
  const providerId = normalizeDenTypeId("inferenceProvider", input.providerId)
  const [provider] = await ctx.db
    .select({ id: GatewayProviderTable.id })
    .from(GatewayProviderTable)
    .where(and(eq(GatewayProviderTable.id, providerId), eq(GatewayProviderTable.organization_id, normalizeDenTypeId("organization", ctx.organizationId))))
    .limit(1)
  if (!provider) return input.model
  const [model] = await ctx.db
    .select({ id: GatewayProviderModelTable.id })
    .from(GatewayProviderModelTable)
    .where(and(eq(GatewayProviderModelTable.gateway_provider_id, providerId), eq(GatewayProviderModelTable.model_id, input.hint.modelId)))
    .limit(1)
  const groups = await ctx.db
    .select({ id: GatewayModelGroupTable.id, name: GatewayModelGroupTable.name })
    .from(GatewayModelGroupTable)
    .where(eq(GatewayModelGroupTable.gateway_provider_id, providerId))
  const sets = await ctx.db
    .select({ id: GatewayCredentialSetTable.id, name: GatewayCredentialSetTable.name })
    .from(GatewayCredentialSetTable)
    .where(eq(GatewayCredentialSetTable.gateway_provider_id, providerId))
  const group = pick(groups, alias.modelGroupId, input.hint.modelGroup)
  const set = pick(sets, alias.credentialSetId, input.hint.credentialSet)
  if (!model || !group || !set) return input.model
  return createGatewayModelAlias({ modelGroupId: group.id, credentialSetId: set.id, gatewayProviderModelId: model.id })
}

/** How the model is named to an admin: "gpt-5.5 on Acme OpenAI" with a hint, else the id as written. */
export function gatewayModelLabel(model: string, provider: unknown, hint: unknown): string {
  const named = readGatewayModelHint(hint)
  if (!named) return model
  const name = isJsonObject(provider) && typeof provider.name === "string" && provider.name ? provider.name : null
  return name ? `${named.modelId} on ${name}` : named.modelId
}

/**
 * Why a model was left as it is, for the plan and the apply report. The
 * usual cause after an import: the model's provider arrived without its key.
 */
export function modelNotUsable(label: string): string {
  return `${label} isn't one of the models you can use in this organization yet. Check its provider's key and your access to it in AI Gateway, then import again or choose the model in Manage › Workbot.`
}
