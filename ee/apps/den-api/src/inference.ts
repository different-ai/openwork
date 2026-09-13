import { and, asc, eq, inArray, isNotNull, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  InferenceKeyTable,
  InferenceOrgLimitPolicyTable,
  InferenceOrgUpstreamProviderKeyTable,
  InferenceOrgUsageBucketTable,
  LlmProviderAccessTable,
  LlmProviderModelTable,
  LlmProviderTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  createInferenceBearerKey,
  inferenceBearerKey,
  inferenceBearerKeyLookupDigests,
  inferenceBearerKeyPrefix,
  inferenceBearerKeyStorageDigest,
} from "@openwork-ee/utils/inference-bearer-key"
import {
  INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE,
  INFERENCE_TIER_LIMITS,
  INFERENCE_WINDOW_DURATIONS_MS,
} from "@openwork/types/den/inference"
import type { InferenceOrganizationMetadata, InferenceTier, InferenceWindowType } from "@openwork/types/den/inference"
import { assertManagedModelsAllowed, ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { db } from "./db.js"
import { env } from "./env.js"
import { assertOrganizationManagedModelsAllowed, updateOrganizationMetadata } from "./organization-metadata.js"
import { ensureMemberGatewayKey } from "./gateway-keys.js"
import { revokeMemberGatewayCredentials } from "./llm/inference-provider-lifecycle.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

const OPENWORK_PROVIDER_ID = "openwork"
const OPENROUTER_PROVIDER = "openrouter"
const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/keys"

// Read/repair surfaces omit only managed Models when policy cannot allow them.
export async function organizationAllowsManagedModels(organizationId: OrgId): Promise<boolean> {
  try {
    await assertOrganizationManagedModelsAllowed(organizationId)
    return true
  } catch (error) {
    if (error instanceof ManagedModelsPolicyError) return false
    throw error
  }
}

async function withManagedModelsAdmission(
  organizationId: OrgId,
  provision: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
) {
  await db.transaction(async (tx) => {
    // Serialize admission with metadata marking; never do external I/O in this lock.
    const [organization] = await tx
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)
      .for("update")
      .catch(() => { throw new ManagedModelsPolicyError("managed_models_policy_unavailable") })
    if (!organization) throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
    assertManagedModelsAllowed(organization.metadata)
    await provision(tx)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function upstreamKeyPrefix(key: string) {
  return key.slice(0, 16)
}

export function readInferenceMetadata(metadata: Record<string, unknown> | null): InferenceOrganizationMetadata | null {
  if (!isRecord(metadata?.inference)) {
    return null
  }

  const inference = metadata.inference
  if (inference.enabled !== true || inference.tier !== "tier1" && inference.tier !== "tier2") {
    return null
  }

  return { enabled: true, tier: inference.tier }
}

function setInferenceMetadata(metadata: Record<string, unknown> | null, inference: InferenceOrganizationMetadata | null) {
  const next = { ...(metadata ?? {}) }
  if (inference) {
    next.inference = { ...(isRecord(next.inference) ? next.inference : {}), ...inference }
  } else if (isRecord(next.inference)) {
    const remaining = { ...next.inference }
    delete remaining.enabled
    delete remaining.tier
    if (Object.keys(remaining).length > 0) {
      next.inference = remaining
    } else {
      delete next.inference
    }
  }
  return next
}

async function activeMemberCount(organizationId: OrgId) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
  return Math.max(0, Number(row?.count ?? 0))
}

async function listOrgMembers(organizationId: OrgId) {
  return db.select({ id: MemberTable.id }).from(MemberTable).where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt), isNotNull(MemberTable.userId)))
}

function addWindow(start: Date, windowType: InferenceWindowType) {
  return new Date(start.getTime() + INFERENCE_WINDOW_DURATIONS_MS[windowType])
}

