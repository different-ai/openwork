// Translates an Auto request (OpenAI Chat Completions) to the Anthropic
// Messages API, and the Messages response (JSON or SSE) back to Chat
// Completions, so a chat client can be answered by a Claude model.
//
// Chat Completions cannot carry Claude's signed thinking blocks back to the
// gateway, so the response's blocks are handed to `remember` (the reasoning
// store) keyed by the tool call they preceded, and the caller passes them back
// in `reasoning` for the next request. Claude requires them to continue a
// tool-use turn with thinking on; when they are missing, thinking is turned
// off for that request instead of failing it.
import type { AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import { contentText, isJsonObject, type AutoRouteInfo, type JsonObject } from "./chat.js"
import type { ReasoningPayload } from "./reasoning-store.js"
import type { AutoTranslator } from "./protocol.js"

/** Receives reasoning state to keep for the tool calls it preceded. */
export type RememberReasoning = (toolCallIds: string[], payload: ReasoningPayload) => void

function parseDataUrl(url: string) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return match ? { mediaType: match[1] ?? "", data: match[2] ?? "" } : null
}

function userParts(content: unknown): JsonObject[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: JsonObject[] = []
  for (const part of content) {
    if (!isJsonObject(part)) continue
    if (part.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text })
    else if (part.type === "image_url") {
      const url = isJsonObject(part.image_url) ? part.image_url.url : part.image_url
      if (typeof url !== "string") continue
      const inline = parseDataUrl(url)
      parts.push(inline
        ? { type: "image", source: { type: "base64", media_type: inline.mediaType, data: inline.data } }
        : { type: "image", source: { type: "url", url } })
    } else if (part.type === "file" && isJsonObject(part.file) && typeof part.file.file_data === "string") {
      const inline = parseDataUrl(part.file.file_data)
      if (inline?.mediaType === "application/pdf") parts.push({ type: "document", source: { type: "base64", media_type: inline.mediaType, data: inline.data } })
    }
  }
  return parts
}

function parseArguments(value: unknown): JsonObject {
  if (isJsonObject(value)) return value
  if (typeof value !== "string" || !value.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isJsonObject(parsed) ? parsed : { value: parsed }
  } catch {
    return { input: value }
  }
}

function toolCallsOf(message: JsonObject): JsonObject[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls.filter(isJsonObject) : []
}

type AnthropicMessage = { role: "user" | "assistant"; content: JsonObject[] }

function pushMessage(list: AnthropicMessage[], role: "user" | "assistant", content: JsonObject[]) {
  if (!content.length) return
  const last = list[list.length - 1]
  // Messages must alternate; merge consecutive messages from the same side.
  if (last && last.role === role) last.content.push(...content)
  else list.push({ role, content })
}

function toolResultContent(content: unknown): string | JsonObject[] {
  if (typeof content === "string") return content
  const parts = userParts(content)
  return parts.length ? parts : contentText(content)
}

/** Whether a Claude model takes adaptive thinking with an effort (Claude 4.6 and later). */
export function claudeTakesEffort(rawModel: string) {
  // Snapshot dates (claude-3-7-sonnet-20250219) are not versions.
  const model = rawModel.replace(/[-@]\d{8}(?=$|[-@:.])/g, "")
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?/i.exec(model)
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku)/i.exec(model)
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1])
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0)
  return Number.isFinite(major) && (major > 4 || (major === 4 && minor >= 6))
}

