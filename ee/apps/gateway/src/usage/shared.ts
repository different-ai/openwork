// Shared shape + SSE plumbing for the protocol usage parsers. Parsers never
// retain message content: only usage counters and the reported model.

import type { GenerationTerminal } from "../generation-outcome.js"

export type ParsedUsage = {
  generation?: GenerationTerminal
  found: boolean
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens?: number | null
  reasoningTokens: number | null
  costUsd?: number | null
  upstreamRequestId?: string
  // Fixed annotation only; never capture an upstream error message/body.
  streamError?: "upstream_stream_error"
}

export type UsageParser = {
  push(chunkText: string): void
  // Binary framings (AWS event-stream) must see the raw bytes.
  pushBytes?(chunk: Uint8Array): void
  result(): ParsedUsage
}

export const defaultMaxBufferLength = 1024 * 1024

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

export function hasUsage(usage: ParsedUsage) {
  return [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cacheReadTokens,
    usage.cacheWriteTokens, usage.reasoningTokens, usage.costUsd].some((value) => typeof value === "number")
}

export function captureResponseIdentity(target: ParsedUsage, event: unknown) {
  if (!isRecord(event)) return
  const id = event.id ?? event.responseId ?? event.requestId
  if (typeof id === "string" && id.length <= 255) target.upstreamRequestId = id
  if (event.error != null || event.type === "error" || event.type === "response.failed" || event.status === "failed") {
    target.streamError = "upstream_stream_error"
  }
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

// Bound both complete lines and multi-line events BEFORE copying/parsing them.
// Incomplete events at EOF are not usage evidence. Overflow disables observation
// only; callers still relay their original bytes.
export function createSseUsageParser(
  applyEvent: (target: ParsedUsage, event: unknown) => void,
  options: { maxBufferLength?: number } = {},
): UsageParser {
  const maxBufferLength = options.maxBufferLength ?? defaultMaxBufferLength
  const usage = emptyUsage()
  let buffer = ""
  let overflowed = false
  let data = ""
  let eventType = ""
  let eventLength = 0

  function handleLine(line: string) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line
    if (!trimmed) {
      if (eventType === "error") usage.streamError = "upstream_stream_error"
      try {
        const event: unknown = JSON.parse(data)
        captureResponseIdentity(usage, event)
        applyEvent(usage, event)
      } catch {
        // Malformed data and [DONE] are not usage.
      }
      data = ""
      eventType = ""
      eventLength = 0
      return
    }
    eventLength += line.length + 1
    if (eventLength > maxBufferLength) { overflowed = true; return }
    if (trimmed.startsWith("event:")) eventType = trimmed.slice(6).trim()
    if (trimmed.startsWith("data:")) data += `${data ? "\n" : ""}${trimmed.slice(5).replace(/^ /, "")}`
  }

  return {
    push(chunkText) {
      if (overflowed) return
      let offset = 0
      while (offset < chunkText.length && !overflowed) {
        const newline = chunkText.indexOf("\n", offset)
        const end = newline === -1 ? chunkText.length : newline
        if (buffer.length + end - offset > maxBufferLength) { overflowed = true; break }
        buffer += chunkText.slice(offset, end)
        if (newline === -1) break
        handleLine(buffer)
        buffer = ""
        offset = newline + 1
      }
      if (overflowed) { buffer = ""; data = ""; eventType = "" }
    },
    result() {
      if (overflowed) return { ...emptyUsage(), ...(usage.streamError ? { streamError: usage.streamError } : {}) }
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
      if (buffer.length + chunkText.length > maxBufferLength) {
        overflowed = true
        buffer = ""
        return
      }
      buffer += chunkText
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