function currentWindow(input: { anchorAt: Date | null; currentEnd: Date | null; windowType: InferenceWindowType; now: Date }) {
  let start = input.currentEnd ?? input.anchorAt ?? input.now
  let end = addWindow(start, input.windowType)
  while (end <= input.now) {
    start = end
    end = addWindow(start, input.windowType)
  }
  return { start, end }
}

export function buildOpenWorkProviderConfig() {
  return {
    id: OPENWORK_PROVIDER_ID,
    name: "OpenWork",
    npm: "@openrouter/ai-sdk-provider",
    env: ["OPENWORK_API_KEY"],
    doc: "OpenWork-managed inference proxy for organization models.",
    api: `${env.modelsPublicBaseUrl.replace(/\/+$/, "")}/api/v1`,
    options: {
      baseURL: `${env.modelsPublicBaseUrl.replace(/\/+$/, "")}/api/v1`,
    },
  }
}

async function deleteOpenWorkProviders(where: { organizationId: OrgId; memberId?: MemberId }) {
  const providerWhere = where.memberId
    ? and(
        eq(LlmProviderTable.organizationId, where.organizationId),
        eq(LlmProviderTable.createdByOrgMembershipId, where.memberId),
        eq(LlmProviderTable.source, "openwork"),
        eq(LlmProviderTable.providerId, OPENWORK_PROVIDER_ID),
      )
    : and(
        eq(LlmProviderTable.organizationId, where.organizationId),
        eq(LlmProviderTable.source, "openwork"),
        eq(LlmProviderTable.providerId, OPENWORK_PROVIDER_ID),
      )

  const providers = await db.select({ id: LlmProviderTable.id }).from(LlmProviderTable).where(providerWhere)
  if (providers.length === 0) {
    return
  }

  const providerIds = providers.map((provider) => provider.id)
  await db.transaction(async (tx) => {
    await tx.delete(LlmProviderAccessTable).where(inArray(LlmProviderAccessTable.llmProviderId, providerIds))
    await tx.delete(LlmProviderModelTable).where(inArray(LlmProviderModelTable.llmProviderId, providerIds))
    await tx.delete(LlmProviderTable).where(inArray(LlmProviderTable.id, providerIds))
  })
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function createMemberInferenceKey(tx: Tx, input: { organizationId: OrgId; memberId: MemberId }) {
  const key = createInferenceBearerKey()
  await tx.insert(InferenceKeyTable).values({
    id: createDenTypeId("inferenceKey"),
    organization_id: input.organizationId,
    org_membership_id: input.memberId,
    name: "OpenWork Models",
    key_hash: await inferenceBearerKeyStorageDigest(key),
    key_prefix: inferenceBearerKeyPrefix(key),
    encrypted_key: key.value,
    status: "active",
  })
  return key
}

async function findActiveMemberInferenceKey(input: { organizationId: OrgId; memberId: MemberId }, database: Tx | typeof db = db) {
  const [row] = await database
    .select({ id: InferenceKeyTable.id, encryptedKey: InferenceKeyTable.encrypted_key, keyHash: InferenceKeyTable.key_hash })
    .from(InferenceKeyTable)
    .where(and(
      eq(InferenceKeyTable.organization_id, input.organizationId),
      eq(InferenceKeyTable.org_membership_id, input.memberId),
      eq(InferenceKeyTable.status, "active"),
    ))
    .limit(1)
  return row ?? null
}

async function findOpenWorkLlmProviderApiKey(tx: Tx, input: { organizationId: OrgId; memberId: MemberId }) {
  const [provider] = await tx
    .select({ apiKey: LlmProviderTable.apiKey })
    .from(LlmProviderTable)
    .where(and(
      eq(LlmProviderTable.organizationId, input.organizationId),
      eq(LlmProviderTable.createdByOrgMembershipId, input.memberId),
      eq(LlmProviderTable.source, "openwork"),
      eq(LlmProviderTable.providerId, OPENWORK_PROVIDER_ID),
    ))
    .limit(1)
  const apiKey = provider?.apiKey?.trim()
  return apiKey || null
}

/**
 * Return a tier-entitled member's Models-only `ow_inf_` key.
 *
 * Legacy rows minted before `encrypted_key` existed only carried the raw
 * value on the synthetic OpenWork Models provider row; when that row is still
 * present its value is backfilled, otherwise the key is rotated.
 */
export async function ensureMemberInferenceKey(input: { organizationId: OrgId; memberId: MemberId }): Promise<string> {
  return db.transaction(async (tx) => {
    const [organization] = await tx.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, input.organizationId)).for("update")
    if (!readInferenceMetadata(organization?.metadata ?? null)) throw new Error("inference_not_enabled")
    assertManagedModelsAllowed(organization?.metadata)
    // Lock a stable row even when no key exists. Removal takes this same lock.
    const [member] = await tx.select({ id: MemberTable.id, userId: MemberTable.userId }).from(MemberTable)
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
      .for("update")
    if (!member?.userId) throw new Error("member_not_found")
    const existing = await findActiveMemberInferenceKey(input, tx)
    if (existing) {
      const legacyKey = existing.encryptedKey ?? await findOpenWorkLlmProviderApiKey(tx, input)
      if (legacyKey && (await inferenceBearerKeyLookupDigests(inferenceBearerKey(legacyKey))).includes(existing.keyHash)) {
        if (!existing.encryptedKey) await tx.update(InferenceKeyTable).set({ encrypted_key: legacyKey }).where(eq(InferenceKeyTable.id, existing.id))
        return legacyKey
      }
      await tx.update(InferenceKeyTable).set({ status: "revoked", revoked_at: new Date() })
        .where(and(eq(InferenceKeyTable.org_membership_id, input.memberId), eq(InferenceKeyTable.status, "active")))
    }
    return (await createMemberInferenceKey(tx, input)).value
  })
}

