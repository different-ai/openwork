import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { MCP_APP_INITIAL_RESULTS_META, type McpAppToolBinding } from "@openwork/types/mcp-app"
import { appStarter } from "../src/mcp/app-authoring-starter.js"
import { buildAnAppSkillSource } from "../src/mcp/build-an-app-skill.js"
import { launchInitialResults, launchReadHandoff, loadInitialResults, type McpAppLaunchDataStore } from "../src/mcp/app-launch-data.js"
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

/** Advances mocked time in steps until the work settles, so the budget expires whenever its timer started. */
async function untilSettled(t: TestContext, work: Promise<unknown>) {
  let settled = false
  void work.finally(() => { settled = true })
  for (let step = 0; step < 100 && !settled; step++) {
    t.mock.timers.tick(100)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const ok = (text: string): ExecuteCapabilityToolResult => ({ content: [{ type: "text", text }] })

/** A tool whose runs finish only when the test says so. */
function slowTool() {
  const runs: Array<{ name: string; args: Record<string, unknown> }> = []
  const pending: Array<(result: ExecuteCapabilityToolResult) => void> = []
  const callTool = (tool: McpAppToolBinding, args: Record<string, unknown>) => {
    runs.push({ name: tool.name, args })
    return new Promise<ExecuteCapabilityToolResult>((resolve) => { pending.push(resolve) })
  }
  return { runs, callTool, finish: (result: ExecuteCapabilityToolResult) => pending.shift()?.(result) }
}

test("a launch read past its budget is handed to the App's own call, so each open runs it once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const mrr = binding({})
  const tool = slowTool()
  const handoff = launchReadHandoff("member-a")
  const opening = loadInitialResults({ tools: [mrr], scopes: new Set([DEN_MCP_READ_SCOPE]), timeZone: "Europe/Paris", callTool: tool.callTool, handoff })
  await untilSettled(t, opening)
  assert.deepEqual(await opening, [], "the App opens without the late read")
  // The App asks for the same read, as the App server's tools/call does, and
  // gets the launch's run when it finishes instead of starting another.
  const appCall = handoff.call(mrr, { timeZone: "Europe/Paris" }, () => tool.callTool(mrr, { timeZone: "Europe/Paris" }))
  assert.equal(tool.runs.length, 1, "the App's call waits for the launch's run")
  tool.finish(ok("MRR"))
  assert.deepEqual(await appCall, ok("MRR"))
  assert.deepEqual(tool.runs, [{ name: "load_mrr", args: { timeZone: "Europe/Paris" } }])
  // It is taken once; the App's next call runs the tool.
  const again = handoff.call(mrr, { timeZone: "Europe/Paris" }, () => tool.callTool(mrr, { timeZone: "Europe/Paris" }))
  tool.finish(ok("MRR again"))
  assert.deepEqual(await again, ok("MRR again"))
  assert.equal(tool.runs.length, 2)
})

test("a read finished within its budget is not held, so the App's own call runs it", async () => {
  const mrr = binding({})
  const handoff = launchReadHandoff("member-in-time")
  let runs = 0
  const callTool = async () => { runs += 1; return ok(`run ${runs}`) }
  const opened = await loadInitialResults({ tools: [mrr], scopes: new Set([DEN_MCP_READ_SCOPE]), timeZone: "UTC", callTool, handoff })
  assert.equal(opened.length, 1)
  assert.deepEqual(await handoff.call(mrr, { timeZone: "UTC" }, callTool), ok("run 2"))
})

test("only the same caller, binding and arguments take a held read", async () => {
  const mrr = binding({})
  const args = { timeZone: "Europe/Paris" }
  let runs = 0
  const run = async () => { runs += 1; return ok("ran") }
  const handoff = launchReadHandoff("member-b")
  handoff.hold(mrr, args, Promise.resolve(ok("held")))
  assert.deepEqual(await launchReadHandoff("member-c").call(mrr, args, run), ok("ran"), "another caller")
  assert.deepEqual(await handoff.call(mrr, { timeZone: "Asia/Tokyo" }, run), ok("ran"), "other arguments")
  assert.deepEqual(await handoff.call(binding({ capability: "plugin:plg_1:cob_2" }), args, run), ok("ran"), "a rebound tool of the same name")
  assert.equal(runs, 3)
  assert.deepEqual(await handoff.call(mrr, args, run), ok("held"))
  assert.equal(runs, 3)
})

test("a held read that fails is not handed over; the App's own call runs it again", async () => {
  const mrr = binding({})
  const args = { timeZone: "UTC" }
  const handoff = launchReadHandoff("member-d")
  const run = async () => ok("fresh")
  handoff.hold(mrr, args, Promise.resolve({ isError: true, content: [{ type: "text", text: "provider_failed" }] }))
  assert.deepEqual(await handoff.call(mrr, args, run), ok("fresh"))
  handoff.hold(mrr, args, Promise.reject(new Error("dropped")))
  assert.deepEqual(await handoff.call(mrr, args, run), ok("fresh"))
})

test("a finished read nobody takes is dropped after a short grace", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const mrr = binding({})
  const args = { timeZone: "UTC" }
  const run = async () => ok("fresh")
  const handoff = launchReadHandoff("member-e", 1_000)
  handoff.hold(mrr, args, Promise.resolve(ok("held")))
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(999)
  assert.deepEqual(await handoff.call(mrr, args, run), ok("held"), "taken within the grace")
  handoff.hold(mrr, args, Promise.resolve(ok("held")))
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(1_000)
  assert.deepEqual(await handoff.call(mrr, args, run), ok("fresh"), "dropped after it")
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

test("the starter reads a saved Workflow's value, not its run receipt", () => {
  const source = appStarter([binding({})]).reactSource
  const pick = (name: string) => {
    const start = source.indexOf(`function ${name}(`)
    assert.ok(start >= 0, `starter defines ${name}`)
    let depth = 0
    for (let i = source.indexOf("{", start); i < source.length; i++) {
      if (source[i] === "{") depth++
      else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1)
    }
    throw new Error(`unterminated ${name}`)
  }
  const valueOf = new Function(`${pick("isRecord")}\n${pick("textOf")}\n${pick("unwrapWorkflow")}\n${pick("valueOf")}\nreturn valueOf;`)() as (response: unknown) => unknown
  const data = { gates: [{ id: "g1" }], blockers: [] }
  const receipt = { kind: "workflow", status: "executed", name: "Launch room data", value: data, receiptId: "rcp_1" }
  assert.deepEqual(valueOf({ structuredContent: receipt }), data)
  assert.deepEqual(valueOf({ content: [{ type: "text", text: JSON.stringify(receipt) }] }), data)
  // Other tools' results pass through unchanged, including objects that merely have a value field.
  assert.deepEqual(valueOf({ structuredContent: { value: 3, unit: "USD" } }), { value: 3, unit: "USD" })
  assert.equal(valueOf({ content: [{ type: "text", text: "plain" }] }), "plain")
  // Authors who replace the starter are told too.
  assert.match(buildAnAppSkillSource("ecmascript"), /A saved Workflow answers with its run receipt/)
})
