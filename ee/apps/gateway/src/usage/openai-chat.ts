// OpenAI-compatible prompt tokens include cache reads; output includes reasoning.
import { captureResponseIdentity, createSseUsageParser, emptyUsage, hasUsage, isRecord, readNumber } from "./shared.js"
import type { ParsedUsage, UsageParser } from "./shared.js"

export type OpenAiChatUsage = ParsedUsage
export type OpenAiChatSseUsageParser = UsageParser

function applyEvent(target: ParsedUsage, event: unknown) {
  if (!isRecord(event)) return
  captureResponseIdentity(target, event)
  if (typeof event.model === "string") target.model = event.model
  if (!isRecord(event.usage)) return
  const usage = event.usage
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : null
  target.inputTokens = readNumber(usage.prompt_tokens)
  target.outputTokens = readNumber(usage.completion_tokens)
  target.totalTokens = readNumber(usage.total_tokens)
  target.cacheReadTokens = promptDetails ? readNumber(promptDetails.cached_tokens) : null
  // Claude cache writes, also inside prompt_tokens: OpenRouter's detail, else LiteLLM's Anthropic field.
  target.cacheWriteTokens = (promptDetails ? readNumber(promptDetails.cache_write_tokens) : null) ?? readNumber(usage.cache_creation_input_tokens)
  target.reasoningTokens = completionDetails ? readNumber(completionDetails.reasoning_tokens) : null
  target.costUsd = readNumber(usage.cost)
  target.found = hasUsage(target)
}

export function parseOpenAiChatJsonUsage(body: unknown): OpenAiChatUsage {
  const usage = emptyUsage()
  applyEvent(usage, body)
  return usage
}

export function createOpenAiChatSseUsageParser(options: { maxBufferLength?: number } = {}): OpenAiChatSseUsageParser {
  return createSseUsageParser(applyEvent, options)
}
