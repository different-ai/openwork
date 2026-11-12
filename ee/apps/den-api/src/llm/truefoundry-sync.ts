/**
 * TrueFoundry gateway providers: one admin key, a personal access token for each person.
 *
 * An admin pastes a TrueFoundry virtual account token with the tenant admin
 * role. OpenWork reads the tenant's chat models with it, then, for every person
 * an admin allows (grants of the empty "Gets a TrueFoundry key" group):
 *
 *   1. finds their TrueFoundry user by their OpenWork email; when missing and
 *      "Create missing users in TrueFoundry" is on, adds them first;
 *   2. creates one personal access token owned by that user, and stores it as
 *      the person's own credential (never shown to anyone);
 *   3. lists the models that token can reach and grants the shared group with
 *      exactly that model set.
 *
 * Requests then reach TrueFoundry as that person, so TrueFoundry's teams,
 * budgets, rate limits and logs apply; OpenWork records tokens but not cost.
 * Someone with a token but no models (a new TrueFoundry user, until a TrueFoundry
 * admin gives them access) keeps the token, and the next sync picks up their models.
 *
 * TrueFoundry admins cannot delete another user's tokens, but a token can
 * delete itself. A person who loses access keeps a revoked credential row
 * (secret retained, never served) only until the next reconcile deletes the
 * token with itself.
 *
 * Network calls happen before any transaction; apply steps take the provider
 * lock and recheck eligibility. Tokens created for a plan that cannot be
 * applied are deleted again.
 */
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, GatewayCredentialSetTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderTable, GatewayTrueFoundryUserTable, MemberTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { gatewayAudienceKey } from "@openwork-ee/utils/gateway-routing"
import { TRUEFOUNDRY_ADMIN_CREDENTIAL_SUBJECT, isTrueFoundryProviderId } from "@openwork-ee/utils/truefoundry-catalog"
import type { GatewayAudience, GatewayTrueFoundrySyncResult } from "@openwork/types/den/gateway"
import { db } from "../db.js"
import { GatewayWriteError, writeGatewayGrant, writeGatewayModels, type GatewayMemberId, type GatewayProvider, type GatewaySet, type GatewayTx } from "./gateway-matrix.js"
import { liteLlmModelSetKey } from "./litellm.js"
import { getModelsDevCatalogProviders, type ModelsDevProvider } from "./models-dev.js"
import { ensureGroup, loadProviderForUpdate, memberEligible, SIGN_IN_GROUP_KEY, upsertKeyRow } from "./litellm-sync.js"
import { TrueFoundryError, createTrueFoundryClient, normalizeTrueFoundryEndpoints, trueFoundryCatalogModels, trueFoundryTokenName, type TrueFoundryClient, type TrueFoundryEndpoints, type TrueFoundryModel } from "./truefoundry.js"
import { readTrueFoundrySettings, type TrueFoundrySettings } from "./truefoundry-settings.js"
export { readTrueFoundrySettings, trueFoundryCatalogProvider, trueFoundryStatus, type TrueFoundrySettings } from "./truefoundry-settings.js"

type Credential = typeof GatewayProviderCredentialTable.$inferSelect
type UserRow = typeof GatewayTrueFoundryUserTable.$inferSelect
export type TrueFoundryUserStatus = "active" | "not_in_truefoundry" | "user_inactive" | "token_limit" | "no_models" | "error" | "revoked"

export const TRUEFOUNDRY_ACCESS_GROUP_NAME = "Gets a TrueFoundry key"
const CONCURRENCY = 4
const RETRY_AFTER_MS = 5 * 60_000

export function requireTrueFoundrySettings(provider: Pick<GatewayProvider, "provider_id" | "settings">): TrueFoundrySettings {
  const settings = isTrueFoundryProviderId(provider.provider_id) ? readTrueFoundrySettings(provider.settings) : null
  if (!settings) throw new GatewayWriteError(409, "truefoundry_not_configured", "This provider is not a configured TrueFoundry provider.")
  return settings
}

export function trueFoundryEndpoints(provider: Pick<GatewayProvider, "provider_id" | "settings">): TrueFoundryEndpoints {
  const settings = requireTrueFoundrySettings(provider)
  const gateway = provider.settings.upstreamBaseUrl
  if (typeof gateway !== "string") throw new GatewayWriteError(409, "truefoundry_not_configured", "This TrueFoundry provider has no gateway address.")
  return normalizeTrueFoundryEndpoints(settings.controlPlaneUrl, gateway)
}

export function trueFoundryErrorResponse(error: TrueFoundryError): GatewayWriteError {
  const status = error.code === "invalid_url" || error.code === "no_models" || error.code === "personal_token" ? 400 : 409
  return new GatewayWriteError(status, `truefoundry_${error.code}`, error.message)
}

