/**
 * LiteLLM gateway providers.
 *
 * Organization key mode: one LiteLLM key for everyone. Its /v1/models list is
 * the catalog, one "All LiteLLM models" group carries it, and admins grant
 * that group like any other provider. Spend is tracked and limited by OpenWork.
 *
 * Per-user key mode: an admin key syncs the catalog and team model sets; each
 * member then connects their own LiteLLM key. Their key's /v1/models list
 * picks the shared group with exactly that model set (one group per distinct
 * set, named after the LiteLLM team when known) and a member grant is created
 * for it. Admin grants on the empty "Can connect a LiteLLM key" group decide
 * who may connect. LiteLLM budgets those keys, so OpenWork spend tracking is off.
 *
 * Network calls happen before any transaction; apply steps take the caller's
 * provider lock and recheck what they depend on.
 */
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { GatewayCredentialSetTable, GatewayLiteLlmIssuedKeyTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderTable, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { gatewayAudienceKey } from "@openwork-ee/utils/gateway-routing"
import { LITELLM_ADMIN_CREDENTIAL_SUBJECT, isLiteLlmProviderId } from "@openwork-ee/utils/litellm-catalog"
import type { GatewayAudience } from "@openwork/types/den/gateway"
import { db } from "../db.js"
import { GatewayWriteError, writeGatewayGrant, writeGatewayGroup, writeGatewayModels, type GatewayMemberId, type GatewayProvider, type GatewaySet, type GatewayTx } from "./gateway-matrix.js"
import { effectiveGatewayGrants, memberGatewayTeams } from "./inference-provider-lifecycle.js"
import { LiteLlmError, createLiteLlmClient, liteLlmCatalogModels, liteLlmModelSetKey, liteLlmPersonalModels, liteLlmTeamModels, normalizeLiteLlmBaseUrl, type LiteLlmClient, type LiteLlmEndpoints, type LiteLlmModel, type LiteLlmTeam } from "./litellm.js"
export { readLiteLlmSettings, liteLlmCatalogProvider, type LiteLlmSettings } from "./litellm-settings.js"
import { readLiteLlmSettings, type LiteLlmSettings } from "./litellm-settings.js"

export type LiteLlmMode = "org" | "member"
type Credential = typeof GatewayProviderCredentialTable.$inferSelect
type GroupId = typeof GatewayModelGroupTable.$inferSelect.id

const ALL_MODELS_GROUP_KEY = "all"
export const SIGN_IN_GROUP_KEY = "signin"
export const LITELLM_PERSONAL_ACCESS_GROUP_NAME = "Can connect a LiteLLM key"
export const LITELLM_ISSUED_ACCESS_GROUP_NAME = "Gets a LiteLLM key"
const MEMBER_MATCH_CONCURRENCY = 4

export function requireSettings(provider: GatewayProvider): LiteLlmSettings {
  const settings = isLiteLlmProviderId(provider.provider_id) ? readLiteLlmSettings(provider.settings) : null
  if (!settings) throw new GatewayWriteError(409, "litellm_not_configured", "This provider is not a configured LiteLLM provider.")
  return settings
}

export function liteLlmEndpoints(provider: Pick<GatewayProvider, "settings">): LiteLlmEndpoints {
  const base = provider.settings.upstreamBaseUrl
  if (typeof base !== "string") throw new GatewayWriteError(409, "litellm_not_configured", "This LiteLLM provider has no proxy URL.")
  return normalizeLiteLlmBaseUrl(base)
}

export function liteLlmErrorResponse(error: LiteLlmError): GatewayWriteError {
  const status = error.code === "invalid_base_url" || error.code === "no_models" ? 400 : 409
  return new GatewayWriteError(status, `litellm_${error.code}`, error.message)
}

export async function activeSet(database: GatewayTx | typeof db, provider: GatewayProvider, settings: LiteLlmSettings): Promise<GatewaySet> {
  const [set] = await database.select().from(GatewayCredentialSetTable)
    .where(and(eq(GatewayCredentialSetTable.id, normalizeDenTypeId("gatewayCredentialSet", settings.credentialSetId)), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id)))
  if (!set || set.credential_mode !== settings.mode) throw new GatewayWriteError(409, "litellm_credential_set_changed", "The LiteLLM credential set changed. Recreate the provider to switch modes.")
  return set
}

