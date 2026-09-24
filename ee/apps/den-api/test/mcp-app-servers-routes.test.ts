import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { ConfigObjectTable, ConfigObjectVersionTable, MemberTable, OrganizationTable, PluginAccessGrantTable } from "@openwork-ee/den-db/schema"
import {
  MCP_APP_CONFIG_SCHEMA_VERSION,
  MCP_APP_LAUNCH_TOOL_NAME,
  mcpAppResourceUri,
  mcpAppServerPath,
  type McpAppSummary,
  type McpAppToolBinding,
} from "@openwork/types/mcp-app"
import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Hono } from "hono"
import * as Effect from "effect/Effect"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

const origin = "http://127.0.0.1:8790"
const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const appId = createDenTypeId("configObject")
const otherAppId = createDenTypeId("configObject")
const revisionId = createDenTypeId("configObjectVersion")
const nextRevisionId = createDenTypeId("configObjectVersion")
const pluginId = createDenTypeId("plugin")
const member = { orgMembershipId: memberId, teamIds: [] }
const now = new Date()
const context: PluginArchActorContext = {
  memberTeams: [], session: null,
  organizationContext: {
    organization: { id: organizationId, name: "App test", slug: "app-test", logo: null, allowedEmailDomains: null, metadata: null, createdAt: now, updatedAt: now },
    currentMember: { id: memberId, userId, role: "member", directRole: "member", adminTeams: [], createdAt: now, joinedAt: now, isOwner: false },
    invitations: [], members: [], roles: [], teams: [],
  },
}
const bindings: McpAppToolBinding[] = [
  {
    name: "list_projects", description: "List projects.", capability: "getProjects", kind: "api", mode: "input",
    inputSchema: { type: "object", properties: { query: { type: "object" } } }, readOnly: true,
  },
  {
    name: "create_note", description: "Create a note.", capability: "mcp:emc_notes:create_note", kind: "mcp", mode: "input",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, readOnly: false,
    schemaDigest: `sha256:${"1".repeat(64)}`,
  },
]
const declarations = bindings.map(({ name, description, capability, mode }) => ({ name, description, capability, mode }))
const source = {
  title: "Project explorer",
  textFallback: "Open Project explorer.",
  reactSource: "export default function App() { return <main>source-marker</main> }",
  tools: declarations,
}

function summary(revision: string): McpAppSummary {
  return {
    appId, pluginId, revisionId: revision, title: source.title, description: null, textFallback: source.textFallback,
    toolName: MCP_APP_LAUNCH_TOOL_NAME, resourceUri: mcpAppResourceUri(appId, revision), serverPath: mcpAppServerPath(appId),
    tools: bindings.map(({ name, description, capability, mode, readOnly }) => ({ name, description, capability, mode, readOnly })),
  }
}

const appSummary = summary(revisionId)
const nextSummary = summary(nextRevisionId)
const appUrl = `${origin}${mcpAppServerPath(appId)}`
const launchMeta = (app: McpAppSummary) => ({
  "openwork/mcpApp": { connectionId: appId, toolName: MCP_APP_LAUNCH_TOOL_NAME, resourceUri: app.resourceUri, arguments: { input: {} } },
})

let current: McpAppSummary | null = null
let scopes = new Set(["mcp:read", "mcp:write"])
let enabled = true
let editor = true
let visible = true
let memberPresent = true
let mutationError: Error | null = null
let catalogError: Error | null = null
const created: unknown[] = []
const resolverCalls: unknown[] = []
const resourceReads: unknown[] = []
let normalExecutions: unknown[] = []
let workflowCreations = 0
let registerAgentMcpRoutes: typeof import("../src/mcp/agent.js")["registerAgentMcpRoutes"]
let registerExternalConnectionProxyRoutes: typeof import("../src/mcp/external-connection-proxy.js")["registerExternalConnectionProxyRoutes"]
let apps: typeof import("../src/mcp-apps.js")
let access: typeof import("../src/routes/org/plugin-system/access.js")
let marketplace: typeof import("../src/mcp/marketplace-capabilities.js")
let registry: typeof import("../src/mcp/capability-registry.js")
let version: { schemaVersion: string | null; normalizedPayloadJson: Record<string, unknown> | null; rawSourceText: string }
let grant = true
let useMarketplaceFixture = false

