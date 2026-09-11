import { isDeepStrictEqual } from "node:util"
import { and, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, GatewayCredentialSetTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderOauthStateTable, GatewayProviderTable, MemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { createGatewayModelAlias, gatewayAudienceKey } from "@openwork-ee/utils/gateway-routing"
import { inferenceCredentialEnvNames, isInferenceCredentialKindSupported, pickInferenceApiKeyFromMap } from "@openwork-ee/utils/inference-credentials"
import { parseGatewayProviderSecret, type GatewayAccessGrant, type GatewayAccessGrantWrite, type GatewayCredentialSet, type GatewayCredentialSetPatch, type GatewayModelGroup, type GatewayModelGroupPatch, type GatewayProviderDetails, type GatewayProviderSummary, type GatewayUsableModel } from "@openwork/types/den/gateway"
import { db } from "../db.js"
import { env } from "../env.js"
import { buildGatewayProviderConfig, buildProviderConfigSnapshot, gatewayConfigurationError, gatewayModelConfigurationError, isSupportedGatewayNpm, nonSecretProviderConfig, publicProviderSettings, readProviderConfigNpm, upstreamBaseUrlSettingError } from "./inference-provider-config.js"
import { isGoogleOAuthInferenceProviderId } from "./inference-provider-google-oauth.js"
import { effectiveGatewayGrants, memberGatewayTeams } from "./inference-provider-lifecycle.js"
import { getModelsDevProvider, type ModelsDevProvider } from "./models-dev.js"
import { readProviderEnvNames } from "./provider-credentials.js"

export type GatewayTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type GatewayProvider = typeof GatewayProviderTable.$inferSelect
export type GatewaySet = typeof GatewayCredentialSetTable.$inferSelect
export type GatewayMemberId = typeof MemberTable.$inferSelect.id
type Credential = typeof GatewayProviderCredentialTable.$inferSelect
type CredentialInput = { kind: Credential["kind"]; secret: string }

export class GatewayWriteError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message = code) { super(message) }
}

export function validateGatewaySettings(config: Record<string, unknown>, settings: Record<string, unknown>) {
  const error = upstreamBaseUrlSettingError(settings) ?? gatewayConfigurationError(config, settings)
  if (error) throw new GatewayWriteError(400, "invalid_settings", error)
  const npm = readProviderConfigNpm(config)
  if (npm === "@ai-sdk/google-vertex" || npm === "@ai-sdk/google-vertex/anthropic") {
    // Keep identical to Gateway's vertexPublisherBase (gateway/src/protocols.ts); no shared validator exists yet.
    if (typeof settings.project !== "string" || !/^(?:[a-z][a-z0-9-]{4,61}[a-z0-9]|[0-9]{6,20})$/.test(settings.project)
      || typeof settings.location !== "string" || !/^(?:global|[a-z]+(?:-[a-z]+)*[0-9]+)$/.test(settings.location)) {
      throw new GatewayWriteError(400, "invalid_settings", "Vertex requires a 6-63 character project ID or 6-20 digit project number, and global or a region ending in digits.")
    }
  }
  if (npm === "@ai-sdk/azure" && (typeof settings.resourceName !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(settings.resourceName))) {
    throw new GatewayWriteError(400, "invalid_settings", "Azure requires a resourceName DNS label.")
  }
}

export async function gatewayCatalog(providerId: string, modelIds: string[]) {
  const catalog = await getModelsDevProvider(providerId)
  if (!catalog) throw new GatewayWriteError(404, "provider_not_found")
  return resolveGatewayCatalog(catalog, modelIds)
}

