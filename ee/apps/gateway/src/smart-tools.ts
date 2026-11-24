import { autoRouterIdFromModel, autoRouterModelName } from "@openwork/types/den/auto-router"
import { isSmartRouterToolName, matchSmartRouter, parseClaudeCodeModelName, smartRouterToolName } from "@openwork/types/den/gateway-cursor"
import { isJsonObject, type JsonObject } from "@openwork-ee/gateway-protocols"
import type { AutoRouterConfig, LoadMemberAutoRouters } from "./auto-router/config.js"
import { autoCandidates, autoRouterError, type RoutedCandidate } from "./auto-router/handler.js"
import type { GatewayContext } from "./middleware/gateway-auth.js"
import type { GatewayMemberAccessRow } from "./provider-access.js"
import type { ProviderCatalog } from "@openwork-ee/gateway-catalog"

export type SmartToolDependencies = {
  routingConfigured: boolean
  loadMemberAutoRouters: LoadMemberAutoRouters
  route: (input: { request: Request; body: JsonObject; routerId: string }) => Promise<Response>
}

export type SmartToolRouter = {
  id: string
  routerName: string
  name: string
  toolName: string
  candidates: RoutedCandidate[]
}

async function memberRouters(identity: GatewayContext, smart: SmartToolDependencies): Promise<AutoRouterConfig[]> {
  if (!smart.routingConfigured || !identity.orgMembershipId) return []
  return smart.loadMemberAutoRouters({ organizationId: identity.organizationId, memberId: identity.orgMembershipId })
}

export async function smartToolRouters(identity: GatewayContext, rows: GatewayMemberAccessRow[], catalog: ProviderCatalog, smart: SmartToolDependencies | undefined): Promise<SmartToolRouter[]> {
  if (!smart) return []
  const routers: SmartToolRouter[] = []
  for (const config of await memberRouters(identity, smart)) {
    const candidates = autoCandidates(config, rows, catalog)
    if (candidates.length === 0) continue
    routers.push({
      id: config.id,
      routerName: config.name,
      name: autoRouterModelName(config.name),
      toolName: smartRouterToolName({ routerName: config.name, routerId: config.id }),
      candidates,
    })
  }
  return routers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export type SmartResolution =
  | { kind: "router"; routerId: string }
  | { kind: "unavailable"; error: () => Response }
  | { kind: "none" }

export async function resolveSmartRouter(requested: unknown, identity: GatewayContext, smart: SmartToolDependencies | undefined): Promise<SmartResolution> {
  if (!smart) return { kind: "none" }
  const direct = autoRouterIdFromModel(requested)
  if (direct) return { kind: "router", routerId: direct }
  const parsed = parseClaudeCodeModelName(requested)
  if (!parsed || !isSmartRouterToolName(parsed)) return { kind: "none" }
  if (!smart.routingConfigured) return { kind: "unavailable", error: () => autoRouterError("notConfigured") }
  const match = matchSmartRouter(parsed, await memberRouters(identity, smart))
  if (match.kind === "found") return { kind: "router", routerId: match.model.id }
  return { kind: "unavailable", error: () => autoRouterError("unavailable") }
}

export function smartContextWindow(router: SmartToolRouter): number | null {
  let smallest: number | null = null
  for (const candidate of router.candidates) {
    const limit = candidate.row.model?.model_config.limit
    const context = isJsonObject(limit) ? limit.context : null
    if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) return null
    smallest = smallest === null ? context : Math.min(smallest, context)
  }
  return smallest
}

export function smartAcceptsImages(router: SmartToolRouter): boolean {
  return router.candidates.every((candidate) => {
    const modalities = candidate.row.model?.model_config.modalities
    const input = isJsonObject(modalities) ? modalities.input : null
    return Array.isArray(input) ? input.includes("image") : true
  })
}
