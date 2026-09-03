import assert from "node:assert/strict"
import { test } from "node:test"
import { createAnthropicMessagesSseUsageParser, parseAnthropicMessagesJsonUsage } from "../src/usage/anthropic-messages.js"
import {
  createGoogleGenerateContentJsonStreamUsageParser,
  createGoogleGenerateContentSseUsageParser,
  parseGoogleGenerateContentJsonUsage,
} from "../src/usage/google-generate-content.js"
import { createOpenAiResponsesSseUsageParser, parseOpenAiResponsesJsonUsage } from "../src/usage/openai-responses.js"
import type { UsageParser } from "../src/usage/shared.js"

const anthropicStart = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":25,"cache_creation_input_tokens":4,"cache_read_input_tokens":9,"output_tokens":1}}}\n\n'
const anthropicDelta = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n'
const responsesCompleted = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","usage":{"input_tokens":11,"output_tokens":22,"total_tokens":33,"input_tokens_details":{"cached_tokens":5},"output_tokens_details":{"reasoning_tokens":8}}}}\n\n'
const googleChunk = 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10},"modelVersion":"gemini-2.5-pro"}\n\n'
const googleFinal = 'data: {"candidates":[],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":13,"totalTokenCount":25,"cachedContentTokenCount":2,"thoughtsTokenCount":5},"modelVersion":"gemini-2.5-pro"}\n\n'

function pushSplit(parser: UsageParser, text: string, marker: string) {
  const splitAt = text.indexOf(marker)
  assert.ok(splitAt > 0)
  parser.push(text.slice(0, splitAt))
  parser.push(text.slice(splitAt))
}

test("anthropic: combines message_start and message_delta usage", () => {
  const parser = createAnthropicMessagesSseUsageParser()
  parser.push(anthropicStart)
  parser.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n')
  parser.push(anthropicDelta)
  parser.push('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  const usage = parser.result()
  assert.equal(usage.found, true)
  assert.equal(usage.model, "claude-sonnet-4-5")
  assert.equal(usage.inputTokens, 25)
  assert.equal(usage.outputTokens, 42)
  assert.equal(usage.cacheWriteTokens, 4)
  assert.equal(usage.cacheReadTokens, 9)
})

test("anthropic: usage split across chunk boundaries", () => {
  const parser = createAnthropicMessagesSseUsageParser()
  pushSplit(parser, anthropicStart, "cache_read")
  pushSplit(parser, anthropicDelta, "output_tokens")
  const usage = parser.result()
  assert.equal(usage.inputTokens, 25)
  assert.equal(usage.outputTokens, 42)
})

test("anthropic: missing usage and JSON body", () => {
  const parser = createAnthropicMessagesSseUsageParser()
  parser.push('event: ping\ndata: {"type":"ping"}\n\n')
  assert.equal(parser.result().found, false)

  const json = parseAnthropicMessagesJsonUsage({ model: "claude-x", usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1 } })
  assert.equal(json.found, true)
  assert.equal(json.model, "claude-x")
  assert.equal(json.inputTokens, 3)
  assert.equal(json.outputTokens, 4)
  assert.equal(json.cacheReadTokens, 1)
  assert.equal(json.cacheWriteTokens, null)
})

test("openai responses: response.completed carries usage", () => {
  const parser = createOpenAiResponsesSseUsageParser()
  parser.push('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n')
  pushSplit(parser, responsesCompleted, "output_tokens_details")
  const usage = parser.result()
  assert.deepEqual(usage, {
    found: true,
    model: "gpt-5",
    inputTokens: 11,
    outputTokens: 22,
    totalTokens: 33,
    cacheReadTokens: 5,
    cacheWriteTokens: null,
    reasoningTokens: 8,
    costUsd: null,
  })
})

test("openai responses: response.incomplete, missing usage, JSON body", () => {
  const incomplete = createOpenAiResponsesSseUsageParser()
  incomplete.push('data: {"type":"response.incomplete","response":{"model":"gpt-5","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n')
  assert.equal(incomplete.result().totalTokens, 3)

  const missing = createOpenAiResponsesSseUsageParser()
  missing.push('data: {"type":"response.created","response":{"model":"gpt-5"}}\n\n')
  assert.equal(missing.result().found, false)
  assert.equal(missing.result().model, "gpt-5")

  const json = parseOpenAiResponsesJsonUsage({ model: "gpt-5", usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 } })
  assert.equal(json.found, true)
  assert.equal(json.inputTokens, 5)
})

test("google: last usageMetadata chunk wins", () => {
  const parser = createGoogleGenerateContentSseUsageParser()
  parser.push(googleChunk)
  pushSplit(parser, googleFinal, "thoughtsTokenCount")
  const usage = parser.result()
  assert.equal(usage.found, true)
  assert.equal(usage.model, "gemini-2.5-pro")
  assert.equal(usage.inputTokens, 7)
  assert.equal(usage.outputTokens, 13)
  assert.equal(usage.totalTokens, 25)
  assert.equal(usage.cacheReadTokens, 2)
  assert.equal(usage.reasoningTokens, 5)
})

test("google: JSON array streaming form and missing usage", () => {
  const stream = createGoogleGenerateContentJsonStreamUsageParser()
  stream.push('[{"candidates":[],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}},')
  stream.push('{"candidates":[],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":9,"totalTokenCount":10},"modelVersion":"gemini-2.5-flash"}]')
  const usage = stream.result()
  assert.equal(usage.outputTokens, 9)
  assert.equal(usage.model, "gemini-2.5-flash")

  const missing = createGoogleGenerateContentSseUsageParser()
  missing.push('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n')
  assert.equal(missing.result().found, false)

  assert.equal(parseGoogleGenerateContentJsonUsage({ usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }).totalTokens, 5)
})
