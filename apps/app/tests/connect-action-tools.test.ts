import { expect, test } from "bun:test"
import type { DynamicToolUIPart } from "ai"
import { connectionFromChatToolPart } from "../src/components/tools/error-attribution"
import { isRemoteThreadStatusCheck, remoteThreadFollowUpFromToolPart, remoteThreadFromToolPart } from "../src/lib/remote-session-thread"
import { resolveConnectorToolIdentity, type ConnectorToolIdentity } from "../src/react-app/domains/connections/connector-tool-identity"

/**
 * OpenWork Connect can list every connection action as its own tool
 * (`openwork-cloud_linear_list_issues`) instead of one execute_capability
 * tool. The chat must still name the connector, draw its connection card and
 * follow tasks started on another computer.
 */

function call(toolName: string, input: unknown, output: unknown = "{}"): DynamicToolUIPart {
  return { type: "dynamic-tool", toolCallId: "call_1", toolName, input, state: "output-available", output }
}

function identity(id: string, name: string, connectionId: string | null = null): ConnectorToolIdentity {
  return { id, name, iconUrl: null, serviceUrl: null, toolNamespace: connectionId ? null : name.toLowerCase(), connectionId }
}

const identities = [
  identity("native:google-workspace", "Google Workspace"),
  identity("catalog:linear", "Linear"),
  identity("connection:emc_linear", "Linear", "emc_linear"),
  identity("connection:emc_google", "Google", "emc_google"),
  identity("connection:emc_den", "Den", "emc_den"),
]

test("a per-action Connect tool is attributed to the connection Connect named it after", () => {
  expect(resolveConnectorToolIdentity(call("openwork-cloud_linear_list_issues", {}), identities)?.id).toBe("connection:emc_linear")
  // A second connection of the same name is numbered by Connect.
  expect(resolveConnectorToolIdentity(call("openwork-cloud_linear_2_list_issues", {}), identities)?.id).toBe("connection:emc_linear")
  // The longest matching name owns the tool: "google_workspace_…" is not the "Google" connection's.
  expect(resolveConnectorToolIdentity(
    call("openwork-cloud_google_workspace_getCapabilitiesGoogleWorkspaceCalendarEvents", {}), identities,
  )?.id).toBe("native:google-workspace")
  expect(resolveConnectorToolIdentity(call("openwork-cloud_connection_status", { connection: "linear" }), identities)?.id).toBe("connection:emc_linear")
  expect(resolveConnectorToolIdentity(call("openwork-cloud_connection_status", { connection: "linear_2" }), identities)?.id).toBe("connection:emc_linear")
})

test("OpenWork's own tools are never attributed to a connection", () => {
  for (const toolName of [
    "openwork-cloud_den_postMcpConnectionsCredentialPrompt",
    "openwork-cloud_search_capabilities",
    "openwork-cloud_list_skills",
    "openwork-cloud_remote-session_create",
    "openwork-cloud_run-workflow_stripe_mrr_report",
  ]) expect(resolveConnectorToolIdentity(call(toolName, {}), identities)).toBeNull()
  expect(resolveConnectorToolIdentity(call("openwork-cloud_connection_status", { connection: "notion" }), identities)).toBeNull()
})

const needsSignIn = {
  schemaVersion: "1",
  connectionId: "emc_linear",
  connectionName: "Linear",
  state: "needs_connection",
  actor: "member",
  message: "Sign in to Linear to continue.",
  action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
  authType: "oauth",
  credentialMode: "per_member",
}

test("a per-action tool and connection_status draw the connection card their result reports", () => {
  for (const part of [
    call("openwork-cloud_linear_list_issues", { query: "bugs" }, JSON.stringify({ connectionStatus: needsSignIn })),
    call("openwork-cloud_connection_status", { connection: "linear" }, JSON.stringify(needsSignIn)),
  ]) {
    const found = connectionFromChatToolPart(part)
    expect(found?.connection).toMatchObject({ connectionId: "emc_linear", state: "needs_connection" })
    expect(found?.action).toMatchObject({ connectionId: "emc_linear", label: "Connect" })
  }
  // Another MCP server's tool cannot draw a card with the same payload.
  expect(connectionFromChatToolPart(call("linear_list_issues", {}, JSON.stringify({ connectionStatus: needsSignIn })))).toBeNull()
  // Ordinary discovery stays quiet.
  expect(connectionFromChatToolPart(call("openwork-cloud_search_capabilities", { query: "linear" }, JSON.stringify({ matches: [{ connectionStatus: needsSignIn }] })))).toBeNull()
})

test("remote-session tools start and follow a task like remote-session capabilities", () => {
  const start = remoteThreadFromToolPart(call(
    "openwork-cloud_remote-session_create",
    { target: "registered", computerId: "cmp_fixture", title: "Remote session", prompt: "Summarize the release notes\nfor this week" },
    JSON.stringify({ commandId: "cmd_fixture", sessionId: "ses_fixture", computerId: "cmp_fixture" }),
  ))
  expect(start).toMatchObject({
    key: "command:cmd_fixture", target: "desktop", title: "Summarize the release notes",
    sessionId: "ses_fixture", computerId: "cmp_fixture",
  })

  const followUp = remoteThreadFollowUpFromToolPart(call(
    "openwork-cloud_remote-session_send",
    { sessionId: "ses_fixture", prompt: "Also list the fixes" },
    JSON.stringify({ commandId: "cmd_fixture" }),
  ))
  expect(followUp).toMatchObject({ commandId: "cmd_fixture", sessionId: "ses_fixture" })

  expect(isRemoteThreadStatusCheck(call("openwork-cloud_remote-session_status", { commandIds: ["cmd_fixture"] }))).toBe(true)
  // Only Connect's own remote-session tools count.
  expect(remoteThreadFromToolPart(call(
    "other_remote-session_create", { prompt: "x" }, JSON.stringify({ commandId: "cmd_fixture" }),
  ))).toBeNull()
})