export function toAnthropicBody(body: JsonObject, input: {
  model: string
  upstreamModel: string
  thinkingLevel: AutoRouterThinkingLevel
  maxOutputTokens: number | null
  /** Reasoning state remembered for earlier tool calls, by tool call id. */
  reasoning?: ReadonlyMap<string, ReasoningPayload>
}): JsonObject {
  const system: JsonObject[] = []
  const list: AnthropicMessage[] = []
  const source = Array.isArray(body.messages) ? body.messages.filter(isJsonObject) : []
  let lastAssistantMissingThinking = false
  for (const message of source) {
    switch (message.role) {
      case "system":
      case "developer": {
        const text = contentText(message.content)
        if (text) system.push({ type: "text", text })
        break
      }
      case "user":
        pushMessage(list, "user", userParts(message.content))
        lastAssistantMissingThinking = false
        break
      case "assistant": {
        const calls = toolCallsOf(message)
        const ids = calls.flatMap((call) => typeof call.id === "string" ? [call.id] : [])
        const recalled = ids.map((id) => input.reasoning?.get(id)).find((payload) => payload?.kind === "anthropic")
        const thinking = recalled?.blocks ?? null
        const content: JsonObject[] = [...(thinking ?? [])]
        const text = contentText(message.content)
        if (text) content.push({ type: "text", text })
        for (const call of calls) {
          const fn = isJsonObject(call.function) ? call.function : {}
          content.push({ type: "tool_use", id: call.id, name: fn.name, input: parseArguments(fn.arguments) })
        }
        pushMessage(list, "assistant", content)
        lastAssistantMissingThinking = calls.length > 0 && thinking === null
        break
      }
      case "tool":
        pushMessage(list, "user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: toolResultContent(message.content) }])
        break
    }
  }

  const next: JsonObject = {
    model: input.model,
    messages: list,
    max_tokens: readMaxTokens(body) ?? input.maxOutputTokens ?? 32_000,
  }
  if (system.length) next.system = system
  if (body.stream === true) next.stream = true
  const stop = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((value) => typeof value === "string") : []
  if (stop.length) next.stop_sequences = stop
  if (Array.isArray(body.tools)) {
    const tools = body.tools.filter(isJsonObject).flatMap((tool) => {
      const fn = isJsonObject(tool.function) ? tool.function : null
      if (tool.type !== "function" || !fn || typeof fn.name !== "string") return []
      return [{ name: fn.name, ...(typeof fn.description === "string" ? { description: fn.description } : {}), input_schema: isJsonObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} } }]
    })
    if (tools.length) next.tools = tools
  }
  const toolChoice = body.tool_choice
  if (next.tools !== undefined && toolChoice !== undefined) {
    if (toolChoice === "required") next.tool_choice = { type: "any" }
    else if (toolChoice === "none") next.tool_choice = { type: "none" }
    else if (isJsonObject(toolChoice) && isJsonObject(toolChoice.function) && typeof toolChoice.function.name === "string") next.tool_choice = { type: "tool", name: toolChoice.function.name }
    else next.tool_choice = { type: "auto" }
  }

  // A tool-use turn with thinking on must replay the signed thinking; without it, think off.
  const level = lastAssistantMissingThinking && input.thinkingLevel !== "default" ? "none" : input.thinkingLevel
  const thinkingOn = level !== "default" && level !== "none" && claudeTakesEffort(input.upstreamModel)
  if (thinkingOn) {
    next.thinking = { type: "adaptive", display: "summarized" }
    next.output_config = { effort: level }
  } else if (level === "none" && claudeTakesEffort(input.upstreamModel)) {
    next.thinking = { type: "disabled" }
  }
  if (!thinkingOn) {
    if (typeof body.temperature === "number") next.temperature = Math.min(body.temperature, 1)
    if (typeof body.top_p === "number") next.top_p = body.top_p
  }
  if (isJsonObject(body.metadata) && typeof body.metadata.user_id === "string") next.metadata = { user_id: body.metadata.user_id }
  else if (typeof body.user === "string") next.metadata = { user_id: body.user }
  return next
}

function readMaxTokens(body: JsonObject) {
  const value = body.max_completion_tokens ?? body.max_tokens
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

function finishReason(stopReason: unknown) {
  switch (stopReason) {
    case "tool_use": return "tool_calls"
    case "max_tokens":
    case "model_context_window_exceeded": return "length"
    case "refusal": return "content_filter"
    default: return "stop"
  }
}

type AnthropicUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

function readUsage(value: unknown, into: AnthropicUsage) {
  if (!isJsonObject(value)) return
  if (typeof value.input_tokens === "number") into.input = value.input_tokens
  if (typeof value.output_tokens === "number") into.output = value.output_tokens
  if (typeof value.cache_read_input_tokens === "number") into.cacheRead = value.cache_read_input_tokens
  if (typeof value.cache_creation_input_tokens === "number") into.cacheWrite = value.cache_creation_input_tokens
}

function chatUsage(usage: AnthropicUsage) {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output,
    total_tokens: prompt + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
  }
}

