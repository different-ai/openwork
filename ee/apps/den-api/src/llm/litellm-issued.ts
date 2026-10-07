/**
 * "OpenWork creates each person's key" mode for LiteLLM providers.
 *
 * With the stored LiteLLM admin key, OpenWork finds each allowed person's
 * LiteLLM user by their OpenWork email and creates keys for them, so nobody
 * pastes anything. LiteLLM only stores key hashes, so existing keys can never
 * be fetched; new keys are created instead:
 *
 *   per_team  one key per LiteLLM team the person belongs to (team models and
 *             budgets), or one key without a team (their own LiteLLM user
 *             settings) when they are in no team.
 *   mirror    a copy of their oldest active key: same team, models, aliases,
 *             tags and expiry. Key-level budgets and rate limits are never
 *             copied, because a copy would double the allowance. With no key
 *             to copy, fall back to per_team or report it.
 *
 * Created keys may only call models (LiteLLM llm_api_routes), so a key owned
 * by a LiteLLM admin never carries admin rights. People missing from LiteLLM
 * are never created there, because OpenWork cannot know their teams; they are
 * reported instead. Each team key lives in its own member credential set so a
 * person can hold one key per team.
 *
 * Network work runs before transactions; each apply step takes the provider
 * lock and rechecks eligibility. Keys created for a plan that cannot be
 * applied are deleted again.
 */
import { randomBytes } from "node:crypto"
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, GatewayCredentialSetTable, GatewayLiteLlmIssuedKeyTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderTable, MemberTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { gatewayAudienceKey } from "@openwork-ee/utils/gateway-routing"
import { db } from "../db.js"
import { GatewayWriteError, writeGatewayGrant, type GatewayMemberId, type GatewayProvider, type GatewaySet, type GatewayTx } from "./gateway-matrix.js"
import { LITELLM_ISSUED_KEY_ALIAS_PREFIX, LiteLlmError, createLiteLlmClient, liteLlmMirrorFingerprint, liteLlmModelSetKey, liteLlmPersonalModels, type LiteLlmClient, type LiteLlmKeyRecord, type LiteLlmUser } from "./litellm.js"
import { activeSet, ensureGroup, groupName, liteLlmEndpoints, loadProviderForUpdate, memberEligible, requireSettings, saveSettings, SIGN_IN_GROUP_KEY, syncKey, upsertKeyRow } from "./litellm-sync.js"
import { readLiteLlmSettings, type LiteLlmSettings } from "./litellm-settings.js"

type IssuedRow = typeof GatewayLiteLlmIssuedKeyTable.$inferSelect
export type LiteLlmIssueStatus = "active" | "not_in_litellm" | "no_key_to_mirror" | "no_models" | "error" | "revoked"

const MEMBER_SLOT = "member"
const PERSONAL_SLOT = "personal"
const MIRROR_SLOT = "mirror"
const CONCURRENCY = 4
const RETRY_AFTER_MS = 5 * 60_000

export function isLiteLlmIssued(settings: LiteLlmSettings | null): settings is LiteLlmSettings {
  return settings?.mode === "member" && settings.keySource === "issued"
}

type IssueContext = {
  provider: GatewayProvider
  settings: LiteLlmSettings
  client: LiteLlmClient
  adminKey: string
  catalogIds: string[]
}

type PlannedKey = {
  slot: string
  teamId: string | null
  tokenId: string
  key: string
  models: string[]
  mirroredFrom: string | null
  fingerprint: string | null
  created: boolean
}

export type LiteLlmIssuePlan = {
  memberId: GatewayMemberId
  outcome: Exclude<LiteLlmIssueStatus, "revoked">
  message: string | null
  litellmUserId: string | null
  keys: PlannedKey[]
  /** Rows whose LiteLLM keys were deleted (or replaced) during planning. */
  removeSlots: string[]
}

async function issueContext(provider: GatewayProvider, client?: LiteLlmClient): Promise<IssueContext> {
  const settings = requireSettings(provider)
  if (!isLiteLlmIssued(settings)) throw new GatewayWriteError(409, "litellm_not_issued", "This LiteLLM provider does not create keys for people.")
  const set = await activeSet(db, provider, settings)
  const { key } = await syncKey(db, set, settings.mode)
  return { provider, settings, client: client ?? createLiteLlmClient(liteLlmEndpoints(provider)), adminKey: key, catalogIds: settings.catalog.map((model) => model.id) }
}

