// Anthropic Messages for Claude Code (feature `gatewayMemberApiKeys`). Claude Code only speaks the
// Messages API. A model whose provider speaks it too gets the request as it is; every other model
// goes through the Gateway's translators, which speak Chat Completions on the client side. So a
// Messages request is read as a chat request, and the Chat Completions answer is written back as a
// Messages object (JSON) or Messages event stream (SSE).
import { randomUUID } from "node:crypto"
import { isJsonObject, type JsonObject } from "./auto-router/chat.js"

/** The fewest output tokens every translated provider accepts. */
const MIN_OUTPUT_TOKENS = 16

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((block) => isJsonObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n")
}

/** An Anthropic image block as a Chat Completions image part. */
function imagePart(block: JsonObject): JsonObject | null {
  const source = isJsonObject(block.source) ? block.source : null
  if (!source) return null
  if (source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
    return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } }
  }
  if (source.type === "url" && typeof source.url === "string") return { type: "image_url", image_url: { url: source.url } }
  return null
}

/** A tool result's content as text (Chat Completions tool messages take text). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((block) => {
    if (!isJsonObject(block)) return []
    if (block.type === "text" && typeof block.text === "string") return [block.text]
    if (block.type === "image") return ["[image]"]
    return []
  }).join("\n")
}

/**
 * A Messages request as a Chat Completions request: the system prompt, then each message in order.
 * A user turn's tool results become tool messages before its other content; an assistant turn's
 * tool uses become its tool calls. Thinking blocks are dropped: the Gateway keeps reasoning state
 * itself, by tool call id. Anthropic server tools (web search and the like) are dropped.
 */
export function messagesToChat(body: JsonObject): JsonObject {
  const messages: JsonObject[] = []
  const system = textOf(body.system)
  if (system) messages.push({ role: "system", content: system })
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isJsonObject(message) || (message.role !== "user" && message.role !== "assistant")) continue
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content })
      continue
    }
    const blocks = Array.isArray(message.content) ? message.content.filter(isJsonObject) : []
    if (message.role === "assistant") {
      const text = blocks.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n")
      const calls = blocks.flatMap((block) => block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string"
        ? [{ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }] : [])
      if (text || calls.length) messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) })
      continue
    }
    for (const block of blocks) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const text = toolResultText(block.content)
        messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.is_error === true ? `Error: ${text}` : text })
      }
    }
    const parts = blocks.flatMap((block): JsonObject[] => {
      if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }]
      if (block.type === "image") return imagePart(block) ? [imagePart(block) ?? {}] : []
      return []
    })
    if (parts.length) messages.push({ role: "user", content: parts.every((part) => part.type === "text") ? parts.map((part) => String(part.text)).join("\n") : parts })
  }
  const chat: JsonObject = { model: body.model, messages, stream: body.stream === true }
  // Claude Code checks a model it switches to with max_tokens: 1; OpenAI refuses fewer than 16.
  if (typeof body.max_tokens === "number") chat.max_tokens = Math.max(MIN_OUTPUT_TOKENS, body.max_tokens)
  if (typeof body.temperature === "number") chat.temperature = body.temperature
  if (typeof body.top_p === "number") chat.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) chat.stop = body.stop_sequences
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((tool) => isJsonObject(tool) && typeof tool.name === "string" && isJsonObject(tool.input_schema)
      ? [{ type: "function", function: { name: tool.name, ...(typeof tool.description === "string" ? { description: tool.description } : {}), parameters: tool.input_schema } }]
      : [])
    if (tools.length) chat.tools = tools
  }
  const choice = isJsonObject(body.tool_choice) ? body.tool_choice : null
  if (choice?.type === "auto") chat.tool_choice = "auto"
  else if (choice?.type === "any") chat.tool_choice = "required"
  else if (choice?.type === "none") chat.tool_choice = "none"
  else if (choice?.type === "tool" && typeof choice.name === "string") chat.tool_choice = { type: "function", function: { name: choice.name } }
  if (choice?.disable_parallel_tool_use === true) chat.parallel_tool_calls = false
  return chat
}

/** The effort a Messages request asks for (`output_config.effort`), if any. */
export function messagesReasoningEffort(body: JsonObject): string | null {
  return isJsonObject(body.output_config) && typeof body.output_config.effort === "string" ? body.output_config.effort : null
}

type MessagesUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

function messagesUsage(usage: unknown): MessagesUsage {
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0
  if (!isJsonObject(usage)) return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const details = isJsonObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  const cached = number(details.cached_tokens)
  const written = number(details.cache_write_tokens) || number(usage.cache_creation_input_tokens)
  return { input_tokens: Math.max(0, number(usage.prompt_tokens) - cached - written), output_tokens: number(usage.completion_tokens), cache_read_input_tokens: cached, cache_creation_input_tokens: written }
}

function stopReason(finish: unknown): string {
  if (finish === "length") return "max_tokens"
  if (finish === "tool_calls" || finish === "function_call") return "tool_use"
  if (finish === "content_filter") return "refusal"
  return "end_turn"
}