export async function trueFoundryCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() } catch (error) {
    if (error instanceof TrueFoundryError) throw trueFoundryErrorResponse(error)
    throw error
  }
}

export function emptyTrueFoundrySettings(controlPlaneUrl: string, credentialSetId: string, createMissingUsers: boolean): TrueFoundrySettings {
  return { version: 1, controlPlaneUrl, credentialSetId, createMissingUsers, catalog: [], groups: {}, lastSyncedAt: null, lastSyncError: null }
}

async function activeSet(database: GatewayTx | typeof db | typeof db.$primary, provider: GatewayProvider, settings: TrueFoundrySettings): Promise<GatewaySet> {
  const [set] = await database.select().from(GatewayCredentialSetTable)
    .where(and(eq(GatewayCredentialSetTable.id, normalizeDenTypeId("gatewayCredentialSet", settings.credentialSetId)), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id)))
  if (!set || set.credential_mode !== "member") throw new GatewayWriteError(409, "truefoundry_credential_set_changed", "The TrueFoundry credential set changed. Recreate the provider.")
  return set
}

function apiKeyOf(credential: Pick<Credential, "status" | "kind" | "secret"> | undefined, allowRevoked = false): string | null {
  return credential && (credential.status === "active" || allowRevoked) && credential.kind === "api_key" && credential.secret.trim() && credential.secret !== "{}" ? credential.secret : null
}

async function adminKeyRow(database: GatewayTx | typeof db | typeof db.$primary, set: GatewaySet) {
  const [row] = await database.select().from(GatewayProviderCredentialTable)
    .where(and(eq(GatewayProviderCredentialTable.credential_set_id, set.id), eq(GatewayProviderCredentialTable.subject, TRUEFOUNDRY_ADMIN_CREDENTIAL_SUBJECT), isNull(GatewayProviderCredentialTable.org_membership_id)))
  const key = apiKeyOf(row)
  if (!row || !key) throw new GatewayWriteError(409, "truefoundry_key_missing", "Add the TrueFoundry admin key, then sync again.")
  return { credential: row, key }
}

async function saveSettings(tx: GatewayTx, provider: GatewayProvider, settings: TrueFoundrySettings) {
  const updated_at = new Date()
  const next = { ...provider.settings, truefoundry: settings }
  await tx.update(GatewayProviderTable).set({ settings: next, updated_at }).where(eq(GatewayProviderTable.id, provider.id))
  provider.settings = next
  provider.updated_at = updated_at
}

function groupName(modelIds: string[]) {
  return modelIds.length === 1 ? `TrueFoundry · ${modelIds[0]}`.slice(0, 255) : `TrueFoundry · ${modelIds.length} models`
}

/** The tenant's chat models, read with the admin key. Proves the key can manage users first. */
export async function planTrueFoundryCatalog(client: Pick<TrueFoundryClient, "requireAdmin" | "listModels">, adminKey: string, loadCatalog: () => Promise<readonly ModelsDevProvider[]> = getModelsDevCatalogProviders, previous: readonly TrueFoundryModel[] = []): Promise<TrueFoundryModel[]> {
  await client.requireAdmin(adminKey)
  const ids = await client.listModels(adminKey)
  if (!ids.length) throw new TrueFoundryError("no_models", "TrueFoundry lists no chat models for this key. Give the virtual account access to your models in TrueFoundry, then try again.")
  // Names, capabilities and limits come from models.dev; without it, models keep their ids.
  const catalog = await loadCatalog().catch((): readonly ModelsDevProvider[] => [])
  const models = trueFoundryCatalogModels(ids.slice(0, 500), catalog)
  if (catalog.length) return models
  // models.dev unreachable: keep what the last sync learned instead of dropping names and limits.
  return models.map((model) => previous.find((entry) => entry.id === model.id) ?? model)
}

export type TrueFoundryCatalogPlan = { setId: GatewaySet["id"]; adminCredential: { id: Credential["id"]; secret: string }; catalog: TrueFoundryModel[] }

/** Network half of a catalog sync. Holds no locks; applyTrueFoundryCatalog rechecks its inputs. */
export async function planTrueFoundrySync(provider: GatewayProvider, client: TrueFoundryClient = createTrueFoundryClient(trueFoundryEndpoints(provider))): Promise<TrueFoundryCatalogPlan> {
  const settings = requireTrueFoundrySettings(provider)
  // Primary: syncs run right after the provider or its key was written.
  const set = await activeSet(db.$primary, provider, settings)
  const { credential, key } = await adminKeyRow(db.$primary, set)
  const catalog = await planTrueFoundryCatalog(client, key, getModelsDevCatalogProviders, settings.catalog)
  return { setId: set.id, adminCredential: { id: credential.id, secret: credential.secret }, catalog }
}