async function memberRows(providerId: GatewayProvider["id"], memberId: GatewayMemberId) {
  const rows = await db.select({ row: GatewayLiteLlmIssuedKeyTable, secret: GatewayProviderCredentialTable.secret, credentialStatus: GatewayProviderCredentialTable.status })
    .from(GatewayLiteLlmIssuedKeyTable)
    .leftJoin(GatewayProviderCredentialTable, eq(GatewayProviderCredentialTable.id, GatewayLiteLlmIssuedKeyTable.credential_id))
    .where(and(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, providerId), eq(GatewayLiteLlmIssuedKeyTable.org_membership_id, memberId)))
  return rows
}

function keyAlias(memberId: string, slot: string) {
  return `${LITELLM_ISSUED_KEY_ALIAS_PREFIX}${memberId}-${slot}-${randomBytes(4).toString("hex")}`.slice(0, 255)
}

function isOpenWorkKey(key: LiteLlmKeyRecord) {
  return Boolean(key.alias?.startsWith(LITELLM_ISSUED_KEY_ALIAS_PREFIX)) || typeof key.metadata.openwork === "object"
}

function isUsable(key: LiteLlmKeyRecord, now = Date.now()) {
  return !key.blocked && (!key.expiresAt || Date.parse(key.expiresAt) > now)
}

