import { z } from "zod"
import { INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"
import { desktopFreeHash } from "./desktop-free-proof.js"
import type { AutoConfig } from "./free-config.js"

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const schema = z.strictObject({
  model: z.literal(INFERENCE_FREE_MODEL_ID),
  messages: z.array(z.strictObject({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.strictObject({ type: z.literal("text"), text: z.string() }))]).nullish(),
    name: z.string().optional(), tool_call_id: z.string().optional(), refusal: z.string().nullish(),
    tool_calls: z.array(z.strictObject({ id: z.string().min(1).max(256), type: z.literal("function"),
      function: z.strictObject({ name, arguments: z.string() }) })).max(64).nullish(),
  })).min(1).max(256),
  tools: z.array(z.strictObject({ type: z.literal("function"), function: z.strictObject({ name,
    description: z.string().max(8192).nullish(), parameters: z.record(z.string(), z.unknown()).nullish(), strict: z.boolean().nullish() }) })).max(64).nullish(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), z.strictObject({ type: z.literal("function"), function: z.strictObject({ name }) })]).nullish(),
  parallel_tool_calls: z.boolean().nullish(),
  max_tokens: z.number().int().positive().max(128000).nullish(),
  max_completion_tokens: z.number().int().positive().max(128000).nullish(),
  stream: z.boolean().optional(), stream_options: z.strictObject({ include_usage: z.boolean().optional() }).nullish(),
  n: z.literal(1).nullish(),
  reasoning_effort: z.literal("none").nullish(),
  verbosity: z.enum(["low", "medium", "high"]).nullish(),
  response_format: z.union([z.strictObject({ type: z.enum(["text", "json_object"]) }), z.strictObject({ type: z.literal("json_schema"),
    json_schema: z.strictObject({ name: z.string(), description: z.string().optional(), schema: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }) })]).nullish(),
})
function boundedSchema(value: unknown, depth = 0): boolean {
  if (depth > 24) return false
  if (Array.isArray(value)) return value.every((entry) => boundedSchema(entry, depth + 1))
  if (value && typeof value === "object") return !Object.hasOwn(value, "$ref") && Object.values(value).every((entry) => boundedSchema(entry, depth + 1))
  return true
}
export class FreeRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string, message: string) { super(message) }
}
export function prepareFreeRequest(value: unknown, config: AutoConfig) {
  const parsed = schema.safeParse(value)
  if (!parsed.success || !boundedSchema(value)) throw new FreeRequestError(400, "unsupported_free_inference_input", "Auto supports text and ordinary function tools. This input was not sent.")
  const request = parsed.data
  // OpenAI Chat Completions with the dedicated free key; the client never chooses the model or routing.
  const messages = request.messages.map(({ refusal, ...message }) => refusal == null ? message : { ...message, refusal })
  const body = JSON.stringify({ model: config.upstreamModel, messages,
    ...(request.tools != null ? { tools: request.tools } : {}), ...(request.tool_choice != null ? { tool_choice: request.tool_choice } : {}),
    ...(request.parallel_tool_calls != null ? { parallel_tool_calls: request.parallel_tool_calls } : {}),
    ...(request.response_format != null ? { response_format: request.response_format } : {}),
    ...(request.verbosity != null ? { verbosity: request.verbosity } : {}),
    stream: request.stream === true, ...(request.stream ? { stream_options: { include_usage: true } } : {}),
    max_completion_tokens: Math.min(request.max_tokens ?? config.maxCompletionTokens, request.max_completion_tokens ?? config.maxCompletionTokens, config.maxCompletionTokens),
    reasoning_effort: "none", store: false,
  })
  if (Buffer.byteLength(body, "utf8") > config.maxInputTokens - 2048) throw new FreeRequestError(413, "free_inference_input_too_large", "Auto's text and tool context is too large. Nothing was trimmed or sent.")
  return { body, stream: request.stream === true }
}

export async function readFreeRequest(request: Request, maxBytes: number, signal: AbortSignal) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || request.headers.has("content-encoding")) {
    throw new FreeRequestError(400, "invalid_request", "Auto requires uncompressed JSON.")
  }
  if (!request.body) throw new FreeRequestError(400, "invalid_request", "A JSON body is required.")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener("abort", abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw new FreeRequestError(413, "free_inference_request_too_large", "The Auto request is too large. Nothing was sent.")
      chunks.push(chunk.value)
    }
    const bytes = Buffer.concat(chunks)
    let value: unknown
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
    catch { throw new FreeRequestError(400, "invalid_json", "The Auto request must contain valid UTF-8 JSON.") }
    return { value, bodyHash: desktopFreeHash(Uint8Array.from(bytes)) }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock() }
}