function apiKeyOf(credential: Credential | undefined): string | null {
  return credential && credential.status === "active" && credential.kind === "api_key" && credential.secret.trim() ? credential.secret : null
}

/** The key used to sync: the organization key, or the admin key in per-user mode. */
export async function syncKey(database: GatewayTx | typeof db, set: GatewaySet, mode: LiteLlmMode) {
  const subject = mode === "org" ? "org" : LITELLM_ADMIN_CREDENTIAL_SUBJECT
  const [row] = await database.select().from(GatewayProviderCredentialTable)
    .where(and(eq(GatewayProviderCredentialTable.credential_set_id, set.id), eq(GatewayProviderCredentialTable.subject, subject), isNull(GatewayProviderCredentialTable.org_membership_id)))
  const key = apiKeyOf(row)
  if (!row || !key) throw new GatewayWriteError(409, "litellm_key_missing", mode === "org" ? "Add the organization LiteLLM key, then sync again." : "Add the LiteLLM admin key, then sync again.")
  return { credential: row, key }
}

type MemberMatch =
  | { kind: "matched"; memberId: GatewayMemberId; credentialId: Credential["id"]; secret: string; models: string[]; teamId: string | null }
  | { kind: "rejected"; memberId: GatewayMemberId; credentialId: Credential["id"]; secret: string }
  | { kind: "unavailable"; memberId: GatewayMemberId }

export type LiteLlmSyncPlan = {
  mode: LiteLlmMode
  setId: GatewaySet["id"]
  syncCredential: { id: Credential["id"]; secret: string }
  catalog: LiteLlmModel[]
  teams: LiteLlmTeam[]
  teamsAvailable: boolean
  members: MemberMatch[]
}

/**
 * What a member key can reach. A key that reaches nothing is rejected up front.
 * LiteLLM's /v1/models over-reports for a key without a team: it lists every
 * proxy model even when the owner may call only some. With the admin key, the
 * owner's own model list narrows it to what LiteLLM will actually serve.
 */
export async function verifyLiteLlmKey(client: LiteLlmClient, key: string, adminKey: string | null = null) {
  let models = await client.listModels(key)
  const info = models.length ? await client.keyInfo(key) : null
  if (info && !info.teamId && info.userId && adminKey) {
    const owner = await client.userModels(adminKey, info.userId).catch((error: unknown) => {
      if (error instanceof LiteLlmError && error.code === "unreachable") throw error
      return null
    })
    const personal = owner === null ? null : liteLlmPersonalModels(owner, info.models, models)
    if (personal !== null) models = personal
  }
  if (!models.length) throw new LiteLlmError("no_models", "This LiteLLM key has no models it can use.")
  return { models, teamId: info?.teamId ?? null }
}

/** The stored admin key of a per-person LiteLLM provider, for checks that need it. */
export async function liteLlmAdminKey(provider: GatewayProvider): Promise<string | null> {
  const settings = requireSettings(provider)
  if (settings.mode !== "member") return null
  const set = await activeSet(db, provider, settings)
  try { return (await syncKey(db, set, settings.mode)).key } catch { return null }
}

async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index])
    }
  }))
  return results
}