async function ensureOpenWorkLlmProviderForMember(input: { organizationId: OrgId; memberId: MemberId; rawKey: string }) {
  const now = new Date()
  const providerConfig = buildOpenWorkProviderConfig()

  await withManagedModelsAdmission(input.organizationId, async (tx) => {
    const [organization] = await tx.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, input.organizationId)).for("update")
    if (!readInferenceMetadata(organization?.metadata ?? null)) return
    const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable)
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt))).for("update")
    if (!member || (await findActiveMemberInferenceKey(input, tx))?.encryptedKey !== input.rawKey) return
    const providerRows = await tx
      .select({ id: LlmProviderTable.id })
      .from(LlmProviderTable)
      .where(and(
        eq(LlmProviderTable.organizationId, input.organizationId),
        eq(LlmProviderTable.createdByOrgMembershipId, input.memberId),
        eq(LlmProviderTable.source, "openwork"),
        eq(LlmProviderTable.providerId, OPENWORK_PROVIDER_ID),
      ))
      .limit(1)
    const providerId = providerRows[0]?.id ?? createDenTypeId("llmProvider")

    if (providerRows[0]) {
      await tx
        .update(LlmProviderTable)
        .set({ name: "OpenWork Models", providerConfig, apiKey: input.rawKey, updatedAt: now })
        .where(eq(LlmProviderTable.id, providerId))
      await tx.delete(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, providerId))
      await tx.delete(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.llmProviderId, providerId))
    } else {
      await tx.insert(LlmProviderTable).values({
        id: providerId,
        organizationId: input.organizationId,
        createdByOrgMembershipId: input.memberId,
        source: "openwork",
        providerId: OPENWORK_PROVIDER_ID,
        name: "OpenWork Models",
        providerConfig,
        apiKey: input.rawKey,
        createdAt: now,
        updatedAt: now,
      })
    }

    await tx.insert(LlmProviderAccessTable).values({
      id: createDenTypeId("llmProviderAccess"),
      llmProviderId: providerId,
      orgMembershipId: input.memberId,
      teamId: null,
      createdAt: now,
    })
  })
}