/** A complete Messages response as a Chat Completion. */
export function anthropicJsonToChat(body: unknown, route: AutoRouteInfo, remember?: RememberReasoning): JsonObject {
  const message = isJsonObject(body) ? body : {}
  const content = Array.isArray(message.content) ? message.content.filter(isJsonObject) : []
  const text = content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("")
  const reasoning = content.flatMap((block) => block.type === "thinking" && typeof block.thinking === "string" ? [block.thinking] : []).join("")
  const toolCalls = content.filter((block) => block.type === "tool_use").map((block) => ({
    id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
  }))
  const thinkingBlocks = content.filter((block) => block.type === "thinking" || block.type === "redacted_thinking")
  const toolCallIds = toolCalls.flatMap((call) => typeof call.id === "string" ? [call.id] : [])
  if (remember && thinkingBlocks.length && toolCallIds.length) remember(toolCallIds, { kind: "anthropic", blocks: thinkingBlocks })
  const usage: AnthropicUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  readUsage(message.usage, usage)
  return {
    id: typeof message.id === "string" ? message.id : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: route.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason(message.stop_reason),
    }],
    usage: chatUsage(usage),
    openwork_route: route,
  }
}

/** A Messages error body as a Chat Completions error body. */
export function anthropicErrorToChat(body: unknown): JsonObject {
  const error = isJsonObject(body) && isJsonObject(body.error) ? body.error : null
  if (error && typeof error.message === "string") {
    return { error: { message: error.message, type: typeof error.type === "string" ? error.type : "api_error", code: typeof error.code === "string" ? error.code : error.type ?? null } }
  }
  return isJsonObject(body) ? body : { error: { message: "The provider rejected this request.", type: "api_error" } }
}

const encoder = new TextEncoder()

