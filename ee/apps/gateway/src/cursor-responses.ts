// OpenAI Responses API for Cursor. Cursor's OpenAI override can
// send a model through Responses instead of Chat Completions. Every Gateway translator speaks Chat
// Completions on the client side, so a Responses request is read as a chat request, sent to the
// model's own protocol as usual, and the Chat Completions answer is written back as a Responses
// object (JSON) or Responses event stream (SSE).
import { randomUUID } from "node:crypto"
import { isJsonObject, type JsonObject } from "./auto-router/chat.js"

/** The text of a Responses content array (`input_text`, `output_text`, `text` parts) or a plain string. */
function partsText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((part) => isJsonObject(part) && typeof part.text === "string" ? [part.text] : []).join("")
}

/** Responses content parts as Chat Completions parts (text and images); a string stays a string. */
function chatParts(content: unknown): unknown {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts = content.flatMap((part): JsonObject[] => {
    if (!isJsonObject(part)) return []
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") return [{ type: "text", text: part.text }]
    if (part.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : isJsonObject(part.image_url) && typeof part.image_url.url === "string" ? part.image_url.url : null
      return url ? [{ type: "image_url", image_url: { url, ...(typeof part.detail === "string" ? { detail: part.detail } : {}) } }] : []
    }
    return []
  })
  return parts.every((part) => part.type === "text") ? parts.map((part) => String(part.text)).join("") : parts
}

/**
 * How the tools a Responses request names reach a chat model and come back: custom (freeform) tools
 * become functions taking one `input` string, and the functions of a `namespace` tool become
 * functions named `<namespace>__<name>`.
 */
export type ResponsesToolNames = {
  custom: ReadonlySet<string>
  namespaced: ReadonlyMap<string, { namespace: string; name: string }>
}

const NAMESPACE_SEPARATOR = "__"

function functionTool(tool: JsonObject, name: string): JsonObject {
  return { type: "function", function: {
    name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  } }
}

/** A custom tool takes free text; a chat model gets it as one string argument, with its grammar. */
function customTool(tool: JsonObject, name: string): JsonObject {
  const format = isJsonObject(tool.format) ? tool.format : null
  const grammar = format && typeof format.definition === "string" ? format.definition : null
  // The tool's own description may say not to send JSON: here its text goes in one JSON string.
  const description = [
    typeof tool.description === "string" ? tool.description : "",
    "Send the tool's text as the `input` argument, exactly as written: every line as it should be, with its exact indentation and no added spaces.",
    grammar ? `The text follows this ${typeof format?.syntax === "string" ? format.syntax : ""} grammar:\n${grammar}` : "",
  ].filter(Boolean).join("\n\n")
  return { type: "function", function: {
    name,
    description,
    parameters: { type: "object", properties: { input: { type: "string", description: "The tool's whole text input, exactly as written." } }, required: ["input"], additionalProperties: false },
  } }
}

/**
 * A Responses tool as Chat Completions tools: functions as they are, custom tools and namespaces as
 * above. Hosted tools (web search, file search, local shell and the like) are dropped: only the
 * provider that runs them could.
 */
function chatTools(tool: unknown): JsonObject[] {
  if (!isJsonObject(tool)) return []
  if (tool.type === "function") {
    if (isJsonObject(tool.function)) return [tool]
    return typeof tool.name === "string" ? [functionTool(tool, tool.name)] : []
  }
  if (tool.type === "custom" && typeof tool.name === "string") return [customTool(tool, tool.name)]
  if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
    const namespace = tool.name
    return tool.tools.flatMap((inner): JsonObject[] => {
      if (!isJsonObject(inner) || typeof inner.name !== "string") return []
      const name = `${namespace}${NAMESPACE_SEPARATOR}${inner.name}`
      if (inner.type === "function") return [functionTool(inner, name)]
      if (inner.type === "custom") return [customTool(inner, name)]
      return []
    })
  }
  return []
}

/** The custom and namespaced tools of a Responses request, to name their calls in the answer. */
export function responsesToolNames(body: JsonObject): ResponsesToolNames {
  const custom = new Set<string>()
  const namespaced = new Map<string, { namespace: string; name: string }>()
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isJsonObject(tool) || typeof tool.name !== "string") continue
    if (tool.type === "custom") custom.add(tool.name)
    if (tool.type !== "namespace" || !Array.isArray(tool.tools)) continue
    for (const inner of tool.tools) {
      if (!isJsonObject(inner) || typeof inner.name !== "string") continue
      const joined = `${tool.name}${NAMESPACE_SEPARATOR}${inner.name}`
      namespaced.set(joined, { namespace: tool.name, name: inner.name })
      if (inner.type === "custom") custom.add(joined)
    }
  }
  return { custom, namespaced }
}

