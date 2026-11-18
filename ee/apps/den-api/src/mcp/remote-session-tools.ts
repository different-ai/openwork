import { READ_ONLY_REMOTE_SESSION_ACTIONS } from "./connect-full-tool-sources.js"
import { REMOTE_SESSION_TOOL_NAMESPACE, type ConnectFullTool } from "./connect-full-tools.js"
import { listRemoteSessionCapabilities } from "./remote-session-capabilities.js"
import { withSafetyHints } from "./tool-labels.js"

/**
 * `mcpThreads`: the remote-session actions as tools of their own in the
 * search view, for clients other than OpenWork's own (Claude, ChatGPT and any
 * other MCP client), so a person can start and follow a session without the
 * model first searching for the capability.
 *
 * Names use letters, digits and underscores only (`remote_session_create`):
 * the full view's `remote-session.create` has a dot, which model APIs that
 * take a tool list directly do not accept in a name. Each tool runs the same
 * capability through the executor execute_capability uses.
 */
export function remoteSessionDirectTools(options: { answer?: boolean; attach?: boolean }): ConnectFullTool[] {
  return listRemoteSessionCapabilities(options).map((capability) => ({
    namespace: REMOTE_SESSION_TOOL_NAMESPACE,
    toolName: capability.action,
    capability: capability.name,
    name: `remote_session_${capability.action}`,
    title: `Remote session: ${capability.action}`,
    description: capability.summary,
    inputSchema: capability.argumentsSchema,
    annotations: withSafetyHints({ readOnlyHint: READ_ONLY_REMOTE_SESSION_ACTIONS.has(capability.action) }),
  }))
}
