import { describe, expect, test } from "bun:test"

import {
  attributeChatToolError,
  describeChatToolFailure,
  connectionCardPayloadFromChatToolResult,
  connectionResultFromChatToolPart,
  reconnectActionFromChatToolResult,
} from "../src/components/tools/error-attribution"
import { normalizeErrorText } from "../src/lib/error-text"

test("tool failure summaries keep raw transport text in details and preserve uncertain-outcome guidance", () => {
  const timeout = describeChatToolFailure('Streamable HTTP error: {"diagnostic":{"httpStatus":504}}')
  expect(timeout).toContain("Check whether the action finished")
  expect(timeout).not.toContain("Streamable")
  expect(describeChatToolFailure("access_denied HTTP 403")).toContain("doesn’t have access")
  expect(describeChatToolFailure("invalid_token HTTP 401")).toContain("sign-in settings")
  expect(describeChatToolFailure("Internal server error HTTP 500")).toContain("service couldn’t complete")
  expect(describeChatToolFailure("arbitrary raw engine stack\n at file:123")).not.toContain("file:123")
})

function reconnectStatus(connectionId = "emc_knowledge", connectionName = "Knowledge Hub") {
  return {
    version: 1,
    kind: "connection_action",
    source: "openwork-cloud",
    connectionId,
    connectionName,
    authType: "oauth",
    credentialMode: "per_member",
    state: "reauth_required",
    actor: "member",
    action: {
      type: "reconnect",
      surface: "openwork_your_connections",
      retry: "search_capabilities",
      label: "Reconnect in Your Connections",
    },
  }
}

const connectionPayload = {
  schemaVersion: "1",
  connectionId: "emc_knowledge",
  connectionName: "Knowledge Hub",
  state: "needs_connection",
  actor: "member",
  message: "Connect your account to continue.",
  action: { type: "connect", label: "Connect Knowledge Hub", surface: "openwork_your_connections" },
}