/** Network half for one person: find them, decide their keys, create what is missing. */
export async function planLiteLlmMemberIssue(ctx: IssueContext, member: { memberId: GatewayMemberId; email: string | null }): Promise<LiteLlmIssuePlan> {
  const existing = await memberRows(ctx.provider.id, member.memberId)
  const keyRows = existing.filter(({ row }) => row.slot !== MEMBER_SLOT)
  const created: string[] = []
  const finish = async (outcome: LiteLlmIssuePlan["outcome"], message: string, litellmUserId: string | null = null): Promise<LiteLlmIssuePlan> => {
    // Without keys to keep, every existing key goes, in LiteLLM and here.
    await ctx.client.deleteKeys(ctx.adminKey, [...created, ...keyRows.flatMap(({ row }) => row.litellm_token_id ? [row.litellm_token_id] : [])])
    return { memberId: member.memberId, outcome, message, litellmUserId, keys: [], removeSlots: keyRows.map(({ row }) => row.slot) }
  }
  try {
    if (!member.email) return await finish("not_in_litellm", "This person has no email address in OpenWork.")
    const user = await ctx.client.findUserByEmail(ctx.adminKey, member.email)
    if (!user) return await finish("not_in_litellm", `No LiteLLM user has the email ${member.email}. A LiteLLM admin needs to add it.`)

    let desired: Array<{ slot: string; teamId: string | null; source: LiteLlmKeyRecord | null }>
    if (ctx.settings.issueStrategy === "mirror") {
      const source = (await ctx.client.listUserKeys(ctx.adminKey, user.userId)).find((key) => !isOpenWorkKey(key) && isUsable(key)) ?? null
      if (source) desired = [{ slot: MIRROR_SLOT, teamId: source.teamId, source }]
      else if (ctx.settings.mirrorFallback === "error") return await finish("no_key_to_mirror", "There is no active LiteLLM key to copy for this person. A LiteLLM admin needs to create one.", user.userId)
      else desired = teamSlots(user)
    } else desired = teamSlots(user)

    const keys: PlannedKey[] = []
    const replaced: string[] = []
    for (const want of desired) {
      const current = keyRows.find(({ row, credentialStatus }) => row.slot === want.slot && row.status === "active" && row.litellm_token_id && credentialStatus === "active")
      const fingerprint = want.source ? liteLlmMirrorFingerprint(want.source) : null
      const sameSource = current && (!want.source || current.row.mirrored_from_token_id === want.source.tokenId && current.row.source_fingerprint === fingerprint)
      let models: string[] | null = null
      if (current && sameSource && current.secret && current.row.litellm_token_id) {
        try {
          models = await keyModels(ctx, user, want, current.secret)
          keys.push({ slot: want.slot, teamId: want.teamId, tokenId: current.row.litellm_token_id, key: current.secret, models, mirroredFrom: want.source?.tokenId ?? null, fingerprint, created: false })
          continue
        } catch (error) {
          if (!(error instanceof LiteLlmError && error.code === "unauthorized")) throw error
        }
      }
      // Missing, changed at the source, or rejected by LiteLLM: create a fresh key.
      if (current?.row.litellm_token_id) replaced.push(current.row.litellm_token_id)
      const issued = await ctx.client.issueKey(ctx.adminKey, {
        userId: user.userId,
        teamId: want.teamId,
        alias: keyAlias(member.memberId, want.slot),
        metadata: { ...(want.source?.metadata ?? {}), openwork: { organizationId: ctx.provider.organization_id, inferenceProviderId: ctx.provider.id, memberId: member.memberId, slot: want.slot } },
        ...(want.source ? { models: want.source.models, aliases: want.source.aliases, tags: want.source.tags } : {}),
        ...(want.source?.expiresAt ? { durationSeconds: (Date.parse(want.source.expiresAt) - Date.now()) / 1000 } : {}),
      })
      created.push(issued.tokenId)
      models = await keyModels(ctx, user, want, issued.key)
      keys.push({ slot: want.slot, teamId: want.teamId, tokenId: issued.tokenId, key: issued.key, models, mirroredFrom: want.source?.tokenId ?? null, fingerprint, created: true })
    }
    const removed = keyRows.filter(({ row }) => !desired.some((want) => want.slot === row.slot))
    await ctx.client.deleteKeys(ctx.adminKey, [...replaced, ...removed.flatMap(({ row }) => row.litellm_token_id ? [row.litellm_token_id] : [])])
    const usable = keys.filter((key) => key.models.length)
    if (!usable.length) {
      await ctx.client.deleteKeys(ctx.adminKey, keys.filter((key) => key.created).map((key) => key.tokenId))
      return { memberId: member.memberId, outcome: "no_models", message: "This person's LiteLLM teams and settings allow none of the synced models.", litellmUserId: user.userId, keys: [], removeSlots: keyRows.map(({ row }) => row.slot) }
    }
    return { memberId: member.memberId, outcome: "active", message: null, litellmUserId: user.userId, keys: usable, removeSlots: removed.map(({ row }) => row.slot) }
  } catch (error) {
    // Never leave keys behind for a plan that will not be applied.
    await ctx.client.deleteKeys(ctx.adminKey, created).catch(() => undefined)
    const message = error instanceof LiteLlmError ? error.message : "OpenWork could not create this person's LiteLLM key."
    return { memberId: member.memberId, outcome: "error", message, litellmUserId: null, keys: [], removeSlots: [] }
  }
}

function teamSlots(user: LiteLlmUser) {
  return user.teams.length
    ? [...new Set(user.teams)].map((teamId) => ({ slot: `team:${teamId}`.slice(0, 191), teamId, source: null }))
    : [{ slot: PERSONAL_SLOT, teamId: null, source: null }]
}

/** Models a created key can call, intersected with the synced catalog. */
async function keyModels(ctx: IssueContext, user: LiteLlmUser, want: { teamId: string | null; source: LiteLlmKeyRecord | null }, key: string) {
  const listed = async () => (await ctx.client.listModels(key)).filter((id) => ctx.catalogIds.includes(id))
  // Team keys list exactly their team's models. Keys without a team over-report.
  if (want.teamId) return listed()
  const personal = liteLlmPersonalModels(user.models, want.source?.models ?? [], ctx.catalogIds)
  if (personal === null) return listed()
  await ctx.client.listModels(key) // still proves the key works
  return personal
}

