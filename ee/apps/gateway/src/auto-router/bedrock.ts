// Translates an Auto request (OpenAI Chat Completions) to the Amazon Bedrock
// Converse API, and the Converse response (JSON, or the AWS event stream for
// converse-stream) back to Chat Completions, so a chat client can be answered
// by any Bedrock model.
//
// The model id is part of the path (`model/<alias>/converse`); the gateway
// rewrites the member's alias to the upstream model id. Tools must be
// `{ toolSpec }` only, which is all this translator sends.
//
// Like Claude on the Messages API, Claude on Bedrock must see its signed
// reasoning again to continue a tool-use turn with thinking on. The reasoning
// blocks of a response are handed to `remember` keyed by the tool calls they
// preceded and come back in `reasoning`; when they are missing, thinking is
// turned off for that request instead of failing it.
import type { AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import { readEventStreamFrames, type EventStreamFrame } from "../usage/bedrock-converse.js"
import { claudeTakesEffort, type RememberReasoning } from "./anthropic.js"
import { contentText, isJsonObject, type AutoRouteInfo, type JsonObject } from "./chat.js"
import type { ReasoningPayload } from "./reasoning-store.js"
import type { AutoTranslator } from "./protocol.js"

function parseDataUrl(url: string) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return match ? { mediaType: (match[1] ?? "").toLowerCase(), data: match[2] ?? "" } : null
}

function imageFormat(mediaType: string) {
  switch (mediaType) {
    case "image/png": return "png"
    case "image/jpeg":
    case "image/jpg": return "jpeg"
    case "image/gif": return "gif"
    case "image/webp": return "webp"
    default: return null
  }
}

/** Converse document names must be unique within a request. */
type DocumentNamer = () => string

function createDocumentNamer(): DocumentNamer {
  let count = 0
  return () => {
    count += 1
    return count === 1 ? "document" : `document-${count}`
  }
}

function userBlocks(content: unknown, nameDocument: DocumentNamer): JsonObject[] {
  if (typeof content === "string") return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: JsonObject[] = []
  for (const part of content) {
    if (!isJsonObject(part)) continue
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text) blocks.push({ text: part.text })
    } else if (part.type === "image_url") {
      const url = isJsonObject(part.image_url) ? part.image_url.url : part.image_url
      if (typeof url !== "string") continue
      const inline = parseDataUrl(url)
      const format = inline ? imageFormat(inline.mediaType) : null
      // Converse takes image bytes (or S3), never a URL to fetch.
      if (inline && format) blocks.push({ image: { format, source: { bytes: inline.data } } })
      else blocks.push({ text: inline ? `[Image omitted: ${inline.mediaType} is not supported.]` : `[Image omitted: ${url}]` })
    } else if (part.type === "file" && isJsonObject(part.file) && typeof part.file.file_data === "string") {
      const inline = parseDataUrl(part.file.file_data)
      if (inline?.mediaType === "application/pdf") blocks.push({ document: { format: "pdf", name: nameDocument(), source: { bytes: inline.data } } })
    }
  }
  return blocks
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

type ConverseMessage = { role: "user" | "assistant"; content: JsonObject[] }

function pushMessage(list: ConverseMessage[], role: "user" | "assistant", content: JsonObject[]) {
  if (!content.length) return
  const last = list[list.length - 1]
  // Converse requires alternating roles; merge consecutive messages from the same side.
  if (last && last.role === role) last.content.push(...content)
  else list.push({ role, content })
}

function toolResultContent(content: unknown, nameDocument: DocumentNamer): JsonObject[] {
  if (typeof content === "string") {
    const trimmed = content.trim()
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (isJsonObject(parsed)) return [{ json: parsed }]
      } catch {
        // Not JSON; send it as text.
      }
    }
    return content ? [{ text: content }] : [{ text: "(no output)" }]
  }
  const blocks = userBlocks(content, nameDocument)
  return blocks.length ? blocks : [{ text: "(no output)" }]
}

function isClaude(model: string) {
  return /claude/i.test(model)
}

function readMaxTokens(body: JsonObject) {
  const value = body.max_completion_tokens ?? body.max_tokens
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

function toolSpecs(body: JsonObject): JsonObject[] {
  if (!Array.isArray(body.tools)) return []
  return body.tools.filter(isJsonObject).flatMap((tool) => {
    const fn = isJsonObject(tool.function) ? tool.function : null
    if (tool.type !== "function" || !fn || typeof fn.name !== "string") return []
    return [{
      toolSpec: {
        name: fn.name,
        ...(typeof fn.description === "string" && fn.description ? { description: fn.description } : {}),
        inputSchema: { json: isJsonObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} } },
      },
    }]
  })
}

function toolChoiceOf(value: unknown): JsonObject {
  if (value === "required") return { any: {} }
  if (isJsonObject(value) && isJsonObject(value.function) && typeof value.function.name === "string") return { tool: { name: value.function.name } }
  return { auto: {} }
}