export function resolveGatewayCatalog(catalog: ModelsDevProvider, modelIds: string[], config = buildProviderConfigSnapshot(catalog), strict = true) {
  if (!isSupportedGatewayNpm(catalog.npm)) throw new GatewayWriteError(400, "unsupported_provider")
  if (strict) for (const id of modelIds) {
    if (!catalog.models.some((model) => model.id === id)) throw new GatewayWriteError(404, "model_not_found", `Model ${id} is not in this provider's catalog.`)
  }
  const selected = catalog.models.filter((model) => !modelIds.length || modelIds.includes(model.id))
  const models = selected.filter((model) => {
    const error = gatewayModelConfigurationError(config, [model.config])
    if (error && strict && modelIds.length) throw new GatewayWriteError(400, "unsupported_model_sdk", `Model ${model.id}: ${error}`)
    return !error
  })
  const excluded = selected.length - models.length
  const missing = new Set(modelIds.filter((id) => !catalog.models.some((model) => model.id === id))).size
  const warnings = [
    ...(excluded ? [`${excluded} catalog model(s) excluded by Gateway SDK/configuration compatibility. All models means all supported catalog models.`] : []),
    ...(missing ? [`${missing} selected model(s) are no longer in the catalog. The explicit modelIds policy is retained.`] : []),
  ]
  return { catalog, config, models, ...(warnings.length ? { catalogWarning: warnings.join(" ") } : {}) }
}

export async function refreshGatewayCatalog(provider: GatewayProvider) {
  // Catalog I/O never holds a provider/OAuth lock. A failed load cannot prune rows.
  const catalog = await getModelsDevProvider(provider.provider_id).catch(() => null)
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(GatewayProviderTable)
      .where(and(eq(GatewayProviderTable.id, provider.id), eq(GatewayProviderTable.organization_id, provider.organization_id))).for("update")
    if (!current) throw new GatewayWriteError(404, "inference_provider_not_found")
    if (!catalog) return { provider: current, catalogWarning: "Catalog refresh unavailable. Previously configured models are retained within the saved modelIds policy." }
    if (catalog.id !== current.provider_id || !isSupportedGatewayNpm(catalog.npm) || catalog.npm !== readProviderConfigNpm(current.provider_config)) {
      return { provider: current, catalogWarning: "The catalog provider SDK changed or is unsupported. Create a separate provider to use the new SDK; the saved provider configuration is retained." }
    }
    const resolved = resolveGatewayCatalog(catalog, current.model_ids, current.provider_config, false)
    if (await writeGatewayModels(tx, current, resolved.models)) {
      current.updated_at = new Date()
      await tx.update(GatewayProviderTable).set({ updated_at: current.updated_at }).where(eq(GatewayProviderTable.id, current.id))
    }
    return { provider: current, catalogWarning: resolved.catalogWarning }
  })
}

/** Keep model row IDs stable so existing wire aliases and overlapping links survive catalog edits. */
export async function writeGatewayModels(tx: GatewayTx, provider: GatewayProvider, models: Array<{ id: string; name: string; config: Record<string, unknown> }>) {
  const existing = await tx.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id))
  const removed = existing.filter((row) => !models.some((model) => model.id === row.model_id)).map((row) => row.id)
  let changed = removed.length > 0
  if (removed.length) {
    // Caller holds the provider fence: links and rows disappear in one transaction.
    await tx.delete(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.gateway_provider_model_id, removed))
    await tx.delete(GatewayProviderModelTable).where(and(eq(GatewayProviderModelTable.gateway_provider_id, provider.id), inArray(GatewayProviderModelTable.id, removed)))
  }
  for (const model of models) {
    const row = existing.find((row) => row.model_id === model.id)
    if (row && row.name === model.name && isDeepStrictEqual(row.model_config, model.config)) continue
    changed = true
    if (row) await tx.update(GatewayProviderModelTable).set({ name: model.name, model_config: model.config }).where(eq(GatewayProviderModelTable.id, row.id))
    else await tx.insert(GatewayProviderModelTable).values({ id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: provider.id, model_id: model.id, name: model.name, model_config: model.config })
  }
  return changed
}