/** Database half of a catalog sync. Caller holds the provider lock (providerTransaction). */
export async function applyTrueFoundryCatalog(tx: GatewayTx, lockedProvider: GatewayProvider, plan: TrueFoundryCatalogPlan) {
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = requireTrueFoundrySettings(provider)
  const set = await activeSet(tx, provider, settings)
  if (set.id !== plan.setId) throw new GatewayWriteError(409, "truefoundry_credential_set_changed", "The TrueFoundry configuration changed during sync. Sync again.")
  const { credential } = await adminKeyRow(tx, set)
  if (credential.id !== plan.adminCredential.id || credential.secret !== plan.adminCredential.secret) throw new GatewayWriteError(409, "truefoundry_key_changed", "The TrueFoundry key changed during sync. Sync again.")
  settings.catalog = plan.catalog
  await writeGatewayModels(tx, provider, plan.catalog)
  await ensureGroup(tx, provider, settings, SIGN_IN_GROUP_KEY, TRUEFOUNDRY_ACCESS_GROUP_NAME, "Grant this group to the people and teams OpenWork should create TrueFoundry keys for. It holds no models; each person's TrueFoundry access decides their models.", [])
  // Models that left the catalog drop out of every group with their rows; each
  // person's next reconcile moves them to the group matching their new set.
  settings.lastSyncedAt = new Date().toISOString()
  settings.lastSyncError = null
  await saveSettings(tx, provider, settings)
  Object.assign(lockedProvider, provider)
}

/** Records a failed sync without touching the last good catalog. */
export async function recordTrueFoundrySyncError(providerId: GatewayProvider["id"], message: string) {
  await db.transaction(async (tx) => {
    const [provider] = await tx.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, providerId)).for("update")
    const settings = provider ? readTrueFoundrySettings(provider.settings) : null
    if (!provider || !settings) return
    await saveSettings(tx, provider, { ...settings, lastSyncError: message.slice(0, 500) })
  })
}

export type TrueFoundryCreateInput = {
  adminKey: string
  audiences: GatewayAudience[]
  creatorId: GatewayMemberId
}

/**
 * Inserts a TrueFoundry provider, its member credential set, the admin key and
 * the first catalog. The caller verified the key with planTrueFoundryCatalog and
 * holds the member lock.
 */
export async function createTrueFoundryProvider(tx: GatewayTx, provider: GatewayProvider, input: TrueFoundryCreateInput, catalog: TrueFoundryModel[]) {
  const settings = requireTrueFoundrySettings(provider)
  await tx.insert(GatewayProviderTable).values(provider)
  const set: GatewaySet = {
    id: createDenTypeId("gatewayCredentialSet"), gateway_provider_id: provider.id, created_by_org_membership_id: input.creatorId,
    name: "TrueFoundry keys created by OpenWork", credential_mode: "member",
    oauth_client_id: null, oauth_client_secret: null, oauth_tenant_id: null, aws_sso: null, status: "active", created_at: provider.created_at, updated_at: provider.created_at,
  }
  await tx.insert(GatewayCredentialSetTable).values(set)
  const credential = await upsertKeyRow(tx, provider, set, TRUEFOUNDRY_ADMIN_CREDENTIAL_SUBJECT, null, input.adminKey)
  await saveSettings(tx, provider, { ...settings, credentialSetId: set.id })
  await applyTrueFoundryCatalog(tx, provider, { setId: set.id, adminCredential: { id: credential.id, secret: credential.secret }, catalog })
  const groupId = requireTrueFoundrySettings(provider).groups[SIGN_IN_GROUP_KEY]
  if (!groupId) throw new GatewayWriteError(409, "truefoundry_group_missing")
  for (const audience of input.audiences) await writeGatewayGrant(tx, provider, { modelGroupId: normalizeDenTypeId("gatewayModelGroup", groupId), credentialSetId: set.id, audience })
  return { setId: set.id }
}

/** Replaces the admin key and/or the missing-users setting. Verify a new key first. Caller holds the provider lock. */
export async function updateTrueFoundryProvider(tx: GatewayTx, lockedProvider: GatewayProvider, input: { adminKey?: string; createMissingUsers?: boolean }) {
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = requireTrueFoundrySettings(provider)
  const set = await activeSet(tx, provider, settings)
  if (input.adminKey !== undefined) {
    await upsertKeyRow(tx, provider, set, TRUEFOUNDRY_ADMIN_CREDENTIAL_SUBJECT, null, input.adminKey)
    await tx.update(GatewayCredentialSetTable).set({ updated_at: new Date() }).where(eq(GatewayCredentialSetTable.id, set.id))
  }
  if (input.createMissingUsers !== undefined) await saveSettings(tx, provider, { ...settings, createMissingUsers: input.createMissingUsers })
  Object.assign(lockedProvider, provider)
}