/** Catalog (and, in per-user mode, teams) visible to the sync key. Verifies the key. */
export async function planLiteLlmCatalog(client: LiteLlmClient, mode: LiteLlmMode, key: string): Promise<Pick<LiteLlmSyncPlan, "catalog" | "teams" | "teamsAvailable">> {
  const modelIds = await client.listModels(key)
  if (!modelIds.length) throw new LiteLlmError("no_models", mode === "org" ? "The organization LiteLLM key has no models it can use." : "The LiteLLM admin key lists no models.")
  const catalog = liteLlmCatalogModels(modelIds, await client.modelGroupInfo(key)).slice(0, 500)
  if (!catalog.length) throw new LiteLlmError("no_models", "LiteLLM lists no chat models for this key.")
  let teams: LiteLlmTeam[] = []
  let teamsAvailable = false
  // Per-person modes read users, teams and keys, so the key must be an admin key.
  if (mode === "member") {
    teams = (await client.requireAdmin(key)).slice(0, 1000)
    teamsAvailable = true
  }
  return { catalog, teams, teamsAvailable }
}

/** Network half of a sync. Holds no locks; applyLiteLlmSync rechecks every input. */
export async function planLiteLlmSync(provider: GatewayProvider, client: LiteLlmClient = createLiteLlmClient(liteLlmEndpoints(provider))): Promise<LiteLlmSyncPlan> {
  const settings = requireSettings(provider)
  const set = await activeSet(db, provider, settings)
  const { credential, key } = await syncKey(db, set, settings.mode)
  const catalog = await planLiteLlmCatalog(client, settings.mode, key)
  // Issued keys are reconciled per person by litellm-issued.ts, not matched here.
  const members = settings.mode === "member" && settings.keySource === "personal" ? await planMemberMatches(set, client, key) : []
  return { mode: settings.mode, setId: set.id, syncCredential: { id: credential.id, secret: credential.secret }, ...catalog, members }
}

async function planMemberMatches(set: GatewaySet, client: LiteLlmClient, adminKey: string): Promise<MemberMatch[]> {
  const rows = (await db.select().from(GatewayProviderCredentialTable).where(and(eq(GatewayProviderCredentialTable.credential_set_id, set.id), eq(GatewayProviderCredentialTable.status, "active"))))
    .flatMap((row) => row.org_membership_id !== null && row.subject === row.org_membership_id ? [{ row, memberId: row.org_membership_id }] : [])
  return mapLimited(rows, MEMBER_MATCH_CONCURRENCY, async ({ row, memberId }): Promise<MemberMatch> => {
    const key = apiKeyOf(row)
    if (!key) return { kind: "unavailable", memberId }
    try {
      const verified = await verifyLiteLlmKey(client, key, adminKey)
      return { kind: "matched", memberId, credentialId: row.id, secret: row.secret, ...verified }
    } catch (error) {
      if (error instanceof LiteLlmError && (error.code === "unauthorized" || error.code === "no_models")) return { kind: "rejected", memberId, credentialId: row.id, secret: row.secret }
      return { kind: "unavailable", memberId }
    }
  })
}

export async function loadProviderForUpdate(tx: GatewayTx, provider: GatewayProvider) {
  const [current] = await tx.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, provider.id)).for("update")
  if (!current) throw new GatewayWriteError(404, "inference_provider_not_found")
  return current
}

export async function saveSettings(tx: GatewayTx, provider: GatewayProvider, settings: LiteLlmSettings) {
  const updated_at = new Date()
  const next = { ...provider.settings, litellm: settings }
  await tx.update(GatewayProviderTable).set({ settings: next, updated_at }).where(eq(GatewayProviderTable.id, provider.id))
  provider.settings = next
  provider.updated_at = updated_at
}

/** Creates or refreshes the group for `key`. Admin renames survive later syncs. */
export async function ensureGroup(tx: GatewayTx, provider: GatewayProvider, settings: LiteLlmSettings, key: string, name: string, description: string, modelIds: string[]): Promise<GroupId> {
  const known = settings.groups[key]
  const [existing] = known && isDenTypeId("gatewayModelGroup", known) ? await tx.select().from(GatewayModelGroupTable)
    .where(and(eq(GatewayModelGroupTable.id, known), eq(GatewayModelGroupTable.gateway_provider_id, provider.id))) : []
  const id = await writeGatewayGroup(tx, provider, existing ? { modelIds } : { name, description, modelIds, status: "active" }, existing?.id)
  settings.groups[key] = id
  return id
}

