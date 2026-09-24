import assert from "node:assert/strict"
import { test } from "node:test"
import { createOpenAiChatSseUsageParser } from "../src/usage/openai-chat.js"
import { createAnthropicMessagesSseUsageParser } from "../src/usage/anthropic-messages.js"
import { createGoogleGenerateContentSseUsageParser } from "../src/usage/google-generate-content.js"
import { createOpenAiResponsesSseUsageParser } from "../src/usage/openai-responses.js"

test("OpenAI stream numeric subtotals are incomplete until terminal marker and clean EOF", () => {
  const parser = createOpenAiChatSseUsageParser()
  parser.push('data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n')
  assert.equal(parser.result().found, true)
  assert.equal(parser.complete?.(), false)
  parser.push('data: [DONE]\n\n')
  assert.equal(parser.complete?.(), true)
  parser.push('data: {')
  assert.equal(parser.complete?.(), false)
})
test("Anthropic requires message_stop and Responses requires a terminal usage event", () => {
  const anthropic = createAnthropicMessagesSseUsageParser()
  anthropic.push('data: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}\n\n')
  assert.equal(anthropic.complete?.(), false)
  anthropic.push('data: {"type":"message_stop"}\n\n')
  assert.equal(anthropic.complete?.(), true)
  const responses = createOpenAiResponsesSseUsageParser()
  responses.push('data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3}}}\n\n')
  assert.equal(responses.complete?.(), true)
  responses.push('data: {"type":"error"}\n\n')
  assert.equal(responses.complete?.(), false)
})
test("Google requires finished candidates; malformed/overflowed observation cannot be complete", () => {
  const parser = createGoogleGenerateContentSseUsageParser()
  parser.push('data: {"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3}}\n\n')
  assert.equal(parser.complete?.(), false)
  parser.push('data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3}}\n\n')
  assert.equal(parser.complete?.(), true)
  const bounded = createOpenAiChatSseUsageParser({ maxBufferLength: 2 })
  bounded.push('data: [DONE]\n\n')
  assert.equal(bounded.complete?.(), false)
  const malformed = createOpenAiChatSseUsageParser()
  malformed.push('data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: broken\n\ndata: [DONE]\n\n')
  assert.equal(malformed.result().found, true)
  assert.equal(malformed.complete?.(), false)
})
