import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { mcpAppResourceUri, mcpAppToolName, type McpAppSummary } from "@openwork/types/mcp-app"
import { expect, test } from "bun:test"
import { z } from "zod"
import {
  APP_AUTHORING_GUIDANCE,
  AuthoredAppError,
  authoredAppLaunchInstruction,
  openAppInputSchema,
  registerAgentAuthoredApps,
  searchAuthoredMcpApps,
  type AuthoredAppService,
} from "../src/mcp/authored-apps.js"
import { createScopedAgentMcpHttpHandlers } from "../src/mcp/agent-http.js"

const appId = "cob_01k28e8q8pf8r9sff9mhyqxved"
const revisionId = "cov_01k28e8q8pf8r9sff9mhyqxved"
const nextRevisionId = "cov_01k28e91dcf6ftyz9e90pcrv7p"
const source = {
  title: "Project explorer",
  reactSource: "export default function App({ app, input }) { return <main>{input.title}</main> }",
  cssSource: "main { padding: 12px; }",
  textFallback: "Open Project explorer to browse projects.",
}
const app: McpAppSummary = {
  appId,
  pluginId: "plg_01k28e8q8pf8r9sff9mhyqxved",
  revisionId,
  title: source.title,
  description: "Browse projects",
  textFallback: source.textFallback,
  toolName: mcpAppToolName(appId),
  resourceUri: mcpAppResourceUri(appId, revisionId),
}
const nextApp = { ...app, revisionId: nextRevisionId, resourceUri: mcpAppResourceUri(appId, nextRevisionId) }
const html = "<!doctype html><html><body>compiled-only-marker</body></html>"
const resource = (summary = app) => ({ app: summary, html, resourceDigest: "sha256:" + "0".repeat(64), csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } })

function service(overrides: Partial<AuthoredAppService> = {}): AuthoredAppService {
  return {
    create: async () => app,
    update: async () => nextApp,
    read: async () => ({ app, reactSource: source.reactSource, cssSource: source.cssSource }),
    list: async () => [app],
    loadResource: async ({ revisionId: id }) => resource(id === nextRevisionId ? nextApp : app),
    ...overrides,
  }
}

async function withClient(run: (client: Client) => Promise<void>, overrides: Partial<AuthoredAppService> = {}, scopes = ["mcp:read", "mcp:write"]) {
  const server = new McpServer({ name: "authored-app-test", version: "1" }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
  })
  await registerAgentAuthoredApps({
    server,
    scopes: new Set(scopes),
    service: service(overrides),
    request: { method: "tools/list", toolName: null, resourceUri: null },
    notifyCatalogChanged: () => { server.sendToolListChanged(); server.sendResourceListChanged() },
  })
  const client = new Client({ name: "standard-host", version: "1" }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try { await run(client) } finally { await client.close(); await server.close() }
}

test("standard client roundtrip binds a fixed App resource and launches only input", async () => {
  const loads: unknown[] = []
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools
    for (const name of ["create_app", "update_app", "read_app"]) expect(tools.find((tool) => tool.name === name)?._meta).toBeUndefined()
    expect(tools.find((tool) => tool.name === app.toolName)?._meta).toEqual({
      ui: { resourceUri: app.resourceUri, visibility: ["model", "app"] }, "ui/resourceUri": app.resourceUri,
    })
    expect(tools.some((tool) => /workflow/.test(tool.name))).toBe(false)
    const launched = await client.callTool({ name: app.toolName, arguments: { input: { title: "Projects", nested: [true, null, 4] } } })
    expect(launched.structuredContent).toEqual({ app, input: { title: "Projects", nested: [true, null, 4] } })
    expect(launched.content).toEqual([{ type: "text", text: app.textFallback }])
    expect(launched._meta).toBeUndefined()
    expect(JSON.stringify(launched)).not.toContain(html)
    const read = await client.readResource({ uri: app.resourceUri })
    expect(read.contents[0]).toMatchObject({ uri: app.resourceUri, mimeType: "text/html;profile=mcp-app", text: html, _meta: { ui: { csp: resource().csp } } })
    expect(loads).toEqual([{ appId, revisionId }, { appId, revisionId }])
  }, { loadResource: async (request) => { loads.push(request); return resource() } })
})

