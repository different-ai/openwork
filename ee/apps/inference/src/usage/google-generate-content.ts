// Usage parser for Gemini generateContent (Google AI Studio and Vertex).
// Every chunk may carry `usageMetadata`; the last one is authoritative. Also
// accepts the non-SSE JSON-array streaming form (array of chunks).
import { createJsonBodyUsageParser, createSseUsageParser, emptyUsage, isRecord, readNumber } from "./shared.js"
import type { ParsedUsage, UsageParser } from "./shared.js"

function applyChunk(target: ParsedUsage, chunk: unknown) {
  if (!isRecord(chunk)) return
  if (typeof chunk.modelVersion === "string") target.model = chunk.modelVersion
  if (!isRecord(chunk.usageMetadata)) return
  const usage = chunk.usageMetadata
  target.found = true
  target.inputTokens = readNumber(usage.promptTokenCount)
  target.outputTokens = readNumber(usage.candidatesTokenCount)
  target.totalTokens = readNumber(usage.totalTokenCount)
  target.cacheReadTokens = readNumber(usage.cachedContentTokenCount)
  target.reasoningTokens = readNumber(usage.thoughtsTokenCount)
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
  return createSseUsageParser(applyChunk, options)
}

export function createGoogleGenerateContentJsonStreamUsageParser(options: { maxBufferLength?: number } = {}): UsageParser {
  return createJsonBodyUsageParser(parseGoogleGenerateContentJsonUsage, options)
}