export function groupName(modelIds: string[], alias: string | null) {
  return alias ? `LiteLLM · ${alias}`.slice(0, 255) : `LiteLLM · ${modelIds.length} model${modelIds.length === 1 ? "" : "s"}`
}

export async function memberEligible(tx: GatewayTx | typeof db, provider: GatewayProvider, set: GatewaySet, memberId: GatewayMemberId, settings: LiteLlmSettings) {
  const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable)
    .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt)))
  if (!member) return false
  const issued = await tx.select({ grantId: GatewayLiteLlmIssuedKeyTable.access_grant_id }).from(GatewayLiteLlmIssuedKeyTable).where(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, provider.id))
  const automatic = new Set([...Object.values(settings.members).flatMap((entry) => entry.grantId ? [entry.grantId] : []), ...issued.flatMap((row) => row.grantId ? [row.grantId] : [])])
  const rows = await tx.select({ grant: GatewayProviderAccessTable }).from(GatewayProviderAccessTable)
    .innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.status, "active")))
    .where(and(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id), eq(GatewayProviderAccessTable.credential_set_id, set.id)))
  const teams = await memberGatewayTeams(tx, provider.organization_id, memberId)
  return set.status === "active" && provider.status === "active"
    && effectiveGatewayGrants(rows.map((row) => row.grant).filter((grant) => !automatic.has(grant.id)), memberId, teams.map((team) => team.id)).length > 0
}

async function dropAssignment(tx: GatewayTx, provider: GatewayProvider, settings: LiteLlmSettings, memberId: string) {
  const assignment = settings.members[memberId]
  if (!assignment) return
  if (assignment.grantId && isDenTypeId("inferenceProviderAccess", assignment.grantId)) {
    await tx.delete(GatewayProviderAccessTable).where(and(eq(GatewayProviderAccessTable.id, assignment.grantId), eq(GatewayProviderAccessTable.gateway_provider_id, provider.id)))
  }
  delete settings.members[memberId]
}

export type LiteLlmAssignment =
  | { kind: "assigned"; modelGroupId: GroupId; modelGroupName: string; modelIds: string[] }
  | { kind: "not_eligible" | "no_models" }

/** Points a member at the shared group for their key's model set. Caller holds the provider lock. */
async function assignMember(tx: GatewayTx, provider: GatewayProvider, set: GatewaySet, settings: LiteLlmSettings, memberId: GatewayMemberId, models: string[], teamId: string | null): Promise<LiteLlmAssignment> {
  if (!await memberEligible(tx, provider, set, memberId, settings)) {
    await dropAssignment(tx, provider, settings, memberId)
    return { kind: "not_eligible" }
  }
  const catalogIds = new Set(settings.catalog.map((model) => model.id))
  const modelIds = [...new Set(models.filter((id) => catalogIds.has(id)))].sort()
  if (!modelIds.length) {
    await dropAssignment(tx, provider, settings, memberId)
    return { kind: "no_models" }
  }
  const alias = teamId ? settings.teams.find((team) => team.id === teamId)?.alias ?? null : null
  const groupId = await ensureGroup(tx, provider, settings, liteLlmModelSetKey(modelIds), groupName(modelIds, alias),
    alias ? `Members of the LiteLLM team ${alias}.` : "Members whose LiteLLM key reaches exactly these models.", modelIds)
  const [group] = await tx.select().from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.id, groupId))
  const previous = settings.members[memberId]
  const audience: GatewayAudience = { type: "member", memberId }
  const [current] = await tx.select().from(GatewayProviderAccessTable).where(and(
    eq(GatewayProviderAccessTable.gateway_provider_id, provider.id), eq(GatewayProviderAccessTable.model_group_id, groupId),
    eq(GatewayProviderAccessTable.credential_set_id, set.id), eq(GatewayProviderAccessTable.audience_key, gatewayAudienceKey(audience))))
  if (previous && previous.grantId !== (current?.id ?? null)) await dropAssignment(tx, provider, settings, memberId)
  // An admin may already grant this exact group to the member; reuse, never own, that grant.
  const grantId = current ? (previous?.grantId === current.id ? current.id : null)
    : await writeGatewayGrant(tx, provider, { modelGroupId: groupId, credentialSetId: set.id, audience })
  settings.members[memberId] = { grantId, groupId, teamId, matchedAt: new Date().toISOString() }
  return { kind: "assigned", modelGroupId: groupId, modelGroupName: group?.name ?? groupName(modelIds, alias), modelIds }
}

