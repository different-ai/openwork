/**
 * Stored LiteLLM sync state (gateway_providers.settings.litellm) and the
 * catalog derived from it. Kept free of gateway-matrix imports so the matrix
 * can resolve LiteLLM catalogs without an import cycle.
 */
import { z } from "zod"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, GatewayCredentialSetTable, GatewayLiteLlmIssuedKeyTable, GatewayProviderCredentialTable, MemberTable } from "@openwork-ee/den-db/schema"
import { LITELLM_ADMIN_CREDENTIAL_SUBJECT, LITELLM_DOC_URL, LITELLM_ENV, LITELLM_NPM, LITELLM_PROVIDER_ID, LITELLM_PROVIDER_NAME, isLiteLlmProviderId, liteLlmSpendTrackingEnabled } from "@openwork-ee/utils/litellm-catalog"
import type { GatewayLiteLlmStatus } from "@openwork/types/den/gateway"
import { db } from "../db.js"
import { normalizeLiteLlmBaseUrl } from "./litellm.js"
import type { ModelsDevProvider } from "./models-dev.js"

const storedModelSchema = z.object({ id: z.string().min(1).max(255), name: z.string().min(1).max(255), config: z.record(z.string(), z.unknown()) })
const settingsSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["org", "member"]),
  credentialSetId: z.string().min(1),
  catalog: z.array(storedModelSchema).max(500),
  teams: z.array(z.object({ id: z.string().min(1), alias: z.string().nullable(), modelSetKey: z.string().nullable() })).max(1000),
  groups: z.record(z.string(), z.string()),
  members: z.record(z.string(), z.object({ grantId: z.string().nullable(), groupId: z.string(), teamId: z.string().nullable(), matchedAt: z.string() })),
  lastSyncedAt: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  /** member mode only: each person pastes their key, or OpenWork creates it. */
  keySource: z.enum(["personal", "issued"]).default("personal"),
  /** issued only: one key per LiteLLM team, or a copy of the person's existing key. */
  issueStrategy: z.enum(["per_team", "mirror"]).default("per_team"),
  /** issued + mirror: what to do for someone with no key to copy. */
  mirrorFallback: z.enum(["per_team", "error"]).default("per_team"),
  /** issued + per team: LiteLLM team id -> the credential set holding that team's keys. */
  teamSets: z.record(z.string(), z.string()).default({}),
})
export type LiteLlmSettings = z.infer<typeof settingsSchema>

export function readLiteLlmSettings(settings: Record<string, unknown>): LiteLlmSettings | null {
  const parsed = settingsSchema.safeParse(settings.litellm)
  return parsed.success ? parsed.data : null
}

/** Catalog provider for the gateway matrix, from the last successful sync. */
export function liteLlmCatalogProvider(provider: { settings: Record<string, unknown> }): ModelsDevProvider {
  return {
    id: LITELLM_PROVIDER_ID, name: LITELLM_PROVIDER_NAME, npm: LITELLM_NPM, env: [...LITELLM_ENV], doc: LITELLM_DOC_URL, api: null,
    config: { id: LITELLM_PROVIDER_ID, name: LITELLM_PROVIDER_NAME, npm: LITELLM_NPM, env: [...LITELLM_ENV], doc: LITELLM_DOC_URL },
    models: readLiteLlmSettings(provider.settings)?.catalog ?? [],
  }
}

const ATTENTION_STATUSES = ["not_in_litellm", "no_key_to_mirror", "no_models", "error"] as const

/** Read-only management view. Never includes keys. */
export async function liteLlmStatus(provider: { id: typeof GatewayCredentialSetTable.$inferSelect.gateway_provider_id; provider_id: string; settings: Record<string, unknown> }): Promise<GatewayLiteLlmStatus | undefined> {
  const settings = isLiteLlmProviderId(provider.provider_id) ? readLiteLlmSettings(provider.settings) : null
  if (!settings) return undefined
  const set = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, provider.id))
  const credentials = set.length ? await db.select({ subject: GatewayProviderCredentialTable.subject, status: GatewayProviderCredentialTable.status, memberId: GatewayProviderCredentialTable.org_membership_id })
    .from(GatewayProviderCredentialTable).where(inArray(GatewayProviderCredentialTable.credential_set_id, set.map((row) => row.id))) : []
  const syncSubject = settings.mode === "org" ? "org" : LITELLM_ADMIN_CREDENTIAL_SUBJECT
  let baseUrl: string | null = null
  try { baseUrl = typeof provider.settings.upstreamBaseUrl === "string" ? normalizeLiteLlmBaseUrl(provider.settings.upstreamBaseUrl).adminBaseUrl : null } catch { baseUrl = null }
  const issued = settings.mode === "member" && settings.keySource === "issued"
  const issuedRows = issued ? await db.select({ memberId: GatewayLiteLlmIssuedKeyTable.org_membership_id, slot: GatewayLiteLlmIssuedKeyTable.slot, status: GatewayLiteLlmIssuedKeyTable.status })
    .from(GatewayLiteLlmIssuedKeyTable).where(eq(GatewayLiteLlmIssuedKeyTable.gateway_provider_id, provider.id)) : []
  const attentionRows = issuedRows.filter((row) => row.slot === "member" && ATTENTION_STATUSES.some((status) => status === row.status))
  const people = attentionRows.length ? await db.select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email }).from(MemberTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId)).where(inArray(MemberTable.id, attentionRows.slice(0, 50).map((row) => row.memberId))) : []
  return {
    mode: settings.mode,
    keySource: settings.mode === "member" ? settings.keySource : null,
    issueStrategy: issued ? settings.issueStrategy : null,
    mirrorFallback: issued ? settings.mirrorFallback : null,
    issuedMemberCount: new Set(issuedRows.filter((row) => row.slot !== "member" && row.status === "active").map((row) => row.memberId)).size,
    attentionCount: attentionRows.length,
    attention: attentionRows.slice(0, 50).flatMap((row) => {
      const person = people.find((entry) => entry.id === row.memberId)
      const reason = ATTENTION_STATUSES.find((status) => status === row.status)
      return person && reason ? [{ memberId: row.memberId, name: person.name, email: person.email, reason }] : []
    }),
    baseUrl,
    spendTracking: liteLlmSpendTrackingEnabled(settings.mode),
    hasSyncKey: credentials.some((row) => row.subject === syncSubject && row.memberId === null && row.status === "active"),
    lastSyncedAt: settings.lastSyncedAt,
    lastSyncError: settings.lastSyncError,
    modelCount: settings.catalog.length,
    teamCount: settings.teams.length,
    connectedMemberCount: settings.mode === "member" ? new Set(credentials.filter((row) => row.memberId !== null && row.status === "active").map((row) => row.memberId)).size : 0,
  }
}
