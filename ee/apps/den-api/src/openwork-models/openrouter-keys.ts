import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { InferenceOrgUpstreamProviderKeyTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { assertOrganizationManagedModelsAllowed } from "../organization-metadata.js"
import { withManagedModelsAdmission } from "../inference-shared/public.js"
import { isRecord } from "./metadata.js"

type OrgId = typeof OrganizationTable.$inferSelect.id

const OPENROUTER_PROVIDER = "openrouter"
const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/keys"

function upstreamKeyPrefix(key: string) {
  return key.slice(0, 16)
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

export async function revokeOrgUpstreamProviderKeys(organizationId: OrgId) {
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

export async function ensureOrgUpstreamProviderKey(organizationId: OrgId) {
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