export async function writeGatewayGroup(tx: GatewayTx, provider: GatewayProvider, input: GatewayModelGroupPatch, groupId?: typeof GatewayModelGroupTable.$inferSelect.id) {
  const [existing] = groupId ? await tx.select().from(GatewayModelGroupTable)
    .where(and(eq(GatewayModelGroupTable.id, groupId), eq(GatewayModelGroupTable.gateway_provider_id, provider.id))) : []
  if (groupId && !existing) throw new GatewayWriteError(404, "model_group_not_found")
  const name = input.name ?? existing?.name
  if (!name) throw new GatewayWriteError(400, "invalid_request")
  const models = input.modelIds === undefined ? null : await tx.select().from(GatewayProviderModelTable)
    .where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id))
  const selected = models?.filter((row) => input.modelIds?.includes(row.model_id)
    && (!provider.model_ids.length || provider.model_ids.includes(row.model_id))
    && !gatewayModelConfigurationError(provider.provider_config, [row.model_config]))
  if (input.modelIds && selected?.length !== new Set(input.modelIds).size) throw new GatewayWriteError(404, "model_not_found", "Groups accept configured catalog model IDs from this provider only.")
  const id = existing?.id ?? createDenTypeId("gatewayModelGroup")
  // The caller holds the provider fence; callbacks recheck active group/set grants after access changes.
  const values = { name, description: input.description === undefined ? existing?.description ?? null : input.description, status: input.status ?? existing?.status ?? "active", updated_at: new Date() }
  if (existing) await tx.update(GatewayModelGroupTable).set(values).where(eq(GatewayModelGroupTable.id, id))
  else await tx.insert(GatewayModelGroupTable).values({ id, gateway_provider_id: provider.id, ...values })
  if (selected) {
    await tx.delete(GatewayModelGroupModelTable).where(eq(GatewayModelGroupModelTable.model_group_id, id))
    if (selected.length) await tx.insert(GatewayModelGroupModelTable).values(selected.map((model) => ({ id: createDenTypeId("gatewayModelGroupModel"), model_group_id: id, gateway_provider_model_id: model.id })))
  }
  return id
}

function normalizeCredential(input: GatewayCredentialSetPatch, provider: GatewayProvider, existing?: Credential): CredentialInput | null {
  const envNames = readProviderEnvNames(provider.provider_config)
  let credential = input.credential ?? null
  if (input.apiKeys) {
    if (Object.keys(input.apiKeys).some((name) => !envNames.includes(name))) throw new GatewayWriteError(400, "invalid_api_keys", "API key fields must match the trusted provider catalog.")
    if (!Object.values(input.apiKeys).some((value) => value.trim())) throw new GatewayWriteError(400, "invalid_credential", "Provide a non-empty API key, or omit apiKeys to keep the stored credential.")
    const values: Record<string, string> = {}
    if (existing?.status === "active") {
      const parsed = parseGatewayProviderSecret(existing.kind, existing.secret)
      if (parsed.kind === "api_key_map") Object.assign(values, parsed.apiKeys)
      if (parsed.kind === "api_key") {
        const primary = inferenceCredentialEnvNames(envNames)[0]
        if (primary) values[primary] = existing.secret
      }
    }
    for (const [name, value] of Object.entries(input.apiKeys)) if (value.trim()) values[name] = value.trim()
    credential = { kind: "api_key_map", secret: JSON.stringify(values) }
  }
  if (!credential) return null
  try {
    const parsed = parseGatewayProviderSecret(credential.kind, credential.secret)
    if (!isInferenceCredentialKindSupported(parsed.kind, provider.provider_id)
      || parsed.kind === "api_key_map" && !pickInferenceApiKeyFromMap(parsed.apiKeys, envNames)) throw new Error("invalid")
  } catch { throw new GatewayWriteError(400, "invalid_credential", "Credential kind and key fields must match the trusted provider catalog.") }
  return credential
}

