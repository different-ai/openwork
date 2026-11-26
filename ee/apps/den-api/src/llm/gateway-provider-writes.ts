import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { GatewayCredentialSetTable, GatewayLiteLlmIssuedKeyTable, GatewayTrueFoundryUserTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderOauthStateTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { settleGatewayProviderUsageLimits } from "@openwork-ee/den-db/gateway-usage-limits"
import { isLiteLlmProviderId, isTrueFoundryProviderId } from "@openwork-ee/gateway-catalog"
import { GATEWAY_PROVIDER_STATUSES } from "@openwork/types/den/gateway"
import { isGatewayCustomProviderId } from "@openwork/types/den/gateway-custom-providers"
import type { GatewayProviderRemovalLimitChoice } from "@openwork/types/den/gateway-usage-limits"
import type { z } from "zod"
import { gatewayProviderSettingsSchema } from "@openwork/types/den/inference"
import { organizationFeatureEnabled } from "../features.js"
import { GatewayWriteError, resolveGatewayCatalog, validateGatewaySettings, writeGatewayModels, type GatewayProvider, type GatewayTx } from "./gateway-matrix.js"
import { publicProviderSettings, readProviderConfigNpm } from "./inference-provider-config.js"
import { deleteLiteLlmIssuedKeys, pruneLiteLlmIssuedKeys } from "./litellm-issued.js"
import { pruneLiteLlmAssignments } from "./litellm-sync.js"
import { deleteTrueFoundryTokens, pruneTrueFoundryMembers } from "./truefoundry-sync.js"
import type { ModelsDevProvider } from "./models-dev.js"

type GatewayCredential = typeof GatewayProviderCredentialTable.$inferSelect
type GatewayModelRowId = typeof GatewayProviderModelTable.$inferSelect["id"]

export { gatewayProviderSettingsSchema } from "@openwork/types/den/inference"

export function normalizedBedrockGuardrailSettings(settings: Record<string, unknown>): Record<string, unknown> {
  if (settings.guardrailIdentifier !== "" || settings.guardrailVersion !== "") return settings
  const cleared = { ...settings }
  delete cleared.guardrailIdentifier
  delete cleared.guardrailVersion
  return cleared
}

export async function requireBedrockGuardrailWrite(organizationId: string, settings: Record<string, unknown> | undefined, tx?: GatewayTx): Promise<void> {
  if (settings?.guardrailIdentifier === undefined && settings?.guardrailVersion === undefined) return
  if (!await organizationFeatureEnabled(organizationId, "bedrockGuardrails", tx ? { database: tx, lock: "share" } : {})) {
    throw new GatewayWriteError(403, "feature_disabled", "Bedrock guardrails are not enabled for this organization.")
  }
}

export function readProviderConfigName(config: Record<string, unknown>): string | null {
  return typeof config.name === "string" ? config.name : null
}

export type GatewayProviderPatch = {
  name?: string
  providerId?: string
  modelIds?: string[]
  settings?: z.infer<typeof gatewayProviderSettingsSchema>
  status?: (typeof GATEWAY_PROVIDER_STATUSES)[number]
}

export async function patchGatewayProvider(tx: GatewayTx, existing: GatewayProvider, trusted: ModelsDevProvider | null, input: GatewayProviderPatch, options: { createModelIds?: ReadonlyMap<string, GatewayModelRowId>; syncModels?: boolean } = {}): Promise<GatewayProvider> {
  if (input.providerId !== undefined && input.providerId !== existing.provider_id) throw new GatewayWriteError(409, "provider_identity_immutable", "Create a separate provider rather than moving existing groups and credentials to another catalog provider.")
  if (!trusted || trusted.id !== existing.provider_id || trusted.npm !== readProviderConfigNpm(existing.provider_config)) throw new GatewayWriteError(400, "provider_requires_configuration")
  const config = existing.provider_config
  let settings = existing.settings
  if (input.settings !== undefined) {
    const persisted: Record<string, unknown> = gatewayProviderSettingsSchema.parse(publicProviderSettings(existing.settings))
    await requireBedrockGuardrailWrite(existing.organization_id, input.settings, tx)
    settings = normalizedBedrockGuardrailSettings({ ...existing.settings, ...input.settings })
    validateGatewaySettings(config, settings)
    if (Object.entries(input.settings).some(([key, value]) => key !== "guardrailIdentifier" && key !== "guardrailVersion" && value !== persisted[key])) {
      throw isGatewayCustomProviderId(existing.provider_id)
        ? new GatewayWriteError(409, "provider_destination_immutable", "Change a custom provider's API address with PATCH /v1/inference-providers/{inferenceProviderId}/custom (the custom provider edit), which also asks for the key again for another host.")
        : new GatewayWriteError(409, "provider_destination_immutable", "Create a separate provider to change the upstream account or destination. Existing credentials cannot be relocated.")
    }
  }
  const modelIds = input.modelIds === undefined ? existing.model_ids : [...new Set(input.modelIds)]
  const catalog = resolveGatewayCatalog(trusted, modelIds, config, input.modelIds !== undefined)
  if (input.status === "disabled" && existing.status === "active") await tx.delete(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.gateway_provider_id, existing.id))
  const name = input.name ?? existing.name
  const providerConfig = isGatewayCustomProviderId(existing.provider_id) && name !== readProviderConfigName(config) ? { ...config, name } : config
  const provider: GatewayProvider = { ...existing, name, settings, provider_config: providerConfig, model_ids: modelIds, status: input.status ?? existing.status, updated_at: new Date() }
  if (options.syncModels !== false || input.modelIds !== undefined) await writeGatewayModels(tx, provider, catalog.models, { createIds: options.createModelIds })
  await tx.update(GatewayProviderTable).set({ name: provider.name, ...(settings === existing.settings ? {} : { settings }), ...(providerConfig === config ? {} : { provider_config: providerConfig }), model_ids: modelIds, status: provider.status, updated_at: provider.updated_at }).where(eq(GatewayProviderTable.id, provider.id))
  return provider
}

