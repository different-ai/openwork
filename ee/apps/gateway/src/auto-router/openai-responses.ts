// Translates an Auto request (OpenAI Chat Completions) to the OpenAI Responses
// API, and the Responses output (JSON or SSE) back to Chat Completions.
//
// OpenAI and Azure OpenAI models go through Responses because that is how the
// desktop calls them (`@opencode/ai/providers/openai`, see reasoningVariants in
// packages/opencode-plugin/src/providers.ts): `reasoning.effort` with
// `summary: "auto"` and `include: ["reasoning.encrypted_content"]`. Chat
// Completions rejects function tools with a reasoning effort on current models.
//
// Requests are stateless (`store: false`). The encrypted reasoning items a
// response produced before its tool calls are handed to `remember` and
// replayed ahead of those calls on the next request of the turn.
import type { AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import { contentText, isJsonObject, type AutoRouteInfo, type JsonObject } from "./chat.js"
import type { AutoTranslator } from "./protocol.js"
import type { ReasoningPayload } from "./reasoning-store.js"

type RememberReasoning = (toolCallIds: string[], payload: ReasoningPayload) => void

/** Responses reasoning efforts; Auto's `max` is OpenAI's `xhigh`. */
export function responsesEffort(level: AutoRouterThinkingLevel): string | null {
  if (level === "default") return null
  return level === "max" ? "xhigh" : level
}

function userContent(content: unknown): JsonObject[] {
  if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: JsonObject[] = []
  for (const part of content) {
    if (!isJsonObject(part)) continue
    if (part.type === "text" && typeof part.text === "string") parts.push({ type: "input_text", text: part.text })
    else if (part.type === "image_url") {
      const url = isJsonObject(part.image_url) ? part.image_url.url : part.image_url
      const detail = isJsonObject(part.image_url) && typeof part.image_url.detail === "string" ? part.image_url.detail : "auto"
      if (typeof url === "string") parts.push({ type: "input_image", image_url: url, detail })
    } else if (part.type === "file" && isJsonObject(part.file) && typeof part.file.file_data === "string") {
      parts.push({ type: "input_file", filename: typeof part.file.filename === "string" ? part.file.filename : "document.pdf", file_data: part.file.file_data })
    }
  }
  return parts
}

function argumentsText(value: unknown) {
  if (typeof value === "string") return value
  return JSON.stringify(value ?? {})
}

function toolOutput(content: unknown): string {
  return typeof content === "string" ? content : contentText(content) || JSON.stringify(content ?? "")
}

export function toResponsesBody(body: JsonObject, input: {
  model: string
  thinkingLevel: AutoRouterThinkingLevel
  maxOutputTokens: number | null
  reasoning?: ReadonlyMap<string, ReasoningPayload>
}): JsonObject {
  const instructions: string[] = []
  const items: JsonObject[] = []
  const messages = Array.isArray(body.messages) ? body.messages.filter(isJsonObject) : []
  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        const text = contentText(message.content)
        if (text) instructions.push(text)
        break
      }
      case "user": {
        const content = userContent(message.content)
        if (content.length) items.push({ role: "user", content })
        break
      }
      case "assistant": {
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isJsonObject) : []
        const ids = calls.flatMap((call) => typeof call.id === "string" ? [call.id] : [])
        const recalled = ids.map((id) => input.reasoning?.get(id)).find((payload) => payload?.kind === "openai")
        if (recalled) items.push(...recalled.blocks)
        const text = contentText(message.content)
        if (text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] })
        for (const call of calls) {
          const fn = isJsonObject(call.function) ? call.function : {}
          if (typeof call.id !== "string" || typeof fn.name !== "string") continue
          items.push({ type: "function_call", call_id: call.id, name: fn.name, arguments: argumentsText(fn.arguments) })
        }
        break
      }
      case "tool":
        if (typeof message.tool_call_id === "string") items.push({ type: "function_call_output", call_id: message.tool_call_id, output: toolOutput(message.content) })
        break
    }
  }

  const next: JsonObject = { model: input.model, input: items, store: false }
  if (instructions.length) next.instructions = instructions.join("\n\n")
  if (body.stream === true) next.stream = true
  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  if (typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens > 0) next.max_output_tokens = maxTokens
  else if (input.maxOutputTokens) next.max_output_tokens = input.maxOutputTokens
  if (Array.isArray(body.tools)) {
    const tools = body.tools.filter(isJsonObject).flatMap((tool) => {
      const fn = isJsonObject(tool.function) ? tool.function : null
      if (tool.type !== "function" || !fn || typeof fn.name !== "string") return []
      return [{
        type: "function",
        name: fn.name,
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        parameters: isJsonObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
        strict: fn.strict === true,
      }]
    })
    if (tools.length) next.tools = tools
  }
  const toolChoice = body.tool_choice
  if (next.tools !== undefined && toolChoice !== undefined) {
    if (toolChoice === "required" || toolChoice === "none" || toolChoice === "auto") next.tool_choice = toolChoice
    else if (isJsonObject(toolChoice) && isJsonObject(toolChoice.function) && typeof toolChoice.function.name === "string") next.tool_choice = { type: "function", name: toolChoice.function.name }
  }
  if (typeof body.parallel_tool_calls === "boolean" && next.tools !== undefined) next.parallel_tool_calls = body.parallel_tool_calls
  const effort = responsesEffort(input.thinkingLevel)
  if (effort) {
    next.reasoning = { effort, summary: "auto" }
    next.include = ["reasoning.encrypted_content"]
  } else {
    // Sampling settings are only accepted when no reasoning effort is set.
    if (typeof body.temperature === "number") next.temperature = body.temperature
    if (typeof body.top_p === "number") next.top_p = body.top_p
  }
  if (typeof body.user === "string") next.user = body.user
  return next
}

