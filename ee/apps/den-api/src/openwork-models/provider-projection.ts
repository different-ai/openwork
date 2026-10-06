import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  LlmProviderAccessTable,
  LlmProviderModelTable,
  LlmProviderTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { findActiveMemberInferenceKey, withManagedModelsAdmission } from "../inference-shared/public.js"
import { readInferenceMetadata } from "./metadata.js"

/**
 * OpenWork Models reaches the desktop through `llm_provider` rows with `source='openwork'`.
 * Every read and write of those rows lives here.
 */

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const OPENWORK_PROVIDER_ID = "openwork"

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

export async function deleteOpenWorkProviders(where: { organizationId: OrgId; memberId?: MemberId }) {
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

/** Legacy key material: rows minted before `inference_keys.encrypted_key` existed kept the raw key here. */
export async function findOpenWorkLlmProviderApiKey(tx: Tx, input: { organizationId: OrgId; memberId: MemberId }) {
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

export async function ensureOpenWorkLlmProviderForMember(input: { organizationId: OrgId; memberId: MemberId; rawKey: string }) {
  const now = new Date()
  const providerConfig = buildOpenWorkProviderConfig()

  await withManagedModelsAdmission(input.organizationId, async (tx) => {
    const [organization] = await tx.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, input.organizationId)).for("update")
    if (!readInferenceMetadata(organization?.metadata ?? null)) return
    const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable)
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt))).for("update")
    if (!member || (await findActiveMemberInferenceKey(tx, input))?.encryptedKey !== input.rawKey) return
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

export async function memberHasOpenWorkInferenceAccess(input: { organizationId: OrgId; memberId: MemberId }) {
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
  const key = await findActiveMemberInferenceKey(db, input)

  return Boolean(provider && key?.encryptedKey && provider.apiKey === key.encryptedKey)
}
