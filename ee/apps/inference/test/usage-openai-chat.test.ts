import assert from "node:assert/strict"
import { test } from "node:test"
import { createOpenAiChatSseUsageParser, parseOpenAiChatJsonUsage } from "../src/usage/openai-chat.js"

const usageEvent = 'data: {"id":"gen-1","model":"openai/gpt-4o","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"cost":0.0042,"prompt_tokens_details":{"cached_tokens":6},"completion_tokens_details":{"reasoning_tokens":7}}}\n\n'

test("parses usage from a single SSE chunk", () => {
  const parser = createOpenAiChatSseUsageParser()
  parser.push('data: {"id":"gen-1","model":"openai/gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n')
  parser.push(usageEvent)
  parser.push("data: [DONE]\n\n")
  assert.deepEqual(parser.result(), {
    found: true,
    model: "openai/gpt-4o",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cacheReadTokens: 6,
    reasoningTokens: 7,
    costUsd: 0.0042,
  })
})

test("parses usage split across two chunk boundaries", () => {
  const parser = createOpenAiChatSseUsageParser()
  const splitAt = usageEvent.indexOf("completion_tokens")
  parser.push(usageEvent.slice(0, splitAt))
  parser.push(usageEvent.slice(splitAt))
  const result = parser.result()
  assert.equal(result.found, true)
  assert.equal(result.inputTokens, 10)
  assert.equal(result.outputTokens, 20)
  assert.equal(result.totalTokens, 30)
})

test("reports missing usage when no chunk carries usage", () => {
  const parser = createOpenAiChatSseUsageParser()
  parser.push('data: {"id":"gen-1","model":"openai/gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n')
  parser.push("data: [DONE]\n\n")
  const result = parser.result()
  assert.equal(result.found, false)
  assert.equal(result.model, "openai/gpt-4o")
  assert.equal(result.inputTokens, null)
})

test("ignores non-JSON data lines, comments, and the [DONE] sentinel", () => {
  const parser = createOpenAiChatSseUsageParser()
  parser.push(": OPENROUTER PROCESSING\n\n")
  parser.push("data: not json at all\n\n")
  parser.push("event: ping\n\n")
  parser.push(usageEvent)
  parser.push("data: [DONE]\n\n")
  assert.equal(parser.result().found, true)
  assert.equal(parser.result().totalTokens, 30)
})

test("parses a final data line without a trailing newline", () => {
  const parser = createOpenAiChatSseUsageParser()
  parser.push(usageEvent.trimEnd())
  assert.equal(parser.result().found, true)
})

test("gives up with missing usage when the line buffer overflows", () => {
  const parser = createOpenAiChatSseUsageParser({ maxBufferLength: 64 })
  parser.push(`data: {"padding":"${"x".repeat(100)}`)
  parser.push(usageEvent)
  assert.equal(parser.result().found, false)
})

test("parses usage from a JSON body and computes cache/reasoning details", () => {
  const result = parseOpenAiChatJsonUsage({
    model: "openai/gpt-4o",
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } },
  })
  assert.equal(result.found, true)
  assert.equal(result.model, "openai/gpt-4o")
  assert.equal(result.cacheReadTokens, 1)
  assert.equal(result.reasoningTokens, null)
  assert.equal(result.costUsd, null)
})

test("returns missing usage for non-object JSON bodies", () => {
  assert.equal(parseOpenAiChatJsonUsage(null).found, false)
  assert.equal(parseOpenAiChatJsonUsage("text").found, false)
  assert.equal(parseOpenAiChatJsonUsage({ usage: "nope" }).found, false)
})
