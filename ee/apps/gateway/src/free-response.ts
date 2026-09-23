import { INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"
import type { FreeUsageReceipt } from "./free-allowance.js"
import { freeUsageAmount, type AutoConfig } from "./free-config.js"

export type FreeMeterConfig = Pick<AutoConfig, "upstreamModel" | "inputPrice" | "outputPrice">
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 }
/** OpenAI reports a dated snapshot (for example `gpt-5.6-luna-2026-08-01`) of the requested model. */
export function isFreeUpstreamModel(value: unknown, config: FreeMeterConfig) {
  return typeof value === "string" && (value === config.upstreamModel || value.startsWith(`${config.upstreamModel}-`))
}
export function readFreeUsage(value: unknown, eventId: string, config: FreeMeterConfig): FreeUsageReceipt | null {
  if (!record(value) || !record(value.usage) || !isFreeUpstreamModel(value.model, config)) return null
  const usage = value.usage
  if (!nonnegative(usage.prompt_tokens) || !nonnegative(usage.completion_tokens)) return null
  if (record(usage.completion_tokens_details) && usage.completion_tokens_details.reasoning_tokens !== undefined
    && (!nonnegative(usage.completion_tokens_details.reasoning_tokens) || usage.completion_tokens_details.reasoning_tokens > usage.completion_tokens)) return null
  const amount = freeUsageAmount(config, usage.prompt_tokens, usage.completion_tokens)
  if (!nonnegative(amount)) return null
  return { amount, eventId, model: INFERENCE_FREE_MODEL_ID, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
}
function publicResponse(value: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...value, model: INFERENCE_FREE_MODEL_ID }
  if (!record(value.usage)) return result
  const usage: Record<string, number> = {}
  for (const name of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    if (nonnegative(value.usage[name])) usage[name] = value.usage[name]
  }
  return { ...result, usage }
}

export class FreeResponseReceipt {
  private id: string | null = null
  private terminal = false
  private receipt: FreeUsageReceipt | null = null
  private sawModel = false
  private invalidUsage = false
  done = false
  constructor(private readonly config: FreeMeterConfig) {}
  accept(value: unknown): Record<string, unknown> {
    if (this.done || !record(value) || value.error != null || !Array.isArray(value.choices) || value.choices.length > 1) throw new Error("Incomplete Auto response")
    if (value.id !== undefined) {
      if (typeof value.id !== "string" || !value.id || value.id.length > 255 || this.id !== null && this.id !== value.id) throw new Error("Mismatched Auto response identity")
      this.id = value.id
    }
    if (value.model !== undefined) {
      if (!isFreeUpstreamModel(value.model, this.config)) throw new Error("Mismatched Auto model")
      this.sawModel = true
    }
    for (const choice of value.choices) {
      if (!record(choice) || choice.index !== 0) throw new Error("Invalid Auto choice")
      if (this.terminal && record(choice.delta) && Object.values(choice.delta).some((part) => part !== null && part !== "")) throw new Error("Output after Auto completion")
      if (choice.finish_reason != null) {
        if (!["stop", "length", "tool_calls", "function_call", "content_filter"].includes(String(choice.finish_reason))) throw new Error("Invalid Auto completion")
        this.terminal = true
      }
    }
    if (this.terminal && this.id && this.sawModel && record(value.usage)) {
      const receipt = readFreeUsage(value, this.id, this.config)
      if (receipt && this.receipt && JSON.stringify(receipt) !== JSON.stringify(this.receipt)) throw new Error("Conflicting Auto usage")
      if (receipt) this.receipt = receipt
      else this.invalidUsage = true
    }
    return publicResponse(value)
  }
  complete() {
    if (!this.terminal || !this.id || !this.sawModel || this.done) throw new Error("Incomplete Auto response")
    this.done = true
    return this.invalidUsage ? null : this.receipt
  }
}

export function meterFreeResponse(body: ReadableStream<Uint8Array>, input: {
  config: FreeMeterConfig; streaming: boolean; maxBytes: number; signal: AbortSignal;
  settle: (receipt: FreeUsageReceipt | null) => Promise<void>;
}) {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const encoder = new TextEncoder()
  const receipt = new FreeResponseReceipt(input.config)
  let pending = "", data: string[] = [], bytes = 0, closed = false
  let settlement: Promise<void> | null = null
  const settle = (value: FreeUsageReceipt | null) => settlement ??= input.settle(value).catch(() => undefined)
  const cleanup = () => { input.signal.removeEventListener("abort", abort); void reader.cancel().catch(() => undefined) }
  let output: ReadableStreamDefaultController<Uint8Array>
  const fail = (error: unknown) => {
    if (closed) return
    closed = true
    cleanup()
    void settle(null)
    output.error(error)
  }
  const abort = () => fail(new Error("Auto response cancelled"))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller
      input.signal.addEventListener("abort", abort, { once: true })
      if (input.signal.aborted) abort()
    },
    async pull(controller) {
      try {
        while (!closed) {
          const chunk = await reader.read()
          if (closed) return
          if (chunk.done) {
            pending += decoder.decode()
            if (input.streaming) throw new Error("Auto stream ended before completion")
            const value = receipt.accept(JSON.parse(pending))
            await settle(receipt.complete())
            if (closed) return
            controller.enqueue(encoder.encode(JSON.stringify(value)))
            closed = true
            cleanup()
            controller.close()
            return
          }
          bytes += chunk.value.byteLength
          if (bytes > input.maxBytes) throw new Error("Auto response too large")
          pending += decoder.decode(chunk.value, { stream: true })
          if (pending.length > input.maxBytes) throw new Error("Auto response frame too large")
          if (!input.streaming) continue
          let newline: number
          let emitted = false
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, "")
            pending = pending.slice(newline + 1)
            if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
            else if (line.startsWith("event:") && line.slice(6).trim() === "error") throw new Error("Auto upstream failed")
            else if (!line && data.length) {
              const text = data.join("\n")
              data = []
              if (text.trim() === "[DONE]") {
                await settle(receipt.complete())
                if (closed) return
                controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                closed = true
                cleanup()
                controller.close()
                return
              }
              const value = receipt.accept(JSON.parse(text))
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
              emitted = true
            }
          }
          if (emitted) return
        }
      } catch (error) { fail(error) }
    },
    async cancel() { if (!closed) { closed = true; cleanup(); await settle(null) } },
  }, { highWaterMark: 0 })
}