async function ensureMemberInferenceAccess(input: { organizationId: OrgId; memberId: MemberId }) {
  await assertOrganizationManagedModelsAllowed(input.organizationId)
  const rawKey = await ensureMemberInferenceKey(input)
  await ensureOpenWorkLlmProviderForMember({ ...input, rawKey })
}

async function memberHasOpenWorkInferenceAccess(input: { organizationId: OrgId; memberId: MemberId }) {
  const [provider] = await db
    .select({ id: LlmProviderTable.id, apiKey: LlmProviderTable.apiKey })
    .from(LlmProviderTable)
    .where(and(
      eq(LlmProviderTable.organizationId, input.organizationId),
      eq(LlmProviderTable.createdByOrgMembershipId, input.memberId),
      eq(LlmProviderTable.source, "openwork"),
      eq(LlmProviderTable.providerId, OPENWORK_PROVIDER_ID),
    ))
    .limit(1)
  const key = await findActiveMemberInferenceKey(input)

  return Boolean(provider && key?.encryptedKey && provider.apiKey === key.encryptedKey)
}

/**
 * Re-provision this member's OpenWork Models key + LLM provider when the org
 * has inference enabled but the member row was deleted or never created.
 * Safe to call from member-facing list endpoints (self-heal).
 */
export async function repairMemberInferenceAccessIfNeeded(input: {
  organizationId: OrgId
  memberId: MemberId
}): Promise<boolean> {
  if (!await organizationAllowsManagedModels(input.organizationId)) return false
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.organizationId))
    .limit(1)

  const inference = readInferenceMetadata(organization?.metadata ?? null)
  if (!inference) {
    return false
  }

  if (await memberHasOpenWorkInferenceAccess(input)) {
    return false
  }

  try {
    await ensureMemberInferenceAccess(input)
    return true
  } catch (error) {
    if (error instanceof ManagedModelsPolicyError) return false
    throw error
  }
}

export async function syncInferenceForOrganizationMembers(input: { organizationId: OrgId }) {
  if (!await organizationAllowsManagedModels(input.organizationId)) return
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.organizationId))
    .limit(1)

  const inference = readInferenceMetadata(organization?.metadata ?? null)
  if (!inference) {
    return
  }

  const members = await listOrgMembers(input.organizationId)
  await syncInferenceLimitPolicies({ organizationId: input.organizationId, tier: inference.tier, memberCount: members.length })

  for (const member of members) {
    await repairMemberInferenceAccessIfNeeded({
      organizationId: input.organizationId,
      memberId: member.id,
    })
  }
}

export async function syncInferenceAfterMemberChange(input: {
  organizationId: OrgId
  memberId: MemberId
  memberCount: number
  change: "added" | "removed"
}) {
  if (input.change === "removed") {
    await revokeMemberGatewayCredentials(input)
    await deleteOpenWorkProviders({ organizationId: input.organizationId, memberId: input.memberId })
  } else {
    const [member] = await db.select({ userId: MemberTable.userId }).from(MemberTable)
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
    // Invitations reserve an unbound member row; issuance happens when the user joins.
    if (!member?.userId) return
    await ensureMemberGatewayKey(input)
  }

  if (!await organizationAllowsManagedModels(input.organizationId)) return

  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.organizationId))
    .limit(1)
  const inference = readInferenceMetadata(organization?.metadata ?? null)
  if (!inference) {
    return
  }

  await syncInferenceLimitPolicies({ organizationId: input.organizationId, tier: inference.tier, memberCount: input.memberCount })

  if (input.change === "added") {
    await repairMemberInferenceAccessIfNeeded({ organizationId: input.organizationId, memberId: input.memberId })
  }
}

