type JsonRecord = Record<string, unknown>
function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export type ChatOutcome = "completed" | "incomplete" | "cancelled" | "upstream_error" | "timeout"
export type ChatCompletionReport = {
  outcome: ChatOutcome
  durationMs: number
  firstOutputMs: number | null
  responseBytes: number
  code?: string
}

export function inferenceError(code: string, message: string) {
  return { error: { code, type: "api_error", message } }
}

export function upstreamError(status: number) {
  if (status === 401 || status === 403) return inferenceError("upstream_access_denied", "The managed model provider could not authorize this request. Ask your organization admin to check OpenWork Models access.")
  if (status === 402) return inferenceError("upstream_quota_exhausted", "The managed provider's allowance is exhausted. Ask your organization admin to check OpenWork Models access.")
  if (status === 429) return inferenceError("upstream_rate_limited", "This model is temporarily rate limited. Wait for the retry time, then retry the selected model.")
  if (status === 413) return inferenceError("context_length_exceeded", "This request exceeds the selected model's capacity. Reduce the conversation or attachments, or explicitly choose a model with a larger context.")
  if (status === 408 || status === 504) return inferenceError("upstream_timeout", "The selected model timed out. Review any partial work before retrying.")
  if (status === 400 || status === 422) return inferenceError("upstream_request_rejected", "The model could not accept this request. Check its context and output limits, attachments, and reasoning settings.")
  if (status === 404) return inferenceError("upstream_model_unavailable", "The selected model is no longer available from its provider. Choose another model explicitly to continue.")
  return inferenceError("upstream_unavailable", "The selected model's provider is unavailable. Your work is preserved; retry when it recovers.")
}

/** Bound JSON buffering; abort at the call site also bounds time to receive it. */
export async function readResponseJson(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  if (!body) throw new Error("Missing response body")
  const reader = body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let text = ""
  let bytes = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error("Response body exceeds the managed limit")
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
  }
}

export function completeChatResponse(value: unknown, choiceCount = 1): boolean {
  if (!record(value) || value.error != null || !Array.isArray(value.choices) || value.choices.length !== choiceCount) return false
  const indices = new Set<number>()
  return value.choices.every((choice) => {
    if (!record(choice) || typeof choice.index !== "number" || !Number.isSafeInteger(choice.index) || choice.index < 0 || choice.index >= choiceCount || indices.has(choice.index)) return false
    indices.add(choice.index)
    // Tool execution validity is the client's responsibility, including truncated arguments.
    return record(choice.message) && ["stop", "length", "tool_calls", "content_filter"].includes(String(choice.finish_reason))
  })
}

class InvalidStream extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** Inspect protocol completion without assembling or replaying assistant text. */
class ChatStream {
  private pending = ""
  private data: string[] = []
  private eventBytes = 0
  private finished = new Set<number>()
  private choices = new Set<number>()
  done = false
  failed: string | null = null
  output = false

  constructor(private readonly choiceCount: number) {}

  feed(text: string): string[] {
    this.pending += text
    if (this.pending.length > 2_000_000) throw new InvalidStream("upstream_malformed_stream", "The model returned an oversized response frame.")
    const frames: string[] = []
    let newline: number
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "")
      this.pending = this.pending.slice(newline + 1)
      if (line === "") {
        if (this.data.length) frames.push(this.event(this.data.join("\n")))
        this.data = []
        this.eventBytes = 0
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""))
        this.eventBytes += line.length
        if (this.eventBytes > 2_000_000) throw new InvalidStream("upstream_malformed_stream", "The model returned an oversized response frame.")
      } else if (line.startsWith(":")) {
        // Heartbeats are transport progress, never assistant output or completion.
        frames.push(": processing\n\n")
      }
      if (this.done || this.failed) break
    }
    return frames
  }

  private event(data: string): string {
    if (data === "[DONE]") {
      if (this.choices.size !== this.choiceCount || this.finished.size !== this.choiceCount) throw new InvalidStream("upstream_incomplete", "The model stopped before completing its response. Partial output is preserved. Review it before retrying.")
      this.done = true
      return "data: [DONE]\n\n"
    }
    let value: unknown
    try { value = JSON.parse(data) } catch { throw new InvalidStream("upstream_malformed_stream", "The model returned an invalid response frame. Partial output is preserved.") }
    if (!record(value)) throw new InvalidStream("upstream_malformed_stream", "The model returned an invalid response frame.")
    if (value.error != null) {
      const error = upstreamError(record(value.error) ? Number(value.error.code) : 502)
      this.failed = error.error.code
      return `data: ${JSON.stringify(error)}\n\n`
    }
    if (!Array.isArray(value.choices)) throw new InvalidStream("upstream_malformed_stream", "The model returned a response without completion choices.")
    const indices = new Set<number>()
    for (const choice of value.choices) {
      if (!record(choice) || typeof choice.index !== "number" || !Number.isSafeInteger(choice.index) || choice.index < 0 || choice.index >= this.choiceCount || indices.has(choice.index)) throw new InvalidStream("upstream_malformed_stream", "The model returned an invalid completion choice.")
      indices.add(choice.index)
      this.choices.add(choice.index)
      if (choice.finish_reason === "error") throw new InvalidStream("upstream_error", "The provider interrupted its response. Partial output is preserved.")
      if (choice.delta != null && !record(choice.delta)) throw new InvalidStream("upstream_malformed_stream", "The model returned an invalid response delta.")
      const delta = record(choice.delta) ? choice.delta : {}
      const hasOutput = Boolean(delta.content || delta.reasoning || delta.reasoning_content ||
        (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) ||
        (Array.isArray(delta.tool_calls) && delta.tool_calls.length))
      // OpenRouter's final usage frame may repeat the terminal choice without output.
      if (hasOutput && this.finished.has(choice.index)) throw new InvalidStream("upstream_malformed_stream", "The model sent output after completing the response.")
      if (hasOutput) this.output = true
      if (choice.finish_reason != null) {
        if (typeof choice.finish_reason !== "string" || !["stop", "length", "tool_calls", "content_filter"].includes(choice.finish_reason)) throw new InvalidStream("upstream_malformed_stream", "The model returned an unknown completion status.")
        this.finished.add(choice.index)
      }
    }
    return `data: ${data}\n\n`
  }
}

