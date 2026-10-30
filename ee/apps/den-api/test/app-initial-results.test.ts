import assert from "node:assert/strict"
import { test } from "node:test"
import { MCP_APP_INITIAL_RESULTS_META, type McpAppToolBinding } from "@openwork/types/mcp-app"
import { appStarter } from "../src/mcp/app-authoring-starter.js"
import { launchInitialResults, loadInitialResults, type McpAppLaunchDataStore } from "../src/mcp/app-launch-data.js"
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

function memoryStore() {
  const slots = new Map<string, unknown>()
  const store: McpAppLaunchDataStore = {
    async open(timeZone) {
      const key = timeZone ?? ""
      return { kept: slots.get(key) ?? null, save: async (results) => { slots.set(key, results) } }
    },
  }
  return { slots, store }
}

async function launch(store: McpAppLaunchDataStore | undefined, timeZone = "UTC", stillReadOnly: ((tool: McpAppToolBinding) => Promise<boolean>) | null = async () => true) {
  const calls: string[] = []
  const results = await launchInitialResults({
    tools: TOOLS, scopes: new Set([DEN_MCP_READ_SCOPE]), timeZone, store, stillReadOnly: stillReadOnly ?? undefined,
    callTool: async (tool) => { calls.push(tool.name); return { content: [{ type: "text", text: "ok" }] } },
  })
  return { results, calls }
}

test("a member's next open gets what their last open loaded at once, marked kept", async () => {
  const { slots, store } = memoryStore()
  const first = await launch(store)
  assert.equal(first.calls.length, 3)
  assert.equal(slots.size, 1)
  const second = await launch(store)
  assert.deepEqual(second.calls, [])
  assert.deepEqual(second.results.map((entry) => [entry.name, entry.kept]).sort(), [["broken_read", true], ["count_issues", true], ["load_mrr", true]])
  // Another time zone is another answer, loaded afresh.
  assert.equal((await launch(store, "Asia/Tokyo")).calls.length, 3)
})

test("kept launch data is used only while every read still passes its checks", async () => {
  const { slots, store } = memoryStore()
  await launch(store)
  // A provider revoked one read: nothing kept is shown, every read runs again through its checks.
  const revoked = await launch(store, "UTC", async (tool) => tool.name !== "load_mrr")
  assert.equal(revoked.calls.length, 3)
  assert.ok(revoked.results.every((entry) => entry.kept === undefined))
  assert.equal(slots.size, 1)
  // Without a way to recheck, kept data is never used.
  assert.equal((await launch(store, "UTC", null)).calls.length, 3)
})

test("kept launch data that does not parse, or a store that cannot keep it, loads afresh", async () => {
  const broken: McpAppLaunchDataStore = { open: async () => ({ kept: [{ name: 1 }], save: async () => {} }) }
  const brokenOpen = await launch(broken)
  assert.equal(brokenOpen.calls.length, 3)
  assert.ok(brokenOpen.results.every((entry) => entry.kept === undefined))
  // No slot, as when the inventory revision is unknown: nothing is kept or reused.
  const unavailable: McpAppLaunchDataStore = { open: async () => null }
  assert.equal((await launch(unavailable)).calls.length, 3)
  assert.equal((await launch(unavailable)).calls.length, 3)
})

test("Apps built from the starter read initial results, so new Apps load with their launch", () => {
  assert.ok(appStarter([binding({})]).reactSource.includes(MCP_APP_INITIAL_RESULTS_META))
})
