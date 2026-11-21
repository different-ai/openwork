import { z } from "zod"
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, GatewayProviderCredentialTable, GatewayTrueFoundryUserTable, MemberTable } from "@openwork-ee/den-db/schema"
import { TRUEFOUNDRY_ADMIN_CREDENTIAL_SUBJECT, TRUEFOUNDRY_DOC_URL, TRUEFOUNDRY_ENV, TRUEFOUNDRY_NPM, TRUEFOUNDRY_PROVIDER_ID, TRUEFOUNDRY_PROVIDER_NAME, isTrueFoundryProviderId } from "@openwork-ee/gateway-catalog"
import type { GatewayTrueFoundryAttentionReason, GatewayTrueFoundryStatus } from "@openwork/types/den/gateway"
import { db } from "../db.js"
import type { ModelsDevProvider } from "./models-dev.js"

const storedModelSchema = z.object({ id: z.string().min(1).max(255), name: z.string().min(1).max(255), config: z.record(z.string(), z.unknown()) })
const settingsSchema = z.object({
  version: z.literal(1),
  controlPlaneUrl: z.string().min(1).max(2048),
  credentialSetId: z.string().min(1),
  createMissingUsers: z.boolean().default(false),
  trackUsageCosts: z.boolean().default(false),
  catalog: z.array(storedModelSchema).max(500),
  upstream: z.array(storedModelSchema).max(500).optional(),
  selectedModelIds: z.array(z.string().min(1).max(255)).max(500).nullable().default(null),
  groups: z.record(z.string(), z.string()),
  lastSyncedAt: z.string().nullable(),
  lastSyncError: z.string().nullable(),
})
export type TrueFoundrySettings = z.infer<typeof settingsSchema>

export function readTrueFoundrySettings(settings: Record<string, unknown>): TrueFoundrySettings | null {
  const parsed = settingsSchema.safeParse(settings.truefoundry)
  return parsed.success ? parsed.data : null
}

export function trueFoundryUpstreamModels(settings: Pick<TrueFoundrySettings, "catalog" | "upstream">): TrueFoundrySettings["catalog"] {
  return settings.upstream ?? settings.catalog
}

export function selectTrueFoundryModels<T extends { id: string }>(upstream: readonly T[], selectedModelIds: readonly string[] | null): T[] {
  if (selectedModelIds === null) return [...upstream]
  const picked = new Set(selectedModelIds)
  return upstream.filter((model) => picked.has(model.id))
}

export function trueFoundryCatalogProvider(provider: { settings: Record<string, unknown> }): ModelsDevProvider {
  return {
    id: TRUEFOUNDRY_PROVIDER_ID, name: TRUEFOUNDRY_PROVIDER_NAME, npm: TRUEFOUNDRY_NPM, env: [...TRUEFOUNDRY_ENV], doc: TRUEFOUNDRY_DOC_URL, api: null,
    config: { id: TRUEFOUNDRY_PROVIDER_ID, name: TRUEFOUNDRY_PROVIDER_NAME, npm: TRUEFOUNDRY_NPM, env: [...TRUEFOUNDRY_ENV], doc: TRUEFOUNDRY_DOC_URL },
    models: readTrueFoundrySettings(provider.settings)?.catalog ?? [],
  }
}

export const TRUEFOUNDRY_ATTENTION_STATUSES = ["not_in_truefoundry", "user_inactive", "token_limit", "no_models", "error"] as const satisfies readonly GatewayTrueFoundryAttentionReason[]

function attentionReason(status: string): GatewayTrueFoundryAttentionReason | null {
  return TRUEFOUNDRY_ATTENTION_STATUSES.find((reason) => reason === status) ?? null
}

export async function trueFoundryStatus(provider: { id: typeof GatewayTrueFoundryUserTable.$inferSelect.gateway_provider_id; provider_id: string; settings: Record<string, unknown> }, primary = false): Promise<GatewayTrueFoundryStatus | undefined> {
  const settings = isTrueFoundryProviderId(provider.provider_id) ? readTrueFoundrySettings(provider.settings) : null
  if (!settings) return undefined
  const reader = primary ? db.$primary : db
  const [admin] = await reader.select({ status: GatewayProviderCredentialTable.status }).from(GatewayProviderCredentialTable)
    .where(and(eq(GatewayProviderCredentialTable.gateway_provider_id, provider.id), eq(GatewayProviderCredentialTable.subject, TRUEFOUNDRY_ADMIN_CREDENTIAL_SUBJECT), isNull(GatewayProviderCredentialTable.org_membership_id)))
  const rows = await reader.select({ memberId: GatewayTrueFoundryUserTable.org_membership_id, status: GatewayTrueFoundryUserTable.status, message: GatewayTrueFoundryUserTable.message, created: GatewayTrueFoundryUserTable.truefoundry_user_created })
    .from(GatewayTrueFoundryUserTable).where(eq(GatewayTrueFoundryUserTable.gateway_provider_id, provider.id))
  const attentionRows = rows.filter((row) => attentionReason(row.status) !== null)
  const people = attentionRows.length ? await reader.select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email }).from(MemberTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId)).where(inArray(MemberTable.id, attentionRows.slice(0, 50).map((row) => row.memberId))) : []
  return {
    controlPlaneUrl: settings.controlPlaneUrl,
    gatewayBaseUrl: typeof provider.settings.upstreamBaseUrl === "string" ? provider.settings.upstreamBaseUrl : null,
    createMissingUsers: settings.createMissingUsers,
    trackUsageCosts: settings.trackUsageCosts,
    hasAdminKey: admin?.status === "active",
    lastSyncedAt: settings.lastSyncedAt,
    lastSyncError: settings.lastSyncError,
    modelCount: settings.catalog.length,
    availableModels: trueFoundryUpstreamModels(settings).map((model) => ({ id: model.id, name: model.name })),
    selectedModelIds: settings.selectedModelIds,
    activeMemberCount: rows.filter((row) => row.status === "active").length,
    createdUserCount: rows.filter((row) => row.created !== null && row.status !== "revoked").length,
    attentionCount: attentionRows.length,
    attention: attentionRows.slice(0, 50).flatMap((row) => {
      const person = people.find((entry) => entry.id === row.memberId)
      const reason = attentionReason(row.status)
      return person && reason ? [{ memberId: row.memberId, name: person.name, email: person.email, reason, message: row.message }] : []
    }),
  }
}
