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
  let opened = 0
  const store: McpAppLaunchDataStore = {
    async open(timeZone) {
      opened += 1
      const key = timeZone ?? ""
      return { kept: slots.get(key) ?? null, save: async (results) => { slots.set(key, results) } }
    },
  }
  return { slots, store, opens: () => opened }
}

// In these fixtures, OpenWork's own reads are the api tools.
const ownRead = (tool: McpAppToolBinding) => tool.kind === "api"

async function launch(store: McpAppLaunchDataStore | undefined, options: {
  timeZone?: string
  canKeep?: (tool: McpAppToolBinding) => boolean
  scopes?: string[]
  callTool?: Parameters<typeof launchInitialResults>[0]["callTool"]
} = {}) {
  const calls: string[] = []
  const results = await launchInitialResults({
    tools: TOOLS, scopes: new Set(options.scopes ?? [DEN_MCP_READ_SCOPE]), timeZone: options.timeZone ?? "UTC", store, canKeep: options.canKeep,
    callTool: async (tool, args) => {
      calls.push(tool.name)
      if (options.callTool) return options.callTool(tool, args)
      return tool.name === "broken_read" ? { isError: true, content: [] } : { content: [{ type: "text", text: "ok" }] }
    },
  })
  return { results, calls }
}

test("a member's next open checks every read before marking a matching OpenWork snapshot kept", async () => {
  const { slots, store } = memoryStore()
  const first = await launch(store, { canKeep: ownRead })
  assert.deepEqual(first.calls.sort(), ["broken_read", "count_issues", "load_mrr"])
  // A provider's data is never stored, nor a failed read.
  assert.deepEqual((slots.get("UTC") as Array<{ name: string }>).map((entry) => entry.name), ["count_issues"])
  const second = await launch(store, { canKeep: ownRead })
  assert.deepEqual(second.calls.sort(), ["broken_read", "count_issues", "load_mrr"])
  assert.deepEqual(second.results.map((entry) => [entry.name, entry.kept]).sort(), [["count_issues", true], ["load_mrr", undefined]])
  // Another time zone is another answer, loaded afresh.
  assert.ok((await launch(store, { timeZone: "Asia/Tokyo", canKeep: ownRead })).calls.includes("count_issues"))
})

test("an access reduction cannot serve old launch data when invalidation and clearing fail", async () => {
  const { slots, store } = memoryStore()
  await launch(store, { canKeep: ownRead })
  const stale = slots.get("UTC")
  const unavailableSave: McpAppLaunchDataStore = {
    open: async () => ({ kept: stale, save: async () => { throw new Error("cache unavailable") } }),
  }
  const denied = await launch(unavailableSave, {
    canKeep: ownRead,
    callTool: async (tool) => tool.name === "count_issues"
      ? { isError: true, content: [{ type: "text", text: "forbidden" }] }
      : { content: [{ type: "text", text: "ok" }] },
  })
  assert.ok(denied.calls.includes("count_issues"))
  assert.ok(!denied.results.some((entry) => entry.name === "count_issues"))
  assert.ok(!denied.results.some((entry) => entry.kept))
  assert.equal(slots.get("UTC"), stale, "the old slot still exists but cannot authorize its contents")
})

test("a successful read with reduced visibility replaces the earlier snapshot", async () => {
  const { slots, store } = memoryStore()
  await launch(store, { canKeep: ownRead })
  const reduced = await launch(store, {
    canKeep: ownRead,
    callTool: async () => ({ content: [{ type: "text", text: "visible subset" }] }),
  })
  const result = reduced.results.find((entry) => entry.name === "count_issues")
  assert.deepEqual(result?.result.content, [{ type: "text", text: "visible subset" }])
  assert.equal(result?.kept, undefined)
  assert.ok(JSON.stringify(slots.get("UTC")).includes("visible subset"))
})

test("a cached read whose live check times out is omitted instead of served", async (t) => {
  const { store } = memoryStore()
  await launch(store, { canKeep: ownRead })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let settled = false
  const loading = launch(store, {
    canKeep: ownRead,
    callTool: (tool) => tool.name === "count_issues"
      ? new Promise<ExecuteCapabilityToolResult>(() => {})
      : Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
  })
  void loading.finally(() => { settled = true })
  for (let step = 0; step < 100 && !settled; step++) {
    t.mock.timers.tick(100)
    await new Promise((resolve) => setImmediate(resolve))
  }
  const result = await loading
  assert.ok(!result.results.some((entry) => entry.name === "count_issues"))
})

test("stored results never fill in a read the current scopes cannot run", async () => {
  const { store } = memoryStore()
  await launch(store, { canKeep: ownRead })
  const denied = await launch(store, { canKeep: ownRead, scopes: [] })
  assert.deepEqual(denied.calls, [])
  assert.deepEqual(denied.results, [])
})

test("without a rule for what may be kept, nothing is kept or reused", async () => {
  const { slots, store, opens } = memoryStore()
  await launch(store)
  assert.equal((await launch(store)).calls.length, 3)
  assert.equal(opens(), 0)
  assert.equal(slots.size, 0)
})

test("kept launch data that does not parse, or a store that cannot keep it, loads afresh", async () => {
  const broken: McpAppLaunchDataStore = { open: async () => ({ kept: [{ name: 1 }], save: async () => {} }) }
  const brokenOpen = await launch(broken, { canKeep: ownRead })
  assert.equal(brokenOpen.calls.length, 3)
  assert.ok(brokenOpen.results.every((entry) => entry.kept === undefined))
  // No slot, as when the inventory revision is unknown: nothing is kept or reused.
  const unavailable: McpAppLaunchDataStore = { open: async () => null }
  assert.equal((await launch(unavailable, { canKeep: ownRead })).calls.length, 3)
  assert.equal((await launch(unavailable, { canKeep: ownRead })).calls.length, 3)
})

test("Apps built from the starter read initial results, so new Apps load with their launch", () => {
  assert.ok(appStarter([binding({})]).reactSource.includes(MCP_APP_INITIAL_RESULTS_META))
})