test("create/read/update stay non-UI and refresh tools and resources in the same server", async () => {
  const writes: unknown[] = []
  await withClient(async (client) => {
    let toolChanges = 0
    let resourceChanges = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => { toolChanges += 1 })
    client.setNotificationHandler("notifications/resources/list_changed", () => { resourceChanges += 1 })
    const created = await client.callTool({ name: "create_app", arguments: source })
    expect(created.structuredContent).toEqual({ app })
    expect(created._meta).toBeUndefined()
    expect((await client.listTools()).tools.some((tool) => tool.name === app.toolName)).toBe(true)
    const read = await client.callTool({ name: "read_app", arguments: { appId } })
    expect(read.structuredContent).toEqual({ app, reactSource: source.reactSource, cssSource: source.cssSource })
    expect(read._meta).toBeUndefined()
    const update = { ...source, appId, expectedRevisionId: revisionId }
    const updated = await client.callTool({ name: "update_app", arguments: update })
    expect(updated.structuredContent).toEqual({ app: nextApp })
    expect(updated._meta).toBeUndefined()
    expect((await client.listTools()).tools.find((tool) => tool.name === app.toolName)?._meta).toMatchObject({ ui: { resourceUri: nextApp.resourceUri } })
    expect((await client.listResources()).resources.map((entry) => entry.uri)).toEqual(expect.arrayContaining([app.resourceUri, nextApp.resourceUri]))
    expect(toolChanges).toBeGreaterThan(0)
    expect(resourceChanges).toBeGreaterThan(0)
    expect(writes).toEqual([source, update])
  }, {
    list: async () => [],
    create: async (request) => { writes.push(request); return app },
    update: async (request) => { writes.push(request); return nextApp },
  })
})

test("strict arguments reject Workflow bindings, grants, extra fields, and invalid IDs", async () => {
  let writes = 0
  await withClient(async (client) => {
    const cases = [
      { name: "create_app", arguments: { ...source, workflowId: appId } },
      { name: "create_app", arguments: { ...source, allowedTools: ["write"] } },
      { name: "create_app", arguments: { ...source, textFallback: "" } },
      { name: "create_app", arguments: { ...source, pluginId: "invalid" } },
      { name: "update_app", arguments: { ...source, appId } },
      { name: "update_app", arguments: { ...source, appId, expectedRevisionId: revisionId, pluginId: app.pluginId } },
      { name: "read_app", arguments: { appId, includeHtml: true } },
      { name: app.toolName, arguments: { workflowId: appId } },
      { name: app.toolName, arguments: { input: [] } },
      { name: app.toolName, arguments: { resourceUri: nextApp.resourceUri } },
    ]
    for (const request of cases) expect((await client.callTool(request)).isError).toBe(true)
    expect(writes).toBe(0)
  }, { create: async () => { writes += 1; return app }, update: async () => { writes += 1; return nextApp } })
  for (const value of [undefined, NaN, Infinity, () => 1, new Date(), 1n]) {
    expect(openAppInputSchema.safeParse({ input: { value } }).success).toBe(false)
  }
})

