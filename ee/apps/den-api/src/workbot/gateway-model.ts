import type { HeadlessModelAccess, HeadlessModelCatalog } from "@openwork-ee/headless-protocol"
import { parseGatewayModelAlias } from "@openwork-ee/utils/gateway-routing"
import { WORKBOT_DEFAULT_MODEL_ID } from "@openwork/types/den/workbot-settings"
import type { WorkbotAccessReason } from "@openwork/types/den/workbot-settings"
import type { GatewayProviderSummary } from "@openwork/types/den/gateway"
import { gatewayProviderUrl, readProviderConfigNpm } from "../llm/inference-provider-config.js"

export type CloudAgentGatewayActor = { organizationId: string; userId: string }
export type CloudAgentGatewayProtocol = HeadlessModelAccess["protocol"]
export type CloudAgentGatewayAccess = HeadlessModelAccess
export type CloudAgentGatewaySummary = Pick<GatewayProviderSummary, "id" | "providerId" | "status" | "providerConfig" | "models"> & Partial<Pick<GatewayProviderSummary, "authorizationRequests">>
export class CloudAgentGatewayAccessError extends Error {
  constructor(readonly reason: WorkbotAccessReason) {
    super("cloud_agent_gateway_model_unavailable")
  }
}
export type CloudAgentGatewayModel = {
  id: string
  name: string
  upstreamModelId: string
  provider: string
  baseUrl: string
  protocol: CloudAgentGatewayProtocol
}

/** Classify the shared Gateway's rewritten SDK, not a model's display name or upstream URL. */
export function cloudAgentGatewayProtocol(config: Record<string, unknown>): CloudAgentGatewayProtocol | null {
  switch (readProviderConfigNpm(config)) {
    case "@ai-sdk/anthropic": return "anthropic"
    case "@ai-sdk/openai": return "openai-responses"
    case "@ai-sdk/openai-compatible":
    case "@openrouter/ai-sdk-provider":
    case "@ai-sdk/amazon-bedrock/mantle": return "openai"
    default: return null
  }
}