type ResponsesUsage = { input: number; output: number; cached: number; reasoning: number }

function readUsage(value: unknown, into: ResponsesUsage) {
  if (!isJsonObject(value)) return
  if (typeof value.input_tokens === "number") into.input = value.input_tokens
  if (typeof value.output_tokens === "number") into.output = value.output_tokens
  if (isJsonObject(value.input_tokens_details) && typeof value.input_tokens_details.cached_tokens === "number") into.cached = value.input_tokens_details.cached_tokens
  if (isJsonObject(value.output_tokens_details) && typeof value.output_tokens_details.reasoning_tokens === "number") into.reasoning = value.output_tokens_details.reasoning_tokens
}

function chatUsage(usage: ResponsesUsage) {
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cached },
    completion_tokens_details: { reasoning_tokens: usage.reasoning },
  }
}

function finishReason(response: JsonObject, toolCalls: boolean) {
  if (response.status === "incomplete") {
    const reason = isJsonObject(response.incomplete_details) ? response.incomplete_details.reason : null
    return reason === "content_filter" ? "content_filter" : "length"
  }
  return toolCalls ? "tool_calls" : "stop"
}

/** Encrypted reasoning items, stripped to what a stateless request may send back. */
function replayableReasoning(items: JsonObject[]): JsonObject[] {
  return items.filter((item) => item.type === "reasoning" && typeof item.id === "string" && typeof item.encrypted_content === "string" && item.encrypted_content.trim())
    .map((item) => ({
      type: "reasoning",
      id: item.id,
      encrypted_content: item.encrypted_content,
      summary: Array.isArray(item.summary)
        ? item.summary.filter((part) => isJsonObject(part) && part.type === "summary_text" && typeof part.text === "string")
        : [],
    }))
}

function summaryText(item: JsonObject) {
  return Array.isArray(item.summary)
    ? item.summary.flatMap((part) => isJsonObject(part) && typeof part.text === "string" ? [part.text] : []).join("\n\n")
    : ""
}

export function responsesErrorToChat(body: unknown, status: number): JsonObject {
  const error = isJsonObject(body) && isJsonObject(body.error) ? body.error : isJsonObject(body) && body.type === "error" ? body : null
  const message = error && typeof error.message === "string" ? error.message : `The provider failed with HTTP ${status}.`
  return { error: { message, type: error && typeof error.type === "string" ? error.type : "api_error", code: error && typeof error.code === "string" ? error.code : null } }
}

/** A complete Responses object as a Chat Completion. */
export function responsesJsonToChat(body: unknown, route: AutoRouteInfo, remember?: RememberReasoning): JsonObject {
  const response = isJsonObject(body) ? body : {}
  const output = Array.isArray(response.output) ? response.output.filter(isJsonObject) : []
  let text = ""
  const reasoning: string[] = []
  const toolCalls: JsonObject[] = []
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) if (isJsonObject(part) && part.type === "output_text" && typeof part.text === "string") text += part.text
    } else if (item.type === "reasoning") {
      const summary = summaryText(item)
      if (summary) reasoning.push(summary)
    } else if (item.type === "function_call" && typeof item.call_id === "string") {
      toolCalls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" } })
    }
  }
  const ids = toolCalls.flatMap((call) => typeof call.id === "string" ? [call.id] : [])
  const replay = replayableReasoning(output)
  if (remember && ids.length && replay.length) remember(ids, { kind: "openai", blocks: replay })
  const usage: ResponsesUsage = { input: 0, output: 0, cached: 0, reasoning: 0 }
  readUsage(response.usage, usage)
  return {
    id: typeof response.id === "string" ? response.id : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000),
    model: route.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(reasoning.length ? { reasoning_content: reasoning.join("\n\n") } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason(response, toolCalls.length > 0),
    }],
    usage: chatUsage(usage),
    openwork_route: route,
  }
}

const encoder = new TextEncoder()

