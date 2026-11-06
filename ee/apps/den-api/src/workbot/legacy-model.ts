import type { HeadlessModelAccess, HeadlessModelCatalog } from "@openwork-ee/headless-protocol"
import { automationModelAllowedByProvider } from "@openwork/types/automations"
import { WORKBOT_DEFAULT_MODEL_ID } from "@openwork/types/den/workbot-settings"
import { decodeProviderCredential, readProviderEnvNames, toRuntimeProviderEnv } from "../llm/provider-credentials.js"
import { CloudAgentGatewayAccessError, type CloudAgentGatewayActor } from "./gateway-model.js"

export type CloudAgentLegacyProvider = {
  id: string
  source: string
  providerId: string
  providerConfig: Record<string, unknown>
  /** Already resolved for this actor, never a teammate or deployment credential. */
  credential: string | null
  models: Array<{ modelId: string; name: string; modelConfig: Record<string, unknown> }>
}
export type CloudAgentLegacyDeps = {
  /** Must enforce active org membership and current grants for shared AND per-member providers. */
  providers: (actor: CloudAgentGatewayActor) => Promise<CloudAgentLegacyProvider[]>
}

/** The record identity, not the vendor name, keeps equal upstream IDs collision-free. */
export function legacyCloudModelId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}
export function isLegacyCloudModelId(model: string): boolean {
  return /^lpr_[0-9a-z]+\/.+/.test(model)
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function empty(value: unknown): boolean {
  return value === undefined || (record(value) && Object.keys(value).length === 0)
}
function route(provider: CloudAgentLegacyProvider): Omit<HeadlessModelAccess, "model"> | null {
  const config = provider.providerConfig
  let protocol: HeadlessModelAccess["protocol"]
  let defaultUrl: string | undefined
  switch (config.npm) {
    case "@ai-sdk/openai": protocol = "openai-responses"; defaultUrl = "https://api.openai.com/v1"; break
    case "@ai-sdk/anthropic": protocol = "anthropic"; defaultUrl = "https://api.anthropic.com/v1"; break
    case "@ai-sdk/openai-compatible": protocol = "openai"; break
    default: return null
  }
  // The runner cannot represent signing, SDK options, custom headers or multi-env authentication.
  if (!empty(config.headers) || (config.options !== undefined && !record(config.options))) return null
  const options = record(config.options) ? config.options : {}
  if (Object.keys(options).some(key => key !== "baseURL")) return null
  const declared = readProviderEnvNames(config)
  if (declared.length > 1) return null
  const decoded = decodeProviderCredential(provider.credential)
  const runtime = toRuntimeProviderEnv({ ...provider, apiKeys: decoded.apiKeys })
  const env = readProviderEnvNames(runtime.providerConfig)
  if (decoded.apiKeys && (env.length !== 1 || Object.keys(runtime.apiKeys ?? {}).length !== 1)) return null
  const apiKey = decoded.apiKey ?? (env[0] ? runtime.apiKeys?.[env[0]]?.trim() : null)
  if (!apiKey || /[\r\n]/.test(apiKey)) return null
  const value = options.baseURL ?? config.api ?? defaultUrl
  if (typeof value !== "string" || /[{}]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return { protocol, baseUrl: url.toString().replace(/\/+$/, ""), apiKey }
  } catch { return null }
}
function usableModels(provider: CloudAgentLegacyProvider) {
  return provider.models.filter(model => model.modelId.trim() && automationModelAllowedByProvider(provider.providerConfig, model.modelId)
    && empty(model.modelConfig.headers) && empty(model.modelConfig.options) && empty(model.modelConfig.provider))
}

/** Fresh actor-scoped reads for catalogs, minting and resume; never cache credentials or probe /models. */
export function createCloudAgentLegacyModelService(deps: CloudAgentLegacyDeps) {
  return {
    async catalog(actor: CloudAgentGatewayActor): Promise<HeadlessModelCatalog> {
      const models = (await deps.providers(actor)).flatMap(provider => {
        if (!route(provider)) return []
        return usableModels(provider).map(model => ({ id: legacyCloudModelId(provider.id, model.modelId), name: model.name, provider: provider.id }))
      }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      const luna = models.filter(model => model.id.slice(model.id.indexOf("/") + 1) === "gpt-6-luna")
      return { models, defaultModel: luna.length === 1 ? luna[0]?.id ?? WORKBOT_DEFAULT_MODEL_ID : WORKBOT_DEFAULT_MODEL_ID, verified: true }
    },
    async access(actor: CloudAgentGatewayActor, model: string): Promise<HeadlessModelAccess> {
      const providers = await deps.providers(actor)
      for (const provider of providers) {
        const selected = usableModels(provider).find(entry => legacyCloudModelId(provider.id, entry.modelId) === model)
        if (!selected) continue
        const access = route(provider)
        if (access) return { ...access, model: selected.modelId }
      }
      throw new CloudAgentGatewayAccessError("model_access_unavailable")
    },
  }
}

const service = createCloudAgentLegacyModelService({
  async providers(actor) {
    const [{ and, asc, eq, inArray, isNull }, { AuthUserTable, OrganizationTable, MemberTable, TeamTable, TeamMemberTable, LlmProviderTable, LlmProviderModelTable, LlmProviderMemberCredentialTable }, { normalizeDenTypeId }, { db }, { listAccessibleLlmProviderAccess }, { organizationAllowsManagedModels }] = await Promise.all([
      import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db/schema"), import("@openwork-ee/utils/typeid"), import("../db.js"), import("../routes/org/llm-provider-access.js"), import("../inference.js"),
    ])
    const organizationId = normalizeDenTypeId("organization", actor.organizationId)
    const userId = normalizeDenTypeId("user", actor.userId)
    const [member] = await db.select({ id: MemberTable.id }).from(MemberTable)
      .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
      .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt))).limit(1)
    if (!member) throw new CloudAgentGatewayAccessError("model_access_unavailable")
    const teams = await db.select({ id: TeamTable.id }).from(TeamMemberTable)
      .innerJoin(TeamTable, eq(TeamTable.id, TeamMemberTable.teamId))
      .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamMemberTable.orgMembershipId, member.id)))
    const grants = await listAccessibleLlmProviderAccess({ organizationId, currentMemberId: member.id, teamIds: teams.map(team => team.id) })
    const ids = [...new Set(grants.map(grant => grant.llmProviderId))]
    if (!ids.length) return []
    const [providers, models, credentials, managedAllowed] = await Promise.all([
      db.select().from(LlmProviderTable).where(and(eq(LlmProviderTable.organizationId, organizationId), inArray(LlmProviderTable.id, ids))).orderBy(asc(LlmProviderTable.id)),
      db.select().from(LlmProviderModelTable).where(inArray(LlmProviderModelTable.llmProviderId, ids)),
      db.select().from(LlmProviderMemberCredentialTable).where(and(eq(LlmProviderMemberCredentialTable.organizationId, organizationId), eq(LlmProviderMemberCredentialTable.orgMembershipId, member.id), eq(LlmProviderMemberCredentialTable.state, "active"), inArray(LlmProviderMemberCredentialTable.llmProviderId, ids))),
      organizationAllowsManagedModels(organizationId),
    ])
    return providers.filter(provider => provider.source !== "openwork" || managedAllowed).map(provider => ({
      ...provider,
      credential: provider.credentialMode === "per_member" ? credentials.find(binding => binding.llmProviderId === provider.id)?.secret ?? null : provider.apiKey,
      models: models.filter(model => model.llmProviderId === provider.id),
    }))
  },
})
export const cloudAgentLegacyCatalog = service.catalog
export const cloudAgentLegacyAccess = service.access
