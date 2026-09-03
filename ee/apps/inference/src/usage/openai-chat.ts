// Pure usage parser for OpenAI-style chat completions (OpenAI, OpenRouter,
// openai-compatible providers). Never retains message content.

export type OpenAiChatUsage = {
  found: boolean
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadTokens: number | null
  reasoningTokens: number | null
  costUsd: number | null
}

export type OpenAiChatSseUsageParser = {
  push(chunkText: string): void
  result(): OpenAiChatUsage
}

const defaultMaxBufferLength = 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function emptyUsage(): OpenAiChatUsage {
  return {
    found: false,
    model: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    reasoningTokens: null,
    costUsd: null,
  }
}

function applyEvent(target: OpenAiChatUsage, event: unknown) {
  if (!isRecord(event)) return
  if (typeof event.model === "string") target.model = event.model
  if (!isRecord(event.usage)) return
  const usage = event.usage
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : null
  target.found = true
  target.inputTokens = readNumber(usage.prompt_tokens)
  target.outputTokens = readNumber(usage.completion_tokens)
  target.totalTokens = readNumber(usage.total_tokens)
  target.cacheReadTokens = promptDetails ? readNumber(promptDetails.cached_tokens) : null
  target.reasoningTokens = completionDetails ? readNumber(completionDetails.reasoning_tokens) : null
  target.costUsd = readNumber(usage.cost)
}

export function parseOpenAiChatJsonUsage(body: unknown): OpenAiChatUsage {
  const usage = emptyUsage()
  applyEvent(usage, body)
  return usage
}

export function createOpenAiChatSseUsageParser(options: { maxBufferLength?: number } = {}): OpenAiChatSseUsageParser {
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
