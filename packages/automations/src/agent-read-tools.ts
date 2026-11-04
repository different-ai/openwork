import type { AgentToolDecisionReason, AgentToolOverride } from "@openwork/types/den/workbot-proactive"

/**
 * Which of a connection's tools a member's background agent ("Your agent") may call. It only ever reads.
 *
 * Today (`workbotAgentBrief` off) only services with a hand-reviewed list of read tools can be read at all
 * (`reviewedReadTool`). With `workbotAgentBrief` on, any connected connector can be a source, so each tool gets its
 * own decision (`decideAgentReadTool`), in this order:
 *
 *   1. Never a tool its provider marks destructive (`destructiveHint: true`), whoever allowed it. Locked.
 *   2. An admin's choice for this tool on this connection ("Tools agents may use").
 *   3. A service with a reviewed list (Slack, Linear, Notion, GitHub, Granola): exactly its reviewed read tools.
 *   4. The provider's annotations: `readOnlyHint: true` reads, unless the tool's own name or description clearly says
 *      it changes something (a provider labelling `close_ticket` read-only: conflicting signals are a no);
 *      `readOnlyHint: false` doesn't.
 *   5. No annotations: its name and description (`classifyAgentTool`). A clear read verb and nothing that changes
 *      anything; when unsure, no.
 *
 * Den's own providers (Google Workspace, Microsoft 365) have API operations instead of tools: a GET reads, nothing
 * else ever does (`decideNativeReadOperation`).
 *
 * Pure: Den's gateway, the wake that builds a check's token, the pages and the replay evals all use these.
 */

export type AgentReadToolInput = {
  name: string
  title?: string | null
  description?: string | null
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null
}

export type AgentToolDecision = { allowed: boolean; reason: AgentToolDecisionReason; locked: boolean }

/**
 * Tools reviewed as reads, by the service's MCP host (the URL its preset connects to). Moved here unchanged from
 * den-api's agent-read-sources.ts (#6630, "Your agent reads only reviewed tools").
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

/** A reviewed tool is never one whose name says it writes, even if it is listed by mistake (unchanged from #6630). */
const REVIEWED_WRITE_WORDS = /(?:^|[_\-.\s]|[a-z](?=[A-Z]))(send|post|create|update|upsert|delete|remove|write|edit|modify|move|archive|add|set|schedule|reply|draft|upload|invite|share|assign|close|merge|comment|react|publish|trash|cancel|accept|decline|approve|mark|submit|execute|run|trigger)(?=$|[_\-.\s]|[A-Z])/i

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** The reviewed read tools for a connection's service, or null when its service has no reviewed list. */
export function reviewedReadTools(connectionUrl: string): ReadonlySet<string> | null {
  const host = hostOf(connectionUrl)
  return host === null ? null : REVIEWED_READ_TOOLS[host] ?? null
}

/** Whether a connection's service has a reviewed list of read tools (the only sources with the feature off). */
export function hasReviewedReadTools(connectionUrl: string): boolean {
  return reviewedReadTools(connectionUrl) !== null
}

/** With the feature off: a tool we reviewed as a read on this service. Provider hints are never enough. */
export function reviewedReadTool(connectionUrl: string, tool: { name: string }): boolean {
  if (REVIEWED_WRITE_WORDS.test(tool.name)) return false
  return reviewedReadTools(connectionUrl)?.has(tool.name) === true
}

// ---- The classifier: a tool's name and description, when its provider says nothing -------------------------------

/** Verbs that only read. A tool reads only when one of these leads its name (after at most one namespace word). */
const READ_VERBS: ReadonlySet<string> = new Set(["get", "list", "search", "read", "fetch", "query", "find", "describe", "view", "show", "lookup"])

/**
 * Verbs that change something, anywhere in a tool's name ("get_or_create_*", "search_and_replace", "mark_read"). Broad
 * on purpose: a read caught here only needs an admin to allow it; a write that slips through could send, change or
 * delete something.
 */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  "send", "create", "update", "delete", "write", "archive", "move", "invite", "pay", "upsert", "remove", "edit", "modify",
  "add", "assign", "unassign", "merge", "react", "publish", "trash", "cancel", "accept", "decline", "approve", "mark",
  "submit", "execute", "trigger", "replace", "patch", "put", "insert", "deploy", "install", "uninstall", "enable",
  "disable", "grant", "revoke", "rename", "copy", "clone", "fork", "unstar", "follow", "unfollow", "subscribe",
  "unsubscribe", "mute", "unmute", "unpin", "unlock", "reject", "resolve", "reopen", "notify", "broadcast", "forward",
  "snooze", "save", "store", "kill", "purge", "clear", "reset", "rollback", "revert", "restore", "duplicate", "apply",
  "sign", "invoke", "dispatch", "emit", "push", "toggle", "increment", "decrement", "unlike", "attach", "detach",
  "unlink", "leave", "kick", "ban", "unblock", "deny", "dismiss", "acknowledge", "ack", "claim", "convert", "generate",
  "provision", "drop", "truncate", "migrate", "rebase", "tweet", "withdraw", "void", "close", "upload", "restart",
  "transition", "escalate", "rotate", "regenerate", "overwrite",
])