/** Team keys each get their team's set, so one person can hold a key per team. Other keys use the primary set. */
async function teamSet(tx: GatewayTx, provider: GatewayProvider, settings: LiteLlmSettings, primary: GatewaySet, slot: string, teamId: string | null): Promise<GatewaySet> {
  if (!teamId || !slot.startsWith("team:")) return primary
  const known = settings.teamSets[teamId]
  if (known && isDenTypeId("gatewayCredentialSet", known)) {
    const [set] = await tx.select().from(GatewayCredentialSetTable).where(and(eq(GatewayCredentialSetTable.id, known), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id)))
    if (set) return set
  }
  const alias = settings.teams.find((team) => team.id === teamId)?.alias ?? teamId
  const now = new Date()
  const set: GatewaySet = { id: createDenTypeId("gatewayCredentialSet"), gateway_provider_id: provider.id, created_by_org_membership_id: null, name: `LiteLLM team · ${alias}`.slice(0, 255), credential_mode: "member", oauth_client_id: null, oauth_client_secret: null, status: "active", created_at: now, updated_at: now }
  await tx.insert(GatewayCredentialSetTable).values(set)
  settings.teamSets[teamId] = set.id
  return set
}

/** Revokes the credential and automatic grant behind one row. Keeps the row only to delete its LiteLLM key later. */
async function revokeRow(tx: GatewayTx, row: IssuedRow, keepForDeletion: boolean) {
  if (row.credential_id) await tx.update(GatewayProviderCredentialTable).set({ status: "revoked", secret: "{}", last_error: "litellm_key_removed", updated_at: new Date() }).where(eq(GatewayProviderCredentialTable.id, row.credential_id))
  if (row.access_grant_id) await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, row.access_grant_id))
  const where = and(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, row.gateway_provider_id), eq(GatewayLiteLlmIssuedKeyTable.org_membership_id, row.org_membership_id), eq(GatewayLiteLlmIssuedKeyTable.slot, row.slot))
  if (keepForDeletion && row.litellm_token_id) await tx.update(GatewayLiteLlmIssuedKeyTable).set({ status: "revoked", credential_id: null, access_grant_id: null, updated_at: new Date() }).where(where)
  else await tx.delete(GatewayLiteLlmIssuedKeyTable).where(where)
}

async function upsertRow(tx: GatewayTx, values: typeof GatewayLiteLlmIssuedKeyTable.$inferInsert) {
  const where = and(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, values.gateway_provider_id), eq(GatewayLiteLlmIssuedKeyTable.org_membership_id, values.org_membership_id), eq(GatewayLiteLlmIssuedKeyTable.slot, values.slot))
  const [existing] = await tx.select().from(GatewayLiteLlmIssuedKeyTable).where(where).for("update")
  if (existing) await tx.update(GatewayLiteLlmIssuedKeyTable).set({ ...values, updated_at: new Date() }).where(where)
  else await tx.insert(GatewayLiteLlmIssuedKeyTable).values(values)
}

/**
 * Database half for one person. Returns LiteLLM token ids created for the
 * plan that must be deleted because the person may no longer have keys.
 */
