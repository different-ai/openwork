import assert from "node:assert/strict"
import { test } from "node:test"
import { Tool, toolError } from "@openwork/codemode"
import { Effect } from "effect"
import { codemodeRuntimeFor, runCodemodeScript, type CodemodeRuntime } from "../src/mcp/codemode-run.js"
import { parseCodemodeScriptPayload } from "../src/mcp/codemode-script-object.js"
import type { CodemodeToolTree } from "../src/mcp/codemode-tools.js"

// Den tools are built with OpenWork's Tool.make and JSON Schemas, as in codemode-tools.ts.
const calls: string[] = []
const tools: CodemodeToolTree = {
  host: {
    // No output schema, like an external MCP tool.
    echo: Tool.make({
      description: "Echo an id",
      input: { type: "object", properties: { id: { type: "number" } } },
      run: (input) => Effect.sync(() => {
        const id = typeof input === "object" && input !== null && "id" in input ? input.id : null
        calls.push(`echo ${String(id)}`)
        return { id }
      }),
    }),
    slow: Tool.make({
      description: "Echo an id after 80 ms",
      input: { type: "object", properties: { id: { type: "number" } } },
      output: { type: "object" },
      run: (input) => Effect.as(Effect.sleep("80 millis"), input),
    }),
    refuse: Tool.make({
      description: "Always refuse",
      input: { type: "object" },
      run: () => Effect.fail(toolError("Lookup refused")),
    }),
    // A host call that rejects unexpectedly, as a failed database query would.
    crash: Tool.make({
      description: "Fail with an internal error",
      input: { type: "object" },
      run: () => Effect.promise(() => Promise.reject(new Error("internal detail: db host 10.0.0.7"))),
    }),
  },
}

const run = (code: string, runtime?: CodemodeRuntime, extra: { scriptInput?: unknown; timeoutMs?: number } = {}) =>
  runCodemodeScript({ code, tools, timeoutMs: extra.timeoutMs ?? 5_000, scriptInput: extra.scriptInput, ...(runtime ? { runtime } : {}) })

test("a saved Workflow runs only on the interpreter it was written for, never switching silently", () => {
  assert.equal(codemodeRuntimeFor("codemode-js", true), "openwork")
  assert.equal(codemodeRuntimeFor("codemode-js", false), "openwork")
  assert.equal(codemodeRuntimeFor("ecmascript", true), "standard")
  // With the feature off a standard JavaScript Workflow does not run at all.
  assert.equal(codemodeRuntimeFor("ecmascript", false), undefined)
})

test("a Workflow payload names either Code Mode and nothing else", () => {
  for (const language of ["codemode-js", "ecmascript"]) {
    const parsed = parseCodemodeScriptPayload({ language, requiredCapabilities: [] })
    assert.equal(parsed.ok && parsed.payload.language, language)
  }
  assert.equal(parseCodemodeScriptPayload({ language: "javascript", requiredCapabilities: [] }).ok, false)
})

test("the standard interpreter runs a Den tool and returns its value even without an output schema", async () => {
  const result = await run(`
    const found = await tools.host.echo({ id: input.id })
    return { found, double: found.id * 2 }
  `, "standard", { scriptInput: { id: 21 } })
  assert.deepEqual(result.ok && result.value, { found: { id: 21 }, double: 42 })
  assert.deepEqual(result.toolCalls, [{ name: "host.echo" }])
})

test("each engine is the one that runs: only the standard one has promise chaining", async () => {
  const code = `return await tools.host.echo({ id: 1 }).then((found) => found.id + 1)`
  const standard = await run(code, "standard")
  assert.equal(standard.ok && standard.value, 2)
  const openwork = await run(code)
  assert.equal(openwork.ok, false)
  assert.equal(!openwork.ok && openwork.error.kind, "UnsupportedSyntax")
})

test("async helpers in standard JavaScript run their calls side by side", async () => {
  const started = Date.now()
  const result = await run(`
    const load = async (id) => { const found = await tools.host.slow({ id }); return found.id }
    return await Promise.all([1, 2, 3, 4].map(load))
  `, "standard")
  assert.deepEqual(result.ok && result.value, [1, 2, 3, 4])
  // Four 80 ms calls one after another would take 320 ms.
  assert.ok(Date.now() - started < 250, `took ${Date.now() - started} ms`)
})

test("a Den tool refusal is a catchable ToolFailure with its own message", async () => {
  const caught = await run(`
    try { await tools.host.refuse({}) } catch (error) { return error.message }
  `, "standard")
  assert.equal(caught.ok && caught.value, "Lookup refused")
  const failed = await run(`return await tools.host.refuse({})`, "standard")
  assert.equal(!failed.ok && failed.error.kind, "ToolFailure")
  assert.match(!failed.ok ? failed.error.message : "", /Lookup refused/)
})

test("an unexpected tool failure shows no internal detail on either interpreter", async () => {
  for (const runtime of ["standard", "openwork"] satisfies CodemodeRuntime[]) {
    const caught = await run(`try { await tools.host.crash({}) } catch (error) { return error.message }`, runtime)
    assert.equal(caught.ok && caught.value, "Tool execution failed", runtime)
    const failed = await run(`return await tools.host.crash({})`, runtime)
    assert.equal(!failed.ok && failed.error.kind, "ToolFailure", runtime)
    assert.doesNotMatch(!failed.ok ? failed.error.message : "", /internal detail/, runtime)
  }
})

test("warnings from the standard interpreter reach the run's logs", async () => {
  // The refusal settles while the slow call runs; nothing awaits it.
  const result = await run(`
    tools.host.refuse({})
    await tools.host.slow({ id: 1 })
    console.log("done")
    return 1
  `, "standard")
  assert.equal(result.ok && result.value, 1)
  assert.equal(result.logs[0], "done")
  assert.ok(result.logs.slice(1).some((line) => line.startsWith("warning: ToolFailure:") && line.includes("Lookup refused")), result.logs.join("\n"))
})

test("a standard JavaScript program reaches no host network, process, module or Function constructor", async () => {
  const globals = await run(`return [typeof fetch, typeof process, typeof require, typeof globalThis, typeof setTimeout]`, "standard")
  assert.deepEqual(globals.ok && globals.value, ["undefined", "undefined", "undefined", "undefined", "undefined"])
  for (const code of [
    `import fs from "node:fs"; return typeof fs`,
    `const fs = await import("fs"); return typeof fs.readFileSync`,
    `return [].constructor.constructor("return 1")()`,
  ]) {
    const result = await run(code, "standard")
    assert.equal(result.ok, false, code)
  }
})

test("the timeout bounds a standard JavaScript run", async () => {
  const result = await run(`while (true) {}`, "standard", { timeoutMs: 150 })
  assert.equal(!result.ok && result.error.kind, "TimeoutExceeded")
})
