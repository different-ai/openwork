import { test } from "node:test"
import assert from "node:assert/strict"
import { generationTerminal, providerTerminalReason, validatedUpstreamId } from "../src/generation-outcome.js"
import { createChatGenerationObserver } from "../src/usage/generation.js"
import { parseOpenAiChatJsonUsage, createOpenAiChatSseUsageParser } from "../src/usage/openai-chat.js"
import { parseAnthropicMessagesJsonUsage, createAnthropicMessagesSseUsageParser } from "../src/usage/anthropic-messages.js"
import { parseOpenAiResponsesJsonUsage, createOpenAiResponsesSseUsageParser } from "../src/usage/openai-responses.js"

test("generation reasons are bounded independently of transport", () => {
  for (const id of ["msg_fixture", "chatcmpl-abc", "a".repeat(128)]) assert.equal(validatedUpstreamId(id), id)
  for (const id of ["a".repeat(129), "text with spaces", "url?query", "header\r\nvalue", "", 2, null]) assert.equal(validatedUpstreamId(id), null)
  const malformedReason = { toString: "not callable" }
  assert.equal(parseAnthropicMessagesJsonUsage({ stop_reason: malformedReason, usage: { output_tokens: 3 } }).outputTokens, 3)
  assert.equal(parseOpenAiChatJsonUsage({ choices: [{ index: 0, finish_reason: malformedReason }], usage: { completion_tokens: 3 } }).outputTokens, 3)
  for (const value of [null, undefined, 200, {}, "SECRET_MARKER_DO_NOT_LOG", "error", "cancelled"]) {
    assert.equal(providerTerminalReason(value), "unknown")
    assert.deepEqual(generationTerminal(value), { generationOutcome: "unknown", providerTerminalReason: "unknown" })
  }
  for (const [reason, outcome] of [
    ["stop", "completed"], ["end_turn", "completed"], ["stop_sequence", "completed"], ["completed", "completed"],
    ["length", "length_limited"], ["max_tokens", "length_limited"], ["max_output_tokens", "length_limited"],
    ["tool_calls", "tool_calls"], ["tool_use", "tool_calls"], ["content_filter", "content_filtered"], ["refusal", "refused"], ["incomplete", "unknown"],
  ]) assert.deepEqual(generationTerminal(reason), { generationOutcome: outcome, providerTerminalReason: reason })
})

test("Chat tracks every bounded choice and ignores repeated usage frames", () => {
  for (const reason of ["stop", "length", "tool_calls", "content_filter"]) {
    const body = { choices: [{ index: 0, finish_reason: "stop" }, { index: 1, finish_reason: reason }] }
    assert.deepEqual(parseOpenAiChatJsonUsage(body, 2).generation, generationTerminal(reason))
    const parser = createOpenAiChatSseUsageParser({ expectedChoices: 2 })
    const frame = `data: ${JSON.stringify(body)}\r\n\r\n`
    for (const char of frame + frame + 'data: {"choices":[],"usage":{"total_tokens":3}}\n\ndata: [DONE]\n\n') parser.push(char)
    assert.deepEqual(parser.result().generation, generationTerminal(reason))
    assert.equal(parser.result().totalTokens, 3)
  }
  const observe = createChatGenerationObserver(2)
  assert.equal(observe({ choices: [{ index: 0, finish_reason: "stop" }] }).generationOutcome, "unknown")
  assert.equal(observe({ choices: [{ index: 1, finish_reason: "length" }] }).generationOutcome, "length_limited")
  assert.equal(observe({ choices: [{ index: 1, finish_reason: "stop" }] }).generationOutcome, "unknown")
  assert.equal(observe({ choices: [{ index: 1, finish_reason: "length" }] }).generationOutcome, "unknown")
  for (const index of [-1, 128, 0.5, "0"]) assert.equal(createChatGenerationObserver()({ choices: [{ index, finish_reason: "content_filter" }] }).generationOutcome, "unknown")
  assert.equal(createChatGenerationObserver(129)({ choices: [{ index: 0, finish_reason: "content_filter" }] }).generationOutcome, "unknown")
  const parser = createOpenAiChatSseUsageParser({ maxBufferLength: 100 })
  parser.push(`data: ${"x".repeat(101)}\n\n`)
  parser.push('data: {"choices":[{"index":0,"finish_reason":"content_filter"}]}\n\n')
  assert.equal(parser.result().generation, undefined)
})

test("Anthropic reads only structured terminal fields", () => {
  for (const reason of ["refusal", "max_tokens", "end_turn", "tool_use", "stop_sequence", "SECRET_MARKER_DO_NOT_LOG"]) {
    const expected = generationTerminal(reason)
    assert.deepEqual(parseAnthropicMessagesJsonUsage({ stop_reason: reason }).generation, expected)
    const parser = createAnthropicMessagesSseUsageParser()
    parser.push(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 2 } })}\n\n`)
    parser.push('data: {"type":"message_stop"}\n\n')
    assert.deepEqual(parser.result().generation, expected)
    assert.equal(parser.result().outputTokens, 2)
  }
})

test("Responses uses status, incomplete details and typed refusal, not refusal prose", () => {
  for (const [body, reason] of [
    [{ status: "completed", output: [] }, "completed"],
    [{ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "SECRET_MARKER_DO_NOT_LOG" }] }] }, "refusal"],
    [{ status: "completed", output: [{ type: "function_call", arguments: "SECRET_MARKER_DO_NOT_LOG" }] }, "tool_calls"],
    [{ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "max_output_tokens"],
    [{ status: "incomplete", incomplete_details: { reason: "content_filter" } }, "content_filter"],
    [{ status: "incomplete", incomplete_details: { reason: "SECRET_MARKER_DO_NOT_LOG" } }, "unknown"],
    [{ output: [], refusal: "refusal" }, "unknown"],
    [{ status: "completed" }, "unknown"],
  ]) {
    assert.deepEqual(parseOpenAiResponsesJsonUsage(body).generation, generationTerminal(reason))
    const parser = createOpenAiResponsesSseUsageParser()
    parser.push(`data: ${JSON.stringify({ type: "response.completed", response: body })}\n\n`)
    assert.deepEqual(parser.result().generation, generationTerminal(reason))
    assert.ok(!JSON.stringify(parser.result()).includes("SECRET_MARKER_DO_NOT_LOG"))
  }
  const parser = createOpenAiResponsesSseUsageParser()
  parser.push('data: {"type":"response.refusal.done","refusal":"SECRET_MARKER_DO_NOT_LOG"}\n\n')
  assert.deepEqual(parser.result().generation, generationTerminal("refusal"))
})