export async function applyLiteLlmMemberIssue(tx: GatewayTx, lockedProvider: GatewayProvider, plan: LiteLlmIssuePlan): Promise<string[]> {
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = requireSettings(provider)
  if (!isLiteLlmIssued(settings)) return plan.keys.filter((key) => key.created).map((key) => key.tokenId)
  const primary = await activeSet(tx, provider, settings)
  const rows = await tx.select().from(GatewayLiteLlmIssuedKeyTable)
    .where(and(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, provider.id), eq(GatewayLiteLlmIssuedKeyTable.org_membership_id, plan.memberId))).for("update")
  const now = new Date()
  const eligible = await memberEligible(tx, provider, primary, plan.memberId, settings)
  for (const row of rows) if (plan.removeSlots.includes(row.slot)) await revokeRow(tx, row, false)
  if (!eligible) {
    for (const row of rows) if (row.slot !== MEMBER_SLOT && !plan.removeSlots.includes(row.slot)) await revokeRow(tx, row, true)
    await tx.delete(GatewayLiteLlmIssuedKeyTable).where(and(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, provider.id), eq(GatewayLiteLlmIssuedKeyTable.org_membership_id, plan.memberId), eq(GatewayLiteLlmIssuedKeyTable.slot, MEMBER_SLOT)))
    return plan.keys.filter((key) => key.created).map((key) => key.tokenId)
  }
  for (const key of plan.keys) {
    const set = await teamSet(tx, provider, settings, primary, key.slot, key.teamId)
    const previous = rows.find((row) => row.slot === key.slot)
    // A slot that moved sets (strategy change) drops its old credential first.
    if (previous && previous.credential_set_id && previous.credential_set_id !== set.id) await revokeRow(tx, previous, false)
    const credential = await upsertKeyRow(tx, provider, set, plan.memberId, plan.memberId, key.key)
    const alias = key.teamId ? settings.teams.find((team) => team.id === key.teamId)?.alias ?? key.teamId : null
    const groupId = await ensureGroup(tx, provider, settings, liteLlmModelSetKey(key.models), groupName(key.models, alias),
      alias ? `Members of the LiteLLM team ${alias}.` : "People whose LiteLLM access reaches exactly these models.", key.models)
    const audience = { type: "member" as const, memberId: plan.memberId }
    const [grant] = await tx.select().from(GatewayProviderAccessTable).where(and(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id), eq(GatewayProviderAccessTable.model_group_id, groupId),
      eq(GatewayProviderAccessTable.credential_set_id, set.id), eq(GatewayProviderAccessTable.audience_key, gatewayAudienceKey(audience))))
    const ownGrant = previous?.access_grant_id ?? null
    if (ownGrant && ownGrant !== grant?.id) await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, ownGrant))
    // Reuse, never own, an identical grant an admin made by hand.
    const grantId = grant ? (grant.id === ownGrant ? grant.id : null) : await writeGatewayGrant(tx, provider, { modelGroupId: groupId, credentialSetId: set.id, audience })
    await upsertRow(tx, { gateway_provider_id: provider.id, org_membership_id: plan.memberId, slot: key.slot, status: "active", message: null, litellm_user_id: plan.litellmUserId, litellm_team_id: key.teamId,
      litellm_token_id: key.tokenId, mirrored_from_token_id: key.mirroredFrom, source_fingerprint: key.fingerprint, credential_set_id: set.id, credential_id: credential.id, model_group_id: groupId, access_grant_id: grantId, checked_at: now })
  }
  await upsertRow(tx, { gateway_provider_id: provider.id, org_membership_id: plan.memberId, slot: MEMBER_SLOT, status: plan.outcome, message: plan.message, litellm_user_id: plan.litellmUserId, checked_at: now })
  await saveSettings(tx, provider, settings)
  Object.assign(lockedProvider, provider)
  return []
}

/** Active members allowed to get keys: admin grants on the access group, excluding automatic grants. */
export async function liteLlmEligibleMembers(provider: GatewayProvider, settings: LiteLlmSettings) {
  const groupId = settings.groups[SIGN_IN_GROUP_KEY]
  if (!groupId || !isDenTypeId("gatewayModelGroup", groupId)) return []
  const grants = await db.select().from(GatewayProviderAccessTable).innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.status, "active")))
    .where(and(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id), eq(GatewayProviderAccessTable.model_group_id, groupId), eq(GatewayProviderAccessTable.credential_set_id, normalizeDenTypeId("gatewayCredentialSet", settings.credentialSetId))))
  const audience = grants.map((row) => row.gateway_provider_access)
  const everyone = audience.some((grant) => grant.audience_key === "organization")
  const teamIds = audience.flatMap((grant) => grant.team_id ? [grant.team_id] : [])
  const memberIds = new Set(audience.flatMap((grant) => grant.org_membership_id ? [grant.org_membership_id] : []))
  if (teamIds.length) {
    const teamMembers = await db.select({ memberId: TeamMemberTable.orgMembershipId }).from(TeamMemberTable).innerJoin(TeamTable, eq(TeamTable.id, TeamMemberTable.teamId))
      .where(and(inArray(TeamMemberTable.teamId, teamIds), eq(TeamTable.organizationId, provider.organization_id)))
    for (const row of teamMembers) if (row.memberId) memberIds.add(row.memberId)
  }
  if (!everyone && !memberIds.size) return []
  const members = await db.select({ memberId: MemberTable.id, email: AuthUserTable.email }).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt), everyone ? undefined : inArray(MemberTable.id, [...memberIds])))
  return members
}

