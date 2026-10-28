import { AGENT_CORE_SOURCES, type AgentCoreSource } from "@openwork/types/den/workbot-proactive"

/**
 * What a member's background agent ("Your agent") may read through Connect. Its turn runs with a read-scoped token
 * (`mcp:read`) that also carries this allowlist as scopes Den alone mints: the core sources that are on
 * (`calendar`, `email`, `chat`) and the connections behind every source it may read.
 *
 * - A plain `mcp:read` token never calls a connection's own tools: provider hints can't prove a tool won't change
 *   anything. An agent token may, but only on its connections and only tools that read: a reviewed list for the
 *   services we know, otherwise a tool its provider marks read-only whose name reads and never writes.
 * - Native Google Workspace and Microsoft 365 reads are limited to the core sources that are on: calendar events,
 *   mail, and Teams chats. Nothing else (files, drafts, sites) and never a non-GET.
 *
 * These scopes are never requested through OAuth or shown to clients; Den adds them when it mints the turn's token.
 */

export const AGENT_READ_SCOPE = "openwork:agent-read"
const SOURCE_SCOPE_PREFIX = "openwork:agent-source:"
const CONNECTION_SCOPE_PREFIX = "openwork:agent-connection:"

export type AgentReadAllowlist = {
  /** Core sources that are on. */
  kinds: ReadonlySet<AgentCoreSource>
  /** Connections the agent may read through, native and external. */
  connectionIds: ReadonlySet<string>
}

function isCoreSource(value: string): value is AgentCoreSource {
  return AGENT_CORE_SOURCES.some((source) => source === value)
}

/** The extra token scopes for an agent turn that may read these sources through these connections. */
export function agentReadScopes(input: { kinds: readonly AgentCoreSource[]; connectionIds: readonly string[] }): string[] {
  return [
    AGENT_READ_SCOPE,
    ...[...new Set(input.kinds)].map((kind) => `${SOURCE_SCOPE_PREFIX}${kind}`),
    ...[...new Set(input.connectionIds)].map((id) => `${CONNECTION_SCOPE_PREFIX}${id}`),
  ]
}

/** The allowlist an agent token carries, or null for every other token (whose rules are unchanged). */
export function agentReadAllowlist(scopes: ReadonlySet<string>): AgentReadAllowlist | null {
  if (!scopes.has(AGENT_READ_SCOPE)) return null
  const kinds = new Set<AgentCoreSource>()
  const connectionIds = new Set<string>()
  for (const scope of scopes) {
    if (scope.startsWith(SOURCE_SCOPE_PREFIX)) {
      const kind = scope.slice(SOURCE_SCOPE_PREFIX.length)
      if (isCoreSource(kind)) kinds.add(kind)
    } else if (scope.startsWith(CONNECTION_SCOPE_PREFIX)) {
      const id = scope.slice(CONNECTION_SCOPE_PREFIX.length)
      if (id) connectionIds.add(id)
    }
  }
  return { kinds, connectionIds }
}

/** Which core source a native capability reads, from its route; null for anything else (files, drafts, sites…). */
export function nativeSourceKind(path: string): AgentCoreSource | null {
  const resource = path.replace(/^\/v1\/capabilities\/[^/]+\//, "").split("/")[0] ?? ""
  if (resource === "calendar-event" || resource === "calendar-events") return "calendar"
  if (resource.startsWith("gmail-message") || resource.startsWith("gmail-attachment") || resource.startsWith("mail-message") || resource.startsWith("mail-attachment")) return "email"
  if (resource === "teams-chats") return "chat"
  return null
}

/** A native capability the agent may call: a GET on one of its connections, for a core source that is on. */
export function agentMayUseNative(allowlist: AgentReadAllowlist, connectionId: string, operation: { method: string; path: string }): boolean {
  if (operation.method.toUpperCase() !== "GET" || !allowlist.connectionIds.has(connectionId)) return false
  const kind = nativeSourceKind(operation.path)
  return kind !== null && allowlist.kinds.has(kind)
}

/**
 * Tools reviewed as reads, by the service's MCP host. Only names here or tools that pass `looksLikeRead` are callable,
 * and never one whose name says it writes.
 */
const REVIEWED_READ_TOOLS: Record<string, ReadonlySet<string>> = {
  "mcp.slack.com": new Set([
    "slack_search_public", "slack_search_public_and_private", "slack_read_channel", "slack_read_thread", "slack_read_canvas",
    "slack_read_file", "slack_read_user_profile", "slack_search_users", "slack_search_channels", "slack_get_reactions",
    "slack_list_channel_members",
  ]),
  "mcp.linear.app": new Set([
    "list_issues", "get_issue", "list_my_issues", "list_comments", "list_projects", "get_project", "list_teams", "get_team",
    "list_users", "get_user", "list_cycles", "list_documents", "get_document", "list_issue_statuses", "list_issue_labels",
    "search_documentation",
  ]),
  "mcp.notion.com": new Set(["notion-search", "notion-fetch", "notion-get-comments", "notion-get-users", "notion-get-user", "notion-get-self", "notion-get-teams"]),
  "api.githubcopilot.com": new Set([
    "get_me", "get_issue", "list_issues", "search_issues", "issue_read", "get_issue_comments", "get_pull_request", "list_pull_requests",
    "search_pull_requests", "pull_request_read", "get_pull_request_comments", "list_notifications", "get_notification_details",
    "get_file_contents", "search_code", "list_commits", "get_commit",
  ]),
  "mcp.granola.ai": new Set(["list_meetings", "get_meetings", "get_meeting", "get_meeting_transcript", "query_granola_meetings", "search_meetings"]),
}

const WRITE_WORDS = /(?:^|[_\-.\s]|[a-z](?=[A-Z]))(send|post|create|update|upsert|delete|remove|write|edit|modify|move|archive|add|set|schedule|reply|draft|upload|invite|share|assign|close|merge|comment|react|publish|trash|cancel|accept|decline|approve|mark|submit|execute|run|trigger)(?=$|[_\-.\s]|[A-Z])/i
const READ_WORDS = /(?:^|[_\-.\s]|[a-z](?=[A-Z]))(get|list|search|read|fetch|find|query|lookup|view|describe|retrieve|show)(?=$|[_\-.\s]|[A-Z])/i

/** A tool its provider marks read-only (and not destructive) whose name reads and never writes. */
function looksLikeRead(tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true && READ_WORDS.test(tool.name) && !WRITE_WORDS.test(tool.name)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Whether a connection's tool only reads, by the rules above. */
export function agentReadTool(connectionUrl: string, tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): boolean {
  if (WRITE_WORDS.test(tool.name)) return false
  const host = hostOf(connectionUrl)
  if (host && REVIEWED_READ_TOOLS[host]?.has(tool.name)) return true
  return looksLikeRead(tool)
}

/** An external tool the agent may call: one of its connections, and a tool that only reads. */
export function agentMayUseExternalTool(
  allowlist: AgentReadAllowlist,
  connection: { id: string; url: string },
  tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } },
): boolean {
  return allowlist.connectionIds.has(connection.id) && agentReadTool(connection.url, tool)
}

export const AGENT_SOURCE_BLOCKED_MESSAGE = "Your agent may only read the sources its member turned on, and only tools that read."