/** Only gatewaySummary(..., false).models is usable; authorizationRequests are never a fallback. */
export function projectCloudAgentGatewayModels(summaries: CloudAgentGatewaySummary[], gatewayBaseUrl: string): CloudAgentGatewayModel[] {
  const models = new Map<string, CloudAgentGatewayModel>()
  for (const summary of summaries) {
    if (summary.status !== "active") continue
    const protocol = cloudAgentGatewayProtocol(summary.providerConfig)
    if (!protocol) continue
    const baseUrl = gatewayProviderUrl(gatewayBaseUrl, summary.id)
    for (const model of summary.models) {
      if (!parseGatewayModelAlias(model.id)) continue
      models.set(model.id, { id: model.id, name: model.name, upstreamModelId: model.upstreamModelId, provider: summary.providerId, baseUrl, protocol })
    }
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export function cloudAgentGatewayCatalogProjection(models: CloudAgentGatewayModel[]): HeadlessModelCatalog {
  const luna = models.filter((model) => model.upstreamModelId === "gpt-6-luna")
  return {
    defaultModel: luna.length === 1 ? luna[0]?.id ?? WORKBOT_DEFAULT_MODEL_ID : WORKBOT_DEFAULT_MODEL_ID,
    models: models.map(({ id, name, provider }) => ({ id, name, provider })),
    // Credential/grant readiness only. This is not a paid completion or a claim that upstream is healthy.
    verified: true,
  }
}

export type CloudAgentGatewaySnapshot = { memberId: string; gatewayBaseUrl: string; summaries: CloudAgentGatewaySummary[] }
export type CloudAgentGatewayDeps = {
  snapshot: (actor: CloudAgentGatewayActor) => Promise<CloudAgentGatewaySnapshot>
  memberKey: (actor: CloudAgentGatewayActor, memberId: string) => Promise<string>
  missingModelReason?: (actor: CloudAgentGatewayActor, memberId: string, model: string) => Promise<WorkbotAccessReason>
}

/** Injectable boundary for focused authorization tests. No catalog or access is cached between calls. */
export function createCloudAgentGatewayModelService(deps: CloudAgentGatewayDeps) {
  async function current(actor: CloudAgentGatewayActor) {
    const snapshot = await deps.snapshot(actor)
    return { ...snapshot, models: projectCloudAgentGatewayModels(snapshot.summaries, snapshot.gatewayBaseUrl) }
  }
  return {
    async catalog(actor: CloudAgentGatewayActor): Promise<HeadlessModelCatalog> {
      return cloudAgentGatewayCatalogProjection((await current(actor)).models)
    },
    async access(actor: CloudAgentGatewayActor, model: string): Promise<CloudAgentGatewayAccess> {
      const snapshot = await current(actor)
      const selected = snapshot.models.find((entry) => entry.id === model)
      if (!selected) {
        const reason = !snapshot.summaries.some(provider => provider.status === "active") ? "gateway_provider_missing"
          : !parseGatewayModelAlias(model) ? "gateway_model_unavailable"
          : snapshot.summaries.some(provider => provider.authorizationRequests?.some(request => request.models?.some(entry => entry.id === model))) ? "gateway_authentication_required"
          : await deps.missingModelReason?.(actor, snapshot.memberId, model) ?? "gateway_model_unavailable"
        throw new CloudAgentGatewayAccessError(reason)
      }
      const apiKey = await deps.memberKey(actor, snapshot.memberId)
      return { baseUrl: selected.baseUrl, apiKey, protocol: selected.protocol }
    },
  }
}

// Lazy server imports keep the projections and injectable service usable without booting Den/DB.
const databaseDeps: CloudAgentGatewayDeps = {
  async snapshot(actor) {
    const [{ and, asc, eq, isNull }, { AuthUserTable, GatewayProviderTable, MemberTable, OrganizationTable }, { normalizeDenTypeId }, { db }, { env }, { gatewaySummary }, { scheduleLiteLlmProvisioning }, { isLiteLlmProviderId }] = await Promise.all([
      import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db/schema"), import("@openwork-ee/utils/typeid"),
      import("../db.js"), import("../env.js"), import("../llm/gateway-matrix.js"), import("../llm/litellm-issued.js"), import("@openwork-ee/utils/litellm-catalog"),
    ])
    if (!env.gatewayEnabled) throw new CloudAgentGatewayAccessError("gateway_not_configured")
    const organizationId = normalizeDenTypeId("organization", actor.organizationId)
    const userId = normalizeDenTypeId("user", actor.userId)
    const [member] = await db.select({ id: MemberTable.id }).from(MemberTable)
      .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
      .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt)))
      .limit(1)
    if (!member) throw new Error("cloud_agent_gateway_member_not_found")
    const providers = await db.select().from(GatewayProviderTable)
      .where(and(eq(GatewayProviderTable.organization_id, organizationId), eq(GatewayProviderTable.status, "active")))
      .orderBy(asc(GatewayProviderTable.id))
    const summaries: CloudAgentGatewaySummary[] = []
    for (const provider of providers) {
      const summary = await gatewaySummary(provider, member.id, env.gatewayPublicBaseUrl, false)
      // Only granted members appear in these projections. Provisioning rechecks eligibility itself.
      if (isLiteLlmProviderId(provider.provider_id) && (summary.models.length || summary.authorizationRequests.length)) {
        scheduleLiteLlmProvisioning(provider, member.id)
      }
      summaries.push(summary)
    }
    return { memberId: member.id, gatewayBaseUrl: env.gatewayPublicBaseUrl, summaries }
  },
  async missingModelReason(actor, memberId, model) {
    const selection = parseGatewayModelAlias(model)
    if (!selection) return "gateway_model_unavailable"
    const [{ and, eq }, { GatewayProviderTable: Provider, GatewayProviderModelTable: Model, GatewayModelGroupTable: Group, GatewayModelGroupModelTable: Link, GatewayCredentialSetTable: Set, GatewayProviderAccessTable: Access }, { normalizeDenTypeId }, { db }, { memberGatewayTeams, effectiveGatewayGrants }] = await Promise.all([
      import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db/schema"), import("@openwork-ee/utils/typeid"), import("../db.js"), import("../llm/inference-provider-lifecycle.js"),
    ])
    // Diagnose the saved alias without issuing credentials or mutating providers/defaults.
    const [row] = await db.select({ providerId: Provider.id, mode: Set.credential_mode }).from(Model)
      .innerJoin(Provider, and(eq(Provider.id, Model.gateway_provider_id), eq(Provider.organization_id, normalizeDenTypeId("organization", actor.organizationId)), eq(Provider.status, "active")))
      .innerJoin(Group, and(eq(Group.id, selection.modelGroupId), eq(Group.gateway_provider_id, Provider.id), eq(Group.status, "active")))
      .innerJoin(Link, and(eq(Link.model_group_id, Group.id), eq(Link.gateway_provider_model_id, Model.id)))
      .innerJoin(Set, and(eq(Set.id, selection.credentialSetId), eq(Set.gateway_provider_id, Provider.id), eq(Set.status, "active")))
      .where(eq(Model.id, selection.gatewayProviderModelId)).limit(1)
    if (!row) return "gateway_model_unavailable"
    const member = normalizeDenTypeId("member", memberId)
    const [grants, teams] = await Promise.all([
      db.select().from(Access).where(and(eq(Access.gateway_provider_id, row.providerId), eq(Access.model_group_id, selection.modelGroupId), eq(Access.credential_set_id, selection.credentialSetId))),
      memberGatewayTeams(db, normalizeDenTypeId("organization", actor.organizationId), member),
    ])
    if (!effectiveGatewayGrants(grants, member, teams.map(team => team.id)).length) return "gateway_member_access_missing"
    return row.mode === "member" ? "gateway_authentication_required" : "gateway_credentials_unavailable"
  },
  async memberKey(actor, memberId) {
    const [{ ensureMemberGatewayKey }, { normalizeDenTypeId }] = await Promise.all([
      import("../gateway-keys.js"), import("@openwork-ee/utils/typeid"),
    ])
    return ensureMemberGatewayKey({ organizationId: normalizeDenTypeId("organization", actor.organizationId), memberId: normalizeDenTypeId("member", memberId) })
  },
}

const service = createCloudAgentGatewayModelService(databaseDeps)
export const cloudAgentGatewayCatalog = service.catalog
export const cloudAgentGatewayAccess = service.access