// ---------------------------------------------------------------------------
// People

type IssueContext = {
  provider: GatewayProvider
  settings: TrueFoundrySettings
  client: TrueFoundryClient
  adminKey: string
  catalogIds: string[]
}

export type TrueFoundryMemberPlan = {
  memberId: GatewayMemberId
  outcome: Exclude<TrueFoundryUserStatus, "revoked">
  message: string | null
  userId: string | null
  /** When OpenWork added the TrueFoundry user in this plan or earlier. */
  userCreatedAt: Date | null
  /** The token to store, or null to keep none. */
  token: { value: string; id: string | null; name: string; created: boolean } | null
  models: string[]
}

async function memberRow(providerId: GatewayProvider["id"], memberId: GatewayMemberId, database: typeof db | typeof db.$primary = db) {
  const [row] = await database.select({ row: GatewayTrueFoundryUserTable, secret: GatewayProviderCredentialTable.secret, credentialStatus: GatewayProviderCredentialTable.status, credentialKind: GatewayProviderCredentialTable.kind })
    .from(GatewayTrueFoundryUserTable)
    .leftJoin(GatewayProviderCredentialTable, eq(GatewayProviderCredentialTable.id, GatewayTrueFoundryUserTable.credential_id))
    .where(and(eq(GatewayTrueFoundryUserTable.gateway_provider_id, providerId), eq(GatewayTrueFoundryUserTable.org_membership_id, memberId)))
  return row ?? null
}

async function issueContext(provider: GatewayProvider, client?: TrueFoundryClient): Promise<IssueContext> {
  const settings = requireTrueFoundrySettings(provider)
  // Primary: provisioning runs right after the provider, its key or its grants were written.
  const set = await activeSet(db.$primary, provider, settings)
  const { key } = await adminKeyRow(db.$primary, set)
  return { provider, settings, client: client ?? createTrueFoundryClient(trueFoundryEndpoints(provider)), adminKey: key, catalogIds: settings.catalog.map((model) => model.id) }
}

/** Deletes a token with itself; best effort, never throws. */
async function deleteToken(client: TrueFoundryClient, token: { value: string; id: string | null }) {
  if (!token.id) return
  await client.deleteOwnToken(token.value, token.id).catch((error: unknown) => {
    console.warn("truefoundry_token_delete_failed", { code: error instanceof TrueFoundryError ? error.code : "unexpected" })
  })
}

/** Network half for one person: find (or add) them, reuse or create their token, read its models. */
export async function planTrueFoundryMember(ctx: IssueContext, member: { memberId: GatewayMemberId; email: string | null }): Promise<TrueFoundryMemberPlan> {
  const existing = await memberRow(ctx.provider.id, member.memberId)
  const previousCreatedAt = existing?.row.truefoundry_user_created ?? null
  const base = { memberId: member.memberId, userId: existing?.row.truefoundry_user_id ?? null, userCreatedAt: previousCreatedAt }
  const reachable = (models: string[]) => models.filter((id) => ctx.catalogIds.includes(id))
  let created: { value: string; id: string | null; name: string } | null = null
  try {
    // A stored token that still works is kept: TrueFoundry limits how many each person may hold.
    const stored = existing && existing.row.status !== "revoked" && existing.credentialStatus === "active" && existing.credentialKind === "api_key" && existing.secret && existing.row.token_name
      ? { value: existing.secret, id: existing.row.token_id, name: existing.row.token_name } : null
    if (stored) {
      try {
        const models = reachable(await ctx.client.listModels(stored.value))
        return models.length
          ? { ...base, outcome: "active", message: null, token: { ...stored, created: false }, models }
          : { ...base, outcome: "no_models", message: "This person's TrueFoundry access reaches none of the synced models. Give them access in TrueFoundry, then sync.", token: { ...stored, created: false }, models: [] }
      } catch (error) {
        // Expired or deleted in TrueFoundry: create a fresh token below.
        if (!(error instanceof TrueFoundryError && error.code === "unauthorized")) throw error
      }
    }

    if (!member.email) return { ...base, outcome: "not_in_truefoundry", message: "This person has no email address in OpenWork.", token: null, models: [] }
    let user = await ctx.client.findUserByEmail(ctx.adminKey, member.email)
    let userCreatedAt = previousCreatedAt
    if (!user && ctx.settings.createMissingUsers) {
      await ctx.client.registerUser(ctx.adminKey, member.email)
      user = await ctx.client.findUserByEmail(ctx.adminKey, member.email)
      if (user) userCreatedAt = new Date()
    }
    if (!user) {
      return { ...base, outcome: "not_in_truefoundry", message: ctx.settings.createMissingUsers
        ? `OpenWork could not add ${member.email} to TrueFoundry.`
        : `No TrueFoundry user has the email ${member.email}. Add them in TrueFoundry, or turn on Create missing users in TrueFoundry.`, token: null, models: [] }
    }
    if (!user.active) return { ...base, userId: user.id, userCreatedAt, outcome: "user_inactive", message: `The TrueFoundry user ${user.email} is deactivated. Activate them in TrueFoundry, then check again.`, token: null, models: [] }

    const name = trueFoundryTokenName()
    const value = await ctx.client.createUserToken(ctx.adminKey, { email: user.email, name })
    created = { value, id: null, name }
    created.id = await ctx.client.ownTokenId(value, name).catch(() => null)
    const models = reachable(await ctx.client.listModels(value))
    const token = { ...created, created: true }
    return models.length
      ? { ...base, userId: user.id, userCreatedAt, outcome: "active", message: null, token, models }
      : { ...base, userId: user.id, userCreatedAt, outcome: "no_models", message: userCreatedAt
        ? "OpenWork added this person to TrueFoundry. Only TrueFoundry's default models are available until you give them access in TrueFoundry, and none are synced yet."
        : "This person's TrueFoundry access reaches none of the synced models. Give them access in TrueFoundry, then sync.", token, models: [] }
  } catch (error) {
    // Never leave a token behind for a plan that will not be applied.
    if (created) await deleteToken(ctx.client, created)
    if (error instanceof TrueFoundryError && error.code === "token_limit") return { ...base, outcome: "token_limit", message: error.message, token: null, models: [] }
    if (error instanceof TrueFoundryError && error.code === "user_not_found") return { ...base, outcome: "not_in_truefoundry", message: error.message, token: null, models: [] }
    const message = error instanceof TrueFoundryError ? error.message : "OpenWork could not create this person's TrueFoundry key."
    return { ...base, outcome: "error", message, token: null, models: [] }
  }
}