describe("chat tool error attribution", () => {
  test("uses the same native action for search attachments and standalone status results", () => {
    for (const { toolName, payload } of [
      { toolName: "openwork-cloud_search_capabilities", payload: { connectionAction: connectionPayload } },
      { toolName: "openwork-cloud_execute_capability", payload: connectionPayload },
      { toolName: "openwork-cloud_connection_action", payload: connectionPayload },
    ]) {
      for (const result of [payload, JSON.stringify(payload)]) {
        expect(connectionCardPayloadFromChatToolResult(toolName, result, { intent: "connect" })).toEqual(connectionPayload)
        expect(reconnectActionFromChatToolResult(toolName, result, { intent: "connect" })).toEqual({
          connectionId: "emc_knowledge", connectionName: "Knowledge Hub", label: "Connect",
        })
      }
    }
  })

  test("preserves connection recovery for first-party live app runs", () => {
    for (const prefix of ["openwork_", "openwork-cloud_"]) {
      const toolName = `${prefix}run_artifact_arv_fixture`
      const result = connectionResultFromChatToolPart({
        type: "dynamic-tool", toolName, toolCallId: "app-reconnect", state: "output-available",
        input: {}, output: { error: "needs_connection" },
        callProviderMetadata: { openwork: { mcpResult: { content: [], structuredContent: connectionPayload } } },
      })
      expect(connectionCardPayloadFromChatToolResult(toolName, result)).toEqual(connectionPayload)
      expect(reconnectActionFromChatToolResult(toolName, result)?.label).toBe("Connect")
    }
    for (const toolName of ["foreign_run_artifact_arv_fixture", "openwork-cloud_run_artifact_"]) {
      expect(connectionCardPayloadFromChatToolResult(toolName, connectionPayload)).toBeNull()
    }
  })

  test("keeps connected and admin states native without offering member authorization", () => {
    const connected = { ...connectionPayload, state: "connected", actor: null, action: null }
    const admin = { ...connectionPayload, actor: "organization_admin", action: {
      type: "update_credentials", label: "Ask an admin", surface: "openwork_organization_connections",
    } }
    for (const payload of [connected, admin]) {
      expect(connectionCardPayloadFromChatToolResult("openwork-cloud_execute_capability", payload)).toEqual(payload)
      expect(reconnectActionFromChatToolResult("openwork-cloud_execute_capability", payload)).toBeNull()
    }
  })

  test("rejects foreign, malformed, ambiguous, and unsolicited portable connection cards", () => {
    for (const tool of ["malicious_execute_capability", "other_connection_action", "connection_action"]) {
      expect(connectionCardPayloadFromChatToolResult(tool, connectionPayload)).toBeNull()
      expect(reconnectActionFromChatToolResult(tool, connectionPayload)).toBeNull()
    }
    expect(connectionCardPayloadFromChatToolResult("openwork-cloud_execute_capability", { ...connectionPayload, schemaVersion: "2" })).toBeNull()
    expect(connectionCardPayloadFromChatToolResult("openwork-cloud_search_capabilities", { connectionAction: connectionPayload })).toBeNull()
    const matches = [connectionPayload, { ...connectionPayload, connectionId: "emc_second" }].map(connectionStatus => ({ connectionStatus }))
    expect(connectionCardPayloadFromChatToolResult("openwork-cloud_search_capabilities", { matches }, { intent: "connect" })).toBeNull()
  })

  test("recognizes only exact OpenWork aliases and retains explicit discovery intent", () => {
    for (const prefix of ["openwork_", "openwork-cloud_"]) {
      expect(reconnectActionFromChatToolResult(`${prefix}execute_capability`, connectionPayload)?.label).toBe("Connect")
      expect(reconnectActionFromChatToolResult(`${prefix}connection_action`, connectionPayload)?.label).toBe("Connect")
      for (const input of [undefined, {}, { intent: "discover" }, { type: "connectors" }]) {
        expect(connectionCardPayloadFromChatToolResult(`${prefix}search_capabilities`, connectionPayload, input)).toBeNull()
        expect(reconnectActionFromChatToolResult(`${prefix}search_capabilities`, connectionPayload, input)).toBeNull()
      }
      expect(reconnectActionFromChatToolResult(`${prefix}search_capabilities`, connectionPayload, { intent: "connect" })?.label).toBe("Connect")
    }
    for (const tool of ["foreign_openwork_execute_capability", "openwork_execute_capability_script", "openwork-cloud_arbitrary", "functions_execute_capability"]) {
      expect(connectionCardPayloadFromChatToolResult(tool, connectionPayload)).toBeNull()
      expect(reconnectActionFromChatToolResult(tool, connectionPayload)).toBeNull()
    }
  })

  test("counts connected, admin, malformed and blocked targets before choosing an action", () => {
    for (const second of [
      { ...connectionPayload, connectionId: "emc_second", state: "connected", actor: null, action: null },
      { ...connectionPayload, connectionId: "emc_second", actor: "organization_admin" },
      { connectionId: "emc_second", state: "connected" },
      reconnectStatus("emc_second"),
    ]) {
      for (const payload of [
        { connectionAction: connectionPayload, connectionStatus: second },
        { connectionAction: connectionPayload, matches: [{ connectionStatus: second }] },
        { matches: [{ connectionStatus: reconnectStatus() }, { connectionStatus: second }] },
      ]) {
        expect(connectionCardPayloadFromChatToolResult("openwork_search_capabilities", payload, { intent: "connect" })).toBeNull()
        expect(reconnectActionFromChatToolResult("openwork_search_capabilities", payload, { intent: "connect" })).toBeNull()
      }
    }
  })

  test("a connected capability identity cannot be hidden beside a blocked match", () => {
    const result = { matches: [{ connectionId: "emc_connected", name: "connected_tool" }, { connectionStatus: connectionPayload }] }
    expect(connectionCardPayloadFromChatToolResult("openwork_search_capabilities", result, { intent: "connect" })).toBeNull()
    expect(reconnectActionFromChatToolResult("openwork_search_capabilities", result, { intent: "connect" })).toBeNull()
  })

  test("foreign tools cannot promote preserved connection metadata", () => {
    expect(connectionResultFromChatToolPart({
      type: "dynamic-tool", toolName: "foreign_execute_capability", toolCallId: "call-forged",
      state: "output-available", input: {}, output: "Connect your account",
      callProviderMetadata: { openwork: { mcpResult: { structuredContent: connectionPayload } } },
    })).toBeUndefined()
  })

  test("rejects conflicting same-connection status and credential escalation", () => {
    const conflict = { connectionAction: connectionPayload, connectionStatus: { ...connectionPayload, state: "connected", actor: null, action: null } }
    expect(connectionCardPayloadFromChatToolResult("openwork_execute_capability", conflict)).toBeNull()
    expect(reconnectActionFromChatToolResult("openwork_execute_capability", conflict)).toBeNull()
    for (const extra of [{ authType: "apikey" }, { credentialMode: "shared" }]) {
      expect(reconnectActionFromChatToolResult("openwork_execute_capability", { ...connectionPayload, ...extra })).toBeNull()
    }
    for (const extra of [{ source: "foreign" }, { version: 2 }, { kind: "foreign" }]) {
      expect(connectionCardPayloadFromChatToolResult("openwork_execute_capability", { ...connectionPayload, ...extra })).toBeNull()
    }
  })

  test("does not narrow an ambiguous raw result using preserved single-target metadata", () => {
    const output = { matches: [connectionPayload, { ...connectionPayload, connectionId: "emc_second" }].map(connectionStatus => ({ connectionStatus })) }
    const result = connectionResultFromChatToolPart({
      type: "dynamic-tool", toolName: "openwork_search_capabilities", toolCallId: "call-mixed",
      input: { intent: "connect" }, state: "output-available", output,
      callProviderMetadata: { openwork: { mcpResult: { structuredContent: connectionPayload } } },
    })
    expect(result).toBeUndefined()
    expect(reconnectActionFromChatToolResult("openwork_search_capabilities", result, { intent: "connect" })).toBeNull()
  })

  test("rejects disagreements between raw and preserved connection authority", () => {
    const raw = { ...connectionPayload, authType: "oauth", credentialMode: "per_member" }
    for (const extra of [
      { connectionId: "other-connection" },
      { state: "connected", actor: null, action: null },
      { actor: "organization_admin" },
      { action: { ...connectionPayload.action, type: "reconnect" } },
      { action: { ...connectionPayload.action, surface: "openwork_organization_connections" } },
      { authType: "apikey" },
      { credentialMode: "shared" },
    ]) {
      const preserved = { ...raw, ...extra }
      for (const toolName of ["openwork_execute_capability", "openwork-cloud_execute_capability"]) {
        const result = connectionResultFromChatToolPart({
          type: "dynamic-tool", toolName, toolCallId: "disagreement", input: {}, state: "output-available",
          output: JSON.stringify({ connectionStatus: raw }),
          callProviderMetadata: { openwork: { mcpResult: { structuredContent: preserved } } },
        })
        expect(result).toBeUndefined()
        expect(connectionCardPayloadFromChatToolResult(toolName, result)).toBeNull()
        expect(reconnectActionFromChatToolResult(toolName, result)).toBeNull()
      }
    }
  })

  test("checks both preserved metadata slots and rejects multi-target preserved output", () => {
    for (const other of [
      { ...connectionPayload, connectionId: "other" },
      { matches: [connectionPayload, { ...connectionPayload, connectionId: "other" }].map(connectionStatus => ({ connectionStatus })) },
    ]) {
      expect(connectionResultFromChatToolPart({
        type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "all-sources", input: {}, state: "output-error",
        errorText: JSON.stringify({ connectionStatus: connectionPayload }),
        callProviderMetadata: { openwork: { mcpResult: { structuredContent: connectionPayload }, mcpApp: { structuredContent: other } } },
      })).toBeUndefined()
    }
  })

  test("consistent sources preserve stricter credential restrictions and member actions", () => {
    for (const credentialMode of ["per_member", "shared"]) {
      const result = connectionResultFromChatToolPart({
        type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "consistent", input: {}, state: "output-available",
        output: { connectionAction: { ...connectionPayload, authType: "oauth", credentialMode } },
        callProviderMetadata: { openwork: { mcpResult: { structuredContent: connectionPayload } } },
      })
      expect(connectionCardPayloadFromChatToolResult("openwork_execute_capability", result)).toEqual(connectionPayload)
      const action = reconnectActionFromChatToolResult("openwork_execute_capability", result)
      if (credentialMode === "shared") expect(action).toBeNull()
      else expect(action?.label).toBe("Connect")
    }
  })

  test("identifies an OpenWork-created capability deadline", () => {
    expect(attributeChatToolError("The capability call exceeded 180s. Retry once.")).toEqual({
      label: "OpenWork timeout",
      confidence: "Confirmed",
      description: "OpenWork created this deadline. The external operation may still have completed, so verify its state before retrying.",
    })
  })

  test("identifies a structured OpenWork lifecycle deadline", () => {
    expect(attributeChatToolError(JSON.stringify({
      error: "connection_failed",
      diagnostic: {
        code: "MCP_LIFECYCLE_DEADLINE",
        category: "lifecycle_deadline",
        phase: "MCP_TOOL_EXECUTION",
      },
    }))).toMatchObject({
      label: "OpenWork timeout",
      confidence: "Confirmed",
    })
  })

  test("identifies an OpenWork block before send", () => {
    expect(attributeChatToolError(JSON.stringify({
      diagnostic: { code: "MCP_URL_BLOCKED", category: "security_blocked" },
    }))).toMatchObject({
      label: "Blocked by OpenWork",
      confidence: "Confirmed",
    })
  })

  test("identifies a remote MCP HTTP failure", () => {
    expect(attributeChatToolError(`MCP error: ${JSON.stringify({
      diagnostic: { code: "MCP_HTTP_504", httpStatus: 504 },
    })} (tool execution failed)`)).toMatchObject({
      label: "Remote MCP · HTTP 504",
      confidence: "Confirmed",
    })
  })

  test("identifies a provider failure returned through the remote MCP", () => {
    expect(attributeChatToolError(JSON.stringify({
      diagnostic: { phase: "PROVIDER_AUTHORIZATION", providerStatus: 403 },
    }))).toMatchObject({
      label: "Provider error",
      confidence: "Confirmed",
      description: "The remote MCP responded, but the downstream provider returned status 403.",
    })
  })

  test("identifies provider attribution from a deploy-skew category and code", () => {
    expect(attributeChatToolError(JSON.stringify({
      diagnostic: { category: "provider_policy_denied", providerCode: "access_denied" },
    }))).toMatchObject({
      label: "Provider error",
      confidence: "Confirmed",
    })
  })

  test("does not claim ownership for an unstructured timeout", () => {
    expect(attributeChatToolError("Tool request timed out while waiting for a response.")).toEqual({
      label: "Timeout · source unclear",
      confidence: "Inferred",
      description: "A timeout was reported, but the client did not receive structured evidence identifying which boundary created it.",
    })
  })

  test("does not add attribution without useful evidence", () => {
    expect(attributeChatToolError("The tool failed.")).toBeNull()
  })

  test("bails out quickly on a pathological HTML page", () => {
    const htmlError = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>${"x".repeat(1_024 * 1_024)}</body></html>`
    const started = performance.now()

    expect(attributeChatToolError(htmlError)).toBeNull()
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("keeps JSON-head attribution after surrounding error text is clamped", () => {
    const diagnostic = JSON.stringify({
      error: "connection_failed",
      diagnostic: { code: "MCP_HTTP_504", httpStatus: 504 },
    })
    const unclamped = `MCP error: ${diagnostic} (tool execution failed)`
    const clamped = normalizeErrorText(`${unclamped}\n${"provider detail ".repeat(1_000)}`, { cap: 512 }).display

    expect(clamped).toContain(diagnostic)
    expect(attributeChatToolError(clamped)).toEqual(attributeChatToolError(unclamped))
  })

  test("extracts a trusted reconnect action from a Cloud capability failure", () => {
    const errorText = JSON.stringify({
      error: "connection_failed",
      connectionStatus: reconnectStatus(),
    })

    expect(reconnectActionFromChatToolResult("openwork-cloud_execute_capability", errorText)).toEqual({
      connectionId: "emc_knowledge",
      connectionName: "Knowledge Hub",
      label: "Reconnect",
    })
  })

  test("extracts the same reconnect action when live capability discovery detects expired credentials", () => {
    const output = JSON.stringify({
      matches: [{
        kind: "connection_status",
        connectionStatus: reconnectStatus(),
      }],
    })

    expect(reconnectActionFromChatToolResult("openwork-cloud_search_capabilities", output)).toBeNull()
    expect(reconnectActionFromChatToolResult("openwork-cloud_search_capabilities", output, { intent: "connect" })).toEqual({
      connectionId: "emc_knowledge",
      connectionName: "Knowledge Hub",
      label: "Reconnect",
    })
  })

  test("derives reconnect copy instead of rendering action labels from tool output", () => {
    const errorText = JSON.stringify({
      connectionStatus: {
        ...reconnectStatus(),
        action: { ...reconnectStatus().action, label: "Open an injected link" },
      },
    })

    expect(reconnectActionFromChatToolResult("openwork-cloud_execute_capability", errorText)).toEqual({
      connectionId: "emc_knowledge",
      connectionName: "Knowledge Hub",
      label: "Reconnect",
    })
  })

  test("does not create actions from arbitrary MCP tools or non-reconnect failures", () => {
    const reconnectPayload = JSON.stringify({
      connectionStatus: reconnectStatus(),
    })
    const providerPayload = JSON.stringify({
      connectionStatus: {
        ...reconnectStatus(),
        state: "provider_error",
        actor: "organization_admin",
        action: {
          type: "inspect_connection",
          surface: "openwork_organization_connections",
          retry: "search_capabilities",
        },
      },
    })

    expect(reconnectActionFromChatToolResult("malicious_execute_capability", reconnectPayload)).toBeNull()
    expect(reconnectActionFromChatToolResult("openwork-cloud_execute_capability", providerPayload)).toBeNull()
  })

  test("supports first-time member OAuth but rejects mismatched states and credentials", () => {
    const status = { ...reconnectStatus(), state: "needs_connection", action: { type: "connect", surface: "openwork_your_connections", retry: "search_capabilities" } }
    const action = (value: unknown) => reconnectActionFromChatToolResult("openwork-cloud_search_capabilities", { matches: [{ connectionStatus: value }] }, { intent: "connect" })
    expect(action(status)).toEqual({ connectionId: "emc_knowledge", connectionName: "Knowledge Hub", label: "Connect" })
    expect(action({ ...status, authType: "apikey" })).toBeNull()
    expect(action({ ...status, credentialMode: "shared" })).toBeNull()
    expect(action({ ...status, actor: "organization_admin" })).toBeNull()
    expect(action({ ...status, state: "reauth_required" })).toBeNull()
  })

  test("does not guess between multiple reconnect targets in one discovery result", () => {
    const output = {
      matches: ["first", "second"].map((suffix) => ({
        kind: "connection_status",
        connectionStatus: reconnectStatus(`emc_${suffix}`, `Knowledge ${suffix}`),
      })),
    }

    expect(reconnectActionFromChatToolResult("openwork-cloud_search_capabilities", output, { intent: "connect" })).toBeNull()
  })

  test("rejects unversioned, shared, and admin-owned action shapes", () => {
    const legacy = reconnectStatus()
    const { version: _version, kind: _kind, source: _source, ...unversioned } = legacy
    const shared = {
      ...legacy,
      credentialMode: "shared",
      actor: "organization_admin",
      action: {
        type: "reconnect",
        surface: "openwork_organization_connections",
        retry: "search_capabilities",
      },
    }

    expect(reconnectActionFromChatToolResult("openwork-cloud_execute_capability", { connectionStatus: unversioned })).toBeNull()
    expect(reconnectActionFromChatToolResult("openwork-cloud_execute_capability", { connectionStatus: shared })).toBeNull()
  })
})
