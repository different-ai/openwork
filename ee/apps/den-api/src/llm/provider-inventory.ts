import { and, eq, gt, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, GatewayCredentialSetTable, GatewayKeyTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { env } from "../env.js"
import { sessionTokenMatches } from "../session-token.js"
import { effectiveGatewayGrants, memberGatewayTeams } from "./inference-provider-lifecycle.js"
import { buildGatewayModelConfig, buildGatewayProviderConfig, gatewayConfigurationError, gatewayModelConfigurationError } from "./inference-provider-config.js"
import { providerInventoryReadiness, providerInventoryRevision } from "./provider-inventory-revision.js"
import { readLiteLlmSettings } from "./litellm-settings.js"

export type ProviderInventoryPrincipal = {
  organizationId: typeof OrganizationTable.$inferSelect.id
  memberId: typeof MemberTable.$inferSelect.id
  userId: NonNullable<typeof MemberTable.$inferSelect.userId>
  sessionId: typeof AuthSessionTable.$inferSelect.id
  sessionToken: string
}

/**
 * Dependency fingerprint for the usable list + connect read by providers.ts.
 * Batched, organization-indexed reads in one snapshot, not N gatewaySummary
 * calls, catalog refreshes, key issuance, upstream requests, or timestamp/MAX
 * aggregates. The latter miss model/link deletes, access/team writes, and key
 * rotations that never touch a provider. Resolve grants first, then fingerprint
 * only caller-visible dependencies. Even an opaque revision is an activity
 * side channel if unrelated providers, models, grants or people can change it.
 * Team/access rows affect the effective projection, never the revision directly;
 * provider touch timestamps likewise reveal writes to inaccessible resources.
 */
export async function readProviderInventoryRevision(principal: ProviderInventoryPrincipal): Promise<string> {
  return db.transaction(async (tx) => {
    const now = new Date()
    const [session] = await tx.select({ id: AuthSessionTable.id }).from(AuthSessionTable)
      .where(and(eq(AuthSessionTable.id, principal.sessionId), sessionTokenMatches(principal.sessionToken), eq(AuthSessionTable.userId, principal.userId), gt(AuthSessionTable.expiresAt, now)))
    const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable)
      .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
      .where(and(eq(MemberTable.id, principal.memberId), eq(MemberTable.userId, principal.userId), eq(MemberTable.organizationId, principal.organizationId), isNull(MemberTable.removedAt)))
    // Revalidate the session and membership on every check of an open stream.
    if (!session || !member) {
      throw new Error("Provider inventory is no longer authorized.")
    }
    const providers = await tx.select().from(GatewayProviderTable).where(and(eq(GatewayProviderTable.organization_id, principal.organizationId), eq(GatewayProviderTable.status, "active")))
    const ids = providers.map((provider) => provider.id)
    const groups = ids.length ? await tx.select().from(GatewayModelGroupTable).where(and(inArray(GatewayModelGroupTable.gateway_provider_id, ids), eq(GatewayModelGroupTable.status, "active"))) : []
    const sets = ids.length ? await tx.select().from(GatewayCredentialSetTable).where(and(inArray(GatewayCredentialSetTable.gateway_provider_id, ids), eq(GatewayCredentialSetTable.status, "active"))) : []
    const access = ids.length ? await tx.select().from(GatewayProviderAccessTable).where(inArray(GatewayProviderAccessTable.gateway_provider_id, ids)) : []
    const teams = await memberGatewayTeams(tx, principal.organizationId, principal.memberId)
    const groupById = new Map(groups.map((group) => [group.id, group]))
    const setById = new Map(sets.map((set) => [set.id, set]))
    const grants = effectiveGatewayGrants(access.filter((grant) => groupById.get(grant.model_group_id)?.gateway_provider_id === grant.gateway_provider_id
      && setById.get(grant.credential_set_id)?.gateway_provider_id === grant.gateway_provider_id), principal.memberId, teams.map((team) => team.id))
    const visibleProviderIds = [...new Set(grants.map((grant) => grant.gateway_provider_id))]
    const visibleGroupIds = [...new Set(grants.map((grant) => grant.model_group_id))]
    const visibleSetIds = new Set(grants.map((grant) => grant.credential_set_id))
    const visibleProviders = providers.filter((provider) => visibleProviderIds.includes(provider.id))
    const visibleSets = sets.filter((set) => visibleSetIds.has(set.id))
    const links = visibleGroupIds.length ? await tx.select().from(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.model_group_id, visibleGroupIds)) : []
    const modelIds = [...new Set(links.map((link) => link.gateway_provider_model_id))]
    const models = modelIds.length ? await tx.select().from(GatewayProviderModelTable).where(inArray(GatewayProviderModelTable.id, modelIds)) : []
    const visibleModels = models.filter((model) => {
      const provider = visibleProviders.find((provider) => provider.id === model.gateway_provider_id)
      return provider && (!provider.model_ids.length || provider.model_ids.includes(model.model_id))
        && !gatewayModelConfigurationError(provider.provider_config, [model.model_config])
        && links.some((link) => link.gateway_provider_model_id === model.id && groupById.get(link.model_group_id)?.gateway_provider_id === provider.id)
    })
    const credentials = visibleProviderIds.length ? await tx.select().from(GatewayProviderCredentialTable).where(and(
      inArray(GatewayProviderCredentialTable.gateway_provider_id, visibleProviderIds), inArray(GatewayProviderCredentialTable.credential_set_id, [...visibleSetIds]), eq(GatewayProviderCredentialTable.organization_id, principal.organizationId),
      or(and(eq(GatewayProviderCredentialTable.subject, "org"), isNull(GatewayProviderCredentialTable.org_membership_id)),
        and(eq(GatewayProviderCredentialTable.subject, principal.memberId), eq(GatewayProviderCredentialTable.org_membership_id, principal.memberId))),
    )) : []
    const visibleCredentials = credentials.filter((credential) => {
      const set = setById.get(credential.credential_set_id)
      return set?.gateway_provider_id === credential.gateway_provider_id
        && (set.credential_mode === "org" ? credential.subject === "org" && credential.org_membership_id === null
          : credential.subject === principal.memberId && credential.org_membership_id === principal.memberId)
    })
    const keys = visibleProviders.length ? await tx.select().from(GatewayKeyTable).where(and(eq(GatewayKeyTable.organization_id, principal.organizationId), eq(GatewayKeyTable.org_membership_id, principal.memberId))) : []
    // Time alone can remove readiness: LiteLLM/API-key expiry and the AWS SSO
    // registered client's expiry inside its secret. Never hash the wall clock.
    const readiness = providerInventoryReadiness(visibleCredentials, now.getTime())
    return providerInventoryRevision({ organizationId: principal.organizationId, memberId: principal.memberId, gatewayBaseUrl: env.gatewayPublicBaseUrl,
      rows: {
        providers: visibleProviders.map((provider) => ({ id: provider.id, providerId: provider.provider_id, name: provider.name,
          config: buildGatewayProviderConfig(provider, env.gatewayPublicBaseUrl),
          configurationError: gatewayConfigurationError(provider.provider_config, provider.settings),
          pinnedModelIds: provider.pinned_model_ids.filter((id) => visibleModels.some((model) => model.gateway_provider_id === provider.id && model.model_id === id)),
          migration: provider.settings.migration,
          // Only these settings affect member issued-key readiness, not sync
          // timestamps, management configuration or another member's attention.
          mode: readLiteLlmSettings(provider.settings)?.mode, keySource: readLiteLlmSettings(provider.settings)?.keySource })),
        models: visibleModels.map((model) => ({ id: model.id, providerId: model.gateway_provider_id, upstreamModelId: model.model_id,
          config: buildGatewayModelConfig({ id: model.id, name: model.name, config: model.model_config }) })),
        groups: groups.filter((group) => visibleGroupIds.includes(group.id)).map((group) => ({ id: group.id, name: group.name })),
        links: links.filter((link) => visibleModels.some((model) => model.id === link.gateway_provider_model_id && model.gateway_provider_id === groupById.get(link.model_group_id)?.gateway_provider_id))
          .map((link) => ({ groupId: link.model_group_id, modelId: link.gateway_provider_model_id })),
        sets: visibleSets.map((set) => ({ id: set.id, providerId: set.gateway_provider_id, name: set.name, credentialMode: set.credential_mode,
          oauthClientId: set.oauth_client_id, oauthClientSecret: set.oauth_client_secret, oauthTenantId: set.oauth_tenant_id, awsSso: set.aws_sso })),
        grants: grants.map((grant) => ({ providerId: grant.gateway_provider_id, groupId: grant.model_group_id, setId: grant.credential_set_id })),
        credentials: visibleCredentials.map((credential) => ({ id: credential.id, setId: credential.credential_set_id, kind: credential.kind,
          status: credential.status, secret: credential.secret, expiresAt: credential.expires_at, lastError: credential.last_error })),
        keys: keys.map((key) => ({ id: key.id, key: key.encrypted_key, status: key.status })), readiness,
      } }, env.betterAuthSecret)
  }, { isolationLevel: "repeatable read", accessMode: "read only" })
}
