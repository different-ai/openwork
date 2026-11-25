import assert from "node:assert/strict"
import { after, test } from "node:test"
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client"
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import type { ExternalMcpConnectionRow } from "../../src/capability-sources/external-mcp-connections.js"
import { bootDen } from "./harness.js"

/**
 * A connection's tools reach a client through the per-connection proxy, and a
 * change to what the organization's members may use tells a listening client
 * to list them again: at once for a change made on this replica, and on the
 * next revision check for one made on another. Both protocol eras are served.
 */
const den = await bootDen()
after(() => den.close())
await import("../../src/auth.js").then(({ auth }) => auth.$context)
const { createExternalConnectionProxyHandler, handleExternalConnectionProxyRequest } = await import("../../src/mcp/external-connection-proxy.js")
const { notifyInventoryChanged } = await import("../../src/inventory-writes.js")

const ORIGIN = "http://den-api.example.test"
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")

function connection(overrides: Partial<ExternalMcpConnectionRow> = {}): ExternalMcpConnectionRow {
  return {
    id: createDenTypeId("externalMcpConnection"),
    organizationId,
    name: "Team Notes",
    externalKey: null,
    url: "http://provider.example.test/mcp",
    authType: "oauth",
    kind: "external_mcp",
    nativeProviderKey: null,
    oauthConfiguration: null,
    toolPolicy: null,
    exposeDirectly: true,
    credentialMode: "shared",
    apiKey: null,
    apiKeyAuthScheme: "bearer",
    requestHeaders: null,
    accessToken: "saved-access-token",
    refreshToken: null,
    tokenType: "Bearer",
    scope: null,
    expiresAt: null,
    pendingCodeVerifier: null,
    credentialHealth: null,
    readinessCheck: null,
    readinessCredentialBinding: null,
    oauthIssuerReviewRequiredAt: null,
    connectedAt: new Date(),
    createdByOrgMembershipId: memberId,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

const tool = (name: string, inputSchema: Record<string, unknown> = { type: "object", properties: {} }) => ({ name, description: `${name} tool`, inputSchema })

/** The proxy for one connection, with a provider whose tool list the test sets and a revision it can bump. */
function proxy(row: ExternalMcpConnectionRow, options: { appHostClient?: boolean } = {}) {
  const provider: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; _meta?: Record<string, unknown> }> } = { tools: [tool("read_note")] }
  let revision = "1"
  const handler = createExternalConnectionProxyHandler({ revision: async () => revision, pollMs: 25 })
  after(() => handler.close())
  const app = new Hono()
  app.all("/mcp/agent/connections/:connectionId", (c) => handleExternalConnectionProxyRequest({
    context: c,
    operation: { connection: row, redirectUri: `${ORIGIN}/callback`, member: { orgMembershipId: memberId }, diagnosticReferenceId: "test" },
    scopes: new Set(["mcp:read", "mcp:write"]),
    directExposureEnabled: row.exposeDirectly,
    appHostClient: options.appHostClient === true,
    runtime: {
      listTools: async () => provider.tools,
      callTool: async () => ({ content: [{ type: "text", text: "ok" }], structuredContent: { saved: true }, _meta: { "openwork/test": "kept" } }),
      listResources: async () => [{ uri: "ui://notes/board", name: "Board", mimeType: "text/html;profile=mcp-app" }, { uri: "ui://notes/unbound", name: "Unbound" }],
      listResourceTemplates: async () => [],
      readResource: async ({ uri }) => ({ contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<p>board</p>" }] }),
    },
    dependencies: {
      describe: async () => ({ serverInfo: { name: "Team Notes", version: "1.0.0" }, capabilities: { tools: {}, resources: {} } }),
      serve: (server, context, organization) => handler.fetch(organization, context.req.raw, server),
    },
  }))
  const url = new URL(`${ORIGIN}/mcp/agent/connections/${row.id}`)
  const fetch = (input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)
  return { provider, url, fetch, bump: () => { revision = String(Number(revision) + 1) } }
}

function changes() {
  const seen: string[][] = []
  let wake: (() => void) | undefined
  return {
    onChanged: (error: Error | null, tools: { name: string }[] | null) => {
      if (error) throw error
      seen.push((tools ?? []).map((entry) => entry.name))
      wake?.()
    },
    next: (count: number) => new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no tools/list_changed after ${seen.length} change(s)`)), 3_000)
      const check = () => {
        if (seen.length < count) return
        clearTimeout(timer)
        resolve(seen[count - 1] ?? [])
      }
      wake = check
      check()
    }),
  }
}

test("a listening client lists a directly exposed connection's tools again after a change on this replica", async () => {
  const row = connection()
  const served = proxy(row)
  const changed = changes()
  const client = new ModernClient({ name: "test", version: "1" }, { versionNegotiation: { mode: "auto" }, listChanged: { tools: { onChanged: changed.onChanged, debounceMs: 0 } } })
  await client.connect(new ModernTransport(served.url, { fetch: served.fetch }))
  after(() => client.close())

  assert.equal(client.getServerCapabilities()?.tools?.listChanged, true)
  assert.deepEqual((await client.listTools()).tools.map((entry) => entry.name), ["read_note"])

  served.provider.tools = [tool("read_note"), tool("write_note")]
  notifyInventoryChanged([organizationId])
  assert.deepEqual(await changed.next(1), ["read_note", "write_note"])
})

test("a change made on another replica reaches a listening client on the next revision check", async () => {
  const row = connection()
  const served = proxy(row)
  const changed = changes()
  const client = new ModernClient({ name: "test", version: "1" }, { versionNegotiation: { mode: "auto" }, listChanged: { tools: { onChanged: changed.onChanged, debounceMs: 0 } } })
  await client.connect(new ModernTransport(served.url, { fetch: served.fetch }))
  after(() => client.close())
  await client.listTools()
  // Let the subscription take in the current revision before it changes.
  await new Promise((resolve) => setTimeout(resolve, 60))

  served.provider.tools = [tool("archive_note")]
  served.bump()
  assert.deepEqual(await changed.next(1), ["archive_note"])
})

test("another organization's change does not reach the stream", async () => {
  const row = connection()
  const served = proxy(row)
  const changed = changes()
  const client = new ModernClient({ name: "test", version: "1" }, { versionNegotiation: { mode: "auto" }, listChanged: { tools: { onChanged: changed.onChanged, debounceMs: 0 } } })
  await client.connect(new ModernTransport(served.url, { fetch: served.fetch }))
  after(() => client.close())
  await client.listTools()

  notifyInventoryChanged([createDenTypeId("organization")])
  await assert.rejects(Promise.race([changed.next(1), new Promise((_, reject) => setTimeout(() => reject(new Error("quiet")), 200))]), /quiet/)
})

test("a 2025-era client is still served without a session", async () => {
  const served = proxy(connection())
  const client = new LegacyClient({ name: "legacy", version: "1" })
  await client.connect(new LegacyTransport(served.url, { fetch: served.fetch }))
  after(() => client.close())

  assert.equal(client.getServerCapabilities()?.tools?.listChanged, true)
  assert.deepEqual((await client.listTools()).tools.map((entry) => entry.name), ["read_note"])
  const result = await client.callTool({ name: "read_note", arguments: {} })
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }])
})

test("the bounded search/execute surface says its list does not change", async () => {
  const served = proxy(connection({ exposeDirectly: false }))
  const client = new ModernClient({ name: "test", version: "1" }, { versionNegotiation: { mode: "auto" } })
  await client.connect(new ModernTransport(served.url, { fetch: served.fetch }))
  after(() => client.close())

  assert.equal(client.getServerCapabilities()?.tools?.listChanged, false)
  assert.deepEqual((await client.listTools()).tools.map((entry) => entry.name), ["search_capabilities", "execute_capability"])
})

test("a provider tool whose input schema is not an object is left out instead of failing the list", async () => {
  const served = proxy(connection())
  served.provider.tools = [tool("read_note"), tool("broken", { type: "string" })]
  const client = new ModernClient({ name: "test", version: "1" }, { versionNegotiation: { mode: "auto" } })
  await client.connect(new ModernTransport(served.url, { fetch: served.fetch }))
  after(() => client.close())

  assert.deepEqual((await client.listTools()).tools.map((entry) => entry.name), ["read_note"])
})

test("the App host still gets app-only tools, their bound App resources and full call results", async () => {
  const served = proxy(connection({ exposeDirectly: false }), { appHostClient: true })
  served.provider.tools = [{ ...tool("show_board"), _meta: { ui: { resourceUri: "ui://notes/board" } } }]
  const client = new LegacyClient({ name: "openwork-mcp-app-host", version: "1" })
  await client.connect(new LegacyTransport(served.url, { fetch: served.fetch }))
  after(() => client.close())

  assert.equal(client.getServerCapabilities()?.tools?.listChanged, true)
  const listed = (await client.listTools()).tools
  const board = listed.find((entry) => entry.name === "show_board")
  assert.deepEqual(board?._meta, { ui: { resourceUri: "ui://notes/board", visibility: ["app"] } })
  assert.deepEqual((await client.listResources()).resources.map((resource) => resource.uri), ["ui://notes/board"])
  assert.deepEqual((await client.readResource({ uri: "ui://notes/board" })).contents, [{ uri: "ui://notes/board", mimeType: "text/html;profile=mcp-app", text: "<p>board</p>" }])
  await assert.rejects(client.readResource({ uri: "ui://notes/unbound" }), /not bound to an available MCP App tool/)

  const result = await client.callTool({ name: "show_board", arguments: {} })
  assert.deepEqual(result.structuredContent, { saved: true })
  assert.deepEqual(result._meta, { "openwork/test": "kept" })
})