async function upsertRow(tx: GatewayTx, values: typeof GatewayTrueFoundryUserTable.$inferInsert) {
  const where = and(eq(GatewayTrueFoundryUserTable.gateway_provider_id, values.gateway_provider_id), eq(GatewayTrueFoundryUserTable.org_membership_id, values.org_membership_id))
  const [existing] = await tx.select().from(GatewayTrueFoundryUserTable).where(where).for("update")
  if (existing) await tx.update(GatewayTrueFoundryUserTable).set({ ...values, updated_at: new Date() }).where(where)
  else await tx.insert(GatewayTrueFoundryUserTable).values(values)
}

/** Drops a row's automatic grant and stops serving its token. Keeps the secret until the token deletes itself. */
async function revokeRow(tx: GatewayTx, row: UserRow) {
  if (row.credential_id) await tx.update(GatewayProviderCredentialTable).set({ status: "revoked", last_error: "truefoundry_access_removed", updated_at: new Date() }).where(eq(GatewayProviderCredentialTable.id, row.credential_id))
  if (row.access_grant_id) await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, row.access_grant_id))
  await tx.update(GatewayTrueFoundryUserTable).set({ status: "revoked", access_grant_id: null, model_group_id: null, message: null, updated_at: new Date() })
    .where(and(eq(GatewayTrueFoundryUserTable.gateway_provider_id, row.gateway_provider_id), eq(GatewayTrueFoundryUserTable.org_membership_id, row.org_membership_id)))
}

/**
 * Database half for one person. Returns a token created for the plan that must
 * be deleted because the person may no longer have one.
 */
