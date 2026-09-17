import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { pluginFlowPayloadSchema } from "@openwork/types/plugin-flow-app"
import { Hono } from "hono"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { legacyConfirmationAppHtml } from "@openwork/mcp-apps/legacy-confirmation"
import { attachPluginFlowCard, PLUGIN_FLOW_APP_HTML, PLUGIN_FLOW_APP_RESOURCE_URI, registerAgentPluginFlowApp } from "../src/mcp/plugin-flow-app.js"
import type { CapabilityRegistryContext } from "../src/mcp/capability-registry.js"
import type { McpToolOperation } from "../src/mcp/catalog.js"

mock.module("../src/auth.js", () => ({
  auth: {},
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
  DEN_MCP_FIRST_PARTY_RESOURCES: ["http://127.0.0.1:8790/mcp/agent"],
  DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
  DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
  DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp/agent",
  DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
  DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
}))
afterAll(() => mock.restore())

let executeCapability: typeof import("../src/mcp/capability-registry.js")["executeCapability"]

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL ??= "http://127.0.0.1:8790"
  executeCapability = (await import("../src/mcp/capability-registry.js")).executeCapability
})

function context(app: Hono, operation: McpToolOperation): CapabilityRegistryContext {
  const organizationId = createDenTypeId("organization")
  return {
    app,
    env: undefined,
    catalog: [operation],
    principal: {
      userId: createDenTypeId("user"),
      organizationId,
      scopes: new Set(["mcp:read", "mcp:write"]),
      payload: {},
    },
    organizationId,
    member: { orgMembershipId: createDenTypeId("member"), teamIds: [] },
    redirectUriBase: "http://127.0.0.1:8790",
    generatedArtifactViewsEnabled: false,
    externalMcpConnectionsEnabled: false,
    remoteSessionsEnabled: false,
    resolvePlatformAdmin: async () => false,
    resolveNamespaceContext: async () => ({
      nativeProviderEntries: [],
      externalMcpConnections: [],
      codemodeNativeProviderEntries: [],
      codemodeExternalMcpConnections: [],
      namespaces: { native: new Map(), externalMcp: new Map() },
    }),
  }
}

test("legacy formatter is app-only and its exact bound resource resolves before and after calls", async () => {
  const server = new McpServer({ name: "legacy-test", version: "1" })
  registerAgentPluginFlowApp(server)
  const client = new Client({ name: "legacy-host", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const tools = await client.listTools()
    expect(tools.tools).toHaveLength(1)
    expect(tools.tools[0]?._meta).toEqual({ ui: { resourceUri: PLUGIN_FLOW_APP_RESOURCE_URI, visibility: ["app"] }, "ui/resourceUri": PLUGIN_FLOW_APP_RESOURCE_URI })
    expect(tools.tools[0]?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false })
    const historical = await client.readResource({ uri: PLUGIN_FLOW_APP_RESOURCE_URI })
    expect(historical.contents[0]).toMatchObject({ uri: PLUGIN_FLOW_APP_RESOURCE_URI, text: PLUGIN_FLOW_APP_HTML, mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } } })
    const payload = { schemaVersion: "1", mode: "plugin_access_granted", pluginId: "plg_fixture", marketplaceId: null, recipient: null }
    const result = await client.callTool({ name: "plugin_flow", arguments: payload })
    expect(result.structuredContent).toEqual(payload)
    expect(result._meta).toBeUndefined()
    expect(await client.readResource({ uri: PLUGIN_FLOW_APP_RESOURCE_URI })).toEqual(historical)
    const invalid = await client.callTool({ name: "plugin_flow", arguments: { mode: "plugin_access_granted" } })
    expect(invalid.isError).toBe(true)
  } finally {
    await client.close()
    await server.close()
  }
})

test("legacy sharing exports the compiled shared confirmation renderer", () => {
  expect(PLUGIN_FLOW_APP_HTML).toBe(legacyConfirmationAppHtml)
})

const sharingOperations = [
  { name: "postMarketplacesPlugins", path: "/v1/marketplaces/{marketplaceId}/plugins", params: { marketplaceId: "mkt_fixture" }, body: { pluginId: "plg_fixture" } },
  { name: "postPluginsAccess", path: "/v1/plugins/{pluginId}/access", params: { pluginId: "plg_fixture" }, body: { orgMembershipId: "om_fixture", role: "viewer" } },
  { name: "postPluginsAccess", path: "/v1/plugins/{pluginId}/access", params: { pluginId: "plg_fixture" }, body: { teamId: "tem_fixture", role: "editor" } },
  { name: "postPluginsAccess", path: "/v1/plugins/{pluginId}/access", params: { pluginId: "plg_fixture" }, body: { orgWide: true, role: "viewer" } },
  { name: "postMarketplacesAccess", path: "/v1/marketplaces/{marketplaceId}/access", params: { marketplaceId: "mkt_fixture" }, body: { teamId: "tem_fixture", role: "manager" } },
  { name: "postPlugins", path: "/v1/plugins", params: {}, body: { name: "Fixture" } },
]