function rowsFor(table: unknown): unknown[] {
  if (table === OrganizationTable) return [{ metadata: { capabilities: { mcpConnections: enabled } } }]
  if (!useMarketplaceFixture) return []
  if (table === ConfigObjectTable) return [{
    configObject: { id: appId, objectType: "app", title: source.title, description: null },
    plugin: { id: pluginId, name: "Test Plugin" }, marketplace: null,
  }]
  if (table === MemberTable) return [{ id: memberId, role: "member" }]
  if (table === PluginAccessGrantTable && grant) return [{ resourceId: pluginId, orgMembershipId: memberId, orgWide: false, teamId: null, removedAt: null, role: "viewer" }]
  if (table === ConfigObjectVersionTable) return [{ id: revisionId, configObjectId: appId, ...version }]
  return []
}

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= origin
  process.env.DEN_API_PUBLIC_URL ??= origin
  process.env.DEN_GENERATED_ARTIFACT_VIEWS_ENABLED = "false"
  mock.module("../src/auth.js", () => ({
    auth: {},
    DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
    DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
    DEN_MCP_FIRST_PARTY_RESOURCES: [`${origin}/mcp/agent`],
    DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
    DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
    DEN_MCP_OAUTH_RESOURCE: `${origin}/mcp/agent`,
    DEN_MCP_RESOURCE: `${origin}/mcp`,
    DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
    DEN_MCP_RESOURCES: [`${origin}/mcp`],
    DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
  }))
  mock.module("../src/db.js", () => ({ db: {
    select: () => {
      let table: unknown
      const query = {
        from: (value: unknown) => { table = value; return query },
        innerJoin: () => query,
        leftJoin: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () => Promise.resolve(rowsFor(table)),
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rowsFor(table)).then(resolve),
      }
      return query
    },
  } }))
  mock.module("../src/mcp/auth.js", () => ({
    getMcpResourceContext: () => ({}),
    verifyMcpRequest: async () => ({ userId, organizationId, scopes, payload: {} }),
  }))
  const connections = await import("../src/capability-sources/external-mcp-connections.js")
  spyOn(connections, "listUsableExternalMcpConnections").mockImplementation(async () => [])
  spyOn(connections, "readyExternalMcpConnectionsForMember").mockImplementation(async () => [])
  const external = await import("../src/mcp/external-capabilities.js")
  spyOn(external, "resolveMcpMemberIdentity").mockImplementation(async () => memberPresent ? member : null)
  const orgs = await import("../src/orgs.js")
  spyOn(orgs, "getOrganizationContextForUser").mockImplementation(async () => context.organizationContext)
  spyOn(orgs, "listTeamsForMember").mockImplementation(async () => [])
  registry = await import("../src/mcp/capability-registry.js")
  spyOn(registry, "searchCapabilityRegistry").mockImplementation(async () => ({
    matches: [
      ...(current ? [{ name: `plugin:${pluginId}:${appId}`, method: "MCP", path: "", score: 10, summary: source.title, pathParams: [], queryParams: [], hasBody: false, kind: "app" }] : []),
      { name: `plugin:${pluginId}:${otherAppId}`, method: "MCP", path: "", score: 1, summary: "Project workflow", pathParams: [], queryParams: [], hasBody: true, kind: "workflow" },
    ],
  }))
  spyOn(registry, "executeCapability").mockImplementation(async (ctx, request) => {
    normalExecutions.push({ scopes: [...ctx.principal.scopes], member: ctx.member, request })
    return { content: [{ type: "text", text: "ordinary result" }], structuredContent: { ordinary: true }, _meta: { "provider/unchanged": true } }
  })
  const appTools = await import("../src/mcp/app-tools.js")
  spyOn(appTools, "resolveMcpAppTools").mockImplementation(async (ctx, tools) => {
    resolverCalls.push({ scopes: [...ctx.principal.scopes], member: ctx.member, tools })
    return bindings
  })
  apps = await import("../src/mcp-apps.js")
  access = await import("../src/routes/org/plugin-system/access.js")
  marketplace = await import("../src/mcp/marketplace-capabilities.js")
  spyOn(apps, "createMcpApp").mockImplementation(async ({ resolveTools, ...request }) => {
    if (mutationError) throw mutationError
    created.push({ ...request, resolved: await resolveTools(request.tools ?? []) })
    current = appSummary
    return current
  })
  spyOn(apps, "updateMcpApp").mockImplementation(async ({ resolveTools, ...request }) => {
    if (mutationError) throw mutationError
    expect(request.context).toEqual(context)
    expect(request.requireFreshSession).toBe(false)
    expect(await resolveTools(request.tools ?? [])).toEqual(bindings)
    current = nextSummary
    return current
  })
  spyOn(apps, "readMcpApp").mockImplementation(async (request) => {
    expect(request.context).toEqual(context)
    if (!editor) throw new access.PluginArchAuthorizationError(403, "forbidden", "Editor access is required.")
    return { app: current ?? appSummary, reactSource: source.reactSource, cssSource: "" }
  })
  spyOn(apps, "listAccessibleMcpApps").mockImplementation(async (request) => {
    if (catalogError) throw catalogError
    expect(request).toEqual({ organizationId, member: memberPresent ? member : null, enabled })
    return current && visible && memberPresent && enabled
      ? [{ appId, pluginId, revisionId: current.revisionId, title: current.title, description: current.description, serverPath: current.serverPath }]
      : []
  })
  spyOn(apps, "isActiveMcpApp").mockImplementation(async (request) => {
    expect(request.organizationId).toBe(organizationId)
    return current !== null && request.appId === appId
  })
  spyOn(apps, "loadMcpAppServerDefinition").mockImplementation(async (request) => {
    if (!current || !visible || !memberPresent || !request.enabled || request.appId !== appId) {
      throw new apps.McpAppError(404, "mcp_app_not_found", "MCP App or revision is not available.")
    }
    return { app: current, tools: bindings }
  })
  spyOn(apps, "loadMcpAppResource").mockImplementation(async (request) => {
    resourceReads.push(request)
    if (!visible || !memberPresent || !enabled || request.appId !== appId) throw new apps.McpAppError(404, "mcp_app_not_found", "MCP App or revision is not available.")
    return {
      app: request.revisionId === nextRevisionId ? nextSummary : appSummary,
      html: "<!doctype html><html><body>compiled-marker</body></html>",
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, resourceDigest: "sha256:" + "0".repeat(64),
    }
  })
  const store = await import("../src/routes/org/plugin-system/store.js")
  spyOn(store, "createConfigObject").mockImplementation(async () => { workflowCreations += 1; throw new Error("Unexpected Workflow creation") })
  registerAgentMcpRoutes = (await import("../src/mcp/agent.js")).registerAgentMcpRoutes
  registerExternalConnectionProxyRoutes = (await import("../src/mcp/external-connection-proxy.js")).registerExternalConnectionProxyRoutes
})