export async function writeGatewaySet(tx: GatewayTx, provider: GatewayProvider, input: GatewayCredentialSetPatch, target: GatewaySet["id"] | { createdByOrgMembershipId: GatewayMemberId }) {
  const setId = typeof target === "string" ? target : undefined
  let creatorId: GatewayMemberId | null = null
  if (!setId) {
    if (!target || typeof target === "string") throw new GatewayWriteError(400, "creator_required")
    const [creator] = await tx.select({ id: MemberTable.id, userId: MemberTable.userId }).from(MemberTable)
      .where(and(eq(MemberTable.id, target.createdByOrgMembershipId), eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt))).for("update")
    if (!creator?.userId) throw new GatewayWriteError(403, "forbidden")
    creatorId = creator.id
  }
  const [existing] = setId ? await tx.select().from(GatewayCredentialSetTable)
    .where(and(eq(GatewayCredentialSetTable.id, setId), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))).for("update") : []
  if (setId && !existing) throw new GatewayWriteError(404, "credential_set_not_found")
  const name = input.name ?? existing?.name
  const mode = input.credentialMode ?? existing?.credential_mode
  if (!name || !mode) throw new GatewayWriteError(400, "invalid_request")
  const clientId = input.oauthClientId === undefined ? existing?.oauth_client_id ?? null : input.oauthClientId || null
  const clientSecret = input.oauthClientSecret === undefined ? existing?.oauth_client_secret ?? null : input.oauthClientSecret || null
  if (mode === "member" && (!isGoogleOAuthInferenceProviderId(provider.provider_id) || input.credential !== undefined || input.apiKeys !== undefined)) {
    throw new GatewayWriteError(400, "unsupported_credential_mode", "Member sets use each member's own Google OAuth flow, never an uploaded shared credential.")
  }
  const id = existing?.id ?? createDenTypeId("gatewayCredentialSet")
  const modeChanged = existing && mode !== existing.credential_mode
  const clientChanged = existing && (clientId !== existing.oauth_client_id || clientSecret !== existing.oauth_client_secret)
  const disabled = existing?.status === "active" && input.status === "disabled"
  const enabled = existing && existing.status !== "active" && input.status === "active"
  if (mode === "member" && (!existing || modeChanged || clientChanged || enabled) && (!clientId?.trim() || !clientSecret?.trim())) {
    throw new GatewayWriteError(400, "oauth_client_required", "Member credential sets require a non-empty Google OAuth client ID and secret.")
  }
  // Lock exchanges before tokens, but defer cancellation until validation succeeds. Renames do neither.
  if (modeChanged || clientChanged || disabled) await tx.select({ id: GatewayProviderOauthStateTable.id }).from(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.credential_set_id, id)).for("update")
  const credentials = await tx.select().from(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.credential_set_id, id)).for("update")
  if (credentials.some((row) => row.organization_id !== provider.organization_id || row.gateway_provider_id !== provider.id)) throw new GatewayWriteError(409, "credential_set_inconsistent")
  const orgCredential = credentials.find((row) => row.subject === "org" && row.org_membership_id === null)
  const credential = normalizeCredential(input, provider, mode === existing?.credential_mode ? orgCredential : undefined)
  if (mode === "org" && !credential && (!existing || modeChanged || enabled && orgCredential?.status !== "active")) {
    throw new GatewayWriteError(400, "credential_required", "Provide a non-empty organization credential to create this set, switch to organization mode, or re-enable it without an active credential.")
  }
  if (modeChanged || clientChanged || disabled) await tx.delete(GatewayProviderOauthStateTable).where(eq(GatewayProviderOauthStateTable.credential_set_id, id))
  const revoked = credentials.filter((row) => row.status !== "revoked" && (modeChanged || input.status === "disabled" || clientChanged && row.kind === "oauth_google"))
  if (revoked.length) await tx.update(GatewayProviderCredentialTable).set({ status: "revoked", refreshing_until: null, updated_at: new Date() }).where(inArray(GatewayProviderCredentialTable.id, revoked.map((row) => row.id)))
  const values = { name, credential_mode: mode, oauth_client_id: clientId, oauth_client_secret: clientSecret, status: input.status ?? existing?.status ?? "active", updated_at: new Date() }
  if (existing) await tx.update(GatewayCredentialSetTable).set(values).where(eq(GatewayCredentialSetTable.id, id))
  else await tx.insert(GatewayCredentialSetTable).values({ id, gateway_provider_id: provider.id, created_by_org_membership_id: creatorId, ...values })
  if (credential) {
    const value = { kind: credential.kind, secret: credential.secret, status: "active" as const, expires_at: null, refreshing_until: null, last_error: null, updated_at: new Date() }
    if (orgCredential) await tx.update(GatewayProviderCredentialTable).set(value).where(eq(GatewayProviderCredentialTable.id, orgCredential.id))
    else await tx.insert(GatewayProviderCredentialTable).values({ id: createDenTypeId("inferenceProviderCredential"), gateway_provider_id: provider.id, credential_set_id: id, organization_id: provider.organization_id, subject: "org", org_membership_id: null, ...value })
  }
  return { id, revoked }
}

