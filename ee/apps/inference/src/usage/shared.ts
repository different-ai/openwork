// Shared shape + SSE plumbing for the protocol usage parsers. Parsers never
// retain message content: only usage counters and the reported model.

export type ParsedUsage = {
  found: boolean
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens?: number | null
  reasoningTokens: number | null
  costUsd?: number | null
}

export type UsageParser = {
  push(chunkText: string): void
  result(): ParsedUsage
}

export const defaultMaxBufferLength = 1024 * 1024

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function emptyUsage(): ParsedUsage {
  return {
    found: false,
    model: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
  }
}

// Splits `data:` lines out of an SSE stream (bounded buffer) and hands each
// JSON payload to `applyEvent`, which mutates the accumulated usage.
export function createSseUsageParser(
  applyEvent: (target: ParsedUsage, event: unknown) => void,
  options: { maxBufferLength?: number } = {},
): UsageParser {
  const maxBufferLength = options.maxBufferLength ?? defaultMaxBufferLength
  const usage = emptyUsage()
  let buffer = ""
  let overflowed = false

  function handleLine(line: string) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line
    if (!trimmed.startsWith("data:")) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    let event: unknown
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }
    applyEvent(usage, event)
  }

  return {
    push(chunkText) {
      if (overflowed) return
      buffer += chunkText
      let newlineIndex = buffer.indexOf("\n")
      while (newlineIndex !== -1) {
        handleLine(buffer.slice(0, newlineIndex))
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf("\n")
      }
      if (buffer.length > maxBufferLength) {
        overflowed = true
        buffer = ""
      }
    },
    result() {
      if (overflowed) return emptyUsage()
      if (buffer) {
        handleLine(buffer)
        buffer = ""
      }
      return { ...usage }
    },
  }
}

// Collects a (non-SSE) streamed JSON body up to the buffer bound and parses
// it once at the end — used for Google's JSON-array streaming form.
export function createJsonBodyUsageParser(
  parseJson: (body: unknown) => ParsedUsage,
  options: { maxBufferLength?: number } = {},
): UsageParser {
  const maxBufferLength = options.maxBufferLength ?? defaultMaxBufferLength
  let buffer = ""
  let overflowed = false
  return {
    push(chunkText) {
      if (overflowed) return
      buffer += chunkText
      if (buffer.length > maxBufferLength) {
        overflowed = true
        buffer = ""
      }
    },
    result() {
      if (overflowed) return emptyUsage()
      try {
        return parseJson(JSON.parse(buffer))
      } catch {
        return emptyUsage()
      }
    },
  }
}