export async function applyTrueFoundryMember(tx: GatewayTx, lockedProvider: GatewayProvider, plan: TrueFoundryMemberPlan): Promise<{ value: string; id: string | null } | null> {
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = readTrueFoundrySettings(provider.settings)
  const discard = plan.token?.created ? plan.token : null
  if (!settings) return discard
  const set = await activeSet(tx, provider, settings)
  const [current] = await tx.select().from(GatewayTrueFoundryUserTable)
    .where(and(eq(GatewayTrueFoundryUserTable.gateway_provider_id, provider.id), eq(GatewayTrueFoundryUserTable.org_membership_id, plan.memberId))).for("update")
  if (!await memberEligible(tx, provider, set, plan.memberId, settings)) {
    if (current) await revokeRow(tx, current)
    return discard
  }
  const now = new Date()
  const row = { gateway_provider_id: provider.id, org_membership_id: plan.memberId, status: plan.outcome, message: plan.message, truefoundry_user_id: plan.userId, truefoundry_user_created: plan.userCreatedAt, checked_at: now }
  if (!plan.token) {
    // Nothing usable: stop serving any earlier token. A stored token TrueFoundry rejected is already gone there.
    if (current) {
      if (current.credential_id) await tx.update(GatewayProviderCredentialTable).set({ status: "revoked", secret: "{}", last_error: "truefoundry_token_unavailable", updated_at: now }).where(eq(GatewayProviderCredentialTable.id, current.credential_id))
      if (current.access_grant_id) await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, current.access_grant_id))
    }
    await upsertRow(tx, { ...row, token_id: null, token_name: null, credential_id: null, model_group_id: null, access_grant_id: null })
    return null
  }
  const credential = await upsertKeyRow(tx, provider, set, plan.memberId, plan.memberId, plan.token.value)
  let groupId: typeof GatewayModelGroupTable.$inferSelect.id | null = null
  let grantId: typeof GatewayProviderAccessTable.$inferSelect.id | null = null
  const ownGrant = current?.access_grant_id ?? null
  if (plan.models.length) {
    groupId = await ensureGroup(tx, provider, settings, liteLlmModelSetKey(plan.models), groupName(plan.models), "People whose TrueFoundry access reaches exactly these models.", plan.models)
    const audience = { type: "member" as const, memberId: plan.memberId }
    const [grant] = await tx.select().from(GatewayProviderAccessTable).where(and(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id), eq(GatewayProviderAccessTable.model_group_id, groupId),
      eq(GatewayProviderAccessTable.credential_set_id, set.id), eq(GatewayProviderAccessTable.audience_key, gatewayAudienceKey(audience))))
    if (ownGrant && ownGrant !== grant?.id) await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, ownGrant))
    // Reuse, never own, an identical grant an admin made by hand.
    grantId = grant ? (grant.id === ownGrant ? grant.id : null) : await writeGatewayGrant(tx, provider, { modelGroupId: groupId, credentialSetId: set.id, audience })
  } else if (ownGrant) {
    await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, ownGrant))
  }
  await upsertRow(tx, { ...row, token_id: plan.token.id, token_name: plan.token.name, credential_id: credential.id, model_group_id: groupId, access_grant_id: grantId })
  await saveSettings(tx, provider, settings)
  Object.assign(lockedProvider, provider)
  return null
}

/** Active members allowed to get tokens: admin grants on the access group, excluding automatic grants. */
export async function trueFoundryEligibleMembers(provider: GatewayProvider, settings: TrueFoundrySettings) {
  const groupId = settings.groups[SIGN_IN_GROUP_KEY]
  if (!groupId || !isDenTypeId("gatewayModelGroup", groupId)) return []
  // Primary: reconciling runs right after the grants were written.
  const grants = await db.$primary.select().from(GatewayProviderAccessTable).innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.status, "active")))
    .where(and(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id), eq(GatewayProviderAccessTable.model_group_id, groupId), eq(GatewayProviderAccessTable.credential_set_id, normalizeDenTypeId("gatewayCredentialSet", settings.credentialSetId))))
  const audience = grants.map((row) => row.gateway_provider_access)
  const everyone = audience.some((grant) => grant.audience_key === "organization")
  const teamIds = audience.flatMap((grant) => grant.team_id ? [grant.team_id] : [])
  const memberIds = new Set(audience.flatMap((grant) => grant.org_membership_id ? [grant.org_membership_id] : []))
  if (teamIds.length) {
    const teamMembers = await db.$primary.select({ memberId: TeamMemberTable.orgMembershipId }).from(TeamMemberTable).innerJoin(TeamTable, eq(TeamTable.id, TeamMemberTable.teamId))
      .where(and(inArray(TeamMemberTable.teamId, teamIds), eq(TeamTable.organizationId, provider.organization_id)))
    for (const row of teamMembers) if (row.memberId) memberIds.add(row.memberId)
  }
  if (!everyone && !memberIds.size) return []
  return db.$primary.select({ memberId: MemberTable.id, email: AuthUserTable.email }).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt), everyone ? undefined : inArray(MemberTable.id, [...memberIds])))
}

async function applyPlan(provider: GatewayProvider, ctx: IssueContext, plan: TrueFoundryMemberPlan) {
  const orphan = await db.transaction(async (tx) => applyTrueFoundryMember(tx, provider, plan)).catch(async (error: unknown) => {
    if (plan.token?.created) await deleteToken(ctx.client, plan.token)
    throw error
  })
  if (orphan) await deleteToken(ctx.client, orphan)
}

