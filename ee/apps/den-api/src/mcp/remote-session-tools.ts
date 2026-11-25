import { REMOTE_SESSION_TOOL_NAMESPACE, type ConnectFullTool } from "./connect-full-tools.js"
import { listRemoteSessionCapabilities } from "./remote-session-capabilities.js"
import { withSafetyHints } from "./tool-labels.js"

const READ_ONLY_REMOTE_SESSION_ACTIONS = new Set(["read", "list", "targets", "status"])

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
