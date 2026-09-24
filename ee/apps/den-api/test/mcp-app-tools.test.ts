import { Tool } from "@openwork/codemode"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { McpAppToolDeclaration } from "@openwork/types/mcp-app"
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

let appTools: typeof import("../src/mcp/app-tools.js")
let registry: typeof import("../src/mcp/capability-registry.js")
let marketplace: typeof import("../src/mcp/marketplace-capabilities.js")
let codemode: typeof import("../src/mcp/codemode-tools.js")
let treeBuilds = 0
let executions: unknown[] = []
let liveRuns: unknown[] = []
let workflowInputSchema: unknown = { type: "object", properties: { week: { type: "string" } } }

function tool(description: string, input: Record<string, unknown>) {
  return Tool.make({ description, input, run: () => Effect.succeed(null) })
}

function context() {
  return registry.createCapabilityRegistryContext({
    app: new Hono(), env: {}, catalog: [], principal: { userId, organizationId, scopes: new Set(["mcp:read", "mcp:write"]), payload: {} },
    organizationId, member, redirectUriBase: "http://127.0.0.1:8790",
    generatedArtifactViewsEnabled: false, organizationMetadata: null, mcpConnectionsGatingEnabled: false,
  })
}

beforeAll(async () => {
  mock.module("../src/db.js", () => ({ db: {} }))
  registry = await import("../src/mcp/capability-registry.js")
  marketplace = await import("../src/mcp/marketplace-capabilities.js")
  codemode = await import("../src/mcp/codemode-tools.js")
  appTools = await import("../src/mcp/app-tools.js")
  spyOn(registry, "buildCapabilityToolTree").mockImplementation(async () => {
    treeBuilds += 1
    return {
      tools: {
        den: { getProjects: tool("List projects", projectsSchema), postProjects: tool("Create a project", { type: "object" }) },
        notes: { create_note: tool("Create a note", noteSchema), search_notes: tool("Search notes", { type: "object" }) },
      },
      manifest: [
        { scriptPath: codemode.codemodeScriptPath("den", "getProjects"), capabilityName: "getProjects", readOnly: true, authority: "den" },
        { scriptPath: codemode.codemodeScriptPath("den", "postProjects"), capabilityName: "postProjects", readOnly: false, authority: "den" },
        { scriptPath: codemode.codemodeScriptPath("notes", "create_note"), capabilityName: "mcp:emc_notes:create_note", readOnly: false, authority: "external" },
        { scriptPath: codemode.codemodeScriptPath("notes", "search_notes"), capabilityName: "mcp:emc_notes:search_notes", readOnly: true, authority: "external" },
      ],
    }
  })
  spyOn(marketplace, "listAccessibleWorkflows").mockImplementation(async () => [{
    pluginId, configObjectId: workflowId, configObjectVersionId: createDenTypeId("configObjectVersion"),
    title: "Weekly summary", description: null, inputSchema: workflowInputSchema, outputSchema: null, requiredCapabilities: [],
  }])
  spyOn(registry, "executeCapability").mockImplementation(async (_ctx, request) => {
    executions.push(request)
    return { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } }
  })
  spyOn(marketplace, "executeMarketplaceCapability").mockImplementation(async (request) => {
    liveRuns.push({ pluginId: request.pluginId, configObjectId: request.configObjectId, liveRuntime: request.liveRuntime, body: request.body, member: request.member })
    return { ok: true, result: { status: "executed", value: { total: 3 } } }
  })
})

beforeEach(() => {
  treeBuilds = 0
  executions = []
  liveRuns = []
  workflowInputSchema = { type: "object", properties: { week: { type: "string" } } }
})
afterAll(() => mock.restore())

test("declared tools resolve into stored bindings and only Den-verified reads are read-only", async () => {
  const declarations: McpAppToolDeclaration[] = [
    { name: "list_projects", description: "List projects.", capability: "getProjects" },
    { name: "create_project", description: "Create a project.", capability: "postProjects" },
    { name: "create_note", description: "Create a note.", capability: "mcp:emc_notes:create_note" },
    { name: "search_notes", description: "Search notes.", capability: "mcp:emc_notes:search_notes" },
    { name: "weekly_summary", description: "This week's summary.", capability: workflow, mode: "live" },
    { name: "summary_for_week", description: "A chosen week's summary.", capability: workflow },
  ]
  const bindings = await appTools.resolveMcpAppTools(context(), declarations)
  expect(treeBuilds).toBe(1)
  expect(bindings.map(({ name, kind, mode, readOnly }) => ({ name, kind, mode, readOnly }))).toEqual([
    { name: "list_projects", kind: "api", mode: "input", readOnly: true },
    { name: "create_project", kind: "api", mode: "input", readOnly: false },
    { name: "create_note", kind: "mcp", mode: "input", readOnly: false },
    { name: "search_notes", kind: "mcp", mode: "input", readOnly: true },
    { name: "weekly_summary", kind: "workflow", mode: "live", readOnly: true },
    { name: "summary_for_week", kind: "workflow", mode: "input", readOnly: false },
  ])
  expect(bindings[0]?.inputSchema).toEqual(projectsSchema)
  expect(bindings[2]?.inputSchema).toEqual(noteSchema)
  expect(bindings[2]?.schemaDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(bindings[0]?.schemaDigest).toBeUndefined()
  expect(bindings[4]?.inputSchema).toEqual(appTools.LIVE_WORKFLOW_TOOL_INPUT_SCHEMA)
  expect(bindings[5]?.inputSchema).toEqual({ type: "object", properties: { week: { type: "string" } } })
})

test("declarations that cannot become App tools are rejected before anything is published", async () => {
  const rejected: Array<[McpAppToolDeclaration, string]> = [
    [{ name: "nothing", description: "Missing.", capability: "unknown:thing" }, "is not a capability name"],
    [{ name: "missing", description: "Missing.", capability: "getMissing" }, "is not available to you"],
    [{ name: "live_projects", description: "Live.", capability: "getProjects", mode: "live" }, "mode live applies only to saved Workflows"],
    [{ name: "skill", description: "A skill.", capability: `plugin:${pluginId}:${skillId}` }, "is not a saved Workflow you can use"],
    [{ name: "builtin_skill", description: "A skill.", capability: "skill:create-skill" }, "not skills, remote sessions, or admin tools"],
  ]
  for (const [declaration, reason] of rejected) {
    const failure = appTools.resolveMcpAppTools(context(), [declaration])
    await expect(failure).rejects.toMatchObject({ code: "mcp_app_tool_unavailable" })
    await expect(failure).rejects.toThrow(reason)
    await expect(failure).rejects.toThrow("No revision was published")
  }
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
    { name: "mcp:emc_notes:create_note", body: { text: "Ship it" }, schemaDigest: mcp.schemaDigest },
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