export async function writeGatewayGrant(tx: GatewayTx, provider: GatewayProvider, input: GatewayAccessGrantWrite, grantId?: typeof GatewayProviderAccessTable.$inferSelect.id) {
  const groupId = normalizeDenTypeId("gatewayModelGroup", input.modelGroupId)
  const setId = normalizeDenTypeId("gatewayCredentialSet", input.credentialSetId)
  const [group] = await tx.select().from(GatewayModelGroupTable).where(and(eq(GatewayModelGroupTable.id, groupId), eq(GatewayModelGroupTable.gateway_provider_id, provider.id)))
  const [set] = await tx.select().from(GatewayCredentialSetTable).where(and(eq(GatewayCredentialSetTable.id, setId), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id)))
  if (!group || !set) throw new GatewayWriteError(404, "matrix_resource_not_found")
  const memberId = input.audience.type === "member" ? normalizeDenTypeId("member", input.audience.memberId) : null
  const teamId = input.audience.type === "team" ? normalizeDenTypeId("team", input.audience.teamId) : null
  if (memberId) {
    const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable)
      .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt)))
    if (!member) throw new GatewayWriteError(404, "member_not_found")
  }
  if (teamId) {
    const [team] = await tx.select({ id: TeamTable.id }).from(TeamTable).where(and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, provider.organization_id)))
    if (!team) throw new GatewayWriteError(404, "team_not_found")
  }
  const audienceKey = gatewayAudienceKey(input.audience)
  const [duplicate] = await tx.select().from(GatewayProviderAccessTable).where(and(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id), eq(GatewayProviderAccessTable.model_group_id, groupId), eq(GatewayProviderAccessTable.credential_set_id, setId), eq(GatewayProviderAccessTable.audience_key, audienceKey)))
  if (duplicate && duplicate.id !== grantId) throw new GatewayWriteError(409, "access_grant_exists")
  // Additions preserve pending consent. Removed/rebound access is checked under the provider fence at callback.
  const id = grantId ?? createDenTypeId("inferenceProviderAccess")
  const values = { model_group_id: groupId, credential_set_id: setId, org_membership_id: memberId, team_id: teamId, audience_key: audienceKey }
  if (grantId) await tx.update(GatewayProviderAccessTable).set(values).where(and(eq(GatewayProviderAccessTable.id, id), eq(GatewayProviderAccessTable.gateway_provider_id, provider.id)))
  else await tx.insert(GatewayProviderAccessTable).values({ id, gateway_provider_id: provider.id, ...values })
  return id
}

export function gatewayGrantSummary(row: typeof GatewayProviderAccessTable.$inferSelect): GatewayAccessGrant {
  return { id: row.id, modelGroupId: row.model_group_id, credentialSetId: row.credential_set_id,
    audience: row.org_membership_id ? { type: "member", memberId: row.org_membership_id } : row.team_id ? { type: "team", teamId: row.team_id } : { type: "organization" } }
}