beforeEach(() => {
  current = null
  scopes = new Set(["mcp:read", "mcp:write"])
  enabled = editor = visible = memberPresent = grant = true
  useMarketplaceFixture = false
  mutationError = catalogError = null
  created.length = resolverCalls.length = resourceReads.length = workflowCreations = 0
  normalExecutions = []
  version = { schemaVersion: MCP_APP_CONFIG_SCHEMA_VERSION, normalizedPayloadJson: { kind: "authored_mcp_app", html: "compiled-marker" }, rawSourceText: source.reactSource }
})
afterAll(() => mock.restore())

async function withClient(path: string, run: (client: Client) => Promise<void>) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  app.use("*", async (c, next) => { c.set("requestId", "req_app_servers"); await next() })
  app.get("/openapi.json", (c) => c.json({ paths: {} }))
  registerAgentMcpRoutes(app)
  registerExternalConnectionProxyRoutes(app)
  const client = new Client({ name: "route-client", version: "1" }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}${path}`), {
    fetch: (url, init) => app.request(new Request(url, init)),
  }))
  try { await run(client) } finally { await client.close() }
}

test("create_app builds an App that opens in OpenWork and names its own MCP server", async () => {
  await withClient("/mcp/agent", async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(["create_app", "update_app", "read_app", "search_capabilities", "execute_capability"]))
    expect(names.some((name) => name.startsWith(MCP_APP_LAUNCH_TOOL_NAME))).toBe(false)

    const createdResult = await client.callTool({ name: "create_app", arguments: source })
    expect(createdResult.structuredContent).toEqual({ app: appSummary, input: {}, mcpUrl: appUrl })
    expect(createdResult._meta).toEqual(launchMeta(appSummary))
    expect(JSON.stringify(createdResult.content)).toContain(appUrl)
    expect(created).toEqual([{ ...source, context, requireFreshSession: false, resolved: bindings }])
    expect(resolverCalls).toEqual([{ scopes: ["mcp:read", "mcp:write"], member, tools: declarations }])
    expect(workflowCreations).toBe(0)
    expect(normalExecutions).toEqual([])

    expect((await client.callTool({ name: "read_app", arguments: { appId } })).structuredContent).toMatchObject({ reactSource: source.reactSource, app: { tools: appSummary.tools } })
    const updated = await client.callTool({ name: "update_app", arguments: { ...source, appId, expectedRevisionId: revisionId } })
    expect(updated.structuredContent).toEqual({ app: nextSummary, input: {}, mcpUrl: appUrl })
    expect(updated._meta).toEqual(launchMeta(nextSummary))
    expect(normalExecutions).toEqual([])
  })
})

test("the Connect server index lists each App as a directly exposed MCP server", async () => {
  current = appSummary
  const readIndex = async () => {
    let servers: unknown
    await withClient("/mcp/agent", async (client) => {
      const index = await client.readResource({ uri: "openwork://connect/mcp-servers/index.json" })
      const text = index.contents[0] && "text" in index.contents[0] ? index.contents[0].text : "{}"
      servers = JSON.parse(text).servers
    })
    return servers
  }
  expect(await readIndex()).toEqual([{ connectionId: appId, name: source.title, description: null, url: appUrl, exposeDirectly: true }])
  visible = false
  expect(await readIndex()).toEqual([])
  visible = true
  enabled = false
  expect(await readIndex()).toEqual([])
})

test("search and execute open a built App through its own server instead of its generic Plugin entry", async () => {
  current = appSummary
  await withClient("/mcp/agent", async (client) => {
    for (const type of ["all", "mcp", "marketplace", "api", "admin", "skills"]) {
      const result = await client.callTool({ name: "search_capabilities", arguments: { query: "project", type } })
      const matches = JSON.parse(JSON.stringify(result.structuredContent)).matches as Array<Record<string, unknown>>
      const appMatches = matches.filter((match) => match.name === `plugin:${pluginId}:${appId}`)
      if (["all", "mcp", "marketplace"].includes(type)) {
        expect(appMatches).toEqual([expect.objectContaining({ kind: "mcp_app", path: appSummary.serverPath, mcpApp: { resourceUri: appSummary.resourceUri } })])
        expect(JSON.stringify(appMatches)).toContain(appUrl)
      } else {
        expect(appMatches.some((match) => match.kind === "mcp_app")).toBe(false)
      }
      expect(matches.some((match) => match.name === `plugin:${pluginId}:${otherAppId}`)).toBe(true)
    }
    const opened = await client.callTool({ name: "execute_capability", arguments: { name: `plugin:${pluginId}:${appId}` } })
    expect(opened.structuredContent).toEqual({ app: appSummary, input: {}, mcpUrl: appUrl })
    expect(opened._meta).toEqual(launchMeta(appSummary))
    // A body object is the App's launch input, as a connection App gets its call arguments.
    const withInput = await client.callTool({ name: "execute_capability", arguments: { name: `plugin:${pluginId}:${appId}`, body: { project: "Apollo" } } })
    expect(withInput.structuredContent).toEqual({ app: appSummary, input: { project: "Apollo" }, mcpUrl: appUrl })
    expect(withInput._meta).toEqual({ "openwork/mcpApp": { ...launchMeta(appSummary)["openwork/mcpApp"], arguments: { input: { project: "Apollo" } } } })
    for (const body of ["Apollo", ["Apollo"], null]) {
      const ignored = await client.callTool({ name: "execute_capability", arguments: { name: `plugin:${pluginId}:${appId}`, body } })
      expect(ignored._meta).toEqual(launchMeta(appSummary))
    }
    expect(normalExecutions).toEqual([])
    expect(resourceReads).toEqual([])
    const request = { name: `plugin:${pluginId}:${otherAppId}`, body: { custom: true } }
    const ordinary = await client.callTool({ name: "execute_capability", arguments: request })
    expect(ordinary.structuredContent).toEqual({ ordinary: true })
    expect(ordinary._meta).toEqual({ "provider/unchanged": true })
    expect(normalExecutions).toEqual([{ scopes: ["mcp:read", "mcp:write"], member, request }])
  })
})

test("each App's own MCP server exposes only its launch tool, declared tools, and revisions, and runs tools as the caller", async () => {
  current = appSummary
  await withClient(appSummary.serverPath, async (client) => {
    const tools = (await client.listTools()).tools
    expect(tools.map((tool) => tool.name)).toEqual([MCP_APP_LAUNCH_TOOL_NAME, "list_projects", "create_note"])
    expect(tools[0]).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { ui: { resourceUri: appSummary.resourceUri, visibility: ["model", "app"] } },
    })
    expect(tools[1]).toMatchObject({ inputSchema: bindings[0]?.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false } })
    expect(tools[2]).toMatchObject({ inputSchema: bindings[1]?.inputSchema, annotations: { readOnlyHint: false, destructiveHint: true } })

    const opened = await client.callTool({ name: MCP_APP_LAUNCH_TOOL_NAME, arguments: { input: { team: "core" } } })
    expect(opened.structuredContent).toEqual({ app: appSummary, input: { team: "core" } })
    expect(opened.content).toEqual([{ type: "text", text: appSummary.textFallback }])
    expect(normalExecutions).toEqual([])

    expect((await client.callTool({ name: "list_projects", arguments: { query: { q: "roadmap" } } })).structuredContent).toEqual({ ordinary: true })
    await client.callTool({ name: "create_note", arguments: { text: "Ship it" } })
    expect(normalExecutions).toEqual([
      { scopes: ["mcp:read", "mcp:write"], member, request: { name: "getProjects", query: { q: "roadmap" } } },
      { scopes: ["mcp:read", "mcp:write"], member, request: { name: "mcp:emc_notes:create_note", body: { text: "Ship it" }, schemaDigest: bindings[1]?.schemaDigest } },
    ])

    expect((await client.listResources()).resources).toEqual([expect.objectContaining({ uri: appSummary.resourceUri, name: source.title, mimeType: "text/html;profile=mcp-app" })])
    expect((await client.readResource({ uri: appSummary.resourceUri })).contents[0]).toMatchObject({
      uri: appSummary.resourceUri, mimeType: "text/html;profile=mcp-app", text: expect.stringContaining("compiled-marker"),
    })
    await expect(client.readResource({ uri: mcpAppResourceUri(otherAppId, revisionId) })).rejects.toThrow("not an available revision")
    expect(resourceReads).toEqual([{ organizationId, member, enabled: true, appId, revisionId }])
    await expect(client.callTool({ name: "search_capabilities", arguments: { query: "project" } })).rejects.toThrow("is not available on Project explorer")
  })

  scopes = new Set(["mcp:read"])
  normalExecutions = []
  await withClient(appSummary.serverPath, async (client) => {
    expect((await client.callTool({ name: "list_projects", arguments: {} })).isError).not.toBe(true)
    const write = await client.callTool({ name: "create_note", arguments: { text: "Ship it" } })
    expect(write.isError).toBe(true)
    expect(JSON.stringify(write.content)).toContain("insufficient_mcp_scope")
    expect(normalExecutions).toHaveLength(1)
  })

  for (const change of [() => { visible = false }, () => { enabled = false }, () => { memberPresent = false }]) {
    scopes = new Set(["mcp:read", "mcp:write"])
    visible = enabled = memberPresent = true
    change()
    await expect(withClient(appSummary.serverPath, async () => undefined)).rejects.toThrow()
  }
})

test("builder errors keep scope, editor, fresh-session, and membership boundaries without leaking internals", async () => {
  current = appSummary
  await withClient("/mcp/agent", async (client) => {
    scopes = new Set(["mcp:read"])
    expect(JSON.stringify(await client.callTool({ name: "create_app", arguments: source }))).toContain("insufficient_mcp_scope")
    expect(created).toEqual([])
    editor = false
    expect(JSON.stringify(await client.callTool({ name: "read_app", arguments: { appId } }))).toContain("forbidden")
    scopes.add("mcp:write")
    mutationError = new access.PluginArchAuthorizationError(403, "reauth", "Sign in again.", "fresh_session_required")
    expect(JSON.stringify(await client.callTool({ name: "update_app", arguments: { ...source, appId, expectedRevisionId: revisionId } }))).toContain("fresh_session_required")
    mutationError = new Error("credential-marker stack-marker")
    const failed = await client.callTool({ name: "create_app", arguments: source })
    expect(JSON.stringify(failed)).toContain("mcp_app_unavailable")
    expect(JSON.stringify(failed)).not.toContain("credential-marker")
    mutationError = null
    catalogError = new Error("credential-marker raw catalog stack")
    const search = await client.callTool({ name: "search_capabilities", arguments: { query: "project" } })
    expect(JSON.stringify(search)).not.toContain("credential-marker")
    expect(JSON.stringify(search)).not.toContain('"kind":"mcp_app"')
    catalogError = null
    memberPresent = false
    expect(JSON.stringify(await client.callTool({ name: "create_app", arguments: source }))).toContain("mcp_membership_revoked")
  })
  memberPresent = true
  enabled = false
  await withClient("/mcp/agent", async (client) => {
    expect((await client.listTools()).tools.some((tool) => ["create_app", "update_app", "read_app"].includes(tool.name))).toBe(false)
    expect(JSON.stringify(await client.callTool({ name: "search_capabilities", arguments: { query: "project" } }))).not.toContain('"kind":"mcp_app"')
  })
})

test("Code Mode and generic Plugin execution cannot return App source or HTML", async () => {
  useMarketplaceFixture = true
  const registryContext = registry.createCapabilityRegistryContext({
    app: new Hono(), env: {}, catalog: [], principal: { userId, organizationId, scopes, payload: {} },
    organizationId, member, redirectUriBase: origin,
    generatedArtifactViewsEnabled: false, organizationMetadata: null, mcpConnectionsGatingEnabled: false,
  })
  for (const schema of [MCP_APP_CONFIG_SCHEMA_VERSION, null]) {
    version.schemaVersion = schema
    const result = await marketplace.executeMarketplaceCapability({ organizationId, pluginId, configObjectId: appId, member, enabled: true })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected safe App fallback")
    expect(result.result.status).toBe("unsupported")
    expect(result.result.hint).toContain(mcpAppServerPath(appId))
    expect(result.result.hint).toContain(MCP_APP_LAUNCH_TOOL_NAME)
    const generic = await registry.CAPABILITY_REGISTRY.execute(registryContext, { name: `plugin:${pluginId}:${appId}` })
    expect(JSON.stringify(generic)).not.toContain("source-marker")
    expect(JSON.stringify(generic)).not.toContain("compiled-marker")
    const leaves = await registry.CAPABILITY_SOURCES.marketplace.enumerate(registryContext)
    if ("excluded" in leaves) throw new Error("Expected marketplace Code Mode leaf")
    const leaf = leaves.find((entry) => entry.capabilityName === `plugin:${pluginId}:${appId}`)
    if (!leaf) throw new Error("Expected App Code Mode leaf")
    const codeModeContent = await Effect.runPromise(leaf.definition.run({}))
    expect(String(codeModeContent)).not.toContain("source-marker")
    expect(String(codeModeContent)).not.toContain("compiled-marker")
    expect(String(codeModeContent)).toContain(mcpAppServerPath(appId))
    expect(result.result.definition).toBeUndefined()
    expect(result.result.source).toBeUndefined()
  }
  grant = false
  expect(await marketplace.executeMarketplaceCapability({ organizationId, pluginId, configObjectId: appId, member })).toMatchObject({ ok: false, error: "forbidden" })
  grant = true
  version = { schemaVersion: null, normalizedPayloadJson: { kind: "legacy_app" }, rawSourceText: "legacy-definition" }
  const legacy = await marketplace.executeMarketplaceCapability({ organizationId, pluginId, configObjectId: appId, member })
  expect(legacy).toMatchObject({ ok: true, result: { status: "unsupported", definition: "legacy-definition" } })
})

test("with App servers off, Connect keeps its previous surface and App URLs refuse every request", async () => {
  current = appSummary
  const { env } = await import("../src/env.js")
  Object.assign(env, { appMcpServersEnabled: false })
  try {
    await withClient("/mcp/agent", async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      for (const builder of ["create_app", "update_app", "read_app"]) expect(names).not.toContain(builder)
      expect(client.getInstructions()).toContain("save_artifact_view and follow its prerequisites")
      expect(client.getInstructions()).not.toContain("create_app")
      const index = await client.readResource({ uri: "openwork://connect/mcp-servers/index.json" })
      const text = index.contents[0] && "text" in index.contents[0] ? index.contents[0].text : "{}"
      expect(JSON.parse(text).servers).toEqual([])
      const search = await client.callTool({ name: "search_capabilities", arguments: { query: "project" } })
      expect(JSON.stringify(search.structuredContent)).not.toContain('"kind":"mcp_app"')
    })
    await expect(withClient(appSummary.serverPath, async () => undefined)).rejects.toThrow()
  } finally {
    Object.assign(env, { appMcpServersEnabled: true })
  }
})
