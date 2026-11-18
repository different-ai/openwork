import { getOrganizationFeatures } from "../features.js"
import { eventThreadForPrincipal } from "../mcp-events/context.js"
import { MAX_SUBSCRIPTION_TTL_MS } from "../mcp-events/protocol.js"
import { SESSION_EVENT } from "../native-mcp-events/protocol.js"
import { subscribeNativeThread } from "../native-mcp-events/thread.js"
import { appLogger } from "../observability/logger.js"
import type { McpPrincipal } from "./auth.js"
import type { RemoteSessionToolResult } from "./remote-session-capabilities.js"

/** The saved instruction of a watch Den starts for a hosted chat; one text, so a follow-up reuses the watch. */
export const FOLLOW_REMOTE_SESSION_INSTRUCTION = "A remote session this chat started changed. Read it with remote-session:read, then tell the person its result, its error, or the question it waits on. Ask the person before answering a question or approving a permission."

const WATCHED_NOTE = "This chat gets a new turn when the session finishes, fails or needs an answer. Tell the person the task has started, then end your turn; do not wait for it or poll its status."
const EVENT_NOTE = "To hear about changes without polling, subscribe to event (MCP Events) where your client supports it; otherwise call remote-session:status with waitMs."

/**
 * `mcpThreads`: after a session is started or continued, say how the caller
 * hears about its changes instead of leaving it to poll.
 *
 * A hosted chat is watched at once (with `mcpThreadEvents`): the session's
 * next settled state becomes a turn in that chat, through the same watch the
 * chat's own subscribe tool makes. Any other client gets the event to
 * subscribe to. Never fails the call: the session has already started.
 */
export async function followRemoteSession(input: {
  principal: McpPrincipal
  organizationId: string
  action: string
  result: RemoteSessionToolResult
}): Promise<RemoteSessionToolResult> {
  const payload = input.result.structuredContent
  // A Slack run already has its result posted in the thread.
  if ((input.action !== "create" && input.action !== "send") || input.result.isError || !payload || payload.resultPostedInThread) return input.result
  const reference = typeof payload.commandId === "string" ? { commandId: payload.commandId }
    : typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : null
  if (!reference) return input.result
  const features = await getOrganizationFeatures(input.organizationId, { userId: input.principal.userId })
  if (!features.mcpThreads || !features.nativeMcpEvents) return input.result
  const withFields = (fields: Record<string, unknown>): RemoteSessionToolResult => {
    const next = { ...payload, ...fields }
    return { ...input.result, content: [{ type: "text", text: JSON.stringify(next) }], structuredContent: next }
  }
  const thread = features.mcpThreadEvents ? await eventThreadForPrincipal(input.principal) : null
  if (!thread) return withFields({ event: { name: SESSION_EVENT, arguments: reference, delivery: ["webhook", "poll"] }, note: [payload.note, EVENT_NOTE].filter(Boolean).join(" ") })
  try {
    const watch = await subscribeNativeThread(thread, [...input.principal.scopes], { name: SESSION_EVENT, arguments: reference, instruction: FOLLOW_REMOTE_SESSION_INSTRUCTION, ttlMs: MAX_SUBSCRIPTION_TTL_MS })
    return withFields({ watch: { id: watch.id, expiresAt: watch.expiresAt }, note: `${WATCHED_NOTE} The watch ends at ${watch.expiresAt}; after that, use remote-session:status.` })
  } catch (error) {
    // Ten watches, a session that is not readable yet, or the runner being away: the chat follows it as before.
    appLogger.warn("remote_session_follow_failed", { component: "mcp_threads", error: error instanceof Error ? error.message : "unknown" })
    return input.result
  }
}
