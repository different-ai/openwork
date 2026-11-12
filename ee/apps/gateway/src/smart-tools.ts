// Smart Routers on the 3rd party tool endpoints: Cursor,
// Claude Code and Codex list each router that applies to the member
// as `openwork/smart-<router name>-<end of its id>` (packages/types/src/den/gateway-cursor.ts), and a
// request naming one runs the Smart Model Router (auto-router/handler.ts) with the request read as
// Chat Completions; each endpoint writes the answer back in its own protocol.
import { autoRouterIdFromModel, autoRouterModelName } from "@openwork/types/den/auto-router"
import { isSmartRouterToolName, matchSmartRouter, parseClaudeCodeModelName, smartRouterToolName } from "@openwork/types/den/gateway-cursor"
import { isJsonObject, type JsonObject } from "./auto-router/chat.js"
import type { AutoRouterConfig, LoadMemberAutoRouters } from "./auto-router/config.js"
import { autoCandidates, autoRouterError, type RoutedCandidate } from "./auto-router/handler.js"
import type { GatewayContext } from "./middleware/gateway-auth.js"
import type { GatewayMemberAccessRow } from "./provider-access.js"
import type { ProviderCatalog } from "./provider-catalog.js"

export type SmartToolDependencies = {
  /** False when the Gateway has no TypeSafe key: Smart is then off and nothing is listed. */
  routingConfigured: boolean
  loadMemberAutoRouters: LoadMemberAutoRouters
  /** Runs the Smart Model Router on a Chat Completions request; answers as Chat Completions. */
  route: (input: { request: Request; body: JsonObject; routerId: string }) => Promise<Response>
}

/** A router the member can use through a tool, with the models Smart may send their prompts to. */
export type SmartToolRouter = {
  id: string
  /** The router's own name, such as "Engineering". */
  routerName: string
  /** How pickers show it: "Smart: Engineering". */
  name: string
  /** The name tools send: `openwork/smart-engineering-x7q2`. */
  toolName: string
  candidates: RoutedCandidate[]
}

async function memberRouters(identity: GatewayContext, smart: SmartToolDependencies): Promise<AutoRouterConfig[]> {
  if (!smart.routingConfigured || !identity.orgMembershipId) return []
  return smart.loadMemberAutoRouters({ organizationId: identity.organizationId, memberId: identity.orgMembershipId })
}

/**
 * The routers a model list shows: those that apply to the member and have at least one model the
 * member can use right now. One router read per list; the access rows are the list's own.
 */
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

/**
 * What a requested model means for Smart: a router (by its tool name or `openwork-smart-<id>`), a
 * Smart-shaped name that matches none of the member's routers (`unavailable`, with Smart's own
 * error to answer with when no model matches either), or nothing Smart.
 */
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

/** The smallest context window among a router's models, when every one of them says. */
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

/** Whether every model a router may pick reads images. */
export function smartAcceptsImages(router: SmartToolRouter): boolean {
  return router.candidates.every((candidate) => {
    const modalities = candidate.row.model?.model_config.modalities
    const input = isJsonObject(modalities) ? modalities.input : null
    return Array.isArray(input) ? input.includes("image") : true
  })
}
