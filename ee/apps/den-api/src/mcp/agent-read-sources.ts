import { AGENT_CORE_SOURCES, type AgentCoreSource } from "@openwork/types/den/workbot-proactive"
import { hasReviewedReadTools, reviewedReadTool } from "@openwork/automations/agent-read-tools"

export const AGENT_READ_SCOPE = "openwork:agent-read"
const SOURCE_SCOPE_PREFIX = "openwork:agent-source:"
const CONNECTION_SCOPE_PREFIX = "openwork:agent-connection:"
const CORE_SCOPE_PREFIX = "openwork:agent-core:"
export const AGENT_TOOLS_SCOPE = "openwork:agent-tools"
const TOOL_SCOPE_PREFIX = "openwork:agent-tool:"
const NATIVE_SCOPE_PREFIX = "openwork:agent-native:"
const NATIVE_DENY_SCOPE_PREFIX = "openwork:agent-native-deny:"

export type AgentReadAllowlist = {
  kinds: ReadonlySet<AgentCoreSource>
  connectionIds: ReadonlySet<string>
  pairs: ReadonlySet<string>
  tools?: ReadonlyMap<string, ReadonlySet<string>> | null
  nativeReads?: ReadonlyMap<string, ReadonlySet<string>>
}

function isCoreSource(value: string): value is AgentCoreSource {
  return AGENT_CORE_SOURCES.some((source) => source === value)
}

function pairKey(kind: AgentCoreSource, connectionId: string) {
  return `${kind}:${connectionId}`
}

export function agentReadScopes(input: {
  kinds: readonly AgentCoreSource[]
  connectionIds: readonly string[]
  pairs?: readonly { kind: AgentCoreSource; connectionId: string }[]
  tools?: readonly { connectionId: string; names: readonly string[] }[]
  nativeReads?: readonly { connectionId: string; denied: readonly string[] }[]
}): string[] {
  const perTool = input.tools !== undefined || input.nativeReads !== undefined
  return [
    AGENT_READ_SCOPE,
    ...[...new Set(input.kinds)].map((kind) => `${SOURCE_SCOPE_PREFIX}${kind}`),
    ...[...new Set(input.connectionIds)].map((id) => `${CONNECTION_SCOPE_PREFIX}${id}`),
    ...[...new Set((input.pairs ?? []).map((pair) => pairKey(pair.kind, pair.connectionId)))].map((key) => `${CORE_SCOPE_PREFIX}${key}`),
    ...(perTool ? [AGENT_TOOLS_SCOPE] : []),
    ...[...new Set((input.tools ?? []).flatMap((entry) => entry.names.map((name) => `${TOOL_SCOPE_PREFIX}${entry.connectionId}:${encodeURIComponent(name)}`)))],
    ...(input.nativeReads ?? []).flatMap((entry) => [
      `${NATIVE_SCOPE_PREFIX}${entry.connectionId}`,
      ...[...new Set(entry.denied)].map((name) => `${NATIVE_DENY_SCOPE_PREFIX}${entry.connectionId}:${encodeURIComponent(name)}`),
    ]),
  ]
}

function splitToolScope(rest: string): { connectionId: string; name: string } | null {
  const split = rest.indexOf(":")
  if (split <= 0) return null
  try {
    const name = decodeURIComponent(rest.slice(split + 1))
    return name ? { connectionId: rest.slice(0, split), name } : null
  } catch {
    return null
  }
}

function addTo(map: Map<string, Set<string>>, key: string, value?: string) {
  const set = map.get(key) ?? new Set<string>()
  if (value !== undefined) set.add(value)
  map.set(key, set)
}