test("normal scopes, editor denial and fresh-session failures remain visible", async () => {
  let writes = 0
  await withClient(async (client) => {
    for (const name of ["create_app", "update_app"]) {
      const result = await client.callTool({ name, arguments: name === "create_app" ? source : { ...source, appId, expectedRevisionId: revisionId } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain("insufficient_mcp_scope")
    }
    expect((await client.callTool({ name: app.toolName, arguments: {} })).isError).not.toBe(true)
    const read = await client.callTool({ name: "read_app", arguments: { appId } })
    expect(read.isError).toBe(true)
    expect(JSON.stringify(read)).not.toContain(source.reactSource)
    expect(writes).toBe(0)
  }, {
    create: async () => { writes += 1; return app },
    read: async () => { throw new AuthoredAppError("forbidden", "Editor access is required.") },
  }, ["mcp:read"])
  await withClient(async (client) => {
    const result = await client.callTool({ name: "update_app", arguments: { ...source, appId, expectedRevisionId: revisionId } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain("fresh_session_required")
    expect(JSON.stringify(result)).toContain("reauth")
  }, { update: async () => { throw new AuthoredAppError("reauth", "Sign in again.", "fresh_session_required") } })
  await withClient(async (client) => {
    expect((await client.callTool({ name: "read_app", arguments: { appId } })).isError).toBe(true)
    expect((await client.listTools()).tools.some((tool) => tool.name === app.toolName)).toBe(false)
  }, {}, ["mcp:write"])
})

test("resource reads and launch recheck access; callback failures never expose raw errors", async () => {
  let denied = false
  await withClient(async (client) => {
    await client.readResource({ uri: app.resourceUri })
    denied = true
    await expect(client.readResource({ uri: app.resourceUri })).rejects.toThrow("not available")
    expect((await client.callTool({ name: app.toolName, arguments: {} })).isError).toBe(true)
    const result = await client.callTool({ name: "create_app", arguments: source })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain("credential-marker")
    expect(JSON.stringify(result)).not.toContain("stack")
  }, {
    create: async () => { throw new Error("credential-marker raw stack") },
    loadResource: async () => {
      if (denied) throw new AuthoredAppError("mcp_app_not_found", "App is not available.")
      return resource()
    },
  })
})

test("search matches advertise only the exact direct launch and generic execution is an instruction", () => {
  const matches = searchAuthoredMcpApps([app], "project")
  expect(matches).toHaveLength(1)
  expect(matches[0]).toMatchObject({ name: app.toolName, kind: "mcp_app", mcpApp: { resourceUri: app.resourceUri }, hasBody: false })
  expect(matches[0]).not.toHaveProperty("scriptPath")
  const instruction = authoredAppLaunchInstruction(app)
  expect(instruction.structuredContent.status).toBe("direct_tool_required")
  expect(instruction.content[0]?.text).toContain(app.toolName)
  expect(JSON.stringify(instruction)).not.toContain("openwork/mcpApp")
  expect(JSON.stringify(instruction)).not.toContain(html)
  expect(APP_AUTHORING_GUIDANCE).toContain("autoResize:true")
  expect(APP_AUTHORING_GUIDANCE).toContain("app.sendSizeChanged({ height })")
  expect(APP_AUTHORING_GUIDANCE).toContain("{ app, input, result, hostContext }")
})

test("fresh HTTP servers discover a newly created App and read older exact revision resources", async () => {
  const handlers = createScopedAgentMcpHttpHandlers()
  let current: McpAppSummary | null = null
  let instances = 0
  let listCalls = 0
  const loads: string[] = []
  const requestSchema = z.object({ method: z.string(), params: z.object({ name: z.string().optional(), uri: z.string().optional() }).optional() })
  const client = new Client({ name: "http-standard-host", version: "1" }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL("https://openwork.example.test/mcp/agent"), {
    fetch: async (url, init) => {
      const request = new Request(url, init)
      const body = requestSchema.parse(await request.clone().json())
      instances += 1
      const server = new McpServer({ name: "fresh-apps", version: "1" }, { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } })
      await registerAgentAuthoredApps({
        server,
        scopes: new Set(["mcp:read", "mcp:write"]),
        request: { method: body.method, toolName: body.params?.name ?? null, resourceUri: body.params?.uri ?? null },
        service: service({
          list: async () => { listCalls += 1; return current ? [current] : [] },
          create: async () => { current = app; return app },
          update: async () => { current = nextApp; return nextApp },
          loadResource: async ({ revisionId: id }) => { loads.push(id); return resource(id === nextRevisionId ? nextApp : app) },
        }),
        notifyCatalogChanged: () => { handlers.notify.toolsChanged("member"); handlers.notify.resourcesChanged("member") },
      })
      return handlers.fetch("member", request, server)
    },
  }))
  try {
    expect(listCalls).toBe(0)
    await client.callTool({ name: "create_app", arguments: source })
    expect((await client.listTools()).tools.find((tool) => tool.name === app.toolName)?._meta).toMatchObject({ ui: { resourceUri: app.resourceUri } })
    expect((await client.callTool({ name: app.toolName, arguments: {} })).structuredContent).toEqual({ app, input: {} })
    await client.callTool({ name: "update_app", arguments: { ...source, appId, expectedRevisionId: revisionId } })
    const old = await client.readResource({ uri: app.resourceUri })
    expect(old.contents[0]).toMatchObject({ text: html })
    const latest = await client.callTool({ name: app.toolName, arguments: {} })
    expect(latest.structuredContent).toEqual({ app: nextApp, input: {} })
    expect(loads).toEqual([revisionId, revisionId, nextRevisionId])
    expect(listCalls).toBe(3)
    expect(instances).toBeGreaterThanOrEqual(7)
  } finally { await client.close(); await handlers.close() }
})
