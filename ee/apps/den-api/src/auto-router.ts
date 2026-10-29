import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AutoRouterRouteTable,
  AutoRouterTable,
  GatewayCredentialSetTable,
  GatewayModelGroupModelTable,
  GatewayModelGroupTable,
  GatewayProviderAccessTable,
  GatewayProviderModelTable,
  GatewayProviderTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  AUTO_ROUTER_DEFAULT_PROMPT,
  AUTO_ROUTER_SUPPORTED_NPM,
  AUTO_ROUTER_THINKING_LEVELS,
  autoRouterThinkingLevels,
  type AutoRouterModelOption,
  type AutoRouterRoutingState,
  type AutoRouterRoute,
  type AutoRouterThinkingLevel,
  type AutoRouterWrite,
} from "@openwork/types/den/auto-router"
import { db } from "./db.js"
import { env } from "./env.js"
import { gatewayManagementUnavailable } from "./gateway-deployment.js"
import { gatewayModelConfigurationError, readProviderConfigNpm } from "./llm/inference-provider-config.js"
import { effectiveGatewayGrants, memberGatewayTeams } from "./llm/inference-provider-lifecycle.js"

type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The SDK a model is called with: its own override, else its provider's. */
function modelNpm(providerConfig: Record<string, unknown>, modelConfig: Record<string, unknown>) {
  const override = isRecord(modelConfig.provider) && typeof modelConfig.provider.npm === "string" ? modelConfig.provider.npm : null
  return override ?? readProviderConfigNpm(providerConfig)
}

function supportedNpm(npm: string | null) {
  return npm !== null && AUTO_ROUTER_SUPPORTED_NPM.some((supported) => supported === npm)
}

function isThinkingLevel(value: string): value is AutoRouterThinkingLevel {
  return AUTO_ROUTER_THINKING_LEVELS.some((level) => level === value)
}

/**
 * Every AI Gateway model the Auto Router can send prompts to: each active
 * provider's catalog models that sit in at least one active model group and
 * whose protocol the gateway can translate an Auto request to.
 */
export async function listAutoRouterOptions(organizationId: OrganizationId): Promise<AutoRouterModelOption[]> {
  if (gatewayManagementUnavailable()) return []
  const providers = await db.select().from(GatewayProviderTable)
    .where(and(eq(GatewayProviderTable.organization_id, organizationId), eq(GatewayProviderTable.status, "active")))
  if (providers.length === 0) return []
  const providerIds = providers.map((provider) => provider.id)
  const [groups, models] = await Promise.all([
    db.select({ id: GatewayModelGroupTable.id }).from(GatewayModelGroupTable)
      .where(and(inArray(GatewayModelGroupTable.gateway_provider_id, providerIds), eq(GatewayModelGroupTable.status, "active"))),
    db.select().from(GatewayProviderModelTable).where(inArray(GatewayProviderModelTable.gateway_provider_id, providerIds)),
  ])
  const links = groups.length === 0 ? [] : await db
    .select({ modelRowId: GatewayModelGroupModelTable.gateway_provider_model_id })
    .from(GatewayModelGroupModelTable)
    .where(inArray(GatewayModelGroupModelTable.model_group_id, groups.map((group) => group.id)))
  const linked = new Set(links.map((link) => link.modelRowId))
  const options: AutoRouterModelOption[] = []
  for (const provider of providers) {
    const seen = new Set<string>()
    for (const model of models) {
      if (model.gateway_provider_id !== provider.id || !linked.has(model.id) || seen.has(model.model_id)) continue
      if (provider.model_ids.length > 0 && !provider.model_ids.includes(model.model_id)) continue
      if (gatewayModelConfigurationError(provider.provider_config, [model.model_config])) continue
      if (!supportedNpm(modelNpm(provider.provider_config, model.model_config))) continue
      seen.add(model.model_id)
      options.push({
        providerId: provider.id,
        modelId: model.model_id,
        providerName: provider.name,
        modelName: model.name,
        logoProviderId: provider.provider_id,
        thinkingLevels: autoRouterThinkingLevels(model.model_id, model.model_config),
      })
    }
  }
  return options.sort((left, right) => left.providerName.localeCompare(right.providerName) || left.modelName.localeCompare(right.modelName))
}

export async function readAutoRouter(organizationId: OrganizationId): Promise<{ enabled: boolean; routes: AutoRouterRoute[] }> {
  const [router] = await db.select().from(AutoRouterTable).where(eq(AutoRouterTable.organizationId, organizationId)).limit(1)
  if (!router) return { enabled: false, routes: [] }
  const rows = await db.select().from(AutoRouterRouteTable)
    .where(and(eq(AutoRouterRouteTable.autoRouterId, router.id), eq(AutoRouterRouteTable.organizationId, organizationId)))
    .orderBy(asc(AutoRouterRouteTable.position))
  // `thinking_levels` is a JSON array from when a route could run at several
  // levels; a route now runs at its first valid one.
  return {
    enabled: router.enabled,
    routes: rows.map((row, index) => ({
      id: row.id,
      providerId: row.gatewayProviderId,
      modelId: row.modelId,
      prompt: index === 0 ? AUTO_ROUTER_DEFAULT_PROMPT : row.prompt,
      thinkingLevel: row.thinkingLevels.find(isThinkingLevel) ?? "default",
      isDefault: index === 0,
    })),
  }
}

export type AutoRouterWriteProblem = { route: number; error: "unknown_model" | "unsupported_thinking_level"; message: string }

