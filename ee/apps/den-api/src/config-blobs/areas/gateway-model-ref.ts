import { and, eq } from "@openwork-ee/den-db/drizzle"
import { GatewayCredentialSetTable, GatewayModelGroupTable, GatewayProviderModelTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { createGatewayModelAlias, parseGatewayModelAlias } from "@openwork-ee/gateway-catalog"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigRef } from "@openwork/types/den/config-blobs"
import { z } from "zod"
import type { ConfigAreaContext } from "../area.js"
import { isJsonObject } from "./route-support.js"

const PROVIDERS_AREA = "ai-gateway.providers"

export const gatewayModelHintSchema = z.object({
  modelGroup: z.string().trim().min(1).max(255),
  credentialSet: z.string().trim().min(1).max(255),
  modelId: z.string().trim().min(1).max(255),
}).strict()

export type GatewayModelHint = z.infer<typeof gatewayModelHintSchema>

export type GatewayModelDescription = { provider: ConfigRef; gatewayModel: GatewayModelHint | null }

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

export function readGatewayModelHint(value: unknown): GatewayModelHint | null {
  const parsed = gatewayModelHintSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function resolvedProviderId(value: unknown): string | null {
  return isJsonObject(value) && typeof value.id === "string" && value.id ? value.id : null
}

function pick<Row extends { id: string; name: string }>(rows: readonly Row[], id: string, name: string): Row | null {
  const same = rows.find((row) => row.id === id)
  if (same) return same
  const named = rows.filter((row) => row.name === name)
  return named.length === 1 ? named[0] ?? null : null
}

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

export function gatewayModelLabel(model: string, provider: unknown, hint: unknown): string {
  const named = readGatewayModelHint(hint)
  if (!named) return model
  const name = isJsonObject(provider) && typeof provider.name === "string" && provider.name ? provider.name : null
  return name ? `${named.modelId} on ${name}` : named.modelId
}

export function modelNotUsable(label: string): string {
  return `${label} isn't one of the models you can use in this organization yet. Check its provider's key and your access to it in AI Gateway, then import again or choose the model in Manage › Workbot.`
}