export function relayChatStream(input: {
  body: ReadableStream<Uint8Array>
  abort: AbortController
  startedAt: number
  idleMs: number
  choiceCount?: number
  onChunk?(bytes: Uint8Array): void
  onFinish(report: ChatCompletionReport): void
}): ReadableStream<Uint8Array> {
  const reader = input.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const encoder = new TextEncoder()
  const parser = new ChatStream(input.choiceCount ?? 1)
  let settled = false
  let bytes = 0
  let firstOutputMs: number | null = null
  let onAbort = () => {}
  const finish = (outcome: ChatOutcome, code?: string) => {
    if (settled) return
    settled = true
    input.abort.signal.removeEventListener("abort", onAbort)
    try { input.onFinish({ outcome, code, durationMs: Date.now() - input.startedAt, firstOutputMs, responseBytes: bytes }) }
    catch { /* Diagnostics must not prevent stream cleanup. */ }
    input.abort.abort()
    void reader.cancel().catch(() => {})
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        finish("cancelled", "request_cancelled")
        controller.close()
      }
      input.abort.signal.addEventListener("abort", onAbort, { once: true })
      if (input.abort.signal.aborted) onAbort()
    },
    async pull(controller) {
      // A transport chunk may contain no complete SSE frame (or only part of
      // a UTF-8 code point). With zero buffering, returning without enqueueing
      // would strand the pending read. Keep reading under a deadline until we
      // deliver a frame or reach a terminal outcome.
      while (!settled) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InvalidStream("upstream_timeout", "The model stopped responding. Partial output is preserved; review it before retrying.")), input.idleMs) }),
          ])
          if (settled) return
          if (chunk.done) throw new InvalidStream("upstream_incomplete", "The connection closed before the model completed its response. Partial output is preserved; review it before retrying.")
          bytes += chunk.value.byteLength
          parser.output = false
          // Forward one validated frame at a time so a malformed later frame does
          // not discard valid partial output from the same transport chunk.
          const text = decoder.decode(chunk.value, { stream: true })
          let emitted = false
          for (const line of text.split(/(?<=\n)/)) {
            for (const frame of parser.feed(line)) {
              const encoded = encoder.encode(frame)
              try { input.onChunk?.(encoded) } catch { /* Observation is best effort. */ }
              controller.enqueue(encoded)
              if (parser.output) firstOutputMs ??= Date.now() - input.startedAt
              emitted = true
            }
            if (parser.done || parser.failed) break
          }
          if (parser.done || parser.failed) {
            finish(parser.failed ? "upstream_error" : "completed", parser.failed ?? undefined)
            controller.close()
          }
          if (emitted) return
        } catch (error) {
          if (settled) return
          const cancelled = input.abort.signal.aborted
          const code = cancelled ? "request_cancelled" : error instanceof InvalidStream ? error.code : "upstream_interrupted"
          const message = error instanceof InvalidStream ? error.message : "The model response was interrupted. Partial output is preserved; review it before retrying."
          finish(cancelled ? "cancelled" : code === "upstream_timeout" ? "timeout" : code === "upstream_error" ? "upstream_error" : "incomplete", code)
          if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(inferenceError(code, message))}\n\n`))
          controller.close()
        } finally { clearTimeout(timer) }
      }
    },
    cancel() { finish("cancelled", "request_cancelled") },
  }, { highWaterMark: 0 })
}
