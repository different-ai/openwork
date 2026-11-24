import { eq } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderModelTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { SandboxOrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { env } from "./env.js"
import { gatewayCatalog, GatewayWriteError, writeGatewayGrant, writeGatewayGroup, writeGatewayModels, writeGatewaySet, type GatewayProvider } from "./llm/gateway-matrix.js"
import { appLogger } from "./observability/logger.js"

export function sandboxGatewayConfigured() {
  return env.gatewayEnabled && env.sandbox.gateway !== null && (env.sandbox.gateway.apiKey !== null || Boolean(env.openRouterManagementApiKey))
}

export async function addSandboxGatewayProvider(input: {
  organizationId: DenTypeId<"organization">
  ownerMemberId: DenTypeId<"member">
  apiKey?: string
  modelIds?: string[]
}): Promise<DenTypeId<"inferenceProvider"> | null> {
  const config = env.sandbox.gateway
  const apiKey = input.apiKey ?? config?.apiKey ?? null
  if (!env.gatewayEnabled || !config || !apiKey) return null
  const modelIds = [...new Set(input.modelIds ?? config.modelIds)]
  const catalog = await gatewayCatalog(config.providerId, modelIds)
  const now = new Date()
  const provider: GatewayProvider = {
    id: createDenTypeId("inferenceProvider"),
    organization_id: input.organizationId,
    created_by_org_membership_id: input.ownerMemberId,
    provider_id: catalog.catalog.id,
    name: input.apiKey ? "Sandbox models" : `${catalog.catalog.name ?? config.providerId} (sandbox)`,
    model_ids: modelIds,
    pinned_model_ids: [],
    provider_config: catalog.config,
    settings: {},
    credential_mode: "org",
    oauth_client_id: null,
    oauth_client_secret: null,
    status: "active",
    created_at: now,
    updated_at: now,
  }
  await db.transaction(async (tx) => {
    await tx.insert(GatewayProviderTable).values(provider)
    await writeGatewayModels(tx, provider, catalog.models)
    const set = await writeGatewaySet(tx, provider, { name: "Default credentials", credentialMode: "org", credential: { kind: "api_key", secret: apiKey } }, { createdByOrgMembershipId: input.ownerMemberId })
    await tx.update(SandboxOrganizationTable).set({ sponsoredSetId: set.id }).where(eq(SandboxOrganizationTable.organizationId, provider.organization_id))
    const models = await tx.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id))
    if (models.length === 0) throw new Error("sandbox_gateway_models_missing")
    const groupId = await writeGatewayGroup(tx, provider, { name: "All Allowed Models", modelIds: models.map(model => model.model_id) })
    await writeGatewayGrant(tx, provider, { modelGroupId: groupId, credentialSetId: set.id, audience: { type: "organization" } })
  })
  appLogger.info("sandbox gateway provider added", { organization_id: input.organizationId, provider_id: config.providerId, models: modelIds.length })
  return provider.id
}

export async function sandboxGatewayModelOptions() {
  const config = env.sandbox.gateway
  if (!config) return null
  const catalog = await gatewayCatalog(config.providerId, [])
  return { providerId: config.providerId, models: catalog.models.map(model => ({ id: model.id, name: model.name })) }
}

export async function assertSandboxGatewayModels(modelIds: string[]) {
  const config = env.sandbox.gateway
  if (!config) throw new GatewayWriteError(400, "sandbox_gateway_missing", "This deployment has no sandbox model key, so sandboxes get included models only.")
  await gatewayCatalog(config.providerId, modelIds)
}
