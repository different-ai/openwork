import { Tool } from "@openwork/codemode"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { McpAppToolBinding, McpAppToolDeclaration } from "@openwork/types/mcp-app"
import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Hono } from "hono"

process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"

const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const member = { orgMembershipId: createDenTypeId("member"), teamIds: [] }
const pluginId = createDenTypeId("plugin")
const workflowId = createDenTypeId("configObject")
const skillId = createDenTypeId("configObject")
const workflow = `plugin:${pluginId}:${workflowId}`
const projectsSchema = { type: "object", properties: { query: { type: "object", properties: { q: { type: "string" } } } } }
const noteSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
const providerSchemas: Record<string, Record<string, unknown>> = { create_note: noteSchema, search_notes: { type: "object" } }
const catalog = [
  { name: "getProjects", method: "GET", path: "/v1/projects", operation: {}, inputSchema: { type: "object" } },
  { name: "postProjects", method: "POST", path: "/v1/projects", operation: {}, inputSchema: { type: "object" } },
]

let appTools: typeof import("../src/mcp/app-tools.js")
let registry: typeof import("../src/mcp/capability-registry.js")
let marketplace: typeof import("../src/mcp/marketplace-capabilities.js")
let external: typeof import("../src/mcp/external-capabilities.js")
let codemode: typeof import("../src/mcp/codemode-tools.js")
let schemaDigest: typeof import("../src/mcp/external-mcp-tool-arguments.js").externalMcpToolSchemaDigest
let treeBuilds = 0
let catalogEnumerations = 0
let describes: string[] = []
let workflowLookups: string[][] = []
let executions: unknown[] = []
let liveRuns: unknown[] = []
let nextResult: import("../src/mcp/capability-registry.js").ExecuteCapabilityToolResult | null = null
let workflowInputSchema: unknown = { type: "object", properties: { week: { type: "string" } } }

function leaf(toolName: string, readOnly: boolean, input: Record<string, unknown>) {
  return {
    namespace: "den",
    toolName,
    scriptPath: codemode.codemodeScriptPath("den", toolName),
    capabilityName: toolName,
    readOnly,
    authority: "den" as const,
    definition: Tool.make({ description: toolName, input, run: () => Effect.succeed(null) }),
  }
}

function context() {
  return registry.createCapabilityRegistryContext({
    app: new Hono(), env: {}, catalog: catalog as never, principal: { userId, organizationId, scopes: new Set(["mcp:read", "mcp:write"]), payload: {} },
    organizationId, member, redirectUriBase: "http://127.0.0.1:8790",
    generatedArtifactViewsEnabled: false, organizationMetadata: null, mcpConnectionsGatingEnabled: false,
  })
}

beforeAll(async () => {
  mock.module("../src/auth.js", () => ({ auth: {} }))
  mock.module("../src/db.js", () => ({ db: {} }))
  registry = await import("../src/mcp/capability-registry.js")
  marketplace = await import("../src/mcp/marketplace-capabilities.js")
  external = await import("../src/mcp/external-capabilities.js")
  codemode = await import("../src/mcp/codemode-tools.js")
  schemaDigest = (await import("../src/mcp/external-mcp-tool-arguments.js")).externalMcpToolSchemaDigest
  appTools = await import("../src/mcp/app-tools.js")
  spyOn(registry, "buildCapabilityToolTree").mockImplementation(async () => {
    treeBuilds += 1
    return { tools: {}, manifest: [] }
  })
  spyOn(registry.CAPABILITY_SOURCES.catalog, "enumerate").mockImplementation(() => {
    catalogEnumerations += 1
    return Promise.resolve([leaf("getProjects", true, projectsSchema), leaf("postProjects", false, { type: "object" })])
  })
  spyOn(external, "describeExternalCapability").mockImplementation(async (request) => {
    describes.push(request.toolName)
    const inputSchema = providerSchemas[request.toolName]
    return inputSchema
      ? { ok: true, inputSchema }
      : { ok: false, error: "unknown_capability", message: `No current tool named "${request.toolName}" exists on "Notes".` }
  })
  spyOn(marketplace, "listAccessibleWorkflows").mockImplementation(async (request) => {
    workflowLookups.push([...request.configObjectIds ?? []])
    return [{
      pluginId, configObjectId: workflowId, configObjectVersionId: createDenTypeId("configObjectVersion"),
      title: "Weekly summary", description: null, inputSchema: workflowInputSchema, outputSchema: null, requiredCapabilities: [],
    }]
  })
  spyOn(registry, "executeCapability").mockImplementation(async (_ctx, request) => {
    executions.push(request)
    return nextResult ?? { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } }
  })
  spyOn(marketplace, "executeMarketplaceCapability").mockImplementation(async (request) => {
    liveRuns.push({ pluginId: request.pluginId, configObjectId: request.configObjectId, liveRuntime: request.liveRuntime, body: request.body, member: request.member })
    return { ok: true, result: { status: "executed", value: { total: 3 } } }
  })
})