async function deleteUnusedGroups(tx: GatewayTx, provider: GatewayProvider, settings: LiteLlmSettings, keep: Set<string>) {
  for (const [key, id] of Object.entries(settings.groups)) {
    if (!key.startsWith("models:") || keep.has(key)) continue
    if (!isDenTypeId("gatewayModelGroup", id)) { delete settings.groups[key]; continue }
    const [grant] = await tx.select({ id: GatewayProviderAccessTable.id }).from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.model_group_id, id)).limit(1)
    if (grant) continue
    await tx.delete(GatewayModelGroupModelTable).where(eq(GatewayModelGroupModelTable.model_group_id, id))
    await tx.delete(GatewayModelGroupTable).where(and(eq(GatewayModelGroupTable.id, id), eq(GatewayModelGroupTable.gateway_provider_id, provider.id)))
    delete settings.groups[key]
  }
}

export type LiteLlmSyncResult = {
  modelCount: number
  groupCount: number
  teamCount: number
  members: { matched: number; rejected: number; unavailable: number; removed: number }
  warnings: string[]
}

/** Database half of a sync. Caller holds the provider lock (providerTransaction). */
export async function applyLiteLlmSync(tx: GatewayTx, lockedProvider: GatewayProvider, plan: LiteLlmSyncPlan): Promise<LiteLlmSyncResult> {
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = requireSettings(provider)
  const set = await activeSet(tx, provider, settings)
  if (set.id !== plan.setId || settings.mode !== plan.mode) throw new GatewayWriteError(409, "litellm_credential_set_changed", "The LiteLLM configuration changed during sync. Sync again.")
  const { credential } = await syncKey(tx, set, settings.mode)
  if (credential.id !== plan.syncCredential.id || credential.secret !== plan.syncCredential.secret) throw new GatewayWriteError(409, "litellm_key_changed", "The LiteLLM key changed during sync. Sync again.")
  const warnings: string[] = []

  settings.catalog = plan.catalog
  await writeGatewayModels(tx, provider, plan.catalog)
  const catalogIds = plan.catalog.map((model) => model.id)
  const keep = new Set<string>()
  if (plan.mode === "org") {
    await ensureGroup(tx, provider, settings, ALL_MODELS_GROUP_KEY, "All LiteLLM models", "Every model the organization LiteLLM key can use.", catalogIds)
  } else {
    if (settings.keySource === "issued") await ensureGroup(tx, provider, settings, SIGN_IN_GROUP_KEY, LITELLM_ISSUED_ACCESS_GROUP_NAME, "Grant this group to the people and teams OpenWork should create LiteLLM keys for. It holds no models; each person's LiteLLM teams or existing key decide their models.", [])
    else await ensureGroup(tx, provider, settings, SIGN_IN_GROUP_KEY, LITELLM_PERSONAL_ACCESS_GROUP_NAME, "Grant this group to the people and teams who may connect their own LiteLLM key. It holds no models; each person's key decides their models.", [])
    if (plan.teamsAvailable) {
      settings.teams = plan.teams.map((team) => {
        const models = liteLlmTeamModels(team, catalogIds)
        return { id: team.id, alias: team.alias, modelSetKey: models?.length ? liteLlmModelSetKey(models) : null }
      })
      for (const team of plan.teams) {
        const models = liteLlmTeamModels(team, catalogIds)
        if (!models?.length) continue
        const key = liteLlmModelSetKey(models)
        keep.add(key)
        await ensureGroup(tx, provider, settings, key, groupName(models, team.alias ?? team.id), `Members of the LiteLLM team ${team.alias ?? team.id}.`, models)
      }
    } else warnings.push("The admin key could not list LiteLLM teams, so groups are named by model count.")
  }

  const members = { matched: 0, rejected: 0, unavailable: 0, removed: 0 }
  for (const match of plan.members) {
    if (match.kind === "unavailable") { members.unavailable += 1; continue }
    const [row] = await tx.select().from(GatewayProviderCredentialTable).where(eq(GatewayProviderCredentialTable.id, match.credentialId)).for("update")
    // The member replaced or removed their key during the sync; their own save already matched it.
    if (!row || row.secret !== match.secret || row.status !== "active") { members.unavailable += 1; continue }
    if (match.kind === "rejected") {
      await tx.update(GatewayProviderCredentialTable).set({ status: "revoked", secret: "{}", last_error: "litellm_key_rejected", updated_at: new Date() }).where(eq(GatewayProviderCredentialTable.id, row.id))
      await dropAssignment(tx, provider, settings, match.memberId)
      members.rejected += 1
      continue
    }
    const result = await assignMember(tx, provider, set, settings, match.memberId, match.models, match.teamId)
    if (result.kind === "assigned") members.matched += 1
    else members.removed += 1
  }
  // Members whose eligibility was removed since they connected lose their automatic grant.
  for (const memberId of Object.keys(settings.members)) {
    if (!isDenTypeId("member", memberId)) { await dropAssignment(tx, provider, settings, memberId); continue }
    if (!await memberEligible(tx, provider, set, memberId, settings)) { await dropAssignment(tx, provider, settings, memberId); members.removed += 1 }
  }
  for (const assignment of Object.values(settings.members)) {
    const key = Object.entries(settings.groups).find(([, id]) => id === assignment.groupId)?.[0]
    if (key) keep.add(key)
  }
  await deleteUnusedGroups(tx, provider, settings, keep)
  settings.lastSyncedAt = new Date().toISOString()
  settings.lastSyncError = null
  await saveSettings(tx, provider, settings)
  Object.assign(lockedProvider, provider)
  return { modelCount: plan.catalog.length, groupCount: Object.keys(settings.groups).length, teamCount: settings.teams.length, members, warnings }
}

