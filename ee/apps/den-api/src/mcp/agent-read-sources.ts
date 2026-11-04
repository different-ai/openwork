import { AGENT_CORE_SOURCES, type AgentCoreSource } from "@openwork/types/den/workbot-proactive"
import { hasReviewedReadTools, reviewedReadTool } from "@openwork/automations/agent-read-tools"

/**
 * What a member's background agent ("Your agent") may read through Connect. Its turn runs with a read-scoped token
 * (`mcp:read`) that also carries this allowlist as scopes Den alone mints: the core sources that are on
 * (`calendar`, `email`, `chat`) and the connections behind every source it may read.
 *
 * - A plain `mcp:read` token never calls a connection's own tools: provider hints can't prove a tool won't change
 *   anything. An agent token may, but only on its connections and only tools we reviewed as reads, per service
 *   (`REVIEWED_READ_TOOLS`). A service without a reviewed list can't be a source at all; its provider's hints and tool
 *   names never make a tool callable.
 * - Native Google Workspace and Microsoft 365 reads are limited to the core sources that are on: calendar events,
 *   mail, and Teams chats. Nothing else (files, drafts, sites) and never a non-GET.
 *
 * With `workbotAgentBrief` (a check's token carries `openwork:agent-tools`), any connection can be a source and the
 * token carries the exact tools its check may call per connection, decided when the check starts
 * (`decideAgentReadTool` in @openwork/automations): an admin's choice, a reviewed list, the provider's annotations, then
 * the tool's name. Never one its provider marks destructive, even if it was allowed when the check started. Den's own
 * providers may also be read outside calendar, mail and chat: any GET, except operations an admin turned off.
 *
 * These scopes are never requested through OAuth or shown to clients; Den adds them when it mints the turn's token.
 */

export const AGENT_READ_SCOPE = "openwork:agent-read"
const SOURCE_SCOPE_PREFIX = "openwork:agent-source:"
const CONNECTION_SCOPE_PREFIX = "openwork:agent-connection:"
/** `openwork:agent-core:<kind>:<connectionId>`: one core source, read through one connection. */
const CORE_SCOPE_PREFIX = "openwork:agent-core:"
/** `workbotAgentBrief`: the token carries each connection's tools; without it, the reviewed lists decide. */
export const AGENT_TOOLS_SCOPE = "openwork:agent-tools"
/** `openwork:agent-tool:<connectionId>:<tool name, URI-encoded>`: one tool the check may call. */
const TOOL_SCOPE_PREFIX = "openwork:agent-tool:"
/** `openwork:agent-native:<connectionId>`: Den's own provider, read outside calendar, mail and chat. */
const NATIVE_SCOPE_PREFIX = "openwork:agent-native:"
/** `openwork:agent-native-deny:<connectionId>:<operation name>`: one of its reads an admin turned off. */
const NATIVE_DENY_SCOPE_PREFIX = "openwork:agent-native-deny:"

export type AgentReadAllowlist = {
  /** Core sources that are on. */
  kinds: ReadonlySet<AgentCoreSource>
  /** Connections the agent may read through, native and external. */
  connectionIds: ReadonlySet<string>
  /** `<kind>:<connectionId>`: which core source each native connection may be read for. */
  pairs: ReadonlySet<string>
  /**
   * `workbotAgentBrief`: per connection, the tools the check may call. Null or absent on any other agent token: the
   * reviewed lists decide.
   */
  tools?: ReadonlyMap<string, ReadonlySet<string>> | null
  /** `workbotAgentBrief`: Den's own providers read outside calendar, mail and chat, with the operations turned off. */
  nativeReads?: ReadonlyMap<string, ReadonlySet<string>>
}

function isCoreSource(value: string): value is AgentCoreSource {
  return AGENT_CORE_SOURCES.some((source) => source === value)
}

function pairKey(kind: AgentCoreSource, connectionId: string) {
  return `${kind}:${connectionId}`
}

/**
 * The extra token scopes for an agent turn that may read these sources through these connections. `tools` (with
 * `workbotAgentBrief`, even empty) carries the exact tools per connection; `nativeReads`, Den's own providers read
 * outside calendar, mail and chat.
 */
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

/** `<connectionId>:<encoded name>` back to its parts; null when malformed. */
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

/** The allowlist an agent token carries, or null for every other token (whose rules are unchanged). */
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
  // A denial only narrows a native read the token grants.
  for (const [id, denied] of nativeDenied) if (nativeReads.has(id)) nativeReads.set(id, denied)
  return { kinds, connectionIds, pairs, tools, nativeReads }
}

/** Which core source a native capability reads, from its route; null for anything else (files, drafts, sites…). */
export function nativeSourceKind(path: string): AgentCoreSource | null {
  const resource = path.replace(/^\/v1\/capabilities\/[^/]+\//, "").split("/")[0] ?? ""
  if (resource === "calendar-event" || resource === "calendar-events") return "calendar"
  if (resource.startsWith("gmail-message") || resource.startsWith("gmail-attachment") || resource.startsWith("mail-message") || resource.startsWith("mail-attachment")) return "email"
  if (resource === "teams-chats") return "chat"
  return null
}

/**
 * A native capability the agent may call: a GET on one of its connections, for a core source read through that
 * connection, or (`workbotAgentBrief`) any other read on a provider it reads outside calendar, mail and chat that an
 * admin didn't turn off.
 */
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

/**
 * With the feature off, whether agents can read through a connection at all: its service has a reviewed list of read
 * tools (@openwork/automations/agent-read-tools).
 */
export function agentReadableConnection(connectionUrl: string): boolean {
  return hasReviewedReadTools(connectionUrl)
}

/** With the feature off, whether a connection's tool is one we reviewed as a read. Provider hints are never enough. */
export function agentReadTool(connectionUrl: string, tool: { name: string }): boolean {
  return reviewedReadTool(connectionUrl, tool)
}

/**
 * Where a message may link when it drew on a connection: the service's own site, by its reviewed host. Never derived
 * from a hostname (a public suffix like co.uk would let any site through).
 */
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

/**
 * An external tool the agent may call: one of its connections, and a tool that only reads: one of the tools its token
 * carries for that connection (`workbotAgentBrief`), never one its provider now marks destructive; else a reviewed read.
 */
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
