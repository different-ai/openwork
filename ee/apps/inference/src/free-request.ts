import { INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import { z } from "zod"
import { createHash } from "node:crypto"
import models from "./models/openwork-models.json" with { type: "json" }

export const FREE_REQUEST_MAX_BYTES = 128 * 1024
export const FREE_INPUT_CONTENT_MAX_BYTES = 32 * 1024
export const FREE_MAX_OUTPUT_TOKENS = 4096
const effort = z.enum(["none", "low", "medium", "high", "xhigh", "max"])
const functionName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const functionCall = z.strictObject({ name: functionName, arguments: z.string() })
const reasoningDetailFields = { id: z.string().nullish(), format: z.string().optional(), index: z.number().int().nonnegative().optional() }
const reasoningDetail = z.union([
  z.strictObject({ ...reasoningDetailFields, type: z.literal("reasoning.text"), text: z.string(), signature: z.string().nullish() }),
  z.strictObject({ ...reasoningDetailFields, type: z.literal("reasoning.summary"), summary: z.string() }),
  z.strictObject({ ...reasoningDetailFields, type: z.literal("reasoning.encrypted"), data: z.string() }),
])
const requestSchema = z.strictObject({
  model: z.string(),
  messages: z.array(z.strictObject({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.strictObject({ type: z.literal("text"), text: z.string() }))]).nullable().optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.strictObject({ id: z.string().min(1), type: z.literal("function"), function: functionCall })).nullish(),
    reasoning: z.string().nullish(),
    reasoning_content: z.string().nullish(),
    // Preserve ordinary engine reasoning history. Its supplied bytes contribute
    // to the size limit; restored input is charged from actual provider usage.
    reasoning_details: z.array(reasoningDetail).nullish(),
    annotations: z.array(z.never()).nullish(),
  })).min(1),
  tools: z.array(z.strictObject({
    type: z.literal("function"),
    function: z.strictObject({ name: functionName, description: z.string().nullish(), parameters: z.record(z.string(), z.unknown()).nullish(), strict: z.boolean().nullish() }),
  })).nullish(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), z.strictObject({ type: z.literal("function"), function: z.strictObject({ name: functionName }) })]).nullish(),
  parallel_tool_calls: z.boolean().nullish(),
  n: z.literal(1).nullish(),
  max_tokens: z.number().int().positive().max(128_000).nullish(),
  max_completion_tokens: z.number().int().positive().max(128_000).nullish(),
  stream: z.boolean().optional(),
  stream_options: z.strictObject({ include_usage: z.boolean().optional() }).nullish(),
  usage: z.strictObject({ include: z.boolean() }).nullish(),
  reasoning: z.strictObject({ effort: effort.nullish(), enabled: z.boolean().optional(), exclude: z.boolean().optional(), summary: z.enum(["auto", "concise", "detailed"]).optional() }).nullish(),
  reasoning_effort: effort.nullish(),
  // OpenCode 1.18.18 passes these adapter options through OpenRouter SDK 2.9.0
  // verbatim, alongside usage.include and an optional canonical reasoning.effort.
  reasoningEffort: effort.optional(),
  textVerbosity: z.enum(["low", "medium", "high"]).optional(),
  verbosity: z.enum(["low", "medium", "high"]).nullish(),
  temperature: z.number().finite().nullish(),
  top_p: z.number().finite().nullish(),
  top_k: z.number().int().nonnegative().nullish(),
  frequency_penalty: z.number().finite().nullish(),
  presence_penalty: z.number().finite().nullish(),
  seed: z.number().int().nullish(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
  transforms: z.array(z.never()).optional(),
  provider: z.strictObject({ allow_fallbacks: z.literal(false).optional(), require_parameters: z.literal(true).optional() }).optional(),
  response_format: z.union([
    z.strictObject({ type: z.enum(["text", "json_object"]) }),
    z.strictObject({ type: z.literal("json_schema"), json_schema: z.strictObject({ name: z.string(), description: z.string().optional(), schema: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }) }),
  ]).nullish(),
})

export type FreeRequestError = { ok: false; status: 400 | 413 | 503; code: string; message: string }
export type FreeRequestInspection = { ok: true; inputContentBytes: number; request: z.infer<typeof requestSchema> } | FreeRequestError

