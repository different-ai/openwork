import { createHash, randomBytes } from "node:crypto"
import { and, eq, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
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
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE,
  INFERENCE_TIER_LIMITS,
  INFERENCE_WINDOW_DURATIONS_MS,
} from "@openwork/types/den/inference"
import type { InferenceOrganizationMetadata, InferenceTier, InferenceWindowType } from "@openwork/types/den/inference"
import { db } from "./db.js"
import { env } from "./env.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

const OPENWORK_PROVIDER_ID = "openwork"
const OPENROUTER_PROVIDER = "openrouter"
const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/keys"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function createUserFacingInferenceKey() {
  return `ow_inf_${randomBytes(32).toString("base64url")}`
}

function keyPrefix(key: string) {
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
    next.inference = inference
  } else {
    delete next.inference
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
  return db.select({ id: MemberTable.id }).from(MemberTable).where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
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

function buildOpenWorkProviderConfig() {
  return {
    id: OPENWORK_PROVIDER_ID,
    name: "OpenWork",
    npm: "@openrouter/ai-sdk-provider",
    env: ["OPENWORK_API_KEY"],
    doc: "OpenWork-managed inference proxy for organization models.",
    api: `${env.inferenceProxyBaseUrl.replace(/\/+$/, "")}/api/v1`,
    options: {
      baseURL: `${env.inferenceProxyBaseUrl.replace(/\/+$/, "")}/api/v1`,
    },
  }
}

async function revokeMemberInferenceKeys(memberId: MemberId) {
  await db
    .update(InferenceKeyTable)
    .set({ status: "revoked", revoked_at: new Date() })
    .where(and(eq(InferenceKeyTable.org_membership_id, memberId), eq(InferenceKeyTable.status, "active")))
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

async function createMemberInferenceKey(input: { organizationId: OrgId; memberId: MemberId }) {
  const key = createUserFacingInferenceKey()
  await db.insert(InferenceKeyTable).values({
    id: createDenTypeId("inferenceKey"),
    organization_id: input.organizationId,
    org_membership_id: input.memberId,
    name: "OpenWork Models",
    key_hash: sha256(key),
    key_prefix: keyPrefix(key),
    status: "active",
  })
  return key
}

async function ensureOpenWorkLlmProviderForMember(input: { organizationId: OrgId; memberId: MemberId; inferenceKey: string }) {
  const now = new Date()
  const providerRows = await db
    .select({ id: LlmProviderTable.id })
    .from(LlmProviderTable)
    .where(and(
      eq(LlmProviderTable.organizationId, input.organizationId),
      eq(LlmProviderTable.createdByOrgMembershipId, input.memberId),
      eq(LlmProviderTable.source, "openwork"),
      eq(LlmProviderTable.providerId, OPENWORK_PROVIDER_ID),
    ))
    .limit(1)

  const providerConfig = buildOpenWorkProviderConfig()
  const providerId = providerRows[0]?.id ?? createDenTypeId("llmProvider")

  await db.transaction(async (tx) => {
    if (providerRows[0]) {
      await tx
        .update(LlmProviderTable)
        .set({ name: "OpenWork Models", providerConfig, apiKey: input.inferenceKey, updatedAt: now })
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
        apiKey: input.inferenceKey,
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
  const key = await createMemberInferenceKey(input)
  await ensureOpenWorkLlmProviderForMember({ ...input, inferenceKey: key })
}

export async function syncInferenceForOrganizationMembers(input: { organizationId: OrgId }) {
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
    const [provider] = await db
      .select({ id: LlmProviderTable.id })
      .from(LlmProviderTable)
      .where(and(
        eq(LlmProviderTable.organizationId, input.organizationId),
        eq(LlmProviderTable.createdByOrgMembershipId, member.id),
        eq(LlmProviderTable.source, "openwork"),
        eq(LlmProviderTable.providerId, OPENWORK_PROVIDER_ID),
      ))
      .limit(1)
    const [key] = await db
      .select({ id: InferenceKeyTable.id })
      .from(InferenceKeyTable)
      .where(and(
        eq(InferenceKeyTable.organization_id, input.organizationId),
        eq(InferenceKeyTable.org_membership_id, member.id),
        eq(InferenceKeyTable.status, "active"),
      ))
      .limit(1)

    if (!provider || !key) {
      await revokeMemberInferenceKeys(member.id)
      await ensureMemberInferenceAccess({ organizationId: input.organizationId, memberId: member.id })
    }
  }
}

export async function syncInferenceAfterMemberChange(input: {
  organizationId: OrgId
  memberId: MemberId
  memberCount: number
  change: "added" | "removed"
}) {
  if (input.change === "removed") {
    await revokeMemberInferenceKeys(input.memberId)
    await deleteOpenWorkProviders({ organizationId: input.organizationId, memberId: input.memberId })
  }

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
    await ensureMemberInferenceAccess({ organizationId: input.organizationId, memberId: input.memberId })
  }
}

async function syncInferenceLimitPolicies(input: { organizationId: OrgId; tier: InferenceTier; memberCount: number }) {
  const now = new Date()
  for (const windowType of Object.keys(INFERENCE_TIER_LIMITS[input.tier])) {
    await db
      .insert(InferenceOrgLimitPolicyTable)
      .values({
        id: createDenTypeId("inferenceOrgLimitPolicy"),
        organization_id: input.organizationId,
        window_type: windowType as keyof typeof INFERENCE_TIER_LIMITS[InferenceTier],
        reset_strategy: INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE[windowType as keyof typeof INFERENCE_TIER_LIMITS[InferenceTier]],
        anchor_at: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          reset_strategy: INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE[windowType as keyof typeof INFERENCE_TIER_LIMITS[InferenceTier]],
        },
      })
  }

  const policies = await db
    .select({
      id: InferenceOrgLimitPolicyTable.id,
      windowType: InferenceOrgLimitPolicyTable.window_type,
      resetStrategy: InferenceOrgLimitPolicyTable.reset_strategy,
      anchorAt: InferenceOrgLimitPolicyTable.anchor_at,
      currentBucketId: InferenceOrgLimitPolicyTable.current_bucket_id,
    })
    .from(InferenceOrgLimitPolicyTable)
    .where(eq(InferenceOrgLimitPolicyTable.organization_id, input.organizationId))

  for (const policy of policies) {
    const limitAmount = INFERENCE_TIER_LIMITS[input.tier][policy.windowType] * input.memberCount
    const currentBucket = policy.currentBucketId
      ? (await db.select().from(InferenceOrgUsageBucketTable).where(eq(InferenceOrgUsageBucketTable.id, policy.currentBucketId)).limit(1))[0]
      : null

    if (currentBucket && currentBucket.window_start_at <= now && currentBucket.window_end_at > now) {
      await db
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
    await db.insert(InferenceOrgUsageBucketTable).values({
      id: bucketId,
      organization_id: input.organizationId,
      policy_id: policy.id,
      window_start_at: window.start,
      window_end_at: window.end,
      limit_amount: limitAmount,
      used_amount: 0,
    })
    await db
      .update(InferenceOrgLimitPolicyTable)
      .set({ current_bucket_id: bucketId })
      .where(eq(InferenceOrgLimitPolicyTable.id, policy.id))
  }
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

  await db
    .insert(InferenceOrgUpstreamProviderKeyTable)
    .values({
      id: createDenTypeId("inferenceOrgProviderKey"),
      organization_id: organizationId,
      provider: OPENROUTER_PROVIDER,
      external_key_hash: openRouterKey.externalKeyHash,
      external_workspace_id: openRouterKey.externalWorkspaceId,
      encrypted_api_key: openRouterKey.key,
      key_prefix: keyPrefix(openRouterKey.key),
      status: "active",
      revoked_at: null,
    })
    .onDuplicateKeyUpdate({
      set: {
        external_key_hash: openRouterKey.externalKeyHash,
        external_workspace_id: openRouterKey.externalWorkspaceId,
        encrypted_api_key: openRouterKey.key,
        key_prefix: keyPrefix(openRouterKey.key),
        status: "active",
        revoked_at: null,
      },
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
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  const memberCount = await activeMemberCount(organizationId)
  const inference = readInferenceMetadata(organization?.metadata ?? null)
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
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.organizationId))
    .limit(1)
  if (!organization) {
    return null
  }

  if (!input.enabled) {
    const members = await listOrgMembers(input.organizationId)
    await revokeOrgUpstreamProviderKeys(input.organizationId)
    await db
      .update(OrganizationTable)
      .set({ metadata: setInferenceMetadata(organization.metadata, null) })
      .where(eq(OrganizationTable.id, input.organizationId))
    if (members.length > 0) {
      await db
        .update(InferenceKeyTable)
        .set({ status: "revoked", revoked_at: new Date() })
        .where(and(eq(InferenceKeyTable.organization_id, input.organizationId), inArray(InferenceKeyTable.org_membership_id, members.map((member) => member.id))))
    }
    await deleteOpenWorkProviders({ organizationId: input.organizationId })
    return getInferenceStatus(input.organizationId)
  }

  const tier = input.tier ?? readInferenceMetadata(organization.metadata)?.tier ?? "tier1"
  await ensureOrgUpstreamProviderKey(input.organizationId)
  await db
    .update(OrganizationTable)
    .set({ metadata: setInferenceMetadata(organization.metadata, { enabled: true, tier }) })
    .where(eq(OrganizationTable.id, input.organizationId))
  await syncInferenceForOrganizationMembers({ organizationId: input.organizationId })
  return getInferenceStatus(input.organizationId)
}