test.each(sharingOperations)("$name preserves operation content and only attaches tracked legacy confirmations on success", async (fixture) => {
  const app = new Hono()
  const requests: Array<{ path: string; body: unknown }> = []
  let forbidden = false
  const response = { id: "grant_fixture", stored: fixture.body }
  app.post("*", async (c) => {
    requests.push({ path: c.req.path, body: await c.req.json() })
    return forbidden ? c.json({ error: "forbidden" }, 403) : c.json(response, 201)
  })
  const operation: McpToolOperation = { name: fixture.name, method: "POST", path: fixture.path, operation: {}, inputSchema: z.object({}) }
  const ctx = context(app, operation)
  const input = { name: fixture.name, path: JSON.stringify(fixture.params), body: JSON.stringify(fixture.body) }
  const result = await executeCapability(ctx, input)
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(response, null, 2) }])
  if (fixture.name === "postPlugins") {
    expect(result._meta).toBeUndefined()
    expect(result.structuredContent).toBeUndefined()
  } else {
    const mode = fixture.name === "postMarketplacesPlugins" ? "marketplace_plugin_added" : fixture.name === "postPluginsAccess" ? "plugin_access_granted" : "marketplace_access_granted"
    const recipient = fixture.body.orgMembershipId ? { kind: "member", id: fixture.body.orgMembershipId, role: fixture.body.role }
      : fixture.body.teamId ? { kind: "team", id: fixture.body.teamId, role: fixture.body.role }
      : fixture.body.orgWide ? { kind: "org_wide", id: null, role: fixture.body.role } : null
    expect(result.structuredContent).toEqual({
      schemaVersion: "1",
      mode,
      pluginId: fixture.params.pluginId ?? fixture.body.pluginId ?? null,
      marketplaceId: fixture.params.marketplaceId ?? null,
      recipient,
    })
    expect(pluginFlowPayloadSchema.parse(result.structuredContent)).toEqual(result.structuredContent)
    expect(result._meta).toEqual({ "openwork/mcpApp": {
      toolName: "plugin_flow", resourceUri: PLUGIN_FLOW_APP_RESOURCE_URI, arguments: { mode },
    } })
  }
  expect(requests).toEqual([{
    path: fixture.path.replace(/\{[^}]+\}/g, () => Object.values(fixture.params)[0] ?? ""),
    body: fixture.body,
  }])

  forbidden = true
  const failure = await executeCapability(ctx, input)
  expect(failure).toEqual({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: "forbidden" }, null, 2) }] })
  ctx.principal.scopes.delete("mcp:write")
  const denied = await executeCapability(ctx, input)
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain("insufficient_mcp_scope")
  expect(denied._meta).toBeUndefined()
  expect(requests).toHaveLength(2)
})

test("agent retains legacy registration and original automatic result attachments", async () => {
  const agent = await readFile(new URL("../src/mcp/agent.ts", import.meta.url), "utf8")
  const registry = await readFile(new URL("../src/mcp/capability-registry.ts", import.meta.url), "utf8")
  expect(agent).toContain("registerAgentPluginFlowApp(server)")
  expect(agent).toContain("plugin-flow-app")
  expect(registry).toContain("attachPluginFlowCard({ name: parsed.name, path, body, result })")
  expect(registry).toContain("plugin-flow-app")
})

test("legacy attachment preserves unrelated metadata and leaves errors and untracked results untouched", () => {
  const result = { isError: false, content: [{ type: "text", text: "original response" }], structuredContent: { original: true }, _meta: { unrelated: "retained" } }
  const attached = attachPluginFlowCard({ name: "postPluginsAccess", path: null, body: [], result })
  expect(attached.content).toBe(result.content)
  expect(attached._meta).toEqual({ unrelated: "retained", "openwork/mcpApp": {
    toolName: "plugin_flow", resourceUri: PLUGIN_FLOW_APP_RESOURCE_URI, arguments: { mode: "plugin_access_granted" },
  } })
  expect(attached.structuredContent).toEqual({ schemaVersion: "1", mode: "plugin_access_granted", pluginId: null, marketplaceId: null, recipient: null })
  expect(result.structuredContent).toEqual({ original: true })
  const failure = { ...result, isError: true }
  expect(attachPluginFlowCard({ name: "postPluginsAccess", path: {}, body: {}, result: failure })).toBe(failure)
  expect(attachPluginFlowCard({ name: "postPlugins", path: {}, body: {}, result })).toBe(result)
})

test("historical confirmation payloads remain parseable", () => {
  const modes: Array<z.infer<typeof pluginFlowPayloadSchema>["mode"]> = ["marketplace_plugin_added", "plugin_access_granted", "marketplace_access_granted"]
  for (const mode of modes) {
    expect(pluginFlowPayloadSchema.parse({
      schemaVersion: "1",
      mode,
      pluginId: "plg_fixture",
      marketplaceId: "mkt_fixture",
      recipient: { kind: "member", id: "om_fixture", role: "viewer" },
    }).mode).toBe(mode)
  }
})