/** Deletes the tokens of people who lost access or left, then forgets them. */
async function removeStaleMembers(ctx: IssueContext, eligibleIds: Set<string>) {
  // Primary: sees the rows applyPlan wrote moments ago.
  const rows = await db.$primary.select({ row: GatewayTrueFoundryUserTable, secret: GatewayProviderCredentialTable.secret, kind: GatewayProviderCredentialTable.kind, status: GatewayProviderCredentialTable.status })
    .from(GatewayTrueFoundryUserTable).leftJoin(GatewayProviderCredentialTable, eq(GatewayProviderCredentialTable.id, GatewayTrueFoundryUserTable.credential_id))
    .where(eq(GatewayTrueFoundryUserTable.gateway_provider_id, ctx.provider.id))
  let removed = 0
  for (const entry of rows.filter(({ row }) => row.status === "revoked" || !eligibleIds.has(row.org_membership_id))) {
    const value = entry.kind ? apiKeyOf({ status: entry.status ?? "revoked", kind: entry.kind, secret: entry.secret ?? "" }, true) : null
    if (value) await deleteToken(ctx.client, { value, id: entry.row.token_id })
    await db.transaction(async (tx) => {
      await loadProviderForUpdate(tx, ctx.provider)
      const [current] = await tx.select().from(GatewayTrueFoundryUserTable)
        .where(and(eq(GatewayTrueFoundryUserTable.gateway_provider_id, ctx.provider.id), eq(GatewayTrueFoundryUserTable.org_membership_id, entry.row.org_membership_id))).for("update")
      if (!current) return
      // Allowed again while the token was being deleted: the next reconcile creates a fresh one.
      if (current.credential_id) await tx.update(GatewayProviderCredentialTable).set({ status: "revoked", secret: "{}", last_error: "truefoundry_access_removed", updated_at: new Date() }).where(eq(GatewayProviderCredentialTable.id, current.credential_id))
      if (current.access_grant_id) await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, current.access_grant_id))
      await tx.delete(GatewayTrueFoundryUserTable).where(and(eq(GatewayTrueFoundryUserTable.gateway_provider_id, ctx.provider.id), eq(GatewayTrueFoundryUserTable.org_membership_id, entry.row.org_membership_id)))
    })
    removed += 1
  }
  return removed
}

/** Groups no person points at any more, except the access group. Caller holds the provider lock. */
async function deleteUnusedGroups(tx: GatewayTx, lockedProvider: GatewayProvider) {
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = requireTrueFoundrySettings(provider)
  const used = new Set<string>((await tx.select({ id: GatewayTrueFoundryUserTable.model_group_id }).from(GatewayTrueFoundryUserTable)
    .where(eq(GatewayTrueFoundryUserTable.gateway_provider_id, provider.id))).flatMap((row) => row.id ? [row.id] : []))
  for (const [key, id] of Object.entries(settings.groups)) {
    if (!key.startsWith("models:") || used.has(id)) continue
    if (!isDenTypeId("gatewayModelGroup", id)) { delete settings.groups[key]; continue }
    const [grant] = await tx.select({ id: GatewayProviderAccessTable.id }).from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.model_group_id, id)).limit(1)
    if (grant) continue
    await tx.delete(GatewayModelGroupModelTable).where(eq(GatewayModelGroupModelTable.model_group_id, id))
    await tx.delete(GatewayModelGroupTable).where(and(eq(GatewayModelGroupTable.id, id), eq(GatewayModelGroupTable.gateway_provider_id, provider.id)))
    delete settings.groups[key]
  }
  await saveSettings(tx, provider, settings)
  Object.assign(lockedProvider, provider)
}

/**
 * Creates, refreshes and removes tokens for everyone. Run after a catalog sync.
 * People who lost access or left the organization have their tokens deleted
 * in TrueFoundry too. TrueFoundry users OpenWork added are never removed.
 */
export async function reconcileTrueFoundryMembers(provider: GatewayProvider, client?: TrueFoundryClient): Promise<GatewayTrueFoundrySyncResult> {
  const ctx = await issueContext(provider, client)
  const result: GatewayTrueFoundrySyncResult = { modelCount: ctx.settings.catalog.length, people: 0, tokensCreated: 0, usersCreated: 0, notInTrueFoundry: 0, noModels: 0, tokenLimit: 0, errors: 0, removed: 0 }
  const eligible = await trueFoundryEligibleMembers(provider, ctx.settings)
  const queue = [...eligible]
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let member = queue.shift(); member; member = queue.shift()) {
      const before = await memberRow(provider.id, member.memberId, db.$primary)
      const plan = await planTrueFoundryMember(ctx, member)
      try { await applyPlan(provider, ctx, plan) } catch { result.errors += 1; continue }
      if (plan.token?.created) result.tokensCreated += 1
      if (plan.userCreatedAt && !before?.row.truefoundry_user_created) result.usersCreated += 1
      if (plan.outcome === "active") result.people += 1
      else if (plan.outcome === "not_in_truefoundry" || plan.outcome === "user_inactive") result.notInTrueFoundry += 1
      else if (plan.outcome === "no_models") result.noModels += 1
      else if (plan.outcome === "token_limit") result.tokenLimit += 1
      else result.errors += 1
    }
  }))
  result.removed = await removeStaleMembers(ctx, new Set(eligible.map((member) => member.memberId)))
  await db.transaction(async (tx) => deleteUnusedGroups(tx, provider))
  return result
}

