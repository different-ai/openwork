// Usage parser for the Anthropic Messages API (direct and via Vertex).
// Stream: `message_start.message.usage` carries input + cache counters and
// the model; `message_delta.usage.output_tokens` carries the final output.
import { createSseUsageParser, emptyUsage, isRecord, readNumber } from "./shared.js"
import type { ParsedUsage, UsageParser } from "./shared.js"

function applyUsage(target: ParsedUsage, usage: unknown, options: { partial: boolean }) {
  if (!isRecord(usage)) return
  target.found = true
  const input = readNumber(usage.input_tokens)
  const output = readNumber(usage.output_tokens)
  const cacheWrite = readNumber(usage.cache_creation_input_tokens)
  const cacheRead = readNumber(usage.cache_read_input_tokens)
  if (input !== null || !options.partial) target.inputTokens = input ?? target.inputTokens
  if (output !== null || !options.partial) target.outputTokens = output ?? target.outputTokens
  if (cacheWrite !== null) target.cacheWriteTokens = cacheWrite
  if (cacheRead !== null) target.cacheReadTokens = cacheRead
}

function applyEvent(target: ParsedUsage, event: unknown) {
  if (!isRecord(event)) return
  if (event.type === "message_start" && isRecord(event.message)) {
    if (typeof event.message.model === "string") target.model = event.message.model
    applyUsage(target, event.message.usage, { partial: true })
    return
  }
  if (event.type === "message_delta") {
    applyUsage(target, event.usage, { partial: true })
  }
}

export function parseAnthropicMessagesJsonUsage(body: unknown): ParsedUsage {
  const usage = emptyUsage()
  if (!isRecord(body)) return usage
  if (typeof body.model === "string") usage.model = body.model
  applyUsage(usage, body.usage, { partial: false })
  return usage
}

export function createAnthropicMessagesSseUsageParser(options: { maxBufferLength?: number } = {}): UsageParser {
  return createSseUsageParser(applyEvent, options)
}
