import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { ConfigObjectTable, ConfigObjectVersionTable, MemberTable, OrganizationTable, PluginAccessGrantTable } from "@openwork-ee/den-db/schema"
import { mcpAppResourceUri, mcpAppToolName, MCP_APP_CONFIG_SCHEMA_VERSION, type McpAppSummary } from "@openwork/types/mcp-app"
import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Hono } from "hono"
import * as Effect from "effect/Effect"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const appId = createDenTypeId("configObject")
const revisionId = createDenTypeId("configObjectVersion")
const nextRevisionId = createDenTypeId("configObjectVersion")
const pluginId = createDenTypeId("plugin")
const now = new Date()
const context: PluginArchActorContext = {
  memberTeams: [], session: null,
  organizationContext: {
    organization: { id: organizationId, name: "App test", slug: "app-test", logo: null, allowedEmailDomains: null, metadata: null, createdAt: now, updatedAt: now },
    currentMember: { id: memberId, userId, role: "member", directRole: "member", adminTeams: [], createdAt: now, joinedAt: now, isOwner: false },
    invitations: [], members: [], roles: [], teams: [],
  },
}
const source = { title: "Project explorer", textFallback: "Open Project explorer.", reactSource: "export default function App() { return <main>source-marker</main> }" }
const appSummary: McpAppSummary = {
  appId, pluginId, revisionId, title: source.title, description: null, textFallback: source.textFallback,
  toolName: mcpAppToolName(appId), resourceUri: mcpAppResourceUri(appId, revisionId),
}
const nextSummary = { ...appSummary, revisionId: nextRevisionId, resourceUri: mcpAppResourceUri(appId, nextRevisionId) }
let current: McpAppSummary | null = null
let scopes = new Set(["mcp:read", "mcp:write"])
let enabled = true
let editor = true
let visible = true
let memberPresent = true
let mutationError: Error | null = null
let catalogError: Error | null = null
const created: unknown[] = []
const resourceReads: unknown[] = []
let normalExecutions: unknown[] = []
let workflowCreations = 0
let registerAgentMcpRoutes: typeof import("../src/mcp/agent.js")["registerAgentMcpRoutes"]
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
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL ??= "http://127.0.0.1:8790"
  process.env.DEN_GENERATED_ARTIFACT_VIEWS_ENABLED = "false"
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
  const external = await import("../src/mcp/external-capabilities.js")
  spyOn(external, "resolveMcpMemberIdentity").mockImplementation(async () => memberPresent ? { orgMembershipId: memberId, teamIds: [] } : null)
  const orgs = await import("../src/orgs.js")
  spyOn(orgs, "getOrganizationContextForUser").mockImplementation(async () => context.organizationContext)
  spyOn(orgs, "listTeamsForMember").mockImplementation(async () => [])
  registry = await import("../src/mcp/capability-registry.js")
  spyOn(registry, "searchCapabilityRegistry").mockImplementation(async () => ({
    matches: current ? [{ name: `plugin:${pluginId}:${appId}`, method: "MCP", path: "", score: 10, summary: source.title, pathParams: [], queryParams: [], hasBody: false, kind: "app" }] : [],
  }))
  spyOn(registry, "executeCapability").mockImplementation(async (ctx, request) => {
    normalExecutions.push({ scopes: [...ctx.principal.scopes], request })
    return { content: [{ type: "text", text: "ordinary result" }], structuredContent: { ordinary: true }, _meta: { "provider/unchanged": true } }
  })
  apps = await import("../src/mcp-apps.js")
  access = await import("../src/routes/org/plugin-system/access.js")
  marketplace = await import("../src/mcp/marketplace-capabilities.js")
  spyOn(apps, "createMcpApp").mockImplementation(async (request) => {
    created.push(request)
    if (mutationError) throw mutationError
    current = appSummary
    return current
  })
  spyOn(apps, "updateMcpApp").mockImplementation(async (request) => {
    if (mutationError) throw mutationError
    expect(request.context).toEqual(context)
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
    expect(request).toEqual({ organizationId, member: memberPresent ? { orgMembershipId: memberId, teamIds: [] } : null, enabled })
    return current && visible && memberPresent && enabled ? [current] : []
  })
  spyOn(apps, "loadMcpAppResource").mockImplementation(async (request) => {
    resourceReads.push(request)
    if (!visible || !memberPresent || !enabled) throw new apps.McpAppError(404, "mcp_app_not_found", "MCP App or revision is not available.")
    return {
      app: request.revisionId === nextRevisionId ? nextSummary : appSummary,
      html: "<!doctype html><html><body>compiled-marker</body></html>",
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, resourceDigest: "sha256:" + "0".repeat(64),
    }
  })
  const store = await import("../src/routes/org/plugin-system/store.js")
  spyOn(store, "createConfigObject").mockImplementation(async () => { workflowCreations += 1; throw new Error("Unexpected Workflow creation") })
  registerAgentMcpRoutes = (await import("../src/mcp/agent.js")).registerAgentMcpRoutes
})