async function syncInferenceLimitPolicies(input: { organizationId: OrgId; tier: InferenceTier; memberCount: number }) {
  await db.transaction(async (tx) => {
    const anchorAt = new Date()
    for (const windowType of Object.keys(INFERENCE_TIER_LIMITS[input.tier])) {
      await tx
        .insert(InferenceOrgLimitPolicyTable)
        .values({
          id: createDenTypeId("inferenceOrgLimitPolicy"),
          organization_id: input.organizationId,
          window_type: windowType as keyof typeof INFERENCE_TIER_LIMITS[InferenceTier],
          reset_strategy: INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE[windowType as keyof typeof INFERENCE_TIER_LIMITS[InferenceTier]],
          anchor_at: anchorAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            reset_strategy: INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE[windowType as keyof typeof INFERENCE_TIER_LIMITS[InferenceTier]],
          },
        })
    }

    const policies = await tx
      .select({
        id: InferenceOrgLimitPolicyTable.id,
        windowType: InferenceOrgLimitPolicyTable.window_type,
        resetStrategy: InferenceOrgLimitPolicyTable.reset_strategy,
        anchorAt: InferenceOrgLimitPolicyTable.anchor_at,
        currentBucketId: InferenceOrgLimitPolicyTable.current_bucket_id,
      })
      .from(InferenceOrgLimitPolicyTable)
      .where(eq(InferenceOrgLimitPolicyTable.organization_id, input.organizationId))
      .orderBy(asc(InferenceOrgLimitPolicyTable.window_type))
      .for("update")
    const now = new Date()

    for (const policy of policies) {
      const limitAmount = INFERENCE_TIER_LIMITS[input.tier][policy.windowType] * input.memberCount
      const currentBucket = policy.currentBucketId
        ? (await tx.select().from(InferenceOrgUsageBucketTable).where(eq(InferenceOrgUsageBucketTable.id, policy.currentBucketId)).limit(1).for("update"))[0]
        : null

      if (currentBucket && currentBucket.window_start_at <= now && currentBucket.window_end_at > now) {
        await tx
          .update(InferenceOrgUsageBucketTable)
          .set({ limit_amount: limitAmount })
          .where(eq(InferenceOrgUsageBucketTable.id, currentBucket.id))
        continue
      }

      const window = policy.resetStrategy === "anchored"
        ? currentWindow({
            anchorAt: policy.anchorAt,
            currentEnd: currentBucket?.window_end_at ?? null,
            windowType: policy.windowType,
            now,
          })
        : { start: now, end: addWindow(now, policy.windowType) }
      const bucketId = createDenTypeId("inferenceOrgUsageBucket")
      await tx.insert(InferenceOrgUsageBucketTable).values({
        id: bucketId,
        organization_id: input.organizationId,
        policy_id: policy.id,
        window_start_at: window.start,
        window_end_at: window.end,
        limit_amount: limitAmount,
        used_amount: 0,
      })
      await tx
        .update(InferenceOrgLimitPolicyTable)
        .set({ current_bucket_id: bucketId })
        .where(eq(InferenceOrgLimitPolicyTable.id, policy.id))
    }
  })
}

type OpenRouterKeyCreateResponse = {
  key: string
  data: {
    hash: string
    workspace_id?: string | null
  }
}

function isOpenRouterKeyCreateResponse(value: unknown): value is OpenRouterKeyCreateResponse {
  if (!isRecord(value) || typeof value.key !== "string" || !isRecord(value.data)) {
    return false
  }
  return typeof value.data.hash === "string"
}

async function createOpenRouterOrgApiKey(input: { organizationId: OrgId }) {
  await assertOrganizationManagedModelsAllowed(input.organizationId)
  if (!env.openRouterManagementApiKey) {
    throw new Error("openrouter_management_api_key_missing")
  }

  const body: Record<string, unknown> = {
    name: `OpenWork org ${input.organizationId}`,
    include_byok_in_limit: false,
  }
  if (env.openRouterWorkspaceId) {
    body.workspace_id = env.openRouterWorkspaceId
  }

  const response = await fetch(OPENROUTER_KEYS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.openRouterManagementApiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = isRecord(payload?.error) && typeof payload.error.message === "string"
      ? payload.error.message
      : `OpenRouter key creation failed with status ${response.status}.`
    throw new Error(message)
  }
  if (!isOpenRouterKeyCreateResponse(payload)) {
    throw new Error("OpenRouter key creation response was incomplete.")
  }

  return {
    key: payload.key,
    externalKeyHash: payload.data.hash,
    externalWorkspaceId: typeof payload.data.workspace_id === "string" ? payload.data.workspace_id : null,
  }
}