export function toConverseBody(body: JsonObject, input: {
  upstreamModel: string
  thinkingLevel: AutoRouterThinkingLevel
  maxOutputTokens: number | null
  /** Reasoning state remembered for earlier tool calls, by tool call id. */
  reasoning?: ReadonlyMap<string, ReasoningPayload>
}): JsonObject {
  const system: JsonObject[] = []
  const list: ConverseMessage[] = []
  const nameDocument = createDocumentNamer()
  const source = Array.isArray(body.messages) ? body.messages.filter(isJsonObject) : []
  let lastAssistantMissingThinking = false
  let historyUsesTools = false
  for (const message of source) {
    switch (message.role) {
      case "system":
      case "developer": {
        const text = contentText(message.content)
        if (text) system.push({ text })
        break
      }
      case "user":
        pushMessage(list, "user", userBlocks(message.content, nameDocument))
        lastAssistantMissingThinking = false
        break
      case "assistant": {
        const calls = toolCallsOf(message)
        const ids = calls.flatMap((call) => typeof call.id === "string" ? [call.id] : [])
        const recalled = ids.map((id) => input.reasoning?.get(id)).find((payload) => payload?.kind === "bedrock")
        const reasoning = recalled?.blocks ?? null
        const content: JsonObject[] = [...(reasoning ?? [])]
        const text = contentText(message.content)
        if (text) content.push({ text })
        for (const call of calls) {
          const fn = isJsonObject(call.function) ? call.function : {}
          content.push({ toolUse: { toolUseId: call.id, name: fn.name, input: parseArguments(fn.arguments) } })
          historyUsesTools = true
        }
        pushMessage(list, "assistant", content)
        lastAssistantMissingThinking = calls.length > 0 && reasoning === null
        break
      }
      case "tool":
        pushMessage(list, "user", [{ toolResult: { toolUseId: message.tool_call_id, content: toolResultContent(message.content, nameDocument) } }])
        historyUsesTools = true
        break
    }
  }

  const next: JsonObject = { messages: list }
  if (system.length) next.system = system

  // "none" omits the tools, unless the history holds tool blocks: Converse
  // rejects toolUse/toolResult blocks without a toolConfig, so keep the specs
  // then (without forcing a choice).
  const tools = toolSpecs(body)
  if (tools.length && body.tool_choice !== "none") next.toolConfig = { tools, toolChoice: toolChoiceOf(body.tool_choice) }
  else if (tools.length && historyUsesTools) next.toolConfig = { tools }

  const claude = isClaude(input.upstreamModel)
  // Bedrock ids carry date stamps (`claude-3-7-sonnet-20250219-v1:0`) that read as a version.
  const effort = claude && claudeTakesEffort(input.upstreamModel.replace(/-\d{8}(?=-|$|:)/g, ""))
  // A tool-use turn with thinking on must replay the signed reasoning; without it, think off.
  const level = lastAssistantMissingThinking && input.thinkingLevel !== "default" ? "none" : input.thinkingLevel
  const thinkingOn = effort && level !== "default" && level !== "none"
  if (thinkingOn) next.additionalModelRequestFields = { thinking: { type: "adaptive" }, output_config: { effort: level } }
  else if (effort && level === "none") next.additionalModelRequestFields = { thinking: { type: "disabled" } }

  const inference: JsonObject = {}
  const maxTokens = readMaxTokens(body) ?? input.maxOutputTokens
  if (maxTokens !== null) inference.maxTokens = maxTokens
  if (!thinkingOn) {
    if (typeof body.temperature === "number") inference.temperature = claude ? Math.min(body.temperature, 1) : body.temperature
    if (typeof body.top_p === "number") inference.topP = body.top_p
  }
  const stop = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((value) => typeof value === "string") : []
  if (stop.length) inference.stopSequences = stop
  if (Object.keys(inference).length) next.inferenceConfig = inference
  return next
}

function finishReason(stopReason: unknown) {
  switch (stopReason) {
    case "tool_use": return "tool_calls"
    case "max_tokens":
    case "model_context_window_exceeded": return "length"
    case "guardrail_intervened":
    case "content_filtered": return "content_filter"
    default: return "stop"
  }
}

type ConverseUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

function readUsage(value: unknown, into: ConverseUsage) {
  if (!isJsonObject(value)) return
  if (typeof value.inputTokens === "number") into.input = value.inputTokens
  if (typeof value.outputTokens === "number") into.output = value.outputTokens
  if (typeof value.cacheReadInputTokens === "number") into.cacheRead = value.cacheReadInputTokens
  if (typeof value.cacheWriteInputTokens === "number") into.cacheWrite = value.cacheWriteInputTokens
}