const recentAttempts = new Map<string, number>()

/** One person, now: the browser "Check again" button and first use in the app. */
export async function provisionTrueFoundryMember(provider: GatewayProvider, memberId: GatewayMemberId, options: { force?: boolean } = {}) {
  const attemptKey = `${provider.id}:${memberId}`
  const last = recentAttempts.get(attemptKey) ?? 0
  if (!options.force && Date.now() - last < RETRY_AFTER_MS) return null
  recentAttempts.set(attemptKey, Date.now())
  const ctx = await issueContext(provider)
  const [member] = await db.select({ memberId: MemberTable.id, email: AuthUserTable.email }).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt)))
  if (!member) throw new GatewayWriteError(403, "forbidden")
  const set = await activeSet(db, provider, ctx.settings)
  if (!await memberEligible(db, provider, set, memberId, ctx.settings)) throw new GatewayWriteError(403, "forbidden", "Your admin has not given you TrueFoundry access.")
  const plan = await planTrueFoundryMember(ctx, member)
  await applyPlan(provider, ctx, plan)
  return plan
}

/**
 * Starts provisioning in the background for an allowed person with no token
 * yet, at most once every few minutes, so the app picks up models on its next refresh.
 */
export function scheduleTrueFoundryProvisioning(provider: GatewayProvider, memberId: GatewayMemberId) {
  if (!isTrueFoundryProviderId(provider.provider_id) || !readTrueFoundrySettings(provider.settings)) return
  const last = recentAttempts.get(`${provider.id}:${memberId}`) ?? 0
  if (Date.now() - last < RETRY_AFTER_MS) return
  void (async () => {
    const row = await memberRow(provider.id, memberId)
    if (row?.row.status === "active" && row.credentialStatus === "active") return
    await provisionTrueFoundryMember(provider, memberId)
  })().catch((error: unknown) => {
    console.warn("truefoundry_background_provisioning_failed", { inferenceProviderId: provider.id, code: error instanceof GatewayWriteError ? error.code : error instanceof TrueFoundryError ? error.code : "unexpected" })
  })
}

/** A person's state for the connect page. */
export async function trueFoundryMemberStatus(providerId: GatewayProvider["id"], memberId: GatewayMemberId) {
  // Primary: read right after provisioning wrote this person's token.
  const row = await memberRow(providerId, memberId, db.$primary)
  const ready = row?.row.status === "active" && row.credentialStatus === "active"
  return { status: row?.row.status ?? "pending", message: row?.row.message ?? null, ready }
}

/** Local revocation after access changes; the next reconcile deletes the tokens. Caller holds the provider lock. */
export async function pruneTrueFoundryMembers(tx: GatewayTx, lockedProvider: GatewayProvider) {
  if (!isTrueFoundryProviderId(lockedProvider.provider_id)) return
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = readTrueFoundrySettings(provider.settings)
  if (!settings) return
  const set = await activeSet(tx, provider, settings)
  const rows = await tx.select().from(GatewayTrueFoundryUserTable).where(eq(GatewayTrueFoundryUserTable.gateway_provider_id, provider.id)).for("update")
  for (const row of rows) {
    if (row.status === "revoked" || await memberEligible(tx, provider, set, row.org_membership_id, settings)) continue
    await revokeRow(tx, row)
  }
}

/** Best effort, before a provider is removed: every token OpenWork created deletes itself in TrueFoundry. */
export async function deleteTrueFoundryTokens(provider: GatewayProvider) {
  if (!isTrueFoundryProviderId(provider.provider_id) || !readTrueFoundrySettings(provider.settings)) return
  const rows = await db.select({ tokenId: GatewayTrueFoundryUserTable.token_id, secret: GatewayProviderCredentialTable.secret, kind: GatewayProviderCredentialTable.kind, status: GatewayProviderCredentialTable.status })
    .from(GatewayTrueFoundryUserTable).innerJoin(GatewayProviderCredentialTable, eq(GatewayProviderCredentialTable.id, GatewayTrueFoundryUserTable.credential_id))
    .where(eq(GatewayTrueFoundryUserTable.gateway_provider_id, provider.id))
  if (!rows.length) return
  let client: TrueFoundryClient
  try { client = createTrueFoundryClient(trueFoundryEndpoints(provider)) } catch { return }
  const queue = [...rows]
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const value = apiKeyOf(row, true)
      if (value) await deleteToken(client, { value, id: row.tokenId })
    }
  }))
}