export function gatewaySummary(provider: GatewayProvider, memberId: GatewayMemberId, baseUrl: string, manage: true): Promise<GatewayProviderDetails>
export function gatewaySummary(provider: GatewayProvider, memberId: GatewayMemberId, baseUrl: string, manage: boolean): Promise<GatewayProviderSummary>
export async function gatewaySummary(provider: GatewayProvider, memberId: GatewayMemberId, baseUrl: string, manage: boolean): Promise<GatewayProviderDetails | GatewayProviderSummary> {
  const [member] = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt)))
  if (!member?.userId) throw new GatewayWriteError(403, "forbidden")
  const refreshed = await refreshGatewayCatalog(provider)
  provider = refreshed.provider
  const models = (await db.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id)))
    .filter((model) => (!provider.model_ids.length || provider.model_ids.includes(model.model_id))
      && !gatewayModelConfigurationError(provider.provider_config, [model.model_config]))
  const groups = await db.select().from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.gateway_provider_id, provider.id))
  const sets = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))
  const links = groups.length ? await db.select().from(GatewayModelGroupModelTable).where(inArray(GatewayModelGroupModelTable.model_group_id, groups.map((group) => group.id))) : []
  const access = await db.select().from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
  const credentials = await db.select({ credential: GatewayProviderCredentialTable, memberName: AuthUserTable.name, memberEmail: AuthUserTable.email }).from(GatewayProviderCredentialTable)
    .leftJoin(MemberTable, and(eq(MemberTable.id, GatewayProviderCredentialTable.org_membership_id), eq(MemberTable.organizationId, provider.organization_id))).leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(GatewayProviderCredentialTable.gateway_provider_id, provider.id), eq(GatewayProviderCredentialTable.organization_id, provider.organization_id),
      manage ? undefined : or(
        and(eq(GatewayProviderCredentialTable.subject, "org"), isNull(GatewayProviderCredentialTable.org_membership_id)),
        and(eq(GatewayProviderCredentialTable.subject, memberId), eq(GatewayProviderCredentialTable.org_membership_id, memberId)),
      )))
  const teams = await memberGatewayTeams(db, provider.organization_id, memberId)
  const activeAccess = access.filter((grant) => groups.some((group) => group.id === grant.model_group_id && group.status === "active") && sets.some((set) => set.id === grant.credential_set_id && set.status === "active"))
  const grants = provider.status === "active" ? effectiveGatewayGrants(activeAccess, memberId, teams.map((team) => team.id)) : []
  const creatorIds = sets.flatMap((set) => set.created_by_org_membership_id ? [set.created_by_org_membership_id] : [])
  const creators = manage && creatorIds.length ? await db.select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email }).from(MemberTable)
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(inArray(MemberTable.id, creatorIds), eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt))) : []
  const setSummaries: GatewayCredentialSet[] = sets.map((set) => {
    const creator = creators.find((member) => member.id === set.created_by_org_membership_id)
    const subject = set.credential_mode === "org" ? "org" : memberId
    const token = credentials.find(({ credential: row }) => row.credential_set_id === set.id && row.subject === subject
      && row.org_membership_id === (set.credential_mode === "org" ? null : memberId) && row.status === "active")?.credential
    const configured = set.credential_mode === "member" ? Boolean(set.oauth_client_id && set.oauth_client_secret) : Boolean(token)
    let usable = false
    if (token) {
      try {
        const parsed = parseGatewayProviderSecret(token.kind, token.secret)
        usable = isInferenceCredentialKindSupported(parsed.kind, provider.provider_id)
          && (set.credential_mode !== "member" || parsed.kind === "oauth_google")
          && (parsed.kind !== "api_key_map" || Boolean(pickInferenceApiKeyFromMap(parsed.apiKeys, readProviderEnvNames(provider.provider_config))))
          && (!token.expires_at || token.expires_at.getTime() > Date.now() || parsed.kind === "oauth_google" && Boolean(parsed.token.refreshToken && set.oauth_client_id && set.oauth_client_secret))
      } catch { usable = false }
    }
    return { id: set.id, name: set.name, credentialMode: set.credential_mode, status: set.status, configured,
      ...(manage ? { createdAt: set.created_at.toISOString(), createdBy: set.created_by_org_membership_id ? { id: set.created_by_org_membership_id, name: creator?.name ?? null, email: creator?.email ?? null } : null } : {}),
      credentialStatus: provider.status === "active" && set.status === "active" && configured && usable ? "ready" : set.credential_mode === "member" ? "member_auth_required" : "org_credential_missing",
      oauthClientId: set.oauth_client_id, hasOauthClientSecret: Boolean(set.oauth_client_secret) }
  })
  const authorizationRequests = setSummaries.filter((set) => set.credentialMode === "member" && set.credentialStatus === "member_auth_required" && grants.some((grant) => grant.credential_set_id === set.id))
    .map((set) => ({ credentialSetId: set.id, name: set.name, authUrl: `${baseUrl}/v1/inference-providers/${provider.id}/oauth/start?credentialSetId=${encodeURIComponent(set.id)}` }))
  const usableModels: GatewayUsableModel[] = []
  for (const grant of grants) {
    const group = groups.find((group) => group.id === grant.model_group_id)
    const set = setSummaries.find((set) => set.id === grant.credential_set_id)
    if (!group || !set || set.credentialStatus !== "ready") continue
    for (const model of models.filter((model) => links.some((link) => link.model_group_id === group.id && link.gateway_provider_model_id === model.id))) {
      const id = createGatewayModelAlias({ modelGroupId: group.id, credentialSetId: grant.credential_set_id, gatewayProviderModelId: model.id })
      const name = model.name
      usableModels.push({ id, name, config: { ...nonSecretProviderConfig(model.model_config), id, name }, upstreamModelId: model.model_id, modelGroupId: group.id, modelGroupName: group.name, credentialSetId: set.id, credentialSetName: set.name })
    }
  }
  const migration = provider.settings.migration
  const summary: GatewayProviderSummary = {
    modelIds: provider.model_ids, ...(refreshed.catalogWarning ? { catalogWarning: refreshed.catalogWarning } : {}),
    id: provider.id, providerId: provider.provider_id, name: provider.name, source: "openwork_gateway", credentialMode: sets.length > 0 && sets.every((set) => set.credential_mode === "member") ? "member" : "org", status: provider.status, updatedAt: provider.updated_at.toISOString(),
    providerConfig: buildGatewayProviderConfig(provider, env.gatewayPublicBaseUrl), models: usableModels.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), authorizationRequests,
    credentialStatus: usableModels.length ? "ready" : authorizationRequests.length ? "member_auth_required" : "org_credential_missing", authUrl: authorizationRequests[0]?.authUrl ?? null,
  }
  if (typeof migration === "object" && migration !== null && "llmProviderId" in migration && typeof migration.llmProviderId === "string"
    && /^lpr_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(migration.llmProviderId) && "runtimeEnvNames" in migration && Array.isArray(migration.runtimeEnvNames)
    && migration.runtimeEnvNames.every((name): name is string => typeof name === "string" && /^LPR_[A-Z0-9]{5}_[A-Z0-9_]+$/.test(name))) {
    summary.migration = { llmProviderId: migration.llmProviderId, runtimeEnvNames: migration.runtimeEnvNames }
  }
  if (!manage) return summary
  const modelGroups: GatewayModelGroup[] = groups.map((group) => ({ id: group.id, name: group.name, description: group.description, status: group.status,
    modelIds: models.filter((model) => links.some((link) => link.model_group_id === group.id && link.gateway_provider_model_id === model.id)).map((model) => model.model_id) }))
  return { ...summary, settings: publicProviderSettings(provider.settings), modelGroups, credentialSets: setSummaries, accessGrants: access.map(gatewayGrantSummary), oauthCallbackUrl: `${baseUrl}/v1/inference-providers/oauth/callback`,
    credentials: credentials.map(({ credential, memberName, memberEmail }) => ({ id: credential.id, credentialSetId: credential.credential_set_id, subject: credential.subject, orgMembershipId: credential.org_membership_id, memberName, memberEmail, kind: credential.kind, status: credential.status, expiresAt: credential.expires_at?.toISOString() ?? null })) }
}