async function deleteOpenRouterOrgApiKey(externalKeyHash: string) {
  if (!env.openRouterManagementApiKey) {
    throw new Error("openrouter_management_api_key_missing")
  }

  const response = await fetch(`${OPENROUTER_KEYS_URL}/${encodeURIComponent(externalKeyHash)}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${env.openRouterManagementApiKey}`,
      accept: "application/json",
    },
  })

  if (response.ok || response.status === 404) {
    return
  }

  const payload = await response.json().catch(() => null)
  const message = isRecord(payload?.error) && typeof payload.error.message === "string"
    ? payload.error.message
    : `OpenRouter key deletion failed with status ${response.status}.`
  throw new Error(message)
}

async function revokeOrgUpstreamProviderKeys(organizationId: OrgId) {
  const rows = await db
    .select({
      id: InferenceOrgUpstreamProviderKeyTable.id,
      externalKeyHash: InferenceOrgUpstreamProviderKeyTable.external_key_hash,
    })
    .from(InferenceOrgUpstreamProviderKeyTable)
    .where(and(
      eq(InferenceOrgUpstreamProviderKeyTable.organization_id, organizationId),
      eq(InferenceOrgUpstreamProviderKeyTable.provider, OPENROUTER_PROVIDER),
      eq(InferenceOrgUpstreamProviderKeyTable.status, "active"),
    ))

  for (const row of rows) {
    if (row.externalKeyHash) {
      await deleteOpenRouterOrgApiKey(row.externalKeyHash)
    }
  }

  if (rows.length > 0) {
    await db
      .update(InferenceOrgUpstreamProviderKeyTable)
      .set({ status: "revoked", revoked_at: new Date() })
      .where(inArray(InferenceOrgUpstreamProviderKeyTable.id, rows.map((row) => row.id)))
  }
}

async function ensureOrgUpstreamProviderKey(organizationId: OrgId) {
  await assertOrganizationManagedModelsAllowed(organizationId)
  const [existing] = await db
    .select({ id: InferenceOrgUpstreamProviderKeyTable.id })
    .from(InferenceOrgUpstreamProviderKeyTable)
    .where(and(
      eq(InferenceOrgUpstreamProviderKeyTable.organization_id, organizationId),
      eq(InferenceOrgUpstreamProviderKeyTable.provider, OPENROUTER_PROVIDER),
      eq(InferenceOrgUpstreamProviderKeyTable.status, "active"),
    ))
    .limit(1)

  if (existing) {
    return
  }

  const openRouterKey = await createOpenRouterOrgApiKey({ organizationId })

  // An already-transmitted external create cannot be rolled back atomically.
  // If marking wins this lock, leave its unattached external key alone.
  await withManagedModelsAdmission(organizationId, async (tx) => {
    await tx
      .insert(InferenceOrgUpstreamProviderKeyTable)
      .values({
        id: createDenTypeId("inferenceOrgProviderKey"),
        organization_id: organizationId,
        provider: OPENROUTER_PROVIDER,
        external_key_hash: openRouterKey.externalKeyHash,
        external_workspace_id: openRouterKey.externalWorkspaceId,
        encrypted_api_key: openRouterKey.key,
        key_prefix: upstreamKeyPrefix(openRouterKey.key),
        status: "active",
        revoked_at: null,
      })
      .onDuplicateKeyUpdate({
        set: {
          external_key_hash: openRouterKey.externalKeyHash,
          external_workspace_id: openRouterKey.externalWorkspaceId,
          encrypted_api_key: openRouterKey.key,
          key_prefix: upstreamKeyPrefix(openRouterKey.key),
          status: "active",
          revoked_at: null,
        },
      })
  })
}

