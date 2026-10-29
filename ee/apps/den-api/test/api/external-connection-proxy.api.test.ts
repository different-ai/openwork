import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import type { ExternalMcpConnectionRow } from "../../src/capability-sources/external-mcp-connections.js"
import { externalMcpToolSchemaDigest } from "../../src/mcp/external-mcp-tool-arguments.js"
import { DEN_MCP_WRITE_SCOPE } from "../../src/mcp/scopes.js"
import { scoreText, tokenize } from "../../src/mcp/search.js"

// Default adapters initialize at import time, but all provider operations and
// usage writes below are synthetic: no database or external connection is used.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/external_proxy_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-external-proxy-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-external-proxy-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../../src/db.js")
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
mock.method(db, "insert", () => ({ values: async () => undefined }))
const { createExternalConnectionProxyServer, handleExternalConnectionProxyRequest } = await import("../../src/mcp/external-connection-proxy.js")

type ProxyInput = Parameters<typeof createExternalConnectionProxyServer>[0]
const member = { orgMembershipId: createDenTypeId("member") }
const connection: ExternalMcpConnectionRow = {
  id: createDenTypeId("externalMcpConnection"),
  organizationId: createDenTypeId("organization"),
  name: "Issue tracker",
  externalKey: null,
  url: "https://provider.test/mcp",
  authType: "none",
  kind: "external_mcp",
  nativeProviderKey: null,
  oauthConfiguration: null,
  toolPolicy: { allDisabled: false, disabledTools: ["delete_issue"], updatedBy: null, updatedByName: null, updatedAt: null },
  exposeDirectly: false,
  credentialMode: "shared",
  apiKey: null,
  apiKeyAuthScheme: "bearer",
  accessToken: null,
  refreshToken: null,
  tokenType: null,
  scope: null,
  expiresAt: null,
  pendingCodeVerifier: null,
  credentialHealth: null,
  readinessCheck: null,
  readinessCredentialBinding: null,
  oauthIssuerReviewRequiredAt: null,
  connectedAt: null,
  createdByOrgMembershipId: member.orgMembershipId,
  createdAt: new Date("2026-10-21T00:00:00Z"),
  updatedAt: new Date("2026-10-21T00:00:00Z"),
}
const issueTool = {
  name: "list_issues",
  description: "List issues",
  inputSchema: { type: "object", properties: { state: { type: "string" } } },
  annotations: { readOnlyHint: true },
}
const appTool = {
  ...issueTool,
  name: "issue_app",
  _meta: { ui: { resourceUri: "ui://issues/view", visibility: ["app"] } },
}

async function fixture(overrides: Partial<ProxyInput> = {}) {
  const calls: { toolName: string; args: Record<string, unknown> }[] = []
  const server = createExternalConnectionProxyServer({
    descriptor: { capabilities: { tools: {} } },
    operation: { connection, member, redirectUri: "https://den.test/callback", diagnosticReferenceId: "proxy-unit-test" },
    scopes: new Set([DEN_MCP_WRITE_SCOPE]),
    runtime: {
      listTools: async () => [issueTool, appTool, { ...issueTool, name: "delete_issue" }],
      callTool: async ({ toolName, args }) => {
        calls.push({ toolName, args })
        return { content: [{ type: "text", text: "ok" }] }
      },
      listResources: async () => [],
      listResourceTemplates: async () => [],
      readResource: async () => ({ contents: [] }),
    },
    ...overrides,
  })
  const client = new Client({ name: "proxy-unit-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, calls, close: async () => { await client.close(); await server.close() } }
}

for (const enabled of [undefined, false, true]) {
  test(`proxy search and advertised execution schema use ${enabled === true ? "modern" : "legacy"} view (flag ${enabled})`, async (t) => {
    const { client, close } = await fixture({ toolShapes: enabled })
    t.after(close)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(({ name }) => name), ["search_capabilities", "execute_capability"])
    const execute = tools.find(({ name }) => name === "execute_capability")
    assert.deepEqual(execute?.inputSchema.properties, enabled === true
      ? { name: { type: "string", minLength: 1 }, arguments: { type: "object" }, body: { type: "object", description: "Older form of arguments." } }
      : { name: { type: "string", minLength: 1 }, body: { type: "object" } })
    assert.equal(execute?.description, enabled === true
      ? "Execute an exact tool returned by search_capabilities on this connected MCP server, with arguments matching its inputSchema."
      : "Execute an exact tool returned by search_capabilities on this connected MCP server.")
    const result = await client.callTool({ name: "search_capabilities", arguments: { query: "list_issues", limit: 1 } })
    const common = { name: issueTool.name, schemaDigest: externalMcpToolSchemaDigest(issueTool.inputSchema) }
    const matches = enabled === true
      ? [{ ...common, description: issueTool.description, inputSchema: issueTool.inputSchema, annotations: issueTool.annotations }]
      : [{ ...common, method: "MCP", path: connection.name, score: scoreText(tokenize(issueTool.name), tokenize(issueTool.description), tokenize("list_issues")), summary: issueTool.description, pathParams: [], queryParams: [], hasBody: true, argumentsSchema: issueTool.inputSchema, invocation: { argumentsField: "body" } }]
    assert.deepEqual(result.structuredContent, { matches })
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(result.structuredContent) }])
  })

  test(`both cached execute input forms work with flag ${enabled}`, async (t) => {
    const { client, calls, close } = await fixture({ toolShapes: enabled })
    t.after(close)
    for (const field of ["body", "arguments"]) {
      await client.callTool({ name: "execute_capability", arguments: { name: issueTool.name, [field]: { state: "open" } } })
    }
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ toolName: issueTool.name, args: { state: "open" } })))
    await assert.rejects(client.callTool({ name: "execute_capability", arguments: { name: "delete_issue", body: {} } }), /unavailable/)
    assert.equal(calls.length, 2)
  })
}