/** Records a failed sync without touching the last good catalog. */
export async function recordLiteLlmSyncError(providerId: GatewayProvider["id"], message: string) {
  await db.transaction(async (tx) => {
    const [provider] = await tx.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, providerId)).for("update")
    const settings = provider ? readLiteLlmSettings(provider.settings) : null
    if (!provider || !settings) return
    await saveSettings(tx, provider, { ...settings, lastSyncError: message.slice(0, 500) })
  })
}

export type LiteLlmCreateInput = {
  name: string
  mode: LiteLlmMode
  endpoints: LiteLlmEndpoints
  apiKey: string
  audiences: GatewayAudience[]
  creatorId: GatewayMemberId
}

/**
 * Inserts a LiteLLM provider, its single credential set and its initial sync.
 * The caller verified the key with planLiteLlmCreate and holds the member lock.
 */
export async function createLiteLlmProvider(tx: GatewayTx, provider: GatewayProvider, input: LiteLlmCreateInput, plan: Pick<LiteLlmSyncPlan, "catalog" | "teams" | "teamsAvailable">) {
  await tx.insert(GatewayProviderTable).values(provider)
  const set: GatewaySet = {
    id: createDenTypeId("gatewayCredentialSet"), gateway_provider_id: provider.id, created_by_org_membership_id: input.creatorId,
    name: input.mode === "org" ? "Organization LiteLLM key" : readLiteLlmSettings(provider.settings)?.keySource === "issued" ? "LiteLLM keys created by OpenWork" : "Personal LiteLLM keys", credential_mode: input.mode,
    oauth_client_id: null, oauth_client_secret: null, status: "active", created_at: provider.created_at, updated_at: provider.created_at,
  }
  await tx.insert(GatewayCredentialSetTable).values(set)
  const credential = await upsertKeyRow(tx, provider, set, input.mode === "org" ? "org" : LITELLM_ADMIN_CREDENTIAL_SUBJECT, null, input.apiKey)
  await saveSettings(tx, provider, { ...readLiteLlmSettings(provider.settings) ?? emptySettings(input.mode, set.id), credentialSetId: set.id })
  const result = await applyLiteLlmSync(tx, provider, { mode: input.mode, setId: set.id, syncCredential: { id: credential.id, secret: credential.secret }, members: [], ...plan })
  const settings = requireSettings(provider)
  const groupId = settings.groups[input.mode === "org" ? ALL_MODELS_GROUP_KEY : SIGN_IN_GROUP_KEY]
  if (!groupId) throw new GatewayWriteError(409, "litellm_group_missing")
  for (const audience of input.audiences) await writeGatewayGrant(tx, provider, { modelGroupId: groupId, credentialSetId: set.id, audience })
  return { setId: set.id, result }
}

