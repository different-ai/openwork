// Usage parser for the OpenAI Responses API. Stream: the terminal
// `response.completed` / `response.incomplete` event carries `response.usage`.
import { createSseUsageParser, emptyUsage, isRecord, readNumber } from "./shared.js"
import type { ParsedUsage, UsageParser } from "./shared.js"

const terminalEventTypes = new Set(["response.completed", "response.incomplete"])

function applyResponse(target: ParsedUsage, response: unknown, options: { usage: boolean }) {
  if (!isRecord(response)) return
  if (typeof response.model === "string") target.model = response.model
  if (!options.usage || !isRecord(response.usage)) return
  const usage = response.usage
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null
  target.found = true
  target.inputTokens = readNumber(usage.input_tokens)
  target.outputTokens = readNumber(usage.output_tokens)
  target.totalTokens = readNumber(usage.total_tokens)
  target.cacheReadTokens = inputDetails ? readNumber(inputDetails.cached_tokens) : null
  target.reasoningTokens = outputDetails ? readNumber(outputDetails.reasoning_tokens) : null
}

function applyEvent(target: ParsedUsage, event: unknown) {
  if (!isRecord(event) || typeof event.type !== "string") return
  applyResponse(target, event.response, { usage: terminalEventTypes.has(event.type) })
}

export function parseOpenAiResponsesJsonUsage(body: unknown): ParsedUsage {
  const usage = emptyUsage()
  applyResponse(usage, body, { usage: true })
  return usage
}

export function createOpenAiResponsesSseUsageParser(options: { maxBufferLength?: number } = {}): UsageParser {
  return createSseUsageParser(applyEvent, options)
}
