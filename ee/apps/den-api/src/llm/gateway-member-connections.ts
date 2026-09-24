import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { GatewayCredentialSetTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderTable, MemberTable } from "@openwork-ee/den-db/schema"
import { inferenceOauthTokenSecretSchema, type GatewayMemberConnectionsResponse } from "@openwork/types/den/inference"
import { db } from "../db.js"
import { GatewayWriteError, type GatewayMemberId, type GatewayProvider } from "./gateway-matrix.js"
import { gatewayConfigurationError } from "./inference-provider-config.js"
import { GOOGLE_OAUTH_MAX_EXPIRY_SECONDS, googleBearerTokenSchema, isGoogleOAuthInferenceProviderId } from "./inference-provider-google-oauth.js"
import { effectiveGatewayGrants, memberGatewayTeams } from "./inference-provider-lifecycle.js"

export async function gatewayMemberConnections(input: { organizationId: GatewayProvider["organization_id"]; memberId: GatewayMemberId; userId: string }): Promise<GatewayMemberConnectionsResponse> {
  return db.transaction(async (tx) => {
    const [member] = await tx.select().from(MemberTable).where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt))).for("update")
    if (!member?.userId || member.userId !== input.userId) throw new GatewayWriteError(403, "forbidden")
    const providers = (await tx.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.organization_id, input.organizationId)))
      .filter((provider) => isGoogleOAuthInferenceProviderId(provider.provider_id))
    if (!providers.length) return { connections: [] }
    const providerIds = providers.map((provider) => provider.id)
    const sets = await tx.select().from(GatewayCredentialSetTable).where(and(inArray(GatewayCredentialSetTable.gateway_provider_id, providerIds), eq(GatewayCredentialSetTable.credential_mode, "member")))
    if (!sets.length) return { connections: [] }
    const credentials = await tx.select().from(GatewayProviderCredentialTable).where(and(
      eq(GatewayProviderCredentialTable.organization_id, input.organizationId),
      eq(GatewayProviderCredentialTable.subject, input.memberId),
      eq(GatewayProviderCredentialTable.org_membership_id, input.memberId),
      inArray(GatewayProviderCredentialTable.gateway_provider_id, providerIds),
      inArray(GatewayProviderCredentialTable.credential_set_id, sets.map((set) => set.id)),
      eq(GatewayProviderCredentialTable.kind, "oauth_google"),
      inArray(GatewayProviderCredentialTable.status, ["active", "refresh_failed"]),
    ))
    const groups = await tx.select().from(GatewayModelGroupTable).where(and(inArray(GatewayModelGroupTable.gateway_provider_id, providerIds), eq(GatewayModelGroupTable.status, "active")))
    const grants = await tx.select().from(GatewayProviderAccessTable).where(inArray(GatewayProviderAccessTable.gateway_provider_id, providerIds))
    const teams = await memberGatewayTeams(tx, input.organizationId, input.memberId)
    const now = Date.now()
    const connections: GatewayMemberConnectionsResponse["connections"] = []
    for (const provider of providers) {
      const accessible = effectiveGatewayGrants(grants.filter((grant) => grant.gateway_provider_id === provider.id
        && groups.some((group) => group.id === grant.model_group_id && group.gateway_provider_id === provider.id)
        && sets.some((set) => set.id === grant.credential_set_id && set.gateway_provider_id === provider.id && set.status === "active")), input.memberId, teams.map((team) => team.id))
      for (const set of sets.filter((set) => set.gateway_provider_id === provider.id)) {
        const credential = credentials.find((row) => row.credential_set_id === set.id && row.gateway_provider_id === provider.id)
        const hasCredential = Boolean(credential)
        const hasAccess = provider.status === "active" && set.status === "active" && accessible.some((grant) => grant.credential_set_id === set.id)
        if (!hasAccess && !hasCredential) continue
        let token: ReturnType<typeof inferenceOauthTokenSecretSchema.parse> | null = null
        if (credential) {
          try { token = inferenceOauthTokenSecretSchema.parse(JSON.parse(credential.secret)) } catch { token = null }
        }
        const expiry = credential?.expires_at?.getTime()
        const configurationRequired = credential?.last_error === "invalid_client"
        const ready = !configurationRequired && hasAccess && credential?.status === "active" && Boolean(token && googleBearerTokenSchema.safeParse(token.accessToken).success
          && token.refreshToken && /^[\x21-\x7e]+$/.test(token.refreshToken)
          && (token.tokenType === undefined || /^Bearer$/i.test(token.tokenType))
          && typeof expiry === "number" && Number.isFinite(expiry) && expiry > 0 && expiry <= now + GOOGLE_OAUTH_MAX_EXPIRY_SECONDS * 1000
          && set.oauth_client_id && set.oauth_client_secret
          && !gatewayConfigurationError(provider.provider_config, provider.settings))
        connections.push({ providerId: provider.id, credentialSetId: set.id, providerName: provider.name, name: set.name,
          ready, hasAccess, hasCredential, configurationRequired,
          authorizationRevision: token?.googleIdentity?.authorizationRevision ?? null,
          accountEmail: token?.googleIdentity?.emailVerified === true ? token.googleIdentity.email : null,
        })
      }
    }
    connections.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name) || a.credentialSetId.localeCompare(b.credentialSetId))
    return { connections }
  })
}
