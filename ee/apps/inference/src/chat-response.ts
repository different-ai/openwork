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
export async function readResponseJson(body: ReadableStream<Uint8Array> | null, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  if (!body) throw new Error("Missing response body")
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let text = ""
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error("Response body exceeds the managed limit")
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally { void reader.cancel().catch(() => {}) }
}

export function completeChatResponse(value: unknown): boolean {
  if (!record(value) || value.error || !Array.isArray(value.choices) || value.choices.length !== 1) return false
  return value.choices.every((choice) => {
    if (!record(choice) || !record(choice.message) || !["stop", "length", "tool_calls", "content_filter"].includes(String(choice.finish_reason))) return false
    if (choice.message.tool_calls == null) return choice.finish_reason !== "tool_calls"
    if (!Array.isArray(choice.message.tool_calls)) return false
    if (!choice.message.tool_calls.length) return choice.finish_reason !== "tool_calls"
    const ids = new Set<string>()
    return choice.message.tool_calls.every((call) => {
      if (!record(call) || typeof call.id !== "string" || !call.id || ids.has(call.id) || call.type !== "function" || !record(call.function) || typeof call.function.name !== "string" || !call.function.name || typeof call.function.arguments !== "string") return false
      ids.add(call.id)
      try { JSON.parse(call.function.arguments); return true } catch { return false }
    })
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
  private tools = new Map<string, { id: string; name: string; arguments: string }>()
  done = false
  failed = false
  output = false

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
      if (!this.choices.size || [...this.choices].some((choice) => !this.finished.has(choice))) throw new InvalidStream("upstream_incomplete", "The model stopped before completing its response. Partial output is preserved. Review it before retrying.")
      this.done = true
      return "data: [DONE]\n\n"
    }
    let value: unknown
    try { value = JSON.parse(data) } catch { throw new InvalidStream("upstream_malformed_stream", "The model returned an invalid response frame. Partial output is preserved.") }
    if (!record(value)) throw new InvalidStream("upstream_malformed_stream", "The model returned an invalid response frame.")
    if (value.error) {
      this.failed = true
      return `data: ${JSON.stringify(upstreamError(record(value.error) ? Number(value.error.code) : 502))}\n\n`
    }
    if (!Array.isArray(value.choices)) throw new InvalidStream("upstream_malformed_stream", "The model returned a response without completion choices.")
    if (value.choices.length > 1) throw new InvalidStream("upstream_malformed_stream", "The model returned multiple completion choices.")
    for (const choice of value.choices) {
      if (!record(choice) || choice.index !== 0) throw new InvalidStream("upstream_malformed_stream", "The model returned an unrequested completion choice.")
      this.choices.add(choice.index)
      if (choice.finish_reason === "error") throw new InvalidStream("upstream_error", "The provider interrupted its response. Partial output is preserved.")
      const delta = record(choice.delta) ? choice.delta : {}
      const hasOutput = Boolean(delta.content || delta.reasoning || delta.reasoning_content ||
        (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) ||
        (Array.isArray(delta.tool_calls) && delta.tool_calls.length))
      if (hasOutput && this.finished.has(choice.index)) throw new InvalidStream("upstream_malformed_stream", "The model sent output after completing the response.")
      if (hasOutput) this.output = true
      if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) throw new InvalidStream("upstream_malformed_stream", "The model returned invalid tool calls.")
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (!record(call) || typeof call.index !== "number" || !Number.isInteger(call.index) || call.index < 0) throw new InvalidStream("upstream_malformed_stream", "The model returned an invalid tool-call index.")
          const key = `${choice.index}:${call.index}`
          if (!this.tools.has(key) && this.tools.size >= 128) throw new InvalidStream("upstream_malformed_stream", "The model returned too many tool calls.")
          if (call.type !== undefined && call.type !== "function") throw new InvalidStream("upstream_malformed_stream", "The model returned an unsupported tool-call type.")
          const tool = this.tools.get(key) ?? { id: "", name: "", arguments: "" }
          if (typeof call.id === "string") {
            if (tool.id && tool.id !== call.id) throw new InvalidStream("upstream_malformed_stream", "The model changed a tool-call identity while streaming.")
            if (call.id && [...this.tools.entries()].some(([otherKey, other]) => otherKey !== key && other.id === call.id)) throw new InvalidStream("upstream_malformed_stream", "The model reused a tool-call identity.")
            tool.id = call.id
          }
          if (record(call.function)) {
            if (typeof call.function.name === "string") tool.name += call.function.name
            if (typeof call.function.arguments === "string") tool.arguments += call.function.arguments
          }
          if (tool.arguments.length > 2_000_000 || tool.name.length > 1024 || tool.id.length > 1024) throw new InvalidStream("upstream_malformed_stream", "The model returned oversized tool calls.")
          this.tools.set(key, tool)
        }
      }
      if (typeof choice.finish_reason === "string") {
        if (!["stop", "length", "tool_calls", "content_filter"].includes(choice.finish_reason)) throw new InvalidStream("upstream_malformed_stream", "The model returned an unknown completion status.")
        if (choice.finish_reason === "tool_calls" && !this.tools.size) throw new InvalidStream("upstream_incomplete", "The model ended with a missing tool call. Review the partial response before retrying.")
        for (const [key, tool] of this.tools) {
          if (!key.startsWith(`${choice.index}:`)) continue
          if (!tool.id || !tool.name) throw new InvalidStream("upstream_incomplete", "The model did not finish its tool call. Review the partial response before retrying.")
          try { JSON.parse(tool.arguments) } catch { throw new InvalidStream("upstream_incomplete", "The model did not finish its tool arguments. Review the partial response before retrying.") }
        }
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
  onFinish(report: ChatCompletionReport): void
}): ReadableStream<Uint8Array> {
  const reader = input.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const encoder = new TextEncoder()
  const parser = new ChatStream()
  let settled = false
  let bytes = 0
  let firstOutputMs: number | null = null
  let lastOutputAt = Date.now()
  const finish = (outcome: ChatOutcome, code?: string) => {
    if (settled) return
    settled = true
    input.onFinish({ outcome, code, durationMs: Date.now() - input.startedAt, firstOutputMs, responseBytes: bytes })
    input.abort.abort()
    void reader.cancel().catch(() => {})
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
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
        for (const line of text.split(/(?<=\n)/)) {
          for (const frame of parser.feed(line)) controller.enqueue(encoder.encode(frame))
          if (parser.done || parser.failed) break
        }
        if (parser.output) {
          lastOutputAt = Date.now()
          firstOutputMs ??= lastOutputAt - input.startedAt
        }
        if (parser.done || parser.failed) {
          finish(parser.failed ? "upstream_error" : "completed")
          controller.close()
        } else if (Date.now() - lastOutputAt > input.idleMs * 3) {
          throw new InvalidStream("upstream_timeout", "The provider is connected but the model is not producing output. Review partial work before retrying.")
        }
      } catch (error) {
        if (settled) return
        const cancelled = input.abort.signal.aborted
        const code = error instanceof InvalidStream ? error.code : "upstream_interrupted"
        const message = error instanceof InvalidStream ? error.message : "The model response was interrupted. Partial output is preserved; review it before retrying."
        finish(cancelled ? "cancelled" : code === "upstream_timeout" ? "timeout" : "incomplete", code)
        if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(inferenceError(code, message))}\n\n`))
        controller.close()
      } finally { clearTimeout(timer) }
    },
    cancel() { finish("cancelled") },
  }, { highWaterMark: 0 })
}