beforeEach(() => {
  current = null
  scopes = new Set(["mcp:read", "mcp:write"])
  enabled = editor = visible = memberPresent = grant = true
  useMarketplaceFixture = false
  mutationError = catalogError = null
  created.length = resourceReads.length = workflowCreations = 0
  normalExecutions = []
  version = { schemaVersion: MCP_APP_CONFIG_SCHEMA_VERSION, normalizedPayloadJson: { kind: "authored_mcp_app", html: "compiled-marker" }, rawSourceText: source.reactSource }
})
afterAll(() => mock.restore())

async function withClient(run: (client: Client) => Promise<void>) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  app.use("*", async (c, next) => { c.set("requestId", "req_authored_apps"); await next() })
  app.get("/openapi.json", (c) => c.json({ paths: {} }))
  registerAgentMcpRoutes(app)
  const client = new Client({ name: "route-client", version: "1" }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8790/mcp/agent"), {
    fetch: (url, init) => app.request(new Request(url, init)),
  }))
  try { await run(client) } finally { await client.close() }
}

test("agent route wires the library actor and fresh HTTP create/read/update/open/resource requests", async () => {
  await withClient(async (client) => {
    const createdResult = await client.callTool({ name: "create_app", arguments: source })
    expect(createdResult.structuredContent).toEqual({ app: appSummary })
    expect(createdResult._meta).toBeUndefined()
    expect(created).toEqual([{ ...source, context }])
    expect(workflowCreations).toBe(0)
    expect(normalExecutions).toEqual([])
    expect((await client.callTool({ name: "read_app", arguments: { appId } })).structuredContent).toMatchObject({ reactSource: source.reactSource })
    expect((await client.listTools()).tools.find((tool) => tool.name === appSummary.toolName)?._meta).toMatchObject({ ui: { resourceUri: appSummary.resourceUri } })
    await client.callTool({ name: "update_app", arguments: { ...source, appId, expectedRevisionId: revisionId } })
    expect((await client.callTool({ name: appSummary.toolName, arguments: { input: { title: "Caller" } } })).structuredContent).toEqual({ app: nextSummary, input: { title: "Caller" } })
    expect((await client.readResource({ uri: appSummary.resourceUri })).contents[0]).toMatchObject({ uri: appSummary.resourceUri, text: expect.stringContaining("compiled-marker") })
    expect(resourceReads).toEqual([
      { organizationId, member: { orgMembershipId: memberId, teamIds: [] }, enabled: true, appId, revisionId: nextRevisionId },
      { organizationId, member: { orgMembershipId: memberId, teamIds: [] }, enabled: true, appId, revisionId },
    ])
    expect(normalExecutions).toEqual([])
  })
})

test("search returns direct authored App matches only for the applicable source filters", async () => {
  current = appSummary
  await withClient(async (client) => {
    for (const type of ["all", "mcp", "marketplace", "api", "admin", "skills"]) {
      const result = await client.callTool({ name: "search_capabilities", arguments: { query: "project", type } })
      const text = JSON.stringify(result.structuredContent)
      if (["all", "mcp", "marketplace"].includes(type)) {
        expect(text).toContain(appSummary.toolName)
        expect(text).toContain(appSummary.resourceUri)
        expect(text).toContain('"kind":"mcp_app"')
        expect(text).not.toContain(`plugin:${pluginId}:${appId}`)
      } else {
        expect(text).not.toContain(appSummary.toolName)
      }
    }
    const instruction = await client.callTool({ name: "execute_capability", arguments: { name: appSummary.toolName } })
    expect(instruction.structuredContent).toMatchObject({ status: "direct_tool_required", app: appSummary })
    expect(instruction._meta).toBeUndefined()
    expect(normalExecutions).toEqual([])
    expect(resourceReads).toEqual([])
    const request = { name: "plugin:ordinary:workflow", body: { custom: true } }
    const ordinary = await client.callTool({ name: "execute_capability", arguments: request })
    expect(ordinary.structuredContent).toEqual({ ordinary: true })
    expect(ordinary._meta).toEqual({ "provider/unchanged": true })
    expect(normalExecutions).toEqual([{ scopes: ["mcp:read", "mcp:write"], request }])
  })
})

