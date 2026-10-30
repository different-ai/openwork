import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { MCP_APP_INITIAL_RESULTS_META, MCP_APP_LAUNCH_TOOL_NAME, type McpAppToolBinding } from "@openwork/types/mcp-app"
import type { ExecuteCapabilityToolResult } from "../src/mcp/capability-registry.js"

// The modules' default adapters still need a valid local configuration at import time.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/app_initial_results_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-app-initial-results-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-app-initial-results-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the modules initialize, without SQL I/O.
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { createMcpAppServer } = await import("../src/mcp/app-server.js")
const { appStarter } = await import("../src/mcp/app-authoring-starter.js")
const { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } = await import("../src/mcp/scopes.js")

const binding = (overrides: Partial<McpAppToolBinding>): McpAppToolBinding => ({
  name: "load_mrr",
  description: "Reads live revenue.",
  capability: "plugin:plg_1:cob_1",
  kind: "workflow",
  mode: "live",
  inputSchema: { type: "object", properties: { timeZone: { type: "string" } } },
  readOnly: true,
  ...overrides,
})

const TOOLS = [
  binding({}),
  binding({ name: "count_issues", kind: "api", mode: "input", capability: "issues", inputSchema: { type: "object" } }),
  binding({ name: "create_invoice", readOnly: false, mode: "input", inputSchema: { type: "object" } }),
  binding({ name: "find_customer", mode: "input", inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } }),
  binding({ name: "list_recent", mode: "input", inputSchema: { type: "object", properties: { limit: { type: "number", default: 5 } } } }),
  binding({ name: "list_calls", kind: "mcp", mode: "input", capability: "mcp:calls", inputSchema: { type: "object" } }),
  binding({ name: "broken_read", kind: "api", mode: "input", capability: "broken", inputSchema: { type: "object" } }),
]

async function openApp(input: { loadsWithLaunch?: boolean; scopes?: string[]; args?: Record<string, unknown>; callTool?: (tool: McpAppToolBinding, args: Record<string, unknown>) => Promise<ExecuteCapabilityToolResult> }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const server = createMcpAppServer({
    definition: {
      app: {
        appId: "cob_01m3qsv15ees78ra3gtb1yzfnj", pluginId: "plg_01m3qsv13ze75bs9tbb42936gm", revisionId: "cov_01m3qsv15ees78ra3pw7n0kt39",
        title: "Revenue", description: null, textFallback: "Revenue App", toolName: MCP_APP_LAUNCH_TOOL_NAME,
        resourceUri: "ui://openwork/apps/cob_01m3qsv15ees78ra3gtb1yzfnj/revisions/cov_01m3qsv15ees78ra3pw7n0kt39/index.html",
        serverPath: "/mcp/agent/connections/cob_01m3qsv15ees78ra3gtb1yzfnj", tools: [],
      },
      tools: TOOLS,
      ...(input.loadsWithLaunch === false ? {} : { loadsWithLaunch: true }),
    },
    scopes: new Set(input.scopes ?? [DEN_MCP_READ_SCOPE]),
    loadResource: async () => { throw new Error("Unexpected resource read") },
    callTool: async (tool, args) => {
      calls.push({ name: tool.name, args })
      if (input.callTool) return input.callTool(tool, args)
      if (tool.name === "broken_read") return { isError: true, content: [{ type: "text", text: "{\"error\":\"provider_failed\"}" }] }
      return { content: [{ type: "text", text: `${tool.name} answered` }], structuredContent: { tool: tool.name, args } }
    },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name: MCP_APP_LAUNCH_TOOL_NAME, arguments: input.args ?? {} })
    return { result, calls }
  } finally {
    await client.close()
  }
}

test("opening an App runs its no-click reads that need no input and sends them with the launch", async () => {
  const { result, calls } = await openApp({ args: { timeZone: "Europe/Paris" } })
  // A tool needing a click, input, a default the App would send, or a scope the caller lacks never runs.
  assert.deepEqual(calls.map((call) => call.name).sort(), ["broken_read", "count_issues", "load_mrr"])
  const initial = result._meta?.[MCP_APP_INITIAL_RESULTS_META]
  assert.ok(Array.isArray(initial))
  // A failed read is left for the App to call itself; each result names the exact arguments it ran with.
  assert.deepEqual(initial.map((entry) => [entry.name, entry.arguments]).sort(), [
    ["count_issues", {}],
    ["load_mrr", { timeZone: "Europe/Paris" }],
  ])
  assert.deepEqual(initial.find((entry) => entry.name === "load_mrr")?.result.structuredContent, { tool: "load_mrr", args: { timeZone: "Europe/Paris" } })
  // The data stays out of what the model reads.
  assert.deepEqual(result.structuredContent, { app: result.structuredContent?.app, input: {} })
  assert.equal(JSON.stringify(result.content).includes("answered"), false)
})

test("a connection tool loads with the launch only when the caller may call it", async () => {
  const { calls } = await openApp({ scopes: [DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE] })
  assert.ok(calls.some((call) => call.name === "list_calls"))
})

test("an App built before initial results, or opened with input, runs nothing as it opens", async () => {
  for (const options of [{ loadsWithLaunch: false }, { args: { input: { customer: "acme" } } }]) {
    const { result, calls } = await openApp(options)
    assert.deepEqual(calls, [])
    assert.equal(result._meta?.[MCP_APP_INITIAL_RESULTS_META], undefined)
  }
})

test("a read past its time budget is left out rather than holding the launch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const opening = openApp({ callTool: (tool) => tool.name === "load_mrr"
    ? new Promise<ExecuteCapabilityToolResult>(() => {})
    : Promise.resolve({ content: [{ type: "text", text: "ok" }] }) })
  // Let the launch start every read, then pass the budget.
  for (let tick = 0; tick < 20; tick++) await Promise.resolve()
  t.mock.timers.tick(4_000)
  const { result } = await opening
  const initial = result._meta?.[MCP_APP_INITIAL_RESULTS_META]
  assert.ok(Array.isArray(initial))
  assert.deepEqual(initial.map((entry) => entry.name).sort(), ["broken_read", "count_issues"])
})

test("Apps built from the starter read initial results, so new Apps load with their launch", () => {
  assert.ok(appStarter([binding({})]).reactSource.includes(MCP_APP_INITIAL_RESULTS_META))
})