beforeEach(() => {
  treeBuilds = 0
  catalogEnumerations = 0
  describes = []
  workflowLookups = []
  executions = []
  liveRuns = []
  nextResult = null
  workflowInputSchema = { type: "object", properties: { week: { type: "string" } } }
})
afterAll(() => mock.restore())

test("declared tools resolve one capability at a time, and only reads Den verifies are read-only", async () => {
  const declarations: McpAppToolDeclaration[] = [
    { name: "list_projects", description: "List projects.", capability: "getProjects" },
    { name: "create_note", description: "Create a note.", capability: "mcp:emc_notes:create_note" },
    { name: "search_notes", description: "Search notes.", capability: "mcp:emc_notes:search_notes" },
    { name: "weekly_summary", description: "This week's summary.", capability: workflow, mode: "live" },
    { name: "summary_for_week", description: "A chosen week's summary.", capability: workflow },
  ]
  const bindings = await appTools.resolveMcpAppTools(context(), declarations)
  // No whole capability tree: only the named connection tools are described.
  expect(treeBuilds).toBe(0)
  expect(catalogEnumerations).toBe(1)
  expect(describes).toEqual(["create_note", "search_notes"])
  expect(workflowLookups).toEqual([[workflowId]])
  expect(bindings.map(({ name, kind, mode, readOnly }) => ({ name, kind, mode, readOnly }))).toEqual([
    { name: "list_projects", kind: "api", mode: "input", readOnly: true },
    { name: "create_note", kind: "mcp", mode: "input", readOnly: false },
    // A provider's own read-only hint never makes a tool run without a click.
    { name: "search_notes", kind: "mcp", mode: "input", readOnly: false },
    { name: "weekly_summary", kind: "workflow", mode: "live", readOnly: true },
    { name: "summary_for_week", kind: "workflow", mode: "input", readOnly: false },
  ])
  expect(bindings[0]?.inputSchema).toEqual(projectsSchema)
  expect(bindings[1]?.inputSchema).toEqual(noteSchema)
  expect(bindings[1]?.schemaDigest).toBe(schemaDigest(noteSchema))
  expect(bindings[0]?.schemaDigest).toBeUndefined()
  expect(bindings[3]?.inputSchema).toEqual(appTools.LIVE_WORKFLOW_TOOL_INPUT_SCHEMA)
  expect(bindings[4]?.inputSchema).toEqual({ type: "object", properties: { week: { type: "string" } } })
})

test("declarations that cannot become App tools are rejected before anything is published", async () => {
  const rejected: Array<[McpAppToolDeclaration, string]> = [
    [{ name: "nothing", description: "Missing.", capability: "unknown:thing" }, "is not a capability name"],
    [{ name: "missing", description: "Missing.", capability: "getMissing" }, "is not available to you"],
    [{ name: "create_project", description: "Create a project.", capability: "postProjects" }, "changes data. Apps can read with OpenWork actions; to change something, bind a saved Workflow"],
    [{ name: "wipe_notes", description: "Wipe notes.", capability: "mcp:emc_notes:wipe_notes" }, "No current tool named \"wipe_notes\""],
    [{ name: "live_projects", description: "Live.", capability: "getProjects", mode: "live" }, "mode live applies only to saved Workflows"],
    [{ name: "skill", description: "A skill.", capability: `plugin:${pluginId}:${skillId}` }, "is not a saved Workflow you can use"],
    [{ name: "builtin_skill", description: "A skill.", capability: "skill:create-skill" }, "not skills, remote sessions, or admin tools"],
  ]
  for (const [declaration, reason] of rejected) {
    const failure = appTools.resolveMcpAppTools(context(), [declaration])
    await expect(failure).rejects.toMatchObject({ code: "mcp_app_tool_unavailable" })
    await expect(failure).rejects.toThrow(`Tool ${declaration.name}: `)
    await expect(failure).rejects.toThrow(reason)
    await expect(failure).rejects.toThrow("No revision was published")
  }
  // The first failing declaration in order is reported, however they settle.
  await expect(appTools.resolveMcpAppTools(context(), [
    { name: "list_projects", description: "List projects.", capability: "getProjects" },
    { name: "create_project", description: "Create a project.", capability: "postProjects" },
    { name: "wipe_notes", description: "Wipe notes.", capability: "mcp:emc_notes:wipe_notes" },
  ])).rejects.toThrow("Tool create_project: ")
  workflowInputSchema = { type: "string" }
  await expect(appTools.resolveMcpAppTools(context(), [{ name: "summary", description: "Summary.", capability: workflow }])).rejects.toThrow("must describe an object")
  expect((await appTools.resolveMcpAppTools(context(), [{ name: "summary", description: "Summary.", capability: workflow, mode: "live" }]))[0]?.readOnly).toBe(true)
})

