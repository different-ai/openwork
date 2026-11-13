import assert from "node:assert/strict"
import { test } from "node:test"
import { runCodemodeScript, type CodemodeRuntime } from "../../src/mcp/codemode-run.js"
import { validateCodemodeScriptInput } from "../../src/mcp/codemode-script-object.js"
import { validateExternalMcpToolArguments } from "../../src/mcp/external-mcp-tool-arguments.js"

/**
 * Regular expressions a caller supplies, as a JSON Schema `pattern` or in a
 * program, match synchronously: no timer can stop one. Den stops them itself
 * (src/time-limit.ts, src/mcp/codemode-pattern-limit.ts), on both engines.
 */

// Backtracks exponentially: unlimited, this subject takes several seconds.
const SLOW_PATTERN = "^(a+)+$"
const SLOW_SUBJECT = `${"a".repeat(30)}!`
const SLOW_SCHEMA = { type: "object", properties: { text: { type: "string", pattern: SLOW_PATTERN } } }
// The limits are 250ms; this leaves room for a busy machine.
const STOPPED_WITHIN_MS = 1_500
const RUNTIMES: CodemodeRuntime[] = ["standard", "openwork"]

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

async function run(runtime: CodemodeRuntime, code: string) {
  await nextTurn()
  return runCodemodeScript({ code, tools: {}, timeoutMs: 10_000, runtime })
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt
}

test("a slow schema pattern stops instead of holding the event loop", () => {
  for (const validate of [
    () => validateCodemodeScriptInput(SLOW_SCHEMA, { text: SLOW_SUBJECT }),
    () => validateExternalMcpToolArguments(SLOW_SCHEMA, { text: SLOW_SUBJECT }),
  ]) {
    const startedAt = performance.now()
    const result = validate()
    assert.ok(elapsedMs(startedAt) < STOPPED_WITHIN_MS, `stopped after ${Math.round(elapsedMs(startedAt))}ms`)
    assert.equal(result.ok, false)
    assert.match(JSON.stringify(result), /took longer than 250ms/)
  }
})

test("ordinary schema patterns still validate, also after a stopped check", () => {
  const schema = { type: "object", properties: { id: { type: "string", pattern: "^[a-z]+-\\d+$" } }, required: ["id"] }
  assert.deepEqual(validateCodemodeScriptInput(schema, { id: "order-42" }), { ok: true })
  assert.equal(validateCodemodeScriptInput(schema, { id: "42" }).ok, false)
  assert.equal(validateExternalMcpToolArguments(schema, { id: "order-42" }).ok, true)
  assert.equal(validateExternalMcpToolArguments(schema, { id: "42" }).ok, false)
})

for (const runtime of RUNTIMES) {
  test(`a slow pattern in a ${runtime} program stops with an error the program can read`, async () => {
    const subject = JSON.stringify(SLOW_SUBJECT)
    for (const code of [
      `return /${SLOW_PATTERN}/.test(${subject})`,
      `return new RegExp(${JSON.stringify(SLOW_PATTERN)}).exec(${subject})`,
      `return ${subject}.match(/${SLOW_PATTERN}/)`,
      `return ${subject}.replace(/${SLOW_PATTERN}/, "")`,
      `return ${subject}.search(/${SLOW_PATTERN}/)`,
      `return ${subject}.split(/${SLOW_PATTERN}/)`,
    ]) {
      const startedAt = performance.now()
      const result = await run(runtime, code)
      assert.ok(elapsedMs(startedAt) < STOPPED_WITHIN_MS, `${code} stopped after ${Math.round(elapsedMs(startedAt))}ms`)
      assert.equal(result.ok, false, code)
      if (!result.ok) assert.match(result.error.message, /took longer than 250ms/, code)
    }
    const caught = await run(runtime, `try { /${SLOW_PATTERN}/.test(${subject}) } catch (error) { return String(error) }`)
    assert.equal(caught.ok, true)
    if (caught.ok) assert.match(String(caught.value), /RangeError: Regular expression matching took longer than 250ms/)
  })

  test(`slow patterns in a row in a ${runtime} program keep giving the event loop turns`, async () => {
    let longestGapMs = 0
    let lastTurnAt = performance.now()
    let watching = true
    const watch = () => {
      longestGapMs = Math.max(longestGapMs, elapsedMs(lastTurnAt))
      lastTurnAt = performance.now()
      if (watching) setImmediate(watch)
    }
    setImmediate(watch)
    const result = await run(
      runtime,
      `let stopped = 0; for (let i = 0; i < 100; i++) { try { /${SLOW_PATTERN}/.test(${JSON.stringify(SLOW_SUBJECT)}) } catch { stopped++ } } return stopped`,
    )
    watching = false
    assert.deepEqual(result.ok && result.value, 100)
    assert.ok(longestGapMs < STOPPED_WITHIN_MS, `the event loop waited ${Math.round(longestGapMs)}ms for a turn`)
  })

  test(`ordinary patterns in a ${runtime} program match as before`, async () => {
    const cases: Array<[string, unknown]> = [
      [`return /^[a-z]+\\d+$/.test("abc123")`, true],
      [`const found = /(\\w+)@(\\w+)\\.com/.exec("mail bob@example.com now"); return [found[0], found[1], found[2]]`, ["bob@example.com", "bob", "example"]],
      [`return "2026-11-13".match(/(?<year>\\d+)-(?<month>\\d+)/).groups.month`, "11"],
      [`return "a1b22c333".match(/\\d+/g)`, ["1", "22", "333"]],
      [`return Array.from("a1b22c333".matchAll(/\\d+/g)).map((found) => found[0])`, ["1", "22", "333"]],
      [`return "a-b-c".replace(/-/g, "+")`, "a+b+c"],
      [`return "a1b22".replace(/\\d+/g, (digits) => String(digits.length))`, "a1b2"],
      [`return "John Smith".replace(/(\\w+)\\s(\\w+)/, "$2, $1")`, "Smith, John"],
      [`return "a, b;c".split(/[,;]\\s*/)`, ["a", "b", "c"]],
      [`return "a1b2c".split(/(\\d)/, 4)`, ["a", "1", "b", "2"]],
      [`return "hello world".search(/wor/)`, 6],
      [`const pattern = /a/g; pattern.test("aa"); const first = pattern.lastIndex; pattern.test("aa"); return [first, pattern.lastIndex]`, [1, 2]],
      [`const pattern = new RegExp("x", "gi"); return [pattern.source, pattern.flags, String(pattern)]`, ["x", "gi", "/x/gi"]],
      [`return "a.b".match("a.b")[0]`, "a.b"],
      [`let matched = 0; const pattern = /^row-\\d+$/; for (let i = 0; i < 2000; i++) { if (pattern.test("row-" + i)) matched++ } return matched`, 2000],
    ]
    for (const [code, expected] of cases) {
      const result = await run(runtime, code)
      assert.deepEqual(result.ok ? result.value : result.error, expected, code)
    }
  })
}
