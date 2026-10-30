import assert from "node:assert/strict"
import { test } from "node:test"
import { MCP_APP_INITIAL_RESULTS_META, type McpAppToolBinding } from "@openwork/types/mcp-app"
import { appStarter } from "../src/mcp/app-authoring-starter.js"
import { loadInitialResults } from "../src/mcp/app-launch-data.js"
import type { ExecuteCapabilityToolResult } from "../src/mcp/capability-registry.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "../src/mcp/scopes.js"

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
  // Its author chose to load it on open, but no provider marks it read-only.
  binding({ name: "list_unlabeled", kind: "mcp", mode: "input", readOnly: false, loadOnOpen: true, capability: "mcp:unlabeled", inputSchema: { type: "object" } }),
  binding({ name: "find_customer", mode: "input", inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } }),
  binding({ name: "list_recent", kind: "api", mode: "input", capability: "recent", inputSchema: { type: "object", properties: { limit: { type: "number", default: 5 } } } }),
  binding({ name: "list_calls", kind: "mcp", mode: "input", capability: "mcp:calls", inputSchema: { type: "object" } }),
  binding({ name: "broken_read", kind: "api", mode: "input", capability: "broken", inputSchema: { type: "object" } }),
]

async function load(input: { scopes?: string[]; timeZone?: string; callTool?: (tool: McpAppToolBinding, args: Record<string, unknown>) => Promise<ExecuteCapabilityToolResult> } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const results = await loadInitialResults({
    tools: TOOLS,
    scopes: new Set(input.scopes ?? [DEN_MCP_READ_SCOPE]),
    timeZone: input.timeZone,
    callTool: async (tool, args) => {
      calls.push({ name: tool.name, args })
      if (input.callTool) return input.callTool(tool, args)
      if (tool.name === "broken_read") return { isError: true, content: [{ type: "text", text: "{\"error\":\"provider_failed\"}" }] }
      return { content: [{ type: "text", text: `${tool.name} answered` }], structuredContent: { tool: tool.name, args } }
    },
  })
  return { results, calls }
}

test("an App's read-only tools that need no input load with its launch, with the arguments each ran with", async () => {
  const { results, calls } = await load({ timeZone: "Europe/Paris" })
  // A tool needing a click, input, a default the App would send, or a scope the caller lacks never runs.
  assert.deepEqual(calls.map((call) => call.name).sort(), ["broken_read", "count_issues", "load_mrr"])
  // A failed read is left for the App to call itself.
  assert.deepEqual(results.map((entry) => [entry.name, entry.arguments]).sort(), [
    ["count_issues", {}],
    ["load_mrr", { timeZone: "Europe/Paris" }],
  ])
  assert.deepEqual(results.find((entry) => entry.name === "load_mrr")?.result.structuredContent, { tool: "load_mrr", args: { timeZone: "Europe/Paris" } })
})

test("a tool only its author chose to load on open waits for the App, even with every scope", async () => {
  const { calls } = await load({ scopes: [DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE] })
  assert.ok(calls.some((call) => call.name === "list_calls"))
  assert.ok(!calls.some((call) => call.name === "list_unlabeled"))
})

test("a read past its time budget is left out rather than holding the launch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let settled = false
  const loading = load({ callTool: (tool) => tool.name === "load_mrr"
    ? new Promise<ExecuteCapabilityToolResult>(() => {})
    : Promise.resolve({ content: [{ type: "text", text: "ok" }] }) })
  void loading.finally(() => { settled = true })
  // Advance in steps, so the budget expires whenever its timer started.
  for (let step = 0; step < 100 && !settled; step++) {
    t.mock.timers.tick(100)
    await new Promise((resolve) => setImmediate(resolve))
  }
  const { results } = await loading
  assert.deepEqual(results.map((entry) => entry.name).sort(), ["broken_read", "count_issues"])
})

test("Apps built from the starter read initial results, so new Apps load with their launch", () => {
  assert.ok(appStarter([binding({})]).reactSource.includes(MCP_APP_INITIAL_RESULTS_META))
})