/** A Messages SSE stream as a Chat Completions SSE stream, ending with usage and [DONE]. */
export function anthropicStreamToChat(body: ReadableStream<Uint8Array>, route: AutoRouteInfo, remember?: RememberReasoning): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ""
  let id = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  let started = false
  let finished = false
  let stopReason: unknown = null
  const usage: AnthropicUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  // Content block index -> tool call index / thinking block being collected.
  const toolIndexByBlock = new Map<number, number>()
  const toolCallIds: string[] = []
  const thinkingBlocks: JsonObject[] = []
  const thinkingByBlock = new Map<number, JsonObject>()

  const chunk = (delta: JsonObject, extra: JsonObject = {}) => {
    const payload: JsonObject = { id, object: "chat.completion.chunk", created, model: route.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra }
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  const handle = (event: string | null, data: string): string => {
    if (!data) return ""
    let parsed: unknown
    try { parsed = JSON.parse(data) } catch { return "" }
    if (!isJsonObject(parsed)) return ""
    const type = typeof parsed.type === "string" ? parsed.type : event
    switch (type) {
      case "message_start": {
        const message = isJsonObject(parsed.message) ? parsed.message : {}
        if (typeof message.id === "string") id = message.id
        readUsage(message.usage, usage)
        if (started) return ""
        started = true
        return chunk({ role: "assistant", content: "" }, { openwork_route: route })
      }
      case "content_block_start": {
        const index = typeof parsed.index === "number" ? parsed.index : -1
        const block = isJsonObject(parsed.content_block) ? parsed.content_block : {}
        if (block.type === "tool_use") {
          const toolIndex = toolIndexByBlock.size
          toolIndexByBlock.set(index, toolIndex)
          if (typeof block.id === "string") toolCallIds.push(block.id)
          return chunk({ tool_calls: [{ index: toolIndex, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] })
        }
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          const kept: JsonObject = { ...block }
          thinkingByBlock.set(index, kept)
          thinkingBlocks.push(kept)
        }
        return ""
      }
      case "content_block_delta": {
        const index = typeof parsed.index === "number" ? parsed.index : -1
        const delta = isJsonObject(parsed.delta) ? parsed.delta : {}
        if (delta.type === "text_delta" && typeof delta.text === "string") return chunk({ content: delta.text })
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          const kept = thinkingByBlock.get(index)
          if (kept) kept.thinking = `${typeof kept.thinking === "string" ? kept.thinking : ""}${delta.thinking}`
          return chunk({ reasoning_content: delta.thinking })
        }
        if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          const kept = thinkingByBlock.get(index)
          if (kept) kept.signature = `${typeof kept.signature === "string" ? kept.signature : ""}${delta.signature}`
          return ""
        }
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const toolIndex = toolIndexByBlock.get(index)
          return toolIndex === undefined ? "" : chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] })
        }
        return ""
      }
      case "message_delta": {
        const delta = isJsonObject(parsed.delta) ? parsed.delta : {}
        if (delta.stop_reason !== undefined) stopReason = delta.stop_reason
        readUsage(parsed.usage, usage)
        return ""
      }
      case "message_stop":
        return finish()
      case "error": {
        const error = isJsonObject(parsed.error) ? parsed.error : {}
        finished = true
        return `data: ${JSON.stringify({ error: { message: typeof error.message === "string" ? error.message : "The provider failed.", type: typeof error.type === "string" ? error.type : "api_error", code: typeof error.type === "string" ? error.type : null } })}\n\n`
      }
      default:
        return ""
    }
  }

  const finish = () => {
    if (finished) return ""
    finished = true
    const signed = thinkingBlocks.filter((block) => block.type === "redacted_thinking" || typeof block.signature === "string")
    if (remember && signed.length && toolCallIds.length) remember(toolCallIds, { kind: "anthropic", blocks: signed })
    const final = { id, object: "chat.completion.chunk", created, model: route.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason(stopReason) }] }
    const usageChunk = { id, object: "chat.completion.chunk", created, model: route.model, choices: [], usage: chatUsage(usage) }
    return `data: ${JSON.stringify(final)}\n\ndata: ${JSON.stringify(usageChunk)}\n\ndata: [DONE]\n\n`
  }

  const drain = (controller: TransformStreamDefaultController<Uint8Array>, flush: boolean) => {
    // Normalize CRLF and split complete events on blank lines.
    buffer = buffer.replace(/\r\n/g, "\n")
    let boundary = buffer.indexOf("\n\n")
    while (boundary >= 0 || (flush && buffer.trim())) {
      const raw = boundary >= 0 ? buffer.slice(0, boundary) : buffer
      buffer = boundary >= 0 ? buffer.slice(boundary + 2) : ""
      let event: string | null = null
      const data: string[] = []
      const comments: string[] = []
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) comments.push(line)
        else if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
      // Keep heartbeats flowing so proxies keep the connection open.
      if (comments.length && !data.length) controller.enqueue(encoder.encode(`${comments.join("\n")}\n\n`))
      const out = handle(event, data.join("\n"))
      if (out) controller.enqueue(encoder.encode(out))
      boundary = buffer.indexOf("\n\n")
    }
  }

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(value, controller) {
      buffer += decoder.decode(value, { stream: true })
      drain(controller, false)
    },
    flush(controller) {
      buffer += decoder.decode()
      drain(controller, true)
      // A stream that ended without message_stop still ends cleanly for the client.
      if (started && !finished) controller.enqueue(encoder.encode(finish()))
    },
  }))
}

/** Anthropic Messages: Anthropic, Claude on Vertex AI and Claude on Microsoft Foundry. */
export const anthropicTranslator: AutoTranslator = {
  toUpstream(input) {
    return {
      rest: "messages",
      search: "",
      protocol: "anthropic_messages",
      headers: { "anthropic-version": "2023-06-01" },
      body: toAnthropicBody(input.body, input),
    }
  },
  streamToChat: (body, input) => anthropicStreamToChat(body, input.route, input.remember),
  jsonToChat: (body, input) => anthropicJsonToChat(body, input.route, input.remember),
  errorToChat: (body) => anthropicErrorToChat(body),
}
