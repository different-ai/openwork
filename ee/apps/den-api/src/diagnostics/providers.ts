import { and, eq, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import {
  GatewayCredentialSetTable,
  GatewayProviderCredentialTable,
  GatewayProviderModelTable,
  GatewayProviderTable,
  LlmProviderMemberCredentialTable,
  LlmProviderModelTable,
  LlmProviderTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import { freeInferenceOrganizationAllowed } from "@openwork/types/den/inference"
import { db } from "../db.js"
import { env } from "../env.js"
import { gatewayManagementUnavailable } from "../gateway-deployment.js"
import { organizationAllowsManagedModels, readInferenceMetadata } from "../inference.js"
import {
  buildGatewayProviderTargets,
  buildLegacyProviderTargets,
  evaluateProviderTargets,
  openWorkModelsTarget,
  type EvaluatedProvider,
  type ProviderTarget,
} from "./provider-checks.js"

type OrganizationId = DenTypeId<"organization">

/** Whether members get OpenWork-managed models (paid Models or free Auto). No side effects. */
async function openWorkModelsManaged(organizationId: OrganizationId): Promise<boolean> {
  const [organization] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId)).limit(1)
  if (!organization) return false
  const paid = readInferenceMetadata(organization.metadata ?? null)?.enabled === true
  const free = env.inferenceFree.enabled && freeInferenceOrganizationAllowed(organization.metadata)
  if (!paid && !free) return false
  return organizationAllowsManagedModels(organizationId)
}

async function gatewayTargets(organizationId: OrganizationId, now: number): Promise<ProviderTarget[]> {
  const providers = await db.select({
    id: GatewayProviderTable.id,
    provider_id: GatewayProviderTable.provider_id,
    name: GatewayProviderTable.name,
    model_ids: GatewayProviderTable.model_ids,
    provider_config: GatewayProviderTable.provider_config,
    settings: GatewayProviderTable.settings,
    status: GatewayProviderTable.status,
    updated_at: GatewayProviderTable.updated_at,
  }).from(GatewayProviderTable)
    .where(and(eq(GatewayProviderTable.organization_id, organizationId), eq(GatewayProviderTable.status, "active")))
    .limit(100)
  if (!providers.length) return []
  const providerIds = providers.map((provider) => provider.id)
  const credentialColumns = {
    gateway_provider_id: GatewayProviderCredentialTable.gateway_provider_id,
    credential_set_id: GatewayProviderCredentialTable.credential_set_id,
    subject: GatewayProviderCredentialTable.subject,
    org_membership_id: GatewayProviderCredentialTable.org_membership_id,
    kind: GatewayProviderCredentialTable.kind,
    status: GatewayProviderCredentialTable.status,
    expires_at: GatewayProviderCredentialTable.expires_at,
    last_error: GatewayProviderCredentialTable.last_error,
    updated_at: GatewayProviderCredentialTable.updated_at,
  }
  const scope = and(eq(GatewayProviderCredentialTable.organization_id, organizationId), inArray(GatewayProviderCredentialTable.gateway_provider_id, providerIds))
  const [sets, orgCredentials, memberCredentials, models] = await Promise.all([
    db.select({
      id: GatewayCredentialSetTable.id,
      gateway_provider_id: GatewayCredentialSetTable.gateway_provider_id,
      name: GatewayCredentialSetTable.name,
      credential_mode: GatewayCredentialSetTable.credential_mode,
      status: GatewayCredentialSetTable.status,
    }).from(GatewayCredentialSetTable).where(inArray(GatewayCredentialSetTable.gateway_provider_id, providerIds)),
    // Only organization-held credentials are decrypted; member secrets are never read.
    db.select({ ...credentialColumns, secret: GatewayProviderCredentialTable.secret }).from(GatewayProviderCredentialTable)
      .where(and(scope, isNull(GatewayProviderCredentialTable.org_membership_id))),
    db.select(credentialColumns).from(GatewayProviderCredentialTable)
      .where(and(scope, isNotNull(GatewayProviderCredentialTable.org_membership_id))),
    db.select({ gateway_provider_id: GatewayProviderModelTable.gateway_provider_id, model_id: GatewayProviderModelTable.model_id })
      .from(GatewayProviderModelTable).where(inArray(GatewayProviderModelTable.gateway_provider_id, providerIds)),
  ])
  return buildGatewayProviderTargets({
    providers,
    sets,
    credentials: [...orgCredentials, ...memberCredentials.map((row) => ({ ...row, secret: null }))],
    models,
    now,
  })
}

async function legacyTargets(organizationId: OrganizationId): Promise<ProviderTarget[]> {
  const providers = await db.select({
    id: LlmProviderTable.id,
    source: LlmProviderTable.source,
    providerId: LlmProviderTable.providerId,
    name: LlmProviderTable.name,
    providerConfig: LlmProviderTable.providerConfig,
    credentialMode: LlmProviderTable.credentialMode,
    apiKey: LlmProviderTable.apiKey,
    updatedAt: LlmProviderTable.updatedAt,
  }).from(LlmProviderTable).where(eq(LlmProviderTable.organizationId, organizationId)).limit(100)
  if (!providers.length) return []
  const providerIds = providers.map((provider) => provider.id)
  const [memberCredentials, models] = await Promise.all([
    db.select({
      llmProviderId: LlmProviderMemberCredentialTable.llmProviderId,
      orgMembershipId: LlmProviderMemberCredentialTable.orgMembershipId,
      state: LlmProviderMemberCredentialTable.state,
    }).from(LlmProviderMemberCredentialTable).where(and(
      eq(LlmProviderMemberCredentialTable.organizationId, organizationId),
      inArray(LlmProviderMemberCredentialTable.llmProviderId, providerIds),
    )),
    db.select({ llmProviderId: LlmProviderModelTable.llmProviderId, modelId: LlmProviderModelTable.modelId })
      .from(LlmProviderModelTable).where(inArray(LlmProviderModelTable.llmProviderId, providerIds)),
  ])
  return buildLegacyProviderTargets({ providers, memberCredentials, models })
}

/** Every provider row the organization has, with stored facts and the live check each allows. */
export async function loadProviderTargets(organizationId: OrganizationId, now = Date.now()): Promise<ProviderTarget[]> {
  const [gateway, legacy, openwork] = await Promise.all([
    gatewayManagementUnavailable() ? Promise.resolve([]) : gatewayTargets(organizationId, now),
    legacyTargets(organizationId),
    openWorkModelsManaged(organizationId).catch(() => false),
  ])
  return [...(openwork ? [openWorkModelsTarget()] : []), ...gateway, ...legacy]
}

/**
 * Provider rows for one organization. Stored facts only unless `live`; a live
 * check lists models (or confirms the key) with each org-held credential and
 * never sends a model request or uses a member's credential.
 */
export async function checkOrganizationProviders(
  organizationId: OrganizationId,
  options: { live: boolean; fetchImpl?: typeof fetch; previousSuccess?: ReadonlyMap<string, string> },
): Promise<EvaluatedProvider[]> {
  const targets = await loadProviderTargets(organizationId)
  return evaluateProviderTargets(targets, {
    live: options.live,
    deps: { fetchImpl: options.fetchImpl ?? createInferenceEgressFetch() },
    previousSuccess: options.previousSuccess,
  })
}
