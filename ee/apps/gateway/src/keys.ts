import { timingSafeEqual } from "node:crypto"
import { and, eq, gt, inArray, isNotNull, isNull, or } from "@openwork-ee/den-db/drizzle"
import { GatewayApiKeyTable, GatewayKeyTable, InferenceKeyTable, InferenceOrgUpstreamProviderKeyTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db"
import { readFeatures } from "@openwork-ee/den-db/organization-features"
import { readOrganizationAiGatewaySettings } from "@openwork/types/den/gateway-api-keys"
import { assertManagedModelsAllowed, ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { gatewayBearerKeyLookupDigest, type GatewayBearerKey } from "@openwork-ee/utils/gateway-bearer-key"
import {
  inferenceBearerKeyLookupDigests,
  type InferenceBearerKey,
} from "@openwork-ee/utils/inference-bearer-key"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"

export function constantTimeEquals(a: string, b: string) {
  const left = new Uint8Array(Buffer.from(a))
  const right = new Uint8Array(Buffer.from(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

type SelectDb = Pick<typeof db, "select">

/** Replica first; a miss retries on the primary, since Den API may have created the key moments ago. */
async function firstOrPrimary<T>(lookup: (database: SelectDb) => PromiseLike<T[]>): Promise<T[]> {
  const rows = await lookup(db)
  return rows.length > 0 ? rows : lookup(db.$primary)
}

export async function findActiveInferenceKey(key: InferenceBearerKey) {
  if (key.value.startsWith("ow_gw_")) return null
  const keyHashes = await inferenceBearerKeyLookupDigests(key)
  const lookup = (database: SelectDb) => database
    .select({ inferenceKey: InferenceKeyTable })
    .from(InferenceKeyTable)
    .innerJoin(MemberTable, eq(InferenceKeyTable.org_membership_id, MemberTable.id))
    .where(and(
      inArray(InferenceKeyTable.key_hash, keyHashes),
      eq(InferenceKeyTable.status, "active"),
      eq(MemberTable.organizationId, InferenceKeyTable.organization_id),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  const [row] = await firstOrPrimary(lookup)
  if (!row) {
    return null
  }
  return row.inferenceKey
}

export async function assertOrganizationManagedModelsAllowed(organizationId: string): Promise<void> {
  try {
    const [organization] = await db.select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
      .limit(1)
    if (!organization) throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
    assertManagedModelsAllowed(organization.metadata)
  } catch (error) {
    if (error instanceof ManagedModelsPolicyError) throw error
    throw new ManagedModelsPolicyError("managed_models_policy_unavailable")
  }
}

type MemberGatewayKeyRow = Pick<typeof GatewayKeyTable.$inferSelect, "id" | "organization_id" | "org_membership_id">
type MemberApiKeyRow = Pick<typeof GatewayApiKeyTable.$inferSelect, "id" | "organization_id" | "org_membership_id">

/**
 * The key a Gateway request authenticated with: the one OpenWork issues to each member's own apps
 * (gateway_keys), or a key the member created for 3rd party tools (gateway_api_keys). Both act as the member.
 */
export type ActiveGatewayKey =
  | ({ source: "member" } & MemberGatewayKeyRow)
  | ({ source: "api_key"; lastUsedAt: Date | null } & MemberApiKeyRow)

async function lookupGatewayKey(database: SelectDb, digest: string): Promise<ActiveGatewayKey | null> {
  const [member] = await database.select({
    id: GatewayKeyTable.id,
    organization_id: GatewayKeyTable.organization_id,
    org_membership_id: GatewayKeyTable.org_membership_id,
  }).from(GatewayKeyTable)
    .innerJoin(MemberTable, and(eq(MemberTable.id, GatewayKeyTable.org_membership_id), eq(MemberTable.organizationId, GatewayKeyTable.organization_id)))
    .where(and(eq(GatewayKeyTable.key_hash, digest), eq(GatewayKeyTable.status, "active"), isNull(GatewayKeyTable.revoked_at),
      isNull(MemberTable.removedAt), isNotNull(MemberTable.userId)))
    .limit(1)
  if (member) return { source: "member", ...member }
  const [apiKey] = await database.select({
    id: GatewayApiKeyTable.id,
    organization_id: GatewayApiKeyTable.organization_id,
    org_membership_id: GatewayApiKeyTable.org_membership_id,
    lastUsedAt: GatewayApiKeyTable.last_used_at,
  }).from(GatewayApiKeyTable)
    .innerJoin(MemberTable, and(eq(MemberTable.id, GatewayApiKeyTable.org_membership_id), eq(MemberTable.organizationId, GatewayApiKeyTable.organization_id)))
    .where(and(eq(GatewayApiKeyTable.key_hash, digest), eq(GatewayApiKeyTable.status, "active"), isNull(GatewayApiKeyTable.revoked_at),
      or(isNull(GatewayApiKeyTable.expires_at), gt(GatewayApiKeyTable.expires_at, new Date())),
      isNull(MemberTable.removedAt), isNotNull(MemberTable.userId)))
    .limit(1)
  return apiKey ? { source: "api_key", ...apiKey } : null
}

const API_KEY_POLICY_CACHE_MS = 15_000
const apiKeyPolicyCache = new Map<string, { expires: number; allowed: boolean }>()

/**
 * Member API keys work only while the gatewayMemberApiKeys feature is on for the organization and its
 * admins allow them (Settings › General › AI Gateway). Cached briefly: turning either off stops keys
 * within this window.
 */
async function memberApiKeysAllowed(organizationId: string): Promise<boolean> {
  const now = Date.now()
  const cached = apiKeyPolicyCache.get(organizationId)
  if (cached && cached.expires > now) return cached.allowed
  const [organization] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId))).limit(1)
  const allowed = organization !== undefined
    && readOrganizationAiGatewaySettings(organization.metadata).memberApiKeys
    && (await readFeatures(db, organizationId, env.features)).gatewayMemberApiKeys
  if (apiKeyPolicyCache.size > 5_000) for (const [key, entry] of apiKeyPolicyCache) if (entry.expires <= now) apiKeyPolicyCache.delete(key)
  apiKeyPolicyCache.set(organizationId, { expires: now + API_KEY_POLICY_CACHE_MS, allowed })
  return allowed
}

const toolEndpointsPolicyCache = new Map<string, { expires: number; enabled: boolean }>()

/**
 * Whether the Cursor and Claude Code endpoints are on for the organization: they are part of member
 * API keys (feature `gatewayMemberApiKeys`), cached like the key policy.
 */
export async function toolEndpointsEnabled(organizationId: string): Promise<boolean> {
  const now = Date.now()
  const cached = toolEndpointsPolicyCache.get(organizationId)
  if (cached && cached.expires > now) return cached.enabled
  const enabled = (await readFeatures(db, organizationId, env.features)).gatewayMemberApiKeys
  if (toolEndpointsPolicyCache.size > 5_000) for (const [key, entry] of toolEndpointsPolicyCache) if (entry.expires <= now) toolEndpointsPolicyCache.delete(key)
  toolEndpointsPolicyCache.set(organizationId, { expires: now + API_KEY_POLICY_CACHE_MS, enabled })
  return enabled
}

const LAST_USED_RESOLUTION_MS = 60_000

/** Records when a member API key was last used, at most once a minute per key. Never fails the request. */
function touchApiKey(key: Extract<ActiveGatewayKey, { source: "api_key" }>) {
  const now = new Date()
  if (key.lastUsedAt && now.getTime() - key.lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) return
  void db.update(GatewayApiKeyTable).set({ last_used_at: now })
    .where(eq(GatewayApiKeyTable.id, key.id))
    .catch((error: unknown) => console.warn("[gateway] could not record API key use", { gatewayApiKeyId: key.id, error: error instanceof Error ? error.message : String(error) }))
}

export async function findActiveGatewayKey(key: GatewayBearerKey): Promise<ActiveGatewayKey | null> {
  const digest = await gatewayBearerKeyLookupDigest(key)
  // Replica first; a miss retries on the primary, since Den API may have created the key moments ago.
  const found = await lookupGatewayKey(db, digest) ?? await lookupGatewayKey(db.$primary, digest)
  if (found?.source !== "api_key") return found
  if (!await memberApiKeysAllowed(found.organization_id)) return null
  touchApiKey(found)
  return found
}

export async function getOpenRouterProviderKey(organizationId: string): Promise<typeof InferenceOrgUpstreamProviderKeyTable.$inferSelect | null> {
  const rows = await db.select().from(InferenceOrgUpstreamProviderKeyTable)
    .where(and(
      eq(InferenceOrgUpstreamProviderKeyTable.organization_id, normalizeDenTypeId("organization", organizationId)),
      eq(InferenceOrgUpstreamProviderKeyTable.provider, "openrouter"),
      eq(InferenceOrgUpstreamProviderKeyTable.status, "active"),
    ))
    .limit(1)
  return rows[0] ?? null
}