for (const enabled of [false, true]) {
  test(`HTTP handler forwards the resolved tool shape flag ${enabled}`, async () => {
    const app = new Hono()
    app.post("/proxy", (context) => handleExternalConnectionProxyRequest({
      context,
      operation: { connection, member, redirectUri: "https://den.test/callback", diagnosticReferenceId: "proxy-unit-test" },
      scopes: new Set(),
      toolShapes: enabled,
      dependencies: {
        describe: async () => ({ capabilities: { tools: {} } }),
        serve: async (server) => {
          const client = new Client({ name: "proxy-unit-test", version: "1" })
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
          try {
            await server.connect(serverTransport)
            await client.connect(clientTransport)
            return Response.json(await client.listTools())
          } finally {
            await client.close()
            await server.close()
          }
        },
      },
    }))
    const response = await app.request("/proxy", { method: "POST" })
    assert.equal(response.status, 200)
    const result: unknown = await response.json()
    assert.ok(typeof result === "object" && result !== null && "tools" in result && Array.isArray(result.tools))
    assert.equal("arguments" in result.tools[1].inputSchema.properties, enabled)
  })

  test(`App host gets the selected gateway view and keeps App metadata with flag ${enabled}`, async (t) => {
    const { client, close } = await fixture({ toolShapes: enabled, appHostClient: true })
    t.after(close)
    const { tools } = await client.listTools()
    assert.deepEqual(tools[1]?._meta, { ui: { visibility: ["app"] } })
    assert.equal("arguments" in (tools[1]?.inputSchema.properties ?? {}), enabled)
    const result = await client.callTool({ name: "search_capabilities", arguments: { query: "issue_app", limit: 1 } })
    const structured = result.structuredContent
    assert.ok(structured && Array.isArray(structured.matches))
    assert.deepEqual(structured.matches[0]?.mcpApp, { resourceUri: "ui://issues/view" })
    assert.equal(structured.matches[0]?.kind, "mcp_app")
  })

  test(`direct exposure and write scope remain unchanged with flag ${enabled}`, async (t) => {
    const directConnection = { ...connection, exposeDirectly: true }
    const operation = { connection: directConnection, member, redirectUri: "https://den.test/callback", diagnosticReferenceId: "proxy-unit-test" }
    const { client, calls, close } = await fixture({ toolShapes: enabled, directExposureEnabled: true, operation, scopes: new Set() })
    t.after(close)
    assert.deepEqual((await client.listTools()).tools, [issueTool])
    const result = await client.callTool({ name: issueTool.name, arguments: { state: "open" } })
    assert.equal(result.isError, true)
    assert.equal(calls.length, 0)
    await assert.rejects(client.callTool({ name: "delete_issue", arguments: {} }), /not available/)
  })
}
