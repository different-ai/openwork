import { captureResponseIdentity, createJsonBodyUsageParser, createSseUsageParser, emptyUsage, hasUsage, isRecord, readNumber } from "@openwork-ee/gateway-protocols/usage/shared"
import type { ParsedUsage, UsageParser } from "@openwork-ee/gateway-protocols/usage/shared"

function applyChunk(target: ParsedUsage, chunk: unknown) {
  if (!isRecord(chunk)) return
  captureResponseIdentity(target, chunk)
  if (typeof chunk.modelVersion === "string") target.model = chunk.modelVersion
  if (!isRecord(chunk.usageMetadata)) return
  const usage = chunk.usageMetadata
  target.inputTokens = readNumber(usage.promptTokenCount)
  target.outputTokens = readNumber(usage.candidatesTokenCount)
  target.totalTokens = readNumber(usage.totalTokenCount)
  target.cacheReadTokens = readNumber(usage.cachedContentTokenCount)
  target.reasoningTokens = readNumber(usage.thoughtsTokenCount)
  target.found = hasUsage(target)
}

export function parseGoogleGenerateContentJsonUsage(body: unknown): ParsedUsage {
  const usage = emptyUsage()
  if (Array.isArray(body)) {
    for (const chunk of body) applyChunk(usage, chunk)
    return usage
  }
  applyChunk(usage, body)
  return usage
}

export function createGoogleGenerateContentSseUsageParser(options: { maxBufferLength?: number } = {}): UsageParser {
  return createSseUsageParser(applyChunk, { ...options, isTerminal: (event) => isRecord(event) && Array.isArray(event.candidates) && event.candidates.length > 0 && event.candidates.every((candidate) => isRecord(candidate) && typeof candidate.finishReason === "string") })
}

export function createGoogleGenerateContentJsonStreamUsageParser(options: { maxBufferLength?: number } = {}): UsageParser {
  return createJsonBodyUsageParser(parseGoogleGenerateContentJsonUsage, options)
}
