import { INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"
import type { FreeUsageReceipt } from "./allowance.js"
import { freeUsageAmount } from "@openwork/free-auto/accounting"
import type { FreeProtocol } from "./request.js"
import type { AutoConfig } from "./config.js"

export type FreeMeterConfig = Pick<AutoConfig, "upstreamModel" | "inputPrice" | "cachedInputPrice" | "outputPrice">
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 }
/** OpenAI reports a dated snapshot (for example `gpt-6-luna-2026-09-22`) of the requested model. */
export function isFreeUpstreamModel(value: unknown, config: FreeMeterConfig) {
  return typeof value === "string" && (value === config.upstreamModel || value.startsWith(`${config.upstreamModel}-`))
}
export function readFreeUsage(value: unknown, eventId: string, config: FreeMeterConfig, protocol: FreeProtocol = "chat"): FreeUsageReceipt | null {
  if (!record(value) || !record(value.usage) || !isFreeUpstreamModel(value.model, config)) return null
  const usage = value.usage
  const inputTokens = protocol === "responses" ? usage.input_tokens : usage.prompt_tokens
  const outputTokens = protocol === "responses" ? usage.output_tokens : usage.completion_tokens
  const details = protocol === "responses" ? usage.output_tokens_details : usage.completion_tokens_details
  const inputDetails = protocol === "responses" ? usage.input_tokens_details : usage.prompt_tokens_details
  if (!nonnegative(inputTokens) || !nonnegative(outputTokens)) return null
  if (record(details) && details.reasoning_tokens !== undefined
    && (!nonnegative(details.reasoning_tokens) || details.reasoning_tokens > outputTokens)) return null
  // Input tokens include cache hits, which OpenAI bills at the cached input price.
  const cachedInputTokens = record(inputDetails) && inputDetails.cached_tokens != null ? inputDetails.cached_tokens : 0
  if (!nonnegative(cachedInputTokens) || cachedInputTokens > inputTokens) return null
  const amount = freeUsageAmount(config, inputTokens, outputTokens, cachedInputTokens)
  if (!nonnegative(amount)) return null
  return { amount, eventId, model: INFERENCE_FREE_MODEL_ID, inputTokens, cachedInputTokens, outputTokens }
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
  private finishedChoices = new Set<number>()
  private receipt: FreeUsageReceipt | null = null
  private sawModel = false
  private invalidUsage = false
  done = false
  constructor(private readonly config: FreeMeterConfig, private readonly choiceCount = 1) {}
  accept(value: unknown): Record<string, unknown> {
    if (this.done || !record(value) || value.error != null || !Array.isArray(value.choices) || value.choices.length > this.choiceCount) throw new Error("Incomplete Auto response")
    if (value.id !== undefined) {
      if (typeof value.id !== "string" || !value.id || value.id.length > 255 || this.id !== null && this.id !== value.id) throw new Error("Mismatched Auto response identity")
      this.id = value.id
    }
    if (value.model !== undefined) {
      if (!isFreeUpstreamModel(value.model, this.config)) throw new Error("Mismatched Auto model")
      this.sawModel = true
    }
    for (const choice of value.choices) {
      if (!record(choice) || !nonnegative(choice.index) || choice.index >= this.choiceCount) throw new Error("Invalid Auto choice")
      if (this.finishedChoices.has(choice.index) && record(choice.delta) && Object.values(choice.delta).some((part) => part !== null && part !== "")) throw new Error("Output after Auto completion")
      if (choice.finish_reason != null) {
        if (!["stop", "length", "tool_calls", "function_call", "content_filter"].includes(String(choice.finish_reason))) throw new Error("Invalid Auto completion")
        this.finishedChoices.add(choice.index)
      }
    }
    if (this.finishedChoices.size === this.choiceCount && this.id && this.sawModel && record(value.usage)) {
      const receipt = readFreeUsage(value, this.id, this.config)
      if (receipt && this.receipt && JSON.stringify(receipt) !== JSON.stringify(this.receipt)) throw new Error("Conflicting Auto usage")
      if (receipt) this.receipt = receipt
      else this.invalidUsage = true
    }
    return publicResponse(value)
  }
  complete() {
    if (this.finishedChoices.size !== this.choiceCount || !this.id || !this.sawModel || this.done) throw new Error("Incomplete Auto response")
    this.done = true
    return this.invalidUsage ? null : this.receipt
  }
}

/** Responses finishes on a terminal response event, without Chat Completions' [DONE] sentinel. */
export class FreeResponsesReceipt {
  private id: string | null = null
  private receipt: FreeUsageReceipt | null = null
  terminal = false
  done = false
  constructor(private readonly config: FreeMeterConfig) {}
  private response(value: unknown) {
    if (!record(value) || value.error != null || typeof value.id !== "string" || !value.id || value.id.length > 255
      || this.id !== null && this.id !== value.id || !isFreeUpstreamModel(value.model, this.config)) throw new Error("Mismatched Auto response")
    this.id = value.id
    return { ...value, model: INFERENCE_FREE_MODEL_ID }
  }
  accept(value: unknown): Record<string, unknown> {
    if (this.done || this.terminal || !record(value)) throw new Error("Incomplete Auto response")
    if (value.object === "response") {
      const result = this.response(value)
      if (value.status !== "completed" && value.status !== "incomplete") throw new Error("Incomplete Auto response")
      this.receipt = readFreeUsage(value, this.id!, this.config, "responses")
      this.terminal = true
      return result
    }
    if (typeof value.type !== "string" || !value.type.startsWith("response.") || value.type === "response.failed") throw new Error("Auto upstream failed")
    const result = { ...value }
    if (value.response !== undefined) result.response = this.response(value.response)
    if (value.type === "response.completed" || value.type === "response.incomplete") {
      if (!record(value.response) || value.response.status !== value.type.slice("response.".length) || !this.id) throw new Error("Incomplete Auto response")
      this.receipt = readFreeUsage(value.response, this.id, this.config, "responses")
      this.terminal = true
    }
    return result
  }
  complete() {
    if (!this.terminal || this.done) throw new Error("Incomplete Auto response")
    this.done = true
    return this.receipt
  }
}

export function meterFreeResponse(body: ReadableStream<Uint8Array>, input: {
  config: FreeMeterConfig; protocol?: FreeProtocol; streaming: boolean; maxBytes: number; signal: AbortSignal; choices?: number;
  settle: (receipt: FreeUsageReceipt | null) => Promise<void>;
}) {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const encoder = new TextEncoder()
  const receipt = input.protocol === "responses" ? new FreeResponsesReceipt(input.config) : new FreeResponseReceipt(input.config, input.choices)
  let pending = "", data: string[] = [], closed = false
  let settlement: Promise<void> | null = null
  const settle = (value: FreeUsageReceipt | null) => settlement ??= input.settle(value)
  const cleanup = () => { input.signal.removeEventListener("abort", abort); void reader.cancel().catch(() => undefined) }
  let output: ReadableStreamDefaultController<Uint8Array>
  const fail = (error: unknown) => {
    if (closed) return
    closed = true
    cleanup()
    void settle(null).catch(() => { console.error("Auto allowance settlement failed") })
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
              if (receipt instanceof FreeResponsesReceipt && receipt.terminal) await settle(receipt.complete())
              if (closed) return
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
              if (receipt.done) {
                closed = true
                cleanup()
                controller.close()
                return
              }
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
