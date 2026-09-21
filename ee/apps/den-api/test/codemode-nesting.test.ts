import { expect, test } from "bun:test"
import { Tool, toolError } from "@openwork/codemode"
import { Effect } from "effect"
import { runCodemodeScript } from "../src/mcp/codemode-run.js"
import type { CodemodeToolTree } from "../src/mcp/codemode-tools.js"

test("nested and parallel Workflows share the outer tool-call budget", async () => {
  let calls = 0
  const tools: CodemodeToolTree = { test: {
    read: Tool.make({ description: "Read", run: () => Effect.sync(() => ++calls) }),
    workflow: Tool.make({ description: "Workflow", run: () => Effect.promise(async () => {
      const result = await runCodemodeScript({ tools, code: "return await tools.test.read({})", timeoutMs: 1000 })
      return result.ok
    }) }),
  } }
  const result = await runCodemodeScript({ tools, timeoutMs: 1000, maxToolCalls: 3,
    code: "return await Promise.all([tools.test.workflow({}), tools.test.workflow({})])" })
  expect(result.ok).toBe(true)
  expect(calls).toBe(1)
})

test("recursive Workflows stop at the nesting limit", async () => {
  let entered = 0
  const tools: CodemodeToolTree = { test: {
    recurse: Tool.make({ description: "Nested Workflow", run: () => Effect.promise(async () => {
      entered++
      const result = await runCodemodeScript({ tools, code: "return await tools.test.recurse({})", timeoutMs: 1000 })
      if (!result.ok) throw toolError(result.error.message)
      return result.value
    }) }),
  } }
  const result = await runCodemodeScript({ tools, code: "return await tools.test.recurse({})", timeoutMs: 1000 })
  expect(result.ok).toBe(false)
  expect(entered).toBe(4)
})

test("scripts return only the selected value and bound oversized final output", async () => {
  const tools: CodemodeToolTree = { test: {
    report: Tool.make({ description: "Report", run: () => Effect.succeed({ count: 7, raw: "x".repeat(100_000) }) }),
  } }
  const compact = await runCodemodeScript({ tools, timeoutMs: 1000,
    code: "const report = await tools.test.report({}); return { count: report.count }" })
  expect(compact).toMatchObject({ ok: true, value: { count: 7 }, toolCalls: [{ name: "test.report" }] })
  expect(JSON.stringify(compact).length).toBeLessThan(1000)
  const oversized = await runCodemodeScript({ tools: {}, timeoutMs: 1000, code: 'return "x".repeat(100_000)' })
  expect(oversized).toMatchObject({ ok: true, value: expect.stringContaining("result truncated") })
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(66_000)
})