export async function removeGatewayCredentialSet(tx: GatewayTx, provider: GatewayProvider, id: typeof GatewayCredentialSetTable.$inferSelect["id"]): Promise<GatewayCredential[]> {
  const [set] = await tx.select().from(GatewayCredentialSetTable).where(and(eq(GatewayCredentialSetTable.id, id), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))).for("update")
  if (!set) throw new GatewayWriteError(404, "credential_set_not_found")
  const [grant] = await tx.select({ id: GatewayProviderAccessTable.id }).from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.credential_set_id, id)).limit(1)
  if (grant) throw new GatewayWriteError(409, "credential_set_in_use", "Delete referencing access grants first.")
  await tx.delete(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.credential_set_id, id))
  const rows = await tx.select().from(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.credential_set_id, id)).for("update")
  await tx.delete(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.credential_set_id, id))
  await tx.delete(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, id))
  return rows.filter((row) => row.status !== "revoked")
}

export async function removeGatewayModelGroup(tx: GatewayTx, provider: GatewayProvider, id: typeof GatewayModelGroupTable.$inferSelect["id"]): Promise<void> {
  const [group] = await tx.select().from(GatewayModelGroupTable).where(and(eq(GatewayModelGroupTable.id, id), eq(GatewayModelGroupTable.gateway_provider_id, provider.id)))
  if (!group) throw new GatewayWriteError(404, "model_group_not_found")
  const [grant] = await tx.select({ id: GatewayProviderAccessTable.id }).from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.model_group_id, id)).limit(1)
  if (grant) throw new GatewayWriteError(409, "model_group_in_use", "Delete referencing access grants first.")
  await tx.delete(GatewayModelGroupModelTable).where(eq(GatewayModelGroupModelTable.model_group_id, id))
  await tx.delete(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.id, id))
}

export async function removeGatewayAccessGrant(tx: GatewayTx, provider: GatewayProvider, id: typeof GatewayProviderAccessTable.$inferSelect["id"]): Promise<void> {
  const [grant] = await tx.select().from(GatewayProviderAccessTable).where(and(eq(GatewayProviderAccessTable.id, id), eq(GatewayProviderAccessTable.gateway_provider_id, provider.id)))
  if (!grant) throw new GatewayWriteError(404, "access_grant_not_found")
  await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, id))
  await pruneLiteLlmAssignments(tx, provider)
  if (isLiteLlmProviderId(provider.provider_id)) await pruneLiteLlmIssuedKeys(tx, provider)
  if (isTrueFoundryProviderId(provider.provider_id)) await pruneTrueFoundryMembers(tx, provider)
}

export async function removeGatewayProvider(tx: GatewayTx, provider: GatewayProvider, actor: { organizationId: GatewayProvider["organization_id"]; memberId: GatewayProvider["created_by_org_membership_id"] }, choice: GatewayProviderRemovalLimitChoice | undefined): Promise<GatewayCredential[]> {
  await settleGatewayProviderUsageLimits(tx, actor, provider.id, choice)
  if (isLiteLlmProviderId(provider.provider_id)) await deleteLiteLlmIssuedKeys(provider)
  if (isTrueFoundryProviderId(provider.provider_id)) await deleteTrueFoundryTokens(provider)
  await tx.delete(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.gateway_provider_id, provider.id))
  await tx.delete(GatewayLiteLlmIssuedKeyTable).where(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, provider.id))
  await tx.delete(GatewayTrueFoundryUserTable).where(eq(GatewayTrueFoundryUserTable.gateway_provider_id, provider.id))
  const credentials = await tx.select().from(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.gateway_provider_id, provider.id)).for("update")
  const groups = await tx.select({ id: GatewayModelGroupTable.id }).from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.gateway_provider_id, provider.id))
  if (groups.length) await tx.delete(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.model_group_id, groups.map((group) => group.id)))
  await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
  await tx.delete(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.gateway_provider_id, provider.id))
  await tx.delete(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))
  await tx.delete(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.gateway_provider_id, provider.id))
  await tx.delete(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id))
  await tx.delete(GatewayProviderTable).where(eq(GatewayProviderTable.id, provider.id))
  return credentials.filter((row) => row.status !== "revoked")
}