export type LiteLlmIssueSummary = { people: number; keys: number; notInLiteLlm: number; noKeyToMirror: number; noModels: number; errors: number; removed: number }

async function applyPlan(provider: GatewayProvider, ctx: IssueContext, plan: LiteLlmIssuePlan) {
  const orphaned = await db.transaction(async (tx) => applyLiteLlmMemberIssue(tx, provider, plan)).catch(async (error: unknown) => {
    await ctx.client.deleteKeys(ctx.adminKey, plan.keys.filter((key) => key.created).map((key) => key.tokenId)).catch(() => undefined)
    throw error
  })
  await ctx.client.deleteKeys(ctx.adminKey, orphaned).catch(() => undefined)
}

/**
 * Creates, refreshes and removes keys for everyone. Run after a catalog sync.
 * People who lost access, or left the organization, have their keys deleted
 * in LiteLLM too.
 */
export async function reconcileLiteLlmIssuedKeys(provider: GatewayProvider, client?: LiteLlmClient): Promise<LiteLlmIssueSummary> {
  const ctx = await issueContext(provider, client)
  const summary: LiteLlmIssueSummary = { people: 0, keys: 0, notInLiteLlm: 0, noKeyToMirror: 0, noModels: 0, errors: 0, removed: 0 }
  const eligible = await liteLlmEligibleMembers(provider, ctx.settings)
  const queue = [...eligible]
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let member = queue.shift(); member; member = queue.shift()) {
      const plan = await planLiteLlmMemberIssue(ctx, member)
      try { await applyPlan(provider, ctx, plan) } catch { summary.errors += 1; continue }
      if (plan.outcome === "active") { summary.people += 1; summary.keys += plan.keys.length }
      else if (plan.outcome === "not_in_litellm") summary.notInLiteLlm += 1
      else if (plan.outcome === "no_key_to_mirror") summary.noKeyToMirror += 1
      else if (plan.outcome === "no_models") summary.noModels += 1
      else summary.errors += 1
    }
  }))
  // Everyone else with rows: lost access, left the organization, or revoked earlier.
  const eligibleIds = new Set(eligible.map((member) => member.memberId))
  const stale = (await db.select().from(GatewayLiteLlmIssuedKeyTable).where(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, provider.id)))
    .filter((row) => !eligibleIds.has(row.org_membership_id) || row.status === "revoked")
  const staleMembers = [...new Set(stale.map((row) => row.org_membership_id))]
  for (const memberId of staleMembers) {
    const tokens = stale.filter((row) => row.org_membership_id === memberId && row.litellm_token_id && (row.status === "revoked" || !eligibleIds.has(memberId))).flatMap((row) => row.litellm_token_id ? [row.litellm_token_id] : [])
    try { await ctx.client.deleteKeys(ctx.adminKey, tokens) } catch { summary.errors += 1; continue }
    await db.transaction(async (tx) => {
      await loadProviderForUpdate(tx, provider)
      const rows = await tx.select().from(GatewayLiteLlmIssuedKeyTable).where(and(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, provider.id), eq(GatewayLiteLlmIssuedKeyTable.org_membership_id, memberId))).for("update")
      for (const row of rows) if (row.slot === MEMBER_SLOT ? !eligibleIds.has(memberId) : row.litellm_token_id && tokens.includes(row.litellm_token_id)) await revokeRow(tx, row, false)
    })
    if (!eligibleIds.has(memberId)) summary.removed += 1
  }
  return summary
}

const recentAttempts = new Map<string, number>()

/** One person, now: the browser "Check again" button and first use in the app. */
export async function provisionLiteLlmMember(provider: GatewayProvider, memberId: GatewayMemberId, options: { force?: boolean } = {}) {
  const attemptKey = `${provider.id}:${memberId}`
  const last = recentAttempts.get(attemptKey) ?? 0
  if (!options.force && Date.now() - last < RETRY_AFTER_MS) return null
  recentAttempts.set(attemptKey, Date.now())
  const ctx = await issueContext(provider)
  const [member] = await db.select({ memberId: MemberTable.id, email: AuthUserTable.email }).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt)))
  if (!member) throw new GatewayWriteError(403, "forbidden")
  const primary = await activeSet(db, provider, ctx.settings)
  if (!await memberEligible(db, provider, primary, memberId, ctx.settings)) throw new GatewayWriteError(403, "forbidden", "Your admin has not given you LiteLLM access.")
  const plan = await planLiteLlmMemberIssue(ctx, member)
  await applyPlan(provider, ctx, plan)
  return plan
}