async function getActiveUsageBuckets(organizationId: OrgId) {
  const rows = await db
    .select({
      windowType: InferenceOrgLimitPolicyTable.window_type,
      windowStartAt: InferenceOrgUsageBucketTable.window_start_at,
      windowEndAt: InferenceOrgUsageBucketTable.window_end_at,
      limitAmount: InferenceOrgUsageBucketTable.limit_amount,
      usedAmount: InferenceOrgUsageBucketTable.used_amount,
    })
    .from(InferenceOrgUsageBucketTable)
    .innerJoin(
      InferenceOrgLimitPolicyTable,
      eq(InferenceOrgUsageBucketTable.id, InferenceOrgLimitPolicyTable.current_bucket_id),
    )
    .where(eq(InferenceOrgUsageBucketTable.organization_id, organizationId))

  return rows.map((row) => ({
    windowType: row.windowType,
    windowStartAt: row.windowStartAt.toISOString(),
    windowEndAt: row.windowEndAt.toISOString(),
    limitAmount: Number(row.limitAmount ?? 0),
    usedAmount: Number(row.usedAmount ?? 0),
  }))
}

export async function getInferenceStatus(organizationId: OrgId) {
  const managedModelsAllowed = await organizationAllowsManagedModels(organizationId)
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  const memberCount = await activeMemberCount(organizationId)
  const inference = managedModelsAllowed ? readInferenceMetadata(organization?.metadata ?? null) : null
  // Admin status reads are a natural repair point: org can show ENABLED in Den
  // while individual members are missing keys/providers after manual deletes.
  if (inference?.enabled === true) {
    try {
      // Roll expired usage buckets forward so the dashboard never reports a
      // stale window (e.g. an exhausted five-hour bucket whose reset time has
      // already passed).
      await syncInferenceLimitPolicies({ organizationId, tier: inference.tier, memberCount })
    } catch {
      // Status should still return even if bucket roll-forward fails.
    }
    try {
      const members = await listOrgMembers(organizationId)
      for (const member of members) {
        await repairMemberInferenceAccessIfNeeded({
          organizationId,
          memberId: member.id,
        })
      }
    } catch {
      // Status should still return even if upstream key provisioning fails.
    }
  }
  const buckets = inference?.enabled === true ? await getActiveUsageBuckets(organizationId) : []
  return {
    enabled: inference?.enabled === true,
    tier: inference?.tier ?? "tier1",
    memberCount,
    proxyBaseUrl: env.inferenceProxyBaseUrl,
    upstreamProviderConfigured: Boolean(env.openRouterManagementApiKey),
    buckets,
  }
}

export async function setInferenceEnabled(input: { organizationId: OrgId; enabled: boolean; tier?: InferenceTier }) {
  if (!input.enabled) {
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(OrganizationTable).where(eq(OrganizationTable.id, input.organizationId)).for("update")
      if (!current) return
      await tx.update(OrganizationTable).set({ metadata: setInferenceMetadata(current.metadata, null) }).where(eq(OrganizationTable.id, input.organizationId))
      await tx.update(InferenceKeyTable).set({ status: "revoked", revoked_at: new Date() })
        .where(and(eq(InferenceKeyTable.organization_id, input.organizationId), eq(InferenceKeyTable.status, "active")))
    })
    await revokeOrgUpstreamProviderKeys(input.organizationId)
    await deleteOpenWorkProviders({ organizationId: input.organizationId })
    return getInferenceStatus(input.organizationId)
  }

  await assertOrganizationManagedModelsAllowed(input.organizationId)
  await ensureOrgUpstreamProviderKey(input.organizationId)
  await updateOrganizationMetadata(input.organizationId, (metadata) => {
    assertManagedModelsAllowed(metadata)
    const tier = input.tier ?? readInferenceMetadata(metadata)?.tier ?? "tier1"
    return setInferenceMetadata(metadata, { enabled: true, tier })
  })
  await syncInferenceForOrganizationMembers({ organizationId: input.organizationId })
  return getInferenceStatus(input.organizationId)
}