export function emptySettings(mode: LiteLlmMode, credentialSetId: string, issue?: Pick<LiteLlmSettings, "keySource" | "issueStrategy" | "mirrorFallback">): LiteLlmSettings {
  return { version: 1, mode, credentialSetId, catalog: [], teams: [], groups: {}, members: {}, lastSyncedAt: null, lastSyncError: null,
    keySource: issue?.keySource ?? "personal", issueStrategy: issue?.issueStrategy ?? "per_team", mirrorFallback: issue?.mirrorFallback ?? "per_team", teamSets: {} }
}

export async function upsertKeyRow(tx: GatewayTx, provider: GatewayProvider, set: GatewaySet, subject: string, memberId: GatewayMemberId | null, apiKey: string) {
  const [existing] = await tx.select().from(GatewayProviderCredentialTable)
    .where(and(eq(GatewayProviderCredentialTable.credential_set_id, set.id), eq(GatewayProviderCredentialTable.subject, subject))).for("update")
  const values = { kind: "api_key" as const, secret: apiKey, status: "active" as const, expires_at: null, refreshing_until: null, last_error: null, scopes: null, updated_at: new Date() }
  if (existing) {
    if (existing.gateway_provider_id !== provider.id || existing.organization_id !== provider.organization_id || existing.org_membership_id !== memberId) throw new GatewayWriteError(409, "credential_set_inconsistent")
    await tx.update(GatewayProviderCredentialTable).set(values).where(eq(GatewayProviderCredentialTable.id, existing.id))
    return { ...existing, ...values }
  }
  const row = { id: createDenTypeId("inferenceProviderCredential"), gateway_provider_id: provider.id, credential_set_id: set.id, organization_id: provider.organization_id, subject, org_membership_id: memberId, ...values }
  await tx.insert(GatewayProviderCredentialTable).values(row)
  return row
}

/** Changes how OpenWork creates keys. The next reconcile replaces keys created the old way. */
export async function updateLiteLlmIssueSettings(tx: GatewayTx, lockedProvider: GatewayProvider, input: Partial<Pick<LiteLlmSettings, "issueStrategy" | "mirrorFallback">>) {
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = requireSettings(provider)
  if (settings.mode !== "member" || settings.keySource !== "issued") throw new GatewayWriteError(409, "litellm_not_issued")
  await saveSettings(tx, provider, { ...settings, issueStrategy: input.issueStrategy ?? settings.issueStrategy, mirrorFallback: input.mirrorFallback ?? settings.mirrorFallback })
  Object.assign(lockedProvider, provider)
}