function chatUsage(usage: ConverseUsage) {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output,
    total_tokens: prompt + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
  }
}

/** Reasoning blocks Bedrock accepts back: signed text, or redacted content. */
function isReplayable(block: JsonObject) {
  const reasoning = isJsonObject(block.reasoningContent) ? block.reasoningContent : null
  if (!reasoning) return false
  if (typeof reasoning.redactedContent === "string" && reasoning.redactedContent) return true
  return isJsonObject(reasoning.reasoningText) && typeof reasoning.reasoningText.signature === "string" && reasoning.reasoningText.signature.length > 0
}

/** A complete Converse response as a Chat Completion. */
export function converseJsonToChat(body: unknown, route: AutoRouteInfo, remember?: RememberReasoning): JsonObject {
  const response = isJsonObject(body) ? body : {}
  const output = isJsonObject(response.output) ? response.output : {}
  const message = isJsonObject(output.message) ? output.message : {}
  const content = Array.isArray(message.content) ? message.content.filter(isJsonObject) : []
  const text = content.flatMap((block) => typeof block.text === "string" ? [block.text] : []).join("")
  const reasoning = content.flatMap((block) => {
    const value = isJsonObject(block.reasoningContent) && isJsonObject(block.reasoningContent.reasoningText) ? block.reasoningContent.reasoningText.text : undefined
    return typeof value === "string" ? [value] : []
  }).join("")
  const toolCalls = content.flatMap((block) => isJsonObject(block.toolUse) ? [block.toolUse] : []).map((use) => ({
    id: use.toolUseId, type: "function", function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
  }))
  const toolCallIds = toolCalls.flatMap((call) => typeof call.id === "string" ? [call.id] : [])
  const blocks = content.filter(isReplayable)
  if (remember && blocks.length && toolCallIds.length) remember(toolCallIds, { kind: "bedrock", blocks })
  const usage: ConverseUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  readUsage(response.usage, usage)
  return {
    id: `chatcmpl-${Date.now()}`,
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
      finish_reason: finishReason(response.stopReason),
    }],
    usage: chatUsage(usage),
    openwork_route: route,
  }
}

function errorMessage(body: JsonObject) {
  if (typeof body.message === "string" && body.message) return body.message
  if (typeof body.Message === "string" && body.Message) return body.Message
  return null
}

