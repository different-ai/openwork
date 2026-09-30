import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createHash } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { connectionActionAppHtml } from "@openwork/mcp-apps/connection-action"
import { connectionActionAppResourceUri } from "@openwork/types/connection-action-app"

const API_ORIGIN = "http://127.0.0.1:8790"

mock.module("../src/auth.js", () => ({
  auth: {},
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
  DEN_MCP_FIRST_PARTY_RESOURCES: [`${API_ORIGIN}/mcp/agent`],
  DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
  DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
  DEN_MCP_OAUTH_RESOURCE: `${API_ORIGIN}/mcp/agent`,
  DEN_MCP_RESOURCE: `${API_ORIGIN}/mcp`,
  DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
  DEN_MCP_RESOURCES: [`${API_ORIGIN}/mcp`],
  DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
}))
afterAll(() => mock.restore())

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "mcp-apps-test-encryption-key-1234567890"
process.env.BETTER_AUTH_SECRET ??= "mcp-apps-test-secret-1234567890123"
process.env.BETTER_AUTH_URL ??= API_ORIGIN
process.env.CORS_ORIGINS ??= API_ORIGIN

let connections: typeof import("../src/routes/org/mcp-connections.js")

beforeAll(async () => {
  connections = await import("../src/routes/org/mcp-connections.js")
})

// Dashboard elements must carry the exact reference names desktop entries use,
// mirroring `connectMcpAppHostName` in apps/server/src/connect-mcp-server-catalog.ts
// and `projectedMcpToolName` in apps/server/src/mcp-app-host.ts.
test("connection requests expose a standard App and deny unauthenticated intents", async () => {
  const { registerAgentConnectionActionApp } = await import("../src/mcp/connection-action-app.js")
  const server = new McpServer({ name: "connection-app-test", version: "1" })
  registerAgentConnectionActionApp(server, { organizationId: "org_fixture", member: null })
  const client = new Client({ name: "test-host", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const tools = await client.listTools()
    for (const name of ["connection_action", "connection_action_intent"]) {
      expect(tools.tools.find(tool => tool.name === name)?._meta).toMatchObject({ ui: {
        resourceUri: "ui://openwork/connection-action/v2/view.html", visibility: ["app"],
      } })
    }
    const resource = await client.readResource({ uri: connectionActionAppResourceUri })
    expect(resource.contents[0]).toMatchObject({
      uri: connectionActionAppResourceUri,
      mimeType: "text/html;profile=mcp-app",
      text: connectionActionAppHtml,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: ["https://cdn.simpleicons.org"], frameDomains: [], baseUriDomains: [] } } },
    })
    for (const action of ["authenticate", "skip"]) {
      const result = await client.callTool({ name: "connection_action_intent", arguments: { connectionId: "emc_fixture", action } })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
    }
  } finally {
    await client.close()
    await server.close()
  }
})

test("connect app-host server names mirror the desktop naming convention", () => {
  const connectionId = "emc_01dashboardfixture0000000000"
  const digest = createHash("sha256").update(connectionId).digest("hex").slice(0, 12)
  expect(connections.connectMcpAppHostServerName(connectionId)).toBe(`openwork-app-host-connect-${digest}`)
})

test("projected tool names sanitize like the desktop host", () => {
  expect(connections.projectedMcpToolName("openwork-app-host-connect-abc123", "render_report"))
    .toBe("openwork-app-host-connect-abc123_render_report")
  expect(connections.projectedMcpToolName("my server!", "tool.name"))
    .toBe("my_server__tool_name")
})

test("app visibility follows the app-host audience rule", () => {
  expect(connections.mcpToolVisibleToApp({})).toBe(true)
  expect(connections.mcpToolVisibleToApp({ _meta: { ui: { visibility: ["model", "app"] } } })).toBe(true)
  expect(connections.mcpToolVisibleToApp({ _meta: { ui: { visibility: ["app"] } } })).toBe(true)
  expect(connections.mcpToolVisibleToApp({ _meta: { ui: { visibility: ["model"] } } })).toBe(false)
  expect(connections.mcpToolVisibleToApp({ _meta: { ui: { visibility: ["model", "other"] } } })).toBe(false)
})

test("required launch input is detected from the input schema", () => {
  expect(connections.mcpToolRequiresInput({})).toBe(false)
  expect(connections.mcpToolRequiresInput({ inputSchema: { type: "object", required: [] } })).toBe(false)
  expect(connections.mcpToolRequiresInput({ inputSchema: { type: "object", required: ["query"] } })).toBe(true)
})

test("required launch-input keys are listed so authors can supply and Den can validate them", () => {
  expect(connections.mcpToolRequiredInputKeys({})).toEqual([])
  expect(connections.mcpToolRequiredInputKeys({ inputSchema: { type: "object", required: [] } })).toEqual([])
  expect(connections.mcpToolRequiredInputKeys({ inputSchema: { type: "object", required: ["cloudId", "pageId"] } }))
    .toEqual(["cloudId", "pageId"])
  // Non-string entries are provider schema noise, never keys an author can type.
  expect(connections.mcpToolRequiredInputKeys({ inputSchema: { type: "object", required: ["cloudId", 7, ""] } }))
    .toEqual(["cloudId"])
})