export function inspectFreeRequest(value: unknown): FreeRequestInspection {
  const parsed = requestSchema.safeParse(value)
  if (!parsed.success) return { ok: false, status: 400, code: "unsupported_free_inference_input", message: "Free Luna accepts text and ordinary function tools. This input contains an invalid or unsupported parameter, attachment, server feature, or stored reasoning block. Nothing was trimmed or sent; this is not an allowance or upgrade error." }
  const request = parsed.data
  if (![INFERENCE_FREE_MODEL_ID, `openwork/${INFERENCE_FREE_MODEL_ID}`].includes(request.model)) {
    return { ok: false, status: 400, code: "unsupported_free_inference_input", message: "The free request must select standard Luna." }
  }
  // A byte-level BPE starts with UTF-8 bytes and only merges them. This bounds
  // tokens in THIS serialized supplied input, including names, JSON schemas,
  // system messages and tool history. It DOES NOT bound provider-added framing,
  // schema expansion or restored reasoning. See FREE_ALLOWANCE.md for sources.
  const inputContentBytes = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools, response_format: request.response_format }), "utf8")
  if (inputContentBytes > FREE_INPUT_CONTENT_MAX_BYTES) {
    return { ok: false, status: 413, code: "free_inference_input_too_large", message: `Free Luna input is limited to ${FREE_INPUT_CONTENT_MAX_BYTES} UTF-8 bytes including messages, tool schemas and structured-output schemas. Shorten the input explicitly; nothing was trimmed or sent.` }
  }
  return { ok: true, inputContentBytes, request }
}

export async function readFreeRequest(request: Request): Promise<{ ok: true; value: unknown; bodyHash: string } | FreeRequestError> {
  const reader = request.body?.getReader()
  if (!reader) return { ok: false, status: 400, code: "invalid_json", message: "A JSON request body is required." }
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const hash = createHash("sha256")
  let bytes = 0
  let text = ""
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > FREE_REQUEST_MAX_BYTES) {
        void reader.cancel().catch(() => {})
        return { ok: false, status: 413, code: "free_inference_request_too_large", message: `Free inference requests are limited to ${FREE_REQUEST_MAX_BYTES} bytes. Nothing was trimmed or sent.` }
      }
      hash.update(chunk.value)
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return { ok: true, value: JSON.parse(text), bodyHash: hash.digest("hex") }
  } catch {
    void reader.cancel().catch(() => {})
    return { ok: false, status: 400, code: "invalid_json", message: "The request must contain valid UTF-8 JSON." }
  } finally {
    reader.releaseLock()
  }
}

export type FreeRequestPricing = {
  inputTokenEstimate: number
  inputTokenPrice: number
  outputTokenPrice: number
  maxOutputTokens: number
  provider: {
    allow_fallbacks: false
    require_parameters: true
    max_price: { prompt: number; completion: number; request: 0 }
  }
}

export type FreeRequestPreparation = { ok: true; pricing: FreeRequestPricing } | FreeRequestError

export function prepareFreeRequest(value: unknown): FreeRequestPreparation {
  const inspection = inspectFreeRequest(value)
  if (!inspection.ok) return inspection
  const { request, inputContentBytes } = inspection
  const model = models[INFERENCE_FREE_MODEL_ID]
  const costs = [model.cost, ...model.cost.tiers, model.cost.context_over_200k]
  const inputPrice = Math.max(...costs.flatMap((cost) => [cost.input, cost.cache_read, cost.cache_write]))
  const outputPrice = Math.max(...costs.map((cost) => cost.output))
  if (![inputPrice, outputPrice].every((price) => Number.isFinite(price) && price > 0)) {
    return { ok: false, status: 503, code: "free_inference_unavailable", message: "Free Luna pricing is temporarily unavailable. No request was sent." }
  }
  // Deliberately conservative DISPLAY estimate, not a tokenizer or cost bound.
  // Admission uses actual weekly usage, not this amount. Provider framing and
  // restored reasoning can differ; the final admitted reply may exceed budget.
  const inputTokenEstimate = inputContentBytes + 1024 + request.messages.length * 64 + (request.tools?.length ?? 0) * 256
  return { ok: true, pricing: {
    inputTokenEstimate,
    inputTokenPrice: Math.ceil(inputPrice * INFERENCE_USAGE_CONVERSION_FACTOR / 1_000_000),
    outputTokenPrice: Math.ceil(outputPrice * INFERENCE_USAGE_CONVERSION_FACTOR / 1_000_000),
    maxOutputTokens: Math.min(request.max_tokens ?? model.limit.output, request.max_completion_tokens ?? model.limit.output, FREE_MAX_OUTPUT_TOKENS),
    provider: { allow_fallbacks: false, require_parameters: true, max_price: { prompt: inputPrice, completion: outputPrice, request: 0 } },
  } }
}

export function freeRequestReservation(pricing: FreeRequestPricing, remaining: number) {
  if (![pricing.inputTokenEstimate, pricing.inputTokenPrice, pricing.outputTokenPrice, pricing.maxOutputTokens].every((value) => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(remaining) || remaining < 0) return null
  const maxOutputTokens = Math.min(pricing.maxOutputTokens, FREE_MAX_OUTPUT_TOKENS)
  const estimate = pricing.inputTokenEstimate * pricing.inputTokenPrice + maxOutputTokens * pricing.outputTokenPrice
  if (!Number.isSafeInteger(estimate) || estimate <= 0 || remaining === 0) return null
  // A positive marker occupies the one-request slot even with one unit left.
  // The estimate cannot prevent admission or shorten the last admitted reply.
  const amount = Math.min(estimate, remaining)
  return { amount, maxOutputTokens }
}
