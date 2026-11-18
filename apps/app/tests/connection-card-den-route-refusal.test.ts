import { expect, test } from "bun:test"
import { connectionFromChatToolPart } from "@/components/tools/error-attribution"
import { parseDynamicToolUIPart } from "@/react-app/domains/session/sync/parse-tool-parts"

const status = {
  version: 1, kind: "connection_action", source: "openwork-cloud", layer: "downstream_provider",
  connectionId: "emc_gusto", connectionName: "Gusto", authType: "oauth", credentialMode: "per_member",
  state: "needs_connection", errorCode: "not_connected", message: "You haven't connected your Gusto account yet.",
  actor: "member",
  action: { type: "connect", label: "Connect Gusto", surface: "openwork_your_connections", retry: "search_capabilities" },
}
const error = JSON.stringify({ error: "connection_not_ready", message: "Connect your account before using this MCP's tools.", connectionStatus: status })

test("a Den route refusal that reports its connection shows the connect card", () => {
  const part = parseDynamicToolUIPart({
    id: "p1", callID: "c1", sessionID: "s", messageID: "m", type: "tool", tool: "openwork-cloud_execute_capability",
    state: { status: "error", input: { name: "getMcpConnectionsTools", path: { connectionId: "emc_gusto" } }, error, time: { start: 1, end: 2 } },
  })
  expect(part).not.toBeNull()
  const found = part ? connectionFromChatToolPart(part) : null
  expect(found?.connection.connectionName).toBe("Gusto")
  expect(found?.action).toEqual({ connectionId: "emc_gusto", connectionName: "Gusto", label: "Connect" })
})