/**
 * Starts provisioning in the background for an allowed person with no key yet,
 * at most once every few minutes, so the app picks up keys on its next refresh.
 */
export function scheduleLiteLlmProvisioning(provider: GatewayProvider, memberId: GatewayMemberId) {
  if (!isLiteLlmIssued(readLiteLlmSettings(provider.settings))) return
  const last = recentAttempts.get(`${provider.id}:${memberId}`) ?? 0
  if (Date.now() - last < RETRY_AFTER_MS) return
  void (async () => {
    const rows = await memberRows(provider.id, memberId)
    if (rows.some(({ row }) => row.slot !== MEMBER_SLOT && row.status === "active")) return
    await provisionLiteLlmMember(provider, memberId)
  })().catch((error: unknown) => {
    console.warn("litellm_background_provisioning_failed", { inferenceProviderId: provider.id, code: error instanceof GatewayWriteError ? error.code : error instanceof LiteLlmError ? error.code : "unexpected" })
  })
}

/** A person's lookup state for the connect page and provider status. */
export async function liteLlmMemberIssueStatus(providerId: GatewayProvider["id"], memberId: GatewayMemberId) {
  const rows = await memberRows(providerId, memberId)
  const status = rows.find(({ row }) => row.slot === MEMBER_SLOT)?.row ?? null
  const active = rows.filter(({ row }) => row.slot !== MEMBER_SLOT && row.status === "active")
  return { status: status?.status ?? "pending", message: status?.message ?? null, keyCount: active.length }
}

/** Local revocation after access changes; next sync deletes the LiteLLM keys. Caller holds the provider lock. */
export async function pruneLiteLlmIssuedKeys(tx: GatewayTx, lockedProvider: GatewayProvider) {
  const provider = await loadProviderForUpdate(tx, lockedProvider)
  const settings = requireSettings(provider)
  if (!isLiteLlmIssued(settings)) return
  const primary = await activeSet(tx, provider, settings)
  const rows = await tx.select().from(GatewayLiteLlmIssuedKeyTable).where(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, provider.id)).for("update")
  for (const memberId of [...new Set(rows.map((row) => row.org_membership_id))]) {
    if (await memberEligible(tx, provider, primary, memberId, settings)) continue
    for (const row of rows.filter((entry) => entry.org_membership_id === memberId)) await revokeRow(tx, row, row.slot !== MEMBER_SLOT)
  }
}

/** Token ids to delete in LiteLLM before a provider is removed. */
export async function liteLlmIssuedTokenIds(providerId: GatewayProvider["id"]) {
  const rows = await db.select({ token: GatewayLiteLlmIssuedKeyTable.litellm_token_id }).from(GatewayLiteLlmIssuedKeyTable).where(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, providerId))
  return rows.flatMap((row) => row.token ? [row.token] : [])
}

/** Best effort: the provider is being removed either way. */
export async function deleteLiteLlmIssuedKeys(provider: GatewayProvider) {
  const tokens = await liteLlmIssuedTokenIds(provider.id)
  if (!tokens.length) return
  try {
    const ctx = await issueContext(provider)
    await ctx.client.deleteKeys(ctx.adminKey, tokens)
  } catch (error) {
    console.warn("litellm_issued_key_cleanup_failed", { inferenceProviderId: provider.id, keys: tokens.length, code: error instanceof LiteLlmError ? error.code : "unexpected" })
  }
}

export async function liteLlmIssuedProviderIds(organizationId: GatewayProvider["organization_id"]) {
  return db.select({ id: GatewayProviderTable.id }).from(GatewayProviderTable).where(eq(GatewayProviderTable.organization_id, organizationId))
}