/** Checks every route against the organization's models; null when all are valid. */
export function checkAutoRouterWrite(input: AutoRouterWrite, options: AutoRouterModelOption[]): AutoRouterWriteProblem | null {
  for (const [index, route] of input.routes.entries()) {
    const option = options.find((candidate) => candidate.providerId === route.providerId && candidate.modelId === route.modelId)
    if (!option) return { route: index, error: "unknown_model", message: "That model isn't one your AI Gateway offers. Choose one from the list." }
    if (!option.thinkingLevels.includes(route.thinkingLevel)) {
      return { route: index, error: "unsupported_thinking_level", message: `${option.modelName} can't think at the "${route.thinkingLevel}" level.` }
    }
  }
  return null
}

/**
 * Replaces the organization's Auto Router configuration in one transaction.
 * The first route is the default model and always stores the fixed prompt.
 */
export async function saveAutoRouter(input: {
  organizationId: OrganizationId
  memberId: MemberId
  write: AutoRouterWrite
}) {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(AutoRouterTable)
      .where(eq(AutoRouterTable.organizationId, input.organizationId)).for("update").limit(1)
    const routerId = existing?.id ?? createDenTypeId("autoRouter")
    if (existing) {
      await tx.update(AutoRouterTable).set({ enabled: input.write.enabled, updatedByOrgMemberId: input.memberId }).where(eq(AutoRouterTable.id, routerId))
    } else {
      await tx.insert(AutoRouterTable).values({ id: routerId, organizationId: input.organizationId, enabled: input.write.enabled, updatedByOrgMemberId: input.memberId })
    }
    await tx.delete(AutoRouterRouteTable).where(eq(AutoRouterRouteTable.autoRouterId, routerId))
    if (input.write.routes.length > 0) {
      await tx.insert(AutoRouterRouteTable).values(input.write.routes.map((route, position) => ({
        id: createDenTypeId("autoRouterRoute"),
        autoRouterId: routerId,
        organizationId: input.organizationId,
        gatewayProviderId: normalizeDenTypeId("inferenceProvider", route.providerId),
        modelId: route.modelId,
        prompt: position === 0 ? AUTO_ROUTER_DEFAULT_PROMPT : route.prompt ?? "",
        thinkingLevels: [route.thinkingLevel],
        position,
      })))
    }
  })
}

/**
 * Whether this member can use at least one of the organization's routes:
 * an effective grant on the route's provider through an active group that
 * contains the model and an active credential set.
 */
export async function memberCanUseAutoRouter(organizationId: OrganizationId, memberId: MemberId, routes: AutoRouterRoute[]): Promise<boolean> {
  if (routes.length === 0 || gatewayManagementUnavailable()) return false
  const teams = await memberGatewayTeams(db, organizationId, memberId)
  const teamIds = teams.map((team) => team.id)
  for (const providerId of new Set(routes.map((route) => route.providerId))) {
    const rows = await db.select({ grant: GatewayProviderAccessTable, modelId: GatewayProviderModelTable.model_id })
      .from(GatewayProviderAccessTable)
      .innerJoin(GatewayProviderTable, and(eq(GatewayProviderTable.id, GatewayProviderAccessTable.gateway_provider_id), eq(GatewayProviderTable.organization_id, organizationId), eq(GatewayProviderTable.status, "active")))
      .innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.status, "active")))
      .innerJoin(GatewayCredentialSetTable, and(eq(GatewayCredentialSetTable.id, GatewayProviderAccessTable.credential_set_id), eq(GatewayCredentialSetTable.status, "active")))
      .innerJoin(GatewayModelGroupModelTable, eq(GatewayModelGroupModelTable.model_group_id, GatewayModelGroupTable.id))
      .innerJoin(GatewayProviderModelTable, eq(GatewayProviderModelTable.id, GatewayModelGroupModelTable.gateway_provider_model_id))
      .where(eq(GatewayProviderAccessTable.gateway_provider_id, normalizeDenTypeId("inferenceProvider", providerId)))
    const granted = new Set(effectiveGatewayGrants(rows.map((row) => row.grant), memberId, teamIds).map((grant) => grant.id))
    const models = new Set(rows.filter((row) => granted.has(row.grant.id)).map((row) => row.modelId))
    if (routes.some((route) => route.providerId === providerId && models.has(route.modelId))) return true
  }
  return false
}

const ROUTING_CACHE_MS = { known: 60_000, unknown: 10_000 } as const
let routingCache: { state: AutoRouterRoutingState; expires: number } | null = null

/**
 * Asks the AI Gateway whether it has its TypeSafe (Jev) key. Only the gateway
 * holds the key, so Den reads a boolean from its `/auto-router/status`.
 * Cached briefly; `unknown` when the gateway cannot be reached.
 */
export async function readAutoRouterRouting(fetcher: typeof fetch = fetch, now = Date.now()): Promise<AutoRouterRoutingState> {
  if (routingCache && routingCache.expires > now) return routingCache.state
  let state: AutoRouterRoutingState = "unknown"
  try {
    const base = (env.gatewayProxyBaseUrl ?? env.gatewayPublicBaseUrl).replace(/\/+$/, "")
    const response = await fetcher(`${base}/auto-router/status`, { signal: AbortSignal.timeout(2_000), redirect: "error" })
    if (response.ok) {
      const body: unknown = await response.json()
      const configured = typeof body === "object" && body !== null && !Array.isArray(body) ? Reflect.get(body, "routingConfigured") : undefined
      if (typeof configured === "boolean") state = configured ? "ready" : "missing_key"
    } else {
      await response.body?.cancel().catch(() => {})
    }
  } catch (error) {
    console.warn("[auto-router] could not read the gateway's routing status", error instanceof Error ? error.message : error)
  }
  routingCache = { state, expires: now + (state === "unknown" ? ROUTING_CACHE_MS.unknown : ROUTING_CACHE_MS.known) }
  return state
}

/** Test hook. */
export function clearAutoRouterRoutingCache() {
  routingCache = null
}