function parseArguments(value: unknown): JsonObject {
  if (typeof value !== "string" || !value.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isJsonObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function messageId() {
  return `msg_${randomUUID().replace(/-/g, "")}`
}

/** A `chat.completion` object as a Messages `message` object. */
export function chatToMessages(chat: unknown, model: string): JsonObject {
  const choice = isJsonObject(chat) && Array.isArray(chat.choices) ? chat.choices.find(isJsonObject) : undefined
  const message = choice && isJsonObject(choice.message) ? choice.message : {}
  const content: JsonObject[] = []
  const text = typeof message.content === "string" ? message.content : textOf(message.content)
  if (text) content.push({ type: "text", text })
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isJsonObject(call) || !isJsonObject(call.function)) continue
      content.push({ type: "tool_use", id: typeof call.id === "string" ? call.id : `toolu_${randomUUID().replace(/-/g, "")}`, name: String(call.function.name ?? ""), input: parseArguments(call.function.arguments) })
    }
  }
  return {
    id: messageId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: messagesUsage(isJsonObject(chat) ? chat.usage : null),
  }
}

/** A Chat Completions error body as a Messages error body. */
export function chatErrorToMessages(body: unknown, status: number): JsonObject {
  const error = isJsonObject(body) && isJsonObject(body.error) ? body.error : {}
  const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 404 ? "not_found_error"
    : status === 429 ? "rate_limit_error" : status === 413 ? "request_too_large" : status >= 500 ? "api_error" : "invalid_request_error"
  return { type: "error", error: { type, message: typeof error.message === "string" ? error.message : `The model failed with HTTP ${status}.` } }
}

/**
 * A Chat Completions SSE stream as a Messages event stream: message_start, a content block per text
 * run and tool call (text_delta, input_json_delta), message_delta with the stop reason and usage,
 * then message_stop.
 */
export function chatStreamToMessages(body: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ""
  let started = false
  let finished = false
  let index = -1
  let open: { kind: "text" } | { kind: "tool"; key: number } | null = null
  const toolBlocks = new Map<number, number>()
  let finishReason: unknown = null
  let usage = messagesUsage(null)

  const event = (controller: TransformStreamDefaultController<Uint8Array>, type: string, data: JsonObject) => {
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`))
  }
  const start = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (started) return
    started = true
    event(controller, "message_start", { message: { id: messageId(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } })
  }
  const close = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!open) return
    event(controller, "content_block_stop", { index })
    open = null
  }
  const finish = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (finished) return
    finished = true
    start(controller)
    close(controller)
    event(controller, "message_delta", { delta: { stop_reason: stopReason(finishReason), stop_sequence: null }, usage })
    event(controller, "message_stop", {})
  }
  const fail = (controller: TransformStreamDefaultController<Uint8Array>, error: unknown) => {
    finished = true
    const detail = isJsonObject(error) ? error : {}
    event(controller, "error", { error: { type: "api_error", message: typeof detail.message === "string" ? detail.message : "The model failed." } })
  }
  const chunk = (controller: TransformStreamDefaultController<Uint8Array>, data: JsonObject) => {
    if (isJsonObject(data.error)) return fail(controller, data.error)
    start(controller)
    if (isJsonObject(data.usage)) usage = messagesUsage(data.usage)
    const choice = Array.isArray(data.choices) ? data.choices.find(isJsonObject) : undefined
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = isJsonObject(choice.delta) ? choice.delta : {}
    if (typeof delta.content === "string" && delta.content) {
      if (open?.kind !== "text") {
        close(controller)
        index += 1
        open = { kind: "text" }
        event(controller, "content_block_start", { index, content_block: { type: "text", text: "" } })
      }
      event(controller, "content_block_delta", { index, delta: { type: "text_delta", text: delta.content } })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        if (!isJsonObject(part)) continue
        const key = typeof part.index === "number" ? part.index : toolBlocks.size
        const fn = isJsonObject(part.function) ? part.function : {}
        if (!toolBlocks.has(key)) {
          close(controller)
          index += 1
          toolBlocks.set(key, index)
          open = { kind: "tool", key }
          event(controller, "content_block_start", { index, content_block: { type: "tool_use", id: typeof part.id === "string" ? part.id : `toolu_${randomUUID().replace(/-/g, "")}`, name: typeof fn.name === "string" ? fn.name : "", input: {} } })
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          event(controller, "content_block_delta", { index: toolBlocks.get(key) ?? index, delta: { type: "input_json_delta", partial_json: fn.arguments } })
        }
      }
    }
  }
  const line = (controller: TransformStreamDefaultController<Uint8Array>, raw: string) => {
    if (finished || !raw.startsWith("data:")) return
    const data = raw.slice(5).trim()
    if (data === "[DONE]") return finish(controller)
    try {
      const parsed: unknown = JSON.parse(data)
      if (isJsonObject(parsed)) chunk(controller, parsed)
    } catch { /* A malformed line is skipped. */ }
  }
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const raw of lines) line(controller, raw.trimEnd())
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) line(controller, buffer.trimEnd())
      if (!finished) fail(controller, { message: "The model's response ended early." })
    },
  }))
}

/** A rough count for /v1/messages/count_tokens: about four characters a token. */
export function estimateMessagesTokens(body: JsonObject): number {
  const text = JSON.stringify({ system: body.system ?? null, messages: body.messages ?? [], tools: body.tools ?? [] })
  return Math.max(1, Math.ceil(text.length / 4))
}