/** A Responses SSE stream as a Chat Completions SSE stream, ending with usage and [DONE]. */
export function responsesStreamToChat(body: ReadableStream<Uint8Array>, route: AutoRouteInfo, remember?: RememberReasoning): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ""
  let id = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  let started = false
  let finished = false
  let sawReasoningSummary = false
  const usage: ResponsesUsage = { input: 0, output: 0, cached: 0, reasoning: 0 }
  // Output item id (and output_index) -> chat tool call index.
  const toolIndexByItem = new Map<string, number>()
  const toolCallIds: string[] = []
  const reasoningItems: JsonObject[] = []
  let summaryIndex = -1

  const chunk = (delta: JsonObject, extra: JsonObject = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: route.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`
  const start = () => {
    if (started) return ""
    started = true
    return chunk({ role: "assistant", content: "" }, { openwork_route: route })
  }
  const itemKey = (parsed: JsonObject) => typeof parsed.item_id === "string" ? parsed.item_id : `index:${String(parsed.output_index)}`

  const finish = (response: JsonObject) => {
    if (finished) return ""
    finished = true
    readUsage(response.usage, usage)
    const replay = replayableReasoning(reasoningItems)
    if (remember && toolCallIds.length && replay.length) remember(toolCallIds, { kind: "openai", blocks: replay })
    const final = { id, object: "chat.completion.chunk", created, model: route.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason(response, toolCallIds.length > 0) }] }
    const usageChunk = { id, object: "chat.completion.chunk", created, model: route.model, choices: [], usage: chatUsage(usage) }
    return `${start()}data: ${JSON.stringify(final)}\n\ndata: ${JSON.stringify(usageChunk)}\n\ndata: [DONE]\n\n`
  }

  const fail = (error: JsonObject) => {
    finished = true
    return `data: ${JSON.stringify({ error: {
      message: typeof error.message === "string" ? error.message : "The provider failed.",
      type: typeof error.type === "string" ? error.type : "api_error",
      code: typeof error.code === "string" ? error.code : null,
    } })}\n\n`
  }

  const handle = (event: string | null, data: string): string => {
    if (!data || data === "[DONE]" || finished) return ""
    let parsed: unknown
    try { parsed = JSON.parse(data) } catch { return "" }
    if (!isJsonObject(parsed)) return ""
    const type = typeof parsed.type === "string" ? parsed.type : event
    switch (type) {
      case "response.created":
      case "response.in_progress": {
        const response = isJsonObject(parsed.response) ? parsed.response : {}
        if (typeof response.id === "string") id = response.id
        return start()
      }
      case "response.output_item.added": {
        const item = isJsonObject(parsed.item) ? parsed.item : {}
        if (item.type !== "function_call" || typeof item.call_id !== "string") return ""
        const toolIndex = toolCallIds.length
        toolCallIds.push(item.call_id)
        if (typeof item.id === "string") toolIndexByItem.set(item.id, toolIndex)
        toolIndexByItem.set(`index:${String(parsed.output_index)}`, toolIndex)
        return `${start()}${chunk({ tool_calls: [{ index: toolIndex, id: item.call_id, type: "function", function: { name: item.name, arguments: "" } }] })}`
      }
      case "response.function_call_arguments.delta": {
        const toolIndex = toolIndexByItem.get(itemKey(parsed)) ?? toolIndexByItem.get(`index:${String(parsed.output_index)}`)
        return toolIndex !== undefined && typeof parsed.delta === "string" ? chunk({ tool_calls: [{ index: toolIndex, function: { arguments: parsed.delta } }] }) : ""
      }
      case "response.output_text.delta":
        return typeof parsed.delta === "string" ? `${start()}${chunk({ content: parsed.delta })}` : ""
      case "response.reasoning_summary_text.delta": {
        if (typeof parsed.delta !== "string") return ""
        // Separate summary parts the way the desktop renders them.
        const index = typeof parsed.summary_index === "number" ? parsed.summary_index : 0
        const separator = sawReasoningSummary && index !== summaryIndex ? "\n\n" : ""
        sawReasoningSummary = true
        summaryIndex = index
        return `${start()}${chunk({ reasoning_content: `${separator}${parsed.delta}` })}`
      }
      case "response.output_item.done": {
        const item = isJsonObject(parsed.item) ? parsed.item : {}
        if (item.type === "reasoning") reasoningItems.push(item)
        return ""
      }
      case "response.completed":
      case "response.incomplete":
        return finish(isJsonObject(parsed.response) ? parsed.response : {})
      case "response.failed": {
        const response = isJsonObject(parsed.response) ? parsed.response : {}
        return fail(isJsonObject(response.error) ? response.error : {})
      }
      case "error":
        return fail(isJsonObject(parsed.error) ? parsed.error : parsed)
      default:
        return ""
    }
  }

  const drain = (controller: TransformStreamDefaultController<Uint8Array>, flush: boolean) => {
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
      // A stream that ended without response.completed still ends cleanly for the client.
      if (started && !finished) controller.enqueue(encoder.encode(finish({})))
    },
  }))
}

/** OpenAI Responses: OpenAI (`responses`) and Azure OpenAI's v1 API (`v1/responses`). */
export function openAiResponsesTranslator(options: { rest: string }): AutoTranslator {
  return {
    toUpstream(input) {
      return {
        rest: options.rest,
        search: "",
        protocol: "openai_responses",
        headers: {},
        body: toResponsesBody(input.body, input),
      }
    },
    streamToChat: (body, input) => responsesStreamToChat(body, input.route, input.remember),
    jsonToChat: (body, input) => responsesJsonToChat(body, input.route, input.remember),
    errorToChat: (body, status) => responsesErrorToChat(body, status),
  }
}