/** The fewest output tokens every translated provider accepts. */
const MIN_OUTPUT_TOKENS = 16

/**
 * A Responses request as a Chat Completions request. `instructions` becomes the system message;
 * messages, function and custom tool calls and their outputs become chat messages in order
 * (consecutive calls join one assistant message). Reasoning items are dropped: the Gateway keeps
 * reasoning state itself, by tool call id. Hosted tool calls (web search and the like) are dropped.
 */
export function responsesToChat(body: JsonObject): JsonObject {
  const messages: JsonObject[] = []
  if (typeof body.instructions === "string" && body.instructions) messages.push({ role: "system", content: body.instructions })
  const items = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : Array.isArray(body.input) ? body.input : []
  for (const item of items) {
    if (!isJsonObject(item)) continue
    const type = item.type ?? (typeof item.role === "string" ? "message" : undefined)
    if (type === "message" && typeof item.role === "string") {
      const role = item.role === "developer" ? "system" : item.role
      messages.push({ role, content: role === "assistant" || role === "system" ? partsText(item.content) : chatParts(item.content) })
    } else if ((type === "function_call" || type === "custom_tool_call") && typeof item.name === "string") {
      const name = typeof item.namespace === "string" && item.namespace ? `${item.namespace}${NAMESPACE_SEPARATOR}${item.name}` : item.name
      const args = type === "custom_tool_call"
        ? JSON.stringify({ input: typeof item.input === "string" ? item.input : "" })
        : typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
      const call = { id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${randomUUID()}`, type: "function", function: { name, arguments: args } }
      const last = messages[messages.length - 1]
      if (last?.role === "assistant" && Array.isArray(last.tool_calls)) last.tool_calls.push(call)
      else messages.push({ role: "assistant", content: null, tool_calls: [call] })
    } else if ((type === "function_call_output" || type === "custom_tool_call_output") && typeof item.call_id === "string") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : partsText(item.output) || JSON.stringify(item.output ?? "") })
    }
  }
  const chat: JsonObject = { model: body.model, messages, stream: body.stream === true }
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap(chatTools)
    if (tools.length) chat.tools = tools
  }
  const choice = body.tool_choice
  if (typeof choice === "string") chat.tool_choice = choice
  else if (isJsonObject(choice) && (choice.type === "function" || choice.type === "custom") && typeof choice.name === "string") chat.tool_choice = { type: "function", function: { name: choice.name } }
  // OpenAI-compatible providers refuse fewer than 16 output tokens.
  if (typeof body.max_output_tokens === "number") chat.max_tokens = Math.max(MIN_OUTPUT_TOKENS, body.max_output_tokens)
  for (const field of ["temperature", "top_p", "parallel_tool_calls", "user"]) if (body[field] !== undefined) chat[field] = body[field]
  return chat
}

/** The effort a Responses request asks for (`reasoning.effort`), if any. */
export function responsesReasoningEffort(body: JsonObject): string | null {
  return isJsonObject(body.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort : null
}

type ResponsesUsage = { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details: { cached_tokens: number }; output_tokens_details: { reasoning_tokens: number } }

function responsesUsage(usage: unknown): ResponsesUsage | null {
  if (!isJsonObject(usage)) return null
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0
  const input = number(usage.prompt_tokens)
  const output = number(usage.completion_tokens)
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: number(usage.total_tokens) || input + output,
    input_tokens_details: { cached_tokens: isJsonObject(usage.prompt_tokens_details) ? number(usage.prompt_tokens_details.cached_tokens) : 0 },
    output_tokens_details: { reasoning_tokens: isJsonObject(usage.completion_tokens_details) ? number(usage.completion_tokens_details.reasoning_tokens) : 0 },
  }
}

type OutputItem = JsonObject & { type: "message" | "function_call" | "custom_tool_call" | "reasoning"; id: string }

function responseObject(input: { id: string; created: number; model: string; status: "in_progress" | "completed" | "incomplete" | "failed"; output: OutputItem[]; usage: ResponsesUsage | null; error?: JsonObject | null; incomplete?: string | null }): JsonObject {
  return {
    id: input.id,
    object: "response",
    created_at: input.created,
    status: input.status,
    error: input.error ?? null,
    incomplete_details: input.incomplete ? { reason: input.incomplete } : null,
    model: input.model,
    output: input.output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: input.usage,
  }
}

function messageItem(id: string, text: string, status = "completed"): OutputItem {
  return { type: "message", id, status, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }
}

function reasoningItem(id: string, text: string): OutputItem {
  return { type: "reasoning", id, summary: text ? [{ type: "summary_text", text }] : [] }
}

/** A chat tool call as the Responses item the request's tools call for. */
function toolCallItem(input: { id: string; callId: string; name: string; arguments: string; status: string }, tools?: ResponsesToolNames): OutputItem {
  const namespaced = tools?.namespaced.get(input.name)
  if (tools?.custom.has(input.name)) {
    return { type: "custom_tool_call", id: input.id, call_id: input.callId, ...(namespaced ? { namespace: namespaced.namespace, name: namespaced.name } : { name: input.name }), input: customInput(input.arguments), status: input.status }
  }
  return { type: "function_call", id: input.id, call_id: input.callId, ...(namespaced ? { namespace: namespaced.namespace, name: namespaced.name } : { name: input.name }), arguments: input.arguments, status: input.status }
}

/** A custom tool's free text from the `{input}` arguments a chat model sends; other text as it is. */
function customInput(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args)
    if (isJsonObject(parsed) && typeof parsed.input === "string") return parsed.input
  } catch { /* Not JSON: the model sent the text itself. */ }
  return args
}

function itemId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`
}

/** A `chat.completion` object as a Responses `response` object. */
export function chatToResponses(chat: unknown, model: string, tools?: ResponsesToolNames): JsonObject {
  const choice = isJsonObject(chat) && Array.isArray(chat.choices) ? chat.choices.find(isJsonObject) : undefined
  const message = choice && isJsonObject(choice.message) ? choice.message : {}
  const output: OutputItem[] = []
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : ""
  if (reasoning) output.push(reasoningItem(itemId("rs"), reasoning))
  const text = typeof message.content === "string" ? message.content : partsText(message.content)
  if (text) output.push(messageItem(itemId("msg"), text))
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isJsonObject(call) || !isJsonObject(call.function)) continue
      output.push(toolCallItem({ id: itemId("fc"), callId: typeof call.id === "string" ? call.id : itemId("call"), name: String(call.function.name ?? ""), arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}", status: "completed" }, tools))
    }
  }
  const incomplete = choice?.finish_reason === "length" ? "max_output_tokens" : choice?.finish_reason === "content_filter" ? "content_filter" : null
  return responseObject({
    id: itemId("resp"),
    created: isJsonObject(chat) && typeof chat.created === "number" ? chat.created : Math.floor(Date.now() / 1000),
    model,
    status: incomplete ? "incomplete" : "completed",
    output,
    usage: isJsonObject(chat) ? responsesUsage(chat.usage) : null,
    incomplete,
  })
}

/**
 * A Chat Completions SSE stream (`data: {chat.completion.chunk}` … `data: [DONE]`) as a Responses
 * event stream: response.created, the output items with their deltas, then response.completed
 * (or response.incomplete / response.failed).
 */
export function chatStreamToResponses(body: ReadableStream<Uint8Array>, model: string, tools?: ResponsesToolNames): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const id = itemId("resp")
  const created = Math.floor(Date.now() / 1000)
  let sequence = 0
  let buffer = ""
  let started = false
  let finished = false
  let usage: ResponsesUsage | null = null
  let finishReason: unknown = null
  const output: OutputItem[] = []
  let reasoning: { index: number; id: string; text: string } | null = null
  let message: { index: number; id: string; text: string } | null = null
  const calls = new Map<number, { index: number; id: string; callId: string; name: string; arguments: string }>()

  const event = (controller: TransformStreamDefaultController<Uint8Array>, type: string, data: JsonObject) => {
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`))
  }
  const start = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (started) return
    started = true
    const response = responseObject({ id, created, model, status: "in_progress", output: [], usage: null })
    event(controller, "response.created", { response })
    event(controller, "response.in_progress", { response })
  }
  const closeReasoning = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!reasoning) return
    const item = reasoningItem(reasoning.id, reasoning.text)
    output[reasoning.index] = item
    event(controller, "response.reasoning_summary_text.done", { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, text: reasoning.text })
    event(controller, "response.reasoning_summary_part.done", { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, part: { type: "summary_text", text: reasoning.text } })
    event(controller, "response.output_item.done", { output_index: reasoning.index, item })
    reasoning = null
  }
  const closeMessage = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!message) return
    const item = messageItem(message.id, message.text)
    output[message.index] = item
    event(controller, "response.output_text.done", { item_id: message.id, output_index: message.index, content_index: 0, text: message.text })
    event(controller, "response.content_part.done", { item_id: message.id, output_index: message.index, content_index: 0, part: { type: "output_text", text: message.text, annotations: [] } })
    event(controller, "response.output_item.done", { output_index: message.index, item })
    message = null
  }
  const closeCalls = (controller: TransformStreamDefaultController<Uint8Array>) => {
    for (const call of calls.values()) {
      const item = toolCallItem({ id: call.id, callId: call.callId, name: call.name, arguments: call.arguments, status: "completed" }, tools)
      output[call.index] = item
      if (item.type === "custom_tool_call") event(controller, "response.custom_tool_call_input.done", { item_id: call.id, output_index: call.index, input: item.input })
      else event(controller, "response.function_call_arguments.done", { item_id: call.id, output_index: call.index, arguments: call.arguments })
      event(controller, "response.output_item.done", { output_index: call.index, item })
    }
    calls.clear()
  }
  const fail = (controller: TransformStreamDefaultController<Uint8Array>, error: unknown) => {
    finished = true
    start(controller)
    const detail = isJsonObject(error) ? error : {}
    const code = typeof detail.code === "string" ? detail.code : "upstream_error"
    const message = typeof detail.message === "string" ? detail.message : "The model failed."
    event(controller, "error", { code, message, param: null })
    event(controller, "response.failed", { response: responseObject({ id, created, model, status: "failed", output: output.filter(Boolean), usage, error: { code, message } }) })
  }
  const chunk = (controller: TransformStreamDefaultController<Uint8Array>, data: JsonObject) => {
    if (isJsonObject(data.error)) return fail(controller, data.error)
    start(controller)
    const parsedUsage = responsesUsage(data.usage)
    if (parsedUsage) usage = parsedUsage
    const choice = Array.isArray(data.choices) ? data.choices.find(isJsonObject) : undefined
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = isJsonObject(choice.delta) ? choice.delta : {}
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      if (!reasoning) {
        reasoning = { index: output.length, id: itemId("rs"), text: "" }
        output.push(reasoningItem(reasoning.id, ""))
        event(controller, "response.output_item.added", { output_index: reasoning.index, item: reasoningItem(reasoning.id, "") })
        event(controller, "response.reasoning_summary_part.added", { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, part: { type: "summary_text", text: "" } })
      }
      reasoning.text += delta.reasoning_content
      event(controller, "response.reasoning_summary_text.delta", { item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, delta: delta.reasoning_content })
    }
    if (typeof delta.content === "string" && delta.content) {
      closeReasoning(controller)
      if (!message) {
        message = { index: output.length, id: itemId("msg"), text: "" }
        output.push(messageItem(message.id, "", "in_progress"))
        event(controller, "response.output_item.added", { output_index: message.index, item: { ...messageItem(message.id, "", "in_progress"), content: [] } })
        event(controller, "response.content_part.added", { item_id: message.id, output_index: message.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
      }
      message.text += delta.content
      event(controller, "response.output_text.delta", { item_id: message.id, output_index: message.index, content_index: 0, delta: delta.content })
    }
    if (Array.isArray(delta.tool_calls)) {
      closeReasoning(controller)
      closeMessage(controller)
      for (const part of delta.tool_calls) {
        if (!isJsonObject(part)) continue
        const key = typeof part.index === "number" ? part.index : calls.size
        const fn = isJsonObject(part.function) ? part.function : {}
        let call = calls.get(key)
        if (!call) {
          call = { index: output.length, id: itemId("fc"), callId: typeof part.id === "string" ? part.id : itemId("call"), name: typeof fn.name === "string" ? fn.name : "", arguments: "" }
          calls.set(key, call)
          const item = toolCallItem({ id: call.id, callId: call.callId, name: call.name, arguments: "", status: "in_progress" }, tools)
          output.push(item)
          event(controller, "response.output_item.added", { output_index: call.index, item })
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          call.arguments += fn.arguments
          // A custom tool's text is only known once its JSON arguments are whole.
          if (!tools?.custom.has(call.name)) event(controller, "response.function_call_arguments.delta", { item_id: call.id, output_index: call.index, delta: fn.arguments })
        }
      }
    }
  }
  const finish = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (finished) return
    finished = true
    start(controller)
    closeReasoning(controller)
    closeMessage(controller)
    closeCalls(controller)
    const incomplete = finishReason === "length" ? "max_output_tokens" : finishReason === "content_filter" ? "content_filter" : null
    const response = responseObject({ id, created, model, status: incomplete ? "incomplete" : "completed", output: output.filter(Boolean), usage, incomplete })
    event(controller, incomplete ? "response.incomplete" : "response.completed", { response })
  }
  const line = (controller: TransformStreamDefaultController<Uint8Array>, raw: string) => {
    if (finished || !raw.startsWith("data:")) return
    const data = raw.slice(5).trim()
    if (data === "[DONE]") return finish(controller)
    try {
      const parsed: unknown = JSON.parse(data)
      if (isJsonObject(parsed)) chunk(controller, parsed)
    } catch { /* A malformed line is skipped, as Chat Completions clients do. */ }
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
      // A stream cut off before [DONE] still ends with a terminal event.
      if (!finished) fail(controller, { code: "upstream_incomplete", message: "The model's response ended early." })
    },
  }))
}