test("agent route preserves feature exposure, scope, editor and fresh-session errors", async () => {
  current = appSummary
  await withClient(async (client) => {
    scopes = new Set(["mcp:read"])
    const denied = await client.callTool({ name: "create_app", arguments: source })
    expect(JSON.stringify(denied)).toContain("insufficient_mcp_scope")
    expect(created).toEqual([])
    editor = false
    expect(JSON.stringify(await client.callTool({ name: "read_app", arguments: { appId } }))).toContain("forbidden")
    scopes.add("mcp:write")
    mutationError = new access.PluginArchAuthorizationError(403, "reauth", "Sign in again.", "fresh_session_required")
    const reauth = await client.callTool({ name: "update_app", arguments: { ...source, appId, expectedRevisionId: revisionId } })
    expect(JSON.stringify(reauth)).toContain("fresh_session_required")
    mutationError = new Error("credential-marker stack-marker")
    const failed = await client.callTool({ name: "create_app", arguments: source })
    expect(JSON.stringify(failed)).toContain("mcp_app_unavailable")
    expect(JSON.stringify(failed)).not.toContain("credential-marker")
    catalogError = new Error("credential-marker raw catalog stack")
    for (const request of [
      { name: "search_capabilities", arguments: { query: "project" } },
      { name: "execute_capability", arguments: { name: appSummary.toolName } },
    ]) {
      const failedCatalog = await client.callTool(request)
      expect(failedCatalog.isError).toBe(true)
      expect(JSON.stringify(failedCatalog)).not.toContain("credential-marker")
      expect(JSON.stringify(failedCatalog)).toContain("App catalog could not be loaded")
    }
    catalogError = null
    visible = false
    await expect(client.readResource({ uri: appSummary.resourceUri })).rejects.toThrow("not available")
    memberPresent = false
    expect(JSON.stringify(await client.callTool({ name: "create_app", arguments: source }))).toContain("mcp_membership_revoked")
    enabled = false
    expect((await client.listTools()).tools.some((tool) => ["create_app", "update_app", "read_app", appSummary.toolName].includes(tool.name))).toBe(false)
    const search = await client.callTool({ name: "search_capabilities", arguments: { query: "project" } })
    expect(JSON.stringify(search)).not.toContain(appSummary.toolName)
  })
})

test("generic marketplace and Code Mode content fallback cannot return authored source or HTML", async () => {
  useMarketplaceFixture = true
  const registryContext = registry.createCapabilityRegistryContext({
    app: new Hono(), env: {}, catalog: [], principal: { userId, organizationId, scopes, payload: {} },
    organizationId, member: { orgMembershipId: memberId, teamIds: [] }, redirectUriBase: "http://127.0.0.1:8790",
    generatedArtifactViewsEnabled: false, organizationMetadata: null, mcpConnectionsGatingEnabled: false,
  })
  for (const schema of [MCP_APP_CONFIG_SCHEMA_VERSION, null]) {
    version.schemaVersion = schema
    const result = await marketplace.executeMarketplaceCapability({ organizationId, pluginId, configObjectId: appId, member: { orgMembershipId: memberId, teamIds: [] }, enabled: true })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected safe App fallback")
    expect(result.result.status).toBe("unsupported")
    expect(result.result.hint).toContain(appSummary.toolName)
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
    expect(String(codeModeContent)).toContain(appSummary.toolName)
    expect(result.result.definition).toBeUndefined()
    expect(result.result.source).toBeUndefined()
  }
  grant = false
  expect(await marketplace.executeMarketplaceCapability({ organizationId, pluginId, configObjectId: appId, member: { orgMembershipId: memberId, teamIds: [] } })).toMatchObject({ ok: false, error: "forbidden" })
  grant = true
  version = { schemaVersion: null, normalizedPayloadJson: { kind: "legacy_app" }, rawSourceText: "legacy-definition" }
  const legacy = await marketplace.executeMarketplaceCapability({ organizationId, pluginId, configObjectId: appId, member: { orgMembershipId: memberId, teamIds: [] } })
  expect(legacy).toMatchObject({ ok: true, result: { status: "unsupported", definition: "legacy-definition" } })
})