/** A Bedrock error body (`{ message }` or `{ Message }`) as a Chat Completions error body. */
export function converseErrorToChat(body: unknown, status: number): JsonObject {
  if (isJsonObject(body) && isJsonObject(body.error)) return body
  const message = isJsonObject(body) ? errorMessage(body) : null
  return { error: { message: message ?? `The provider failed with HTTP ${status}.`, type: "api_error", code: null } }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
/** Converse frames are small; anything larger than this is a broken stream. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

function concat(left: Uint8Array, right: Uint8Array) {
  if (!left.byteLength) return right
  const joined = new Uint8Array(left.byteLength + right.byteLength)
  joined.set(left)
  joined.set(right, left.byteLength)
  return joined
}

type ReasoningBlock = { text: string; signature: string; redacted: string[] }

/** A converse-stream AWS event stream as a Chat Completions SSE stream, ending with usage and [DONE]. */
export function converseStreamToChat(body: ReadableStream<Uint8Array>, route: AutoRouteInfo, remember?: RememberReasoning): ReadableStream<Uint8Array> {
  let buffer: Uint8Array = new Uint8Array(0)
  const id = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  let started = false
  let stopped = false
  let finished = false
  let stopReason: unknown = null
  const usage: ConverseUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  // Content block index -> tool call index / reasoning block being collected.
  const toolIndexByBlock = new Map<number, number>()
  const toolCallIds: string[] = []
  const reasoningByBlock = new Map<number, ReasoningBlock>()

  const chunk = (delta: JsonObject, extra: JsonObject = {}) => {
    const payload: JsonObject = { id, object: "chat.completion.chunk", created, model: route.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra }
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  const error = (message: string, type: string) => {
    finished = true
    return `data: ${JSON.stringify({ error: { message, type, code: type } })}\n\n`
  }

  const start = () => {
    if (started) return ""
    started = true
    return chunk({ role: "assistant", content: "" }, { openwork_route: route })
  }

  const reasoningFor = (index: number) => {
    let block = reasoningByBlock.get(index)
    if (!block) {
      block = { text: "", signature: "", redacted: [] }
      reasoningByBlock.set(index, block)
    }
    return block
  }

  const handle = (frame: EventStreamFrame): string => {
    if (finished) return ""
    const messageType = frame.headers.get(":message-type")
    let parsed: unknown = null
    try { parsed = JSON.parse(decoder.decode(frame.payload)) } catch { parsed = null }
    const payload = isJsonObject(parsed) ? parsed : {}
    if (messageType === "exception") {
      const type = frame.headers.get(":exception-type") ?? "api_error"
      return error(errorMessage(payload) ?? "The provider failed.", type)
    }
    if (messageType === "error") {
      const type = frame.headers.get(":error-code") ?? "api_error"
      return error(frame.headers.get(":error-message") ?? errorMessage(payload) ?? "The provider failed.", type)
    }
    const index = typeof payload.contentBlockIndex === "number" ? payload.contentBlockIndex : -1
    switch (frame.headers.get(":event-type")) {
      case "messageStart":
        return start()
      case "contentBlockStart": {
        const blockStart = isJsonObject(payload.start) ? payload.start : {}
        const use = isJsonObject(blockStart.toolUse) ? blockStart.toolUse : null
        if (!use) return ""
        const toolIndex = toolIndexByBlock.size
        toolIndexByBlock.set(index, toolIndex)
        if (typeof use.toolUseId === "string") toolCallIds.push(use.toolUseId)
        return start() + chunk({ tool_calls: [{ index: toolIndex, id: use.toolUseId, type: "function", function: { name: use.name, arguments: "" } }] })
      }
      case "contentBlockDelta": {
        const delta = isJsonObject(payload.delta) ? payload.delta : {}
        if (typeof delta.text === "string") return delta.text ? start() + chunk({ content: delta.text }) : ""
        if (isJsonObject(delta.toolUse) && typeof delta.toolUse.input === "string") {
          const toolIndex = toolIndexByBlock.get(index)
          return toolIndex === undefined || !delta.toolUse.input ? "" : chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.toolUse.input } }] })
        }
        if (isJsonObject(delta.reasoningContent)) {
          const reasoning = delta.reasoningContent
          const kept = reasoningFor(index)
          if (typeof reasoning.signature === "string") kept.signature += reasoning.signature
          if (typeof reasoning.redactedContent === "string") kept.redacted.push(reasoning.redactedContent)
          if (typeof reasoning.text === "string" && reasoning.text) {
            kept.text += reasoning.text
            return start() + chunk({ reasoning_content: reasoning.text })
          }
        }
        return ""
      }
      case "messageStop":
        stopped = true
        stopReason = payload.stopReason
        return ""
      case "metadata":
        readUsage(payload.usage, usage)
        // Metadata is the last event of a converse stream.
        return stopped ? finish() : ""
      default:
        return ""
    }
  }

  const finish = () => {
    if (finished) return ""
    finished = true
    const blocks: JsonObject[] = []
    for (const block of reasoningByBlock.values()) {
      if (block.signature) blocks.push({ reasoningContent: { reasoningText: { text: block.text, signature: block.signature } } })
      for (const redacted of block.redacted) blocks.push({ reasoningContent: { redactedContent: redacted } })
    }
    if (remember && blocks.length && toolCallIds.length) remember(toolCallIds, { kind: "bedrock", blocks })
    const final = { id, object: "chat.completion.chunk", created, model: route.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason(stopReason) }] }
    const usageChunk = { id, object: "chat.completion.chunk", created, model: route.model, choices: [], usage: chatUsage(usage) }
    return `${start()}data: ${JSON.stringify(final)}\n\ndata: ${JSON.stringify(usageChunk)}\n\ndata: [DONE]\n\n`
  }

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(value, controller) {
      if (finished) return
      let out = ""
      const rest = readEventStreamFrames(concat(buffer, value), (frame) => { out += handle(frame) })
      const malformed = rest === null || (rest.byteLength >= 4 && new DataView(rest.buffer, rest.byteOffset, rest.byteLength).getUint32(0) > MAX_FRAME_BYTES)
      if (malformed) {
        buffer = new Uint8Array(0)
        if (!finished) out += error("The provider sent a malformed event stream.", "api_error")
      } else {
        buffer = rest.slice()
      }
      if (out) controller.enqueue(encoder.encode(out))
    },
    flush(controller) {
      if (finished) return
      // A stream that ended without metadata still ends cleanly for the client.
      const out = started ? finish() : error("The provider ended the stream without a response.", "api_error")
      controller.enqueue(encoder.encode(out))
    },
  }))
}

/** Amazon Bedrock Converse (`model/<id>/converse` and `converse-stream`). */
export const bedrockTranslator: AutoTranslator = {
  toUpstream(input) {
    const model = encodeURIComponent(input.model)
    return {
      rest: input.body.stream === true ? `model/${model}/converse-stream` : `model/${model}/converse`,
      search: "",
      protocol: "bedrock_converse",
      headers: {},
      body: toConverseBody(input.body, input),
    }
  },
  streamToChat: (body, input) => converseStreamToChat(body, input.route, input.remember),
  jsonToChat: (body, input) => converseJsonToChat(body, input.route, input.remember),
  errorToChat: (body, status) => converseErrorToChat(body, status),
}
