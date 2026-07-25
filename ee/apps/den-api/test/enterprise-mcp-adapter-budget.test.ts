import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import { expect, test } from "bun:test"
import type { ExternalMcpConnectionRow } from "../src/capability-sources/external-mcp-connections.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"
}

seedRequiredEnv()

function standaloneConnection(): ExternalMcpConnectionRow {
  const now = new Date()
  return {
    id: "external-mcp-connection-budget",
    organizationId: "organization-budget",
    name: "Standalone Budget MCP",
    url: "https://mcp-budget.example.com/mcp",
    authType: "none",
    oauthConfiguration: null,
    credentialMode: "shared",
    apiKey: null,
    accessToken: null,
    refreshToken: null,
    tokenType: null,
    scope: null,
    expiresAt: null,
    pendingCodeVerifier: null,
    credentialHealth: null,
    oauthIssuerReviewRequiredAt: null,
    connectedAt: null,
    createdByOrgMembershipId: "member-budget",
    createdAt: now,
    updatedAt: now,
  }
}

test("enterprise adapter forwards the external tool lifecycle to live MCP request options", async () => {
  seedRequiredEnv()
  const observedOptions: RequestOptions[] = []
  const originalConnect = Client.prototype.connect
  const originalCallTool = Client.prototype.callTool
  type ConnectMethod = Client["connect"]
  type CallToolMethod = Client["callTool"]
  function observingConnect(
    this: Client,
    _transport: Parameters<ConnectMethod>[0],
    _options: Parameters<ConnectMethod>[1],
  ): ReturnType<ConnectMethod> {
    return Promise.resolve()
  }
  function observingCallTool(
    this: Client,
    params: Parameters<CallToolMethod>[0],
    resultSchema: Parameters<CallToolMethod>[1],
    options: Parameters<CallToolMethod>[2],
  ): ReturnType<CallToolMethod> {
    if (options) observedOptions.push(options)
    return Promise.resolve({ content: [{ type: "text", text: "ok" }] })
  }
  Client.prototype.connect = observingConnect
  Client.prototype.callTool = observingCallTool

  try {
    const [{ callExternalMcpTool }, {
      EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS,
      EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS,
      createExternalMcpLifecycleDeadline,
    }] = await Promise.all([
      import("../src/capability-sources/enterprise-mcp-client-adapter.js"),
      import("../src/capability-sources/external-mcp-client.js"),
    ])
    const result = await callExternalMcpTool({
      connection: standaloneConnection(),
      redirectUri: "http://127.0.0.1:8790/callback",
      toolName: "lookup",
      args: {},
      lifecycleDeadline: createExternalMcpLifecycleDeadline(EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS),
    })

    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" })
    expect(observedOptions).toHaveLength(1)
    const options = observedOptions[0]
    if (!options) throw new Error("Expected the SDK callTool request options to be captured.")
    expect(options.maxTotalTimeout).toBeGreaterThanOrEqual(EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS - 1_000)
    expect(options.maxTotalTimeout).toBeLessThanOrEqual(EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS)
    expect(options.timeout).toBeGreaterThanOrEqual(EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS)
    expect(options.timeout).toBeLessThan(options.maxTotalTimeout ?? 0)
    expect(options.resetTimeoutOnProgress).toBe(true)
    expect(typeof options.onprogress).toBe("function")
  } finally {
    Client.prototype.connect = originalConnect
    Client.prototype.callTool = originalCallTool
  }
})