/**
 * Verbs that are also common nouns ("get_email", "list_runs", "get_commit"): a write only when they lead the name
 * ("run_query", "post_message", "slack_post_message").
 */
const LEADING_WRITE_VERBS: ReadonlySet<string> = new Set([
  "post", "run", "draft", "comment", "label", "tag", "message", "email", "text", "call", "order", "link", "block", "book",
  "star", "pin", "lock", "like", "bookmark", "favorite", "schedule", "reply", "share", "set", "export", "import", "commit",
  "release", "transfer", "charge", "refund", "deposit", "capture", "seed", "checkout", "vote", "join", "complete",
  "finish", "sync", "start", "stop",
])

/** A write verb in a description: leading it, or right after "and", "or", "then", "also", "will" or "to". */
const DESCRIPTION_WRITE_VERBS = [
  "send", "create", "update", "delete", "post", "write", "archive", "move", "invite", "pay", "run", "execute", "modify",
  "remove", "replace", "publish", "upload", "submit", "cancel", "mark", "approve", "merge", "close", "edit", "insert",
  "trigger", "reply", "forward", "share", "assign", "add", "set", "schedule", "change", "overwrite", "trash", "purge",
]
const verbForms = DESCRIPTION_WRITE_VERBS.map((verb) => `${verb.replace(/e$/, "")}(?:e|es|ed|ing|s)?`).join("|")
const DESCRIPTION_WRITE = new RegExp(`(?:^|\\b(?:and|or|then|also|will|to)\\s+)(?:${verbForms})\\b`, "i")

/** A tool name's words: split on `_ - . / : space` and camelCase, lowercased. */
export function toolNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-./:]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean)
}

export type AgentToolClass = "read" | "write" | "unclear"

/**
 * What a tool's name and description say it does: `write` when anything in them changes something, `read` when a read
 * verb leads its name, else `unclear`.
 */
export function classifyAgentTool(tool: { name: string; description?: string | null }): AgentToolClass {
  const words = toolNameWords(tool.name)
  if (words.some((word) => WRITE_VERBS.has(word))) return "write"
  const description = tool.description?.trim() ?? ""
  if (description && DESCRIPTION_WRITE.test(description)) return "write"
  // The verb that leads the name: its first word, or its second after a namespace ("notion-search", "slack_post_message").
  const lead = words.slice(0, 2).find((word) => READ_VERBS.has(word) || LEADING_WRITE_VERBS.has(word))
  if (lead === undefined) return "unclear"
  return READ_VERBS.has(lead) ? "read" : "write"
}

// ---- The decision -------------------------------------------------------------------------------------------------

/** Whether one of a connection's tools may be called by a member's agent, why, and whether an admin can change it. */
export function decideAgentReadTool(input: { connectionUrl: string; tool: AgentReadToolInput; override?: AgentToolOverride | null }): AgentToolDecision {
  const { tool } = input
  if (tool.annotations?.destructiveHint === true) return { allowed: false, reason: "destructive", locked: true }
  if (input.override === "allow") return { allowed: true, reason: "admin_allowed", locked: false }
  if (input.override === "deny") return { allowed: false, reason: "admin_denied", locked: false }
  if (hasReviewedReadTools(input.connectionUrl)) {
    return reviewedReadTool(input.connectionUrl, tool) ? { allowed: true, reason: "reviewed", locked: false } : { allowed: false, reason: "not_reviewed", locked: false }
  }
  const kind = classifyAgentTool(tool)
  if (tool.annotations?.readOnlyHint === true) return kind === "write" ? { allowed: false, reason: "write_name", locked: false } : { allowed: true, reason: "marked_read", locked: false }
  if (tool.annotations?.readOnlyHint === false) return { allowed: false, reason: "marked_write", locked: false }
  if (kind === "read") return { allowed: true, reason: "read_name", locked: false }
  return { allowed: false, reason: kind === "write" ? "write_name" : "unclear", locked: false }
}

/** One of Den's own operations: a GET reads (an admin may still turn it off); nothing else ever does. */
export function decideNativeReadOperation(input: { method: string; override?: AgentToolOverride | null }): AgentToolDecision {
  if (input.method.toUpperCase() !== "GET") return { allowed: false, reason: "native_write", locked: true }
  if (input.override === "deny") return { allowed: false, reason: "admin_denied", locked: false }
  return { allowed: true, reason: "native_read", locked: false }
}

/** The names of a connection's tools its agents may call, in the order listed. */
export function allowedAgentReadTools(input: {
  connectionUrl: string
  tools: readonly AgentReadToolInput[]
  overrides?: Readonly<Record<string, AgentToolOverride>> | null
}): string[] {
  return input.tools
    .filter((tool) => decideAgentReadTool({ connectionUrl: input.connectionUrl, tool, override: input.overrides?.[tool.name] ?? null }).allowed)
    .map((tool) => tool.name)
}