/** Replaces the organization key (org mode) or admin key (per-user mode). Verify first. */
export async function replaceLiteLlmSyncKey(tx: GatewayTx, provider: GatewayProvider, apiKey: string) {
  const settings = requireSettings(provider)
  const set = await activeSet(tx, provider, settings)
  await upsertKeyRow(tx, provider, set, settings.mode === "org" ? "org" : LITELLM_ADMIN_CREDENTIAL_SUBJECT, null, apiKey)
  await tx.update(GatewayCredentialSetTable).set({ updated_at: new Date() }).where(eq(GatewayCredentialSetTable.id, set.id))
}

/** The per-user set a member may connect to. */
export async function liteLlmMemberSet(database: GatewayTx | typeof db, provider: GatewayProvider, credentialSetId?: string) {
  const settings = requireSettings(provider)
  if (settings.mode !== "member") throw new GatewayWriteError(409, "litellm_org_key_mode", "This LiteLLM provider uses one organization key; there is nothing to connect.")
  if (settings.keySource === "issued") throw new GatewayWriteError(409, "litellm_keys_managed", "OpenWork creates your LiteLLM key for this provider; there is nothing to paste.")
  if (credentialSetId !== undefined && credentialSetId !== settings.credentialSetId) throw new GatewayWriteError(404, "credential_set_not_found")
  const set = await activeSet(database, provider, settings)
  if (set.status !== "active") throw new GatewayWriteError(403, "forbidden", "Personal LiteLLM keys are turned off for this provider.")
  return set
}

/** Stores a member's verified key and assigns their group. Caller holds the provider lock. */
export async function connectLiteLlmMemberKey(tx: GatewayTx, lockedProvider: GatewayProvider, memberId: GatewayMemberId, apiKey: string, verified: { models: string[]; teamId: string | null }): Promise<LiteLlmAssignment> {
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = requireSettings(provider)
  const set = await liteLlmMemberSet(tx, provider)
  if (!await memberEligible(tx, provider, set, memberId, settings)) throw new GatewayWriteError(403, "forbidden", "Your admin has not given you access to connect a LiteLLM key.")
  const assignment = await assignMember(tx, provider, set, settings, memberId, verified.models, verified.teamId)
  if (assignment.kind !== "assigned") {
    await saveSettings(tx, provider, settings)
    throw new GatewayWriteError(409, "litellm_no_shared_models", "Your LiteLLM key works, but none of its models are in this organization's LiteLLM catalog yet. Ask your admin to sync LiteLLM.")
  }
  await upsertKeyRow(tx, provider, set, memberId, memberId, apiKey)
  await saveSettings(tx, provider, settings)
  Object.assign(lockedProvider, provider)
  return assignment
}

/** Removes a member's key and automatic grant. Caller holds the provider lock. */
export async function disconnectLiteLlmMember(tx: GatewayTx, lockedProvider: GatewayProvider, memberId: GatewayMemberId) {
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = readLiteLlmSettings(provider.settings)
  if (!settings) return
  await dropAssignment(tx, provider, settings, memberId)
  await saveSettings(tx, provider, settings)
}

/**
 * Drops automatic grants of members who are no longer allowed to connect,
 * after an admin edits or removes access grants. Caller holds the provider lock.
 */
export async function pruneLiteLlmAssignments(tx: GatewayTx, lockedProvider: GatewayProvider) {
  if (!isLiteLlmProviderId(lockedProvider.provider_id)) return
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = readLiteLlmSettings(provider.settings)
  if (!settings || settings.mode !== "member" || !Object.keys(settings.members).length) return
  const set = await activeSet(tx, provider, settings)
  let changed = false
  for (const memberId of Object.keys(settings.members)) {
    if (isDenTypeId("member", memberId) && await memberEligible(tx, provider, set, memberId, settings)) continue
    await dropAssignment(tx, provider, settings, memberId)
    changed = true
  }
  if (changed) await saveSettings(tx, provider, settings)
  Object.assign(lockedProvider, provider)
}