test("each binding reaches its capability as the caller with the capability's own argument shape", async () => {
  const [api, mcp, live, input] = await appTools.resolveMcpAppTools(context(), [
    { name: "list_projects", description: "List projects.", capability: "getProjects" },
    { name: "create_note", description: "Create a note.", capability: "mcp:emc_notes:create_note" },
    { name: "weekly_summary", description: "This week's summary.", capability: workflow, mode: "live" },
    { name: "summary_for_week", description: "A chosen week's summary.", capability: workflow },
  ])
  if (!api || !mcp || !live || !input) throw new Error("Expected four bindings")
  const ctx = context()
  await appTools.callMcpAppTool(ctx, api, { query: { q: "roadmap" }, ignored: true })
  await appTools.callMcpAppTool(ctx, mcp, { text: "Ship it" })
  await appTools.callMcpAppTool(ctx, input, { week: "2026-W39" })
  expect(executions).toEqual([
    { name: "getProjects", path: undefined, query: { q: "roadmap" }, body: undefined },
    // The provider must still advertise the schema the App was published against.
    { name: "mcp:emc_notes:create_note", body: { text: "Ship it" }, schemaDigest: mcp.schemaDigest, requireSchemaMatch: true },
    { name: workflow, body: { week: "2026-W39" } },
  ])
  const result = await appTools.callMcpAppTool(ctx, live, { timeZone: "Europe/Paris", week: "ignored" })
  expect(result.structuredContent).toEqual({ status: "executed", value: { total: 3 } })
  await appTools.callMcpAppTool(ctx, live, {})
  expect(liveRuns).toEqual([
    { pluginId, configObjectId: workflowId, liveRuntime: { timeZone: "Europe/Paris" }, body: undefined, member },
    { pluginId, configObjectId: workflowId, liveRuntime: {}, body: undefined, member },
  ])
})

test("every call rechecks that an OpenWork action only reads, and drops launch hints meant for the agent server", async () => {
  const ctx = context()
  const write: McpAppToolBinding = { name: "create_project", description: "Create a project.", capability: "postProjects", kind: "api", mode: "input", inputSchema: { type: "object" }, readOnly: true }
  const blocked = await appTools.callMcpAppTool(ctx, write, { body: { name: "Launch" } })
  expect(blocked.isError).toBe(true)
  expect(JSON.parse(blocked.content[0]?.type === "text" ? blocked.content[0].text : "{}")).toMatchObject({ error: "policy_blocked" })
  expect(executions).toEqual([])

  const [api] = await appTools.resolveMcpAppTools(ctx, [{ name: "list_projects", description: "List projects.", capability: "getProjects" }])
  if (!api) throw new Error("Expected a binding")
  nextResult = {
    isError: true,
    content: [{ type: "text", text: "{\"error\":\"needs_connection\"}" }],
    _meta: {
      "openwork/mcpApp": { toolName: "connection_action", resourceUri: "ui://openwork/connection-action", arguments: {} },
      "openwork/serverTools": { searchCapabilities: "search_capabilities", executeCapability: "execute_capability" },
      "openwork/schemaGuidance": { warnings: [] },
    },
  }
  expect((await appTools.callMcpAppTool(ctx, api, {}))._meta).toEqual({ "openwork/schemaGuidance": { warnings: [] } })
  nextResult = { content: [{ type: "text", text: "ok" }], _meta: { "openwork/mcpApp": { toolName: "connection_action" } } }
  expect("_meta" in await appTools.callMcpAppTool(ctx, api, {})).toBe(false)
})
