import { describe, expect, test } from "bun:test"

import {
  attributeChatToolError,
  reconnectActionFromChatToolResult,
} from "../src/components/tools/error-attribution"

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

describe("chat tool error attribution", () => {
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

    expect(reconnectActionFromChatToolResult("openwork-cloud_search_capabilities", output)).toEqual({
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

  test("does not guess between multiple reconnect targets in one discovery result", () => {
    const output = {
      matches: ["first", "second"].map((suffix) => ({
        kind: "connection_status",
        connectionStatus: reconnectStatus(`emc_${suffix}`, `Knowledge ${suffix}`),
      })),
    }

    expect(reconnectActionFromChatToolResult("openwork-cloud_search_capabilities", output)).toBeNull()
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
