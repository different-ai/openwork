import assert from "node:assert/strict"
import test from "node:test"
import { parseProgress, parseReadResult, parseRequestComplete, REQUEST_RESULT_MAX_BYTES, SessionRunnerError } from "../src/index.ts"

function page(messages: unknown[]) {
  return { title: "Task", status: "idle", waitingFor: null, lastError: null, messageCount: messages.length, from: "end", messages, nextCursor: null }
}
const legacyMessage = {
  id: "msg_a", role: "assistant", createdAt: 1_000, text: "Done", truncated: false, error: null,
  toolCalls: [{ id: "prt_1", name: "bash", status: "completed", input: "{\"command\":\"ls\"}", output: "a\nb", error: null, truncated: false }],
}

test("a legacy message without parts still parses and gains no parts", () => {
  const result = parseReadResult(page([legacyMessage]))
  assert.equal(result.messages[0]?.parts, undefined)
  assert.equal(result.messages[0]?.toolCalls.length, 1)
})

test("ordered parts parse with tool state, timestamps and reasoning duration", () => {
  const parts = [
    { type: "reasoning", text: "Plan the listing", durationMs: 12_000 },
    { type: "tool", id: "prt_1", name: "bash", status: "completed", title: "List files", input: "{\"command\":\"ls\"}", output: "a\nb", error: null, truncated: false, startedAt: 1_100, endedAt: 1_400 },
    { type: "text", text: "Two files." },
    { type: "tool", id: "prt_2", name: "read", status: "error", input: "{}", output: null, error: "ENOENT", truncated: false },
  ]
  const result = parseReadResult(page([{ ...legacyMessage, parts, completedAt: 2_000 }]))
  const message = result.messages[0]
  assert.deepEqual(message?.parts?.map(part => part.type), ["reasoning", "tool", "text", "tool"])
  assert.equal(message?.completedAt, 2_000)
  assert.deepEqual(message?.parts?.[1], parts[1])
  assert.deepEqual(message?.parts?.[0], parts[0])
})

test("parts keep the caps: 200 parts, 2000 chars per tool field, known fields only", () => {
  const tool = (extra: Record<string, unknown> = {}) => ({ type: "tool", id: "p", name: "bash", status: null, input: null, output: null, error: null, truncated: false, ...extra })
  assert.throws(() => parseReadResult(page([{ ...legacyMessage, parts: Array.from({ length: 201 }, () => tool()) }])), SessionRunnerError)
  assert.doesNotThrow(() => parseReadResult(page([{ ...legacyMessage, parts: Array.from({ length: 200 }, () => tool()) }])))
  assert.throws(() => parseReadResult(page([{ ...legacyMessage, parts: [tool({ output: "x".repeat(2001) })] }])), SessionRunnerError)
  assert.throws(() => parseReadResult(page([{ ...legacyMessage, parts: [tool({ secret: "nope" })] }])), SessionRunnerError)
  assert.throws(() => parseReadResult(page([{ ...legacyMessage, parts: [{ type: "image", url: "x" }] }])), SessionRunnerError)
  assert.throws(() => parseReadResult(page([{ ...legacyMessage, parts: [{ type: "reasoning", text: "x".repeat(4001) }] }])), SessionRunnerError)
})

test("a page with parts still respects the request result byte cap", () => {
  const big = { type: "text", text: "x".repeat(19_000) }
  const messages = Array.from({ length: 14 }, (_, index) => ({ ...legacyMessage, id: `msg_${index}`, parts: [big] }))
  assert.ok(JSON.stringify(page(messages)).length > REQUEST_RESULT_MAX_BYTES)
  assert.throws(() => parseRequestComplete({ status: "done", outcome: { action: "read", result: page(messages) } }), SessionRunnerError)
})

test("progress carries the step it ran last, and older progress without it still parses", () => {
  assert.deepEqual(parseProgress({ status: "running", latestStep: "Ran List the release notes", observedAt: 1 }),
    { status: "running", latestStep: "Ran List the release notes", observedAt: 1 })
  assert.deepEqual(parseProgress({ status: "running", observedAt: 1 }), { status: "running", observedAt: 1 })
  assert.equal(parseProgress({ status: "idle", latestStep: null, observedAt: 1 }).latestStep, null)
  assert.throws(() => parseProgress({ status: "running", latestStep: "x".repeat(241), observedAt: 1 }), SessionRunnerError)
})