export function agentReadAllowlist(scopes: ReadonlySet<string>): AgentReadAllowlist | null {
  if (!scopes.has(AGENT_READ_SCOPE)) return null
  const kinds = new Set<AgentCoreSource>()
  const connectionIds = new Set<string>()
  const pairs = new Set<string>()
  const tools = scopes.has(AGENT_TOOLS_SCOPE) ? new Map<string, Set<string>>() : null
  const nativeReads = new Map<string, Set<string>>()
  const nativeDenied = new Map<string, Set<string>>()
  for (const scope of scopes) {
    if (scope.startsWith(SOURCE_SCOPE_PREFIX)) {
      const kind = scope.slice(SOURCE_SCOPE_PREFIX.length)
      if (isCoreSource(kind)) kinds.add(kind)
    } else if (scope.startsWith(CONNECTION_SCOPE_PREFIX)) {
      const id = scope.slice(CONNECTION_SCOPE_PREFIX.length)
      if (id) connectionIds.add(id)
    } else if (scope.startsWith(CORE_SCOPE_PREFIX)) {
      const rest = scope.slice(CORE_SCOPE_PREFIX.length)
      const split = rest.indexOf(":")
      const kind = split > 0 ? rest.slice(0, split) : ""
      const id = split > 0 ? rest.slice(split + 1) : ""
      if (isCoreSource(kind) && id) pairs.add(pairKey(kind, id))
    } else if (tools && scope.startsWith(TOOL_SCOPE_PREFIX)) {
      const tool = splitToolScope(scope.slice(TOOL_SCOPE_PREFIX.length))
      if (tool) addTo(tools, tool.connectionId, tool.name)
    } else if (tools && scope.startsWith(NATIVE_DENY_SCOPE_PREFIX)) {
      const denied = splitToolScope(scope.slice(NATIVE_DENY_SCOPE_PREFIX.length))
      if (denied) addTo(nativeDenied, denied.connectionId, denied.name)
    } else if (tools && scope.startsWith(NATIVE_SCOPE_PREFIX)) {
      const id = scope.slice(NATIVE_SCOPE_PREFIX.length)
      if (id) addTo(nativeReads, id)
    }
  }
  for (const [id, denied] of nativeDenied) if (nativeReads.has(id)) nativeReads.set(id, denied)
  return { kinds, connectionIds, pairs, tools, nativeReads }
}

export function nativeSourceKind(path: string): AgentCoreSource | null {
  const resource = path.replace(/^\/v1\/capabilities\/[^/]+\//, "").split("/")[0] ?? ""
  if (resource === "calendar-event" || resource === "calendar-events") return "calendar"
  return null
}

export function agentMayUseNative(allowlist: AgentReadAllowlist, connectionId: string, operation: { method: string; path: string; name?: string }): boolean {
  if (operation.method.toUpperCase() !== "GET" || !allowlist.connectionIds.has(connectionId)) return false
  const kind = nativeSourceKind(operation.path)
  if (kind !== null) return allowlist.kinds.has(kind) && allowlist.pairs.has(pairKey(kind, connectionId))
  const denied = allowlist.nativeReads?.get(connectionId)
  return denied !== undefined && !(operation.name !== undefined && denied.has(operation.name))
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function agentReadableConnection(connectionUrl: string): boolean {
  return hasReviewedReadTools(connectionUrl)
}

export function agentReadTool(connectionUrl: string, tool: { name: string }): boolean {
  return reviewedReadTool(connectionUrl, tool)
}

const SERVICE_LINK_DOMAINS: Record<string, readonly string[]> = {
  "mcp.slack.com": ["slack.com"],
  "mcp.linear.app": ["linear.app"],
  "mcp.notion.com": ["notion.so", "notion.com"],
  "api.githubcopilot.com": ["github.com"],
  "mcp.granola.ai": ["granola.ai"],
}

export function serviceLinkDomains(connectionUrl: string): readonly string[] {
  const host = hostOf(connectionUrl)
  return host ? SERVICE_LINK_DOMAINS[host] ?? [] : []
}

export function agentMayUseExternalTool(
  allowlist: AgentReadAllowlist,
  connection: { id: string; url: string },
  tool: { name: string; annotations?: { destructiveHint?: boolean } | null },
): boolean {
  if (!allowlist.connectionIds.has(connection.id)) return false
  if (!allowlist.tools) return agentReadTool(connection.url, tool)
  return allowlist.tools.get(connection.id)?.has(tool.name) === true && tool.annotations?.destructiveHint !== true
}

export const AGENT_SOURCE_BLOCKED_MESSAGE = "Your agent may only read the sources its member turned on, and only tools that read."
