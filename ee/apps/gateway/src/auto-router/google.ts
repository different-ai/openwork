// Translates an Auto request (OpenAI Chat Completions) to Gemini
// generateContent (Google AI Studio and Vertex AI share the body format), and
// the response (JSON or SSE) back to Chat Completions.
//
// Gemini names the model in the path, not the body. Gemini 3 signs its
// function calls (`thoughtSignature`) and requires the signature back on the
// call when the conversation continues. Chat Completions cannot carry it, so
// each signature is handed to `remember` keyed by the tool call id we made up
// for it, and the caller passes it back in `reasoning`. When one is missing,
// the documented placeholder skips the check instead of failing the request.
import { randomUUID } from "node:crypto"
import type { AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import { contentText, isJsonObject, type AutoRouteInfo, type JsonObject } from "./chat.js"
import type { ReasoningPayload } from "./reasoning-store.js"
import type { AutoTranslator } from "./protocol.js"

/** Receives reasoning state to keep for the tool calls it preceded. */
export type RememberReasoning = (toolCallIds: string[], payload: ReasoningPayload) => void

/** Google's documented value for a function call whose signature was lost. */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator"

function parseDataUrl(url: string) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return match ? { mimeType: match[1] ?? "", data: match[2] ?? "" } : null
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", bmp: "image/bmp", svg: "image/svg+xml", pdf: "application/pdf",
}

function guessMimeType(url: string) {
  let pathname = url
  try { pathname = new URL(url).pathname } catch { pathname = url }
  const extension = /\.([A-Za-z0-9]+)$/.exec(pathname)?.[1]?.toLowerCase()
  return (extension && IMAGE_TYPES[extension]) ?? "image/jpeg"
}

function userParts(content: unknown): JsonObject[] {
  if (typeof content === "string") return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: JsonObject[] = []
  for (const part of content) {
    if (!isJsonObject(part)) continue
    if (part.type === "text" && typeof part.text === "string") parts.push({ text: part.text })
    else if (part.type === "image_url") {
      const url = isJsonObject(part.image_url) ? part.image_url.url : part.image_url
      if (typeof url !== "string") continue
      const inline = parseDataUrl(url)
      if (inline) parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } })
      else if (/^https?:\/\//i.test(url)) parts.push({ fileData: { mimeType: guessMimeType(url), fileUri: url } })
    } else if (part.type === "file" && isJsonObject(part.file) && typeof part.file.file_data === "string") {
      const inline = parseDataUrl(part.file.file_data)
      if (inline?.mimeType === "application/pdf") parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } })
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

function toolResponse(content: unknown): JsonObject {
  const text = contentText(content)
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isJsonObject(parsed)) return parsed
    } catch {
      // Not JSON; sent as text below.
    }
  }
  return { content: text }
}

function toolCallsOf(message: JsonObject): JsonObject[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls.filter(isJsonObject) : []
}

type GeminiContent = { role: "user" | "model"; parts: JsonObject[] }

function pushContent(list: GeminiContent[], role: "user" | "model", parts: JsonObject[]) {
  if (!parts.length) return
  const last = list[list.length - 1]
  // Turns must alternate; merge consecutive contents from the same side.
  if (last && last.role === role) last.parts.push(...parts)
  else list.push({ role, parts })
}

/** The Gemini major and minor version in a model id, e.g. gemini-2.5-flash → [2, 5]. */
export function geminiVersion(model: string): { major: number; minor: number } | null {
  const match = /gemini-(\d+)(?:\.(\d+))?/i.exec(model)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) }
}

function isGemini3(model: string) {
  const version = geminiVersion(model)
  return version !== null && version.major >= 3
}

// ---------------------------------------------------------------------------
// JSON Schema → Gemini's OpenAPI schema subset.

const STRING_FORMATS = new Set(["enum", "date-time"])
const NUMBER_FORMATS = new Set(["int32", "int64", "float", "double"])
const MAX_SCHEMA_DEPTH = 32

function resolveRef(ref: string, root: JsonObject): JsonObject | null {
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref)
  if (!match) return null
  const defs = root[match[1] ?? ""]
  const name = (match[2] ?? "").replace(/~1/g, "/").replace(/~0/g, "~")
  const target = isJsonObject(defs) ? defs[name] : undefined
  return isJsonObject(target) ? target : null
}

function sanitizeNode(value: unknown, root: JsonObject, depth: number): JsonObject {
  if (!isJsonObject(value) || depth > MAX_SCHEMA_DEPTH) return {}
  let schema = value
  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref, root)
    if (!target) return typeof schema.description === "string" ? { description: schema.description } : {}
    const { $ref: _ref, ...rest } = schema
    schema = { ...target, ...rest }
  }
  // allOf: merge the parts; Gemini has no intersection.
  if (Array.isArray(schema.allOf)) {
    const { allOf, ...rest } = schema
    const merged: JsonObject = { ...rest }
    for (const part of allOf) {
      const resolved = sanitizeNode(part, root, depth + 1)
      for (const [key, child] of Object.entries(resolved)) {
        if (key === "properties" && isJsonObject(child)) merged.properties = { ...(isJsonObject(merged.properties) ? merged.properties : {}), ...child }
        else if (key === "required" && Array.isArray(child)) merged.required = [...(Array.isArray(merged.required) ? merged.required : []), ...child]
        else if (merged[key] === undefined) merged[key] = child
      }
    }
    schema = merged
  }

  const out: JsonObject = {}
  let type: unknown = schema.type
  if (Array.isArray(type)) {
    const types = type.filter((item): item is string => typeof item === "string")
    if (types.includes("null")) out.nullable = true
    const rest = types.filter((item) => item !== "null")
    if (rest.length === 1) type = rest[0]
    else {
      type = undefined
      if (rest.length > 1) out.anyOf = rest.map((item) => ({ type: item }))
    }
  }
  if (typeof type === "string" && type !== "null") out.type = type
  if (type === "null") out.nullable = true
  if (typeof schema.description === "string") out.description = schema.description
  if (typeof schema.title === "string") out.title = schema.title
  if (schema.nullable === true) out.nullable = true
  if (typeof schema.format === "string") {
    if ((type === "string" && STRING_FORMATS.has(schema.format)) || ((type === "integer" || type === "number") && NUMBER_FORMATS.has(schema.format))) out.format = schema.format
  }
  const enumValues = Array.isArray(schema.enum) ? schema.enum : schema.const !== undefined ? [schema.const] : null
  if (enumValues) {
    const strings = enumValues.filter((item): item is string => typeof item === "string")
    if (strings.length && strings.length === enumValues.filter((item) => item !== null).length) {
      out.enum = strings
      if (out.type === undefined) out.type = "string"
      if (enumValues.includes(null)) out.nullable = true
    }
  }
  for (const key of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]) {
    if (typeof schema[key] === "number") out[key] = schema[key]
  }
  if (typeof schema.pattern === "string") out.pattern = schema.pattern
  if (isJsonObject(schema.properties)) {
    const properties: JsonObject = {}
    for (const [name, child] of Object.entries(schema.properties)) properties[name] = sanitizeNode(child, root, depth + 1)
    out.properties = properties
    if (out.type === undefined) out.type = "object"
    if (Array.isArray(schema.required)) {
      const required = [...new Set(schema.required.filter((name): name is string => typeof name === "string" && Object.hasOwn(properties, name)))]
      if (required.length) out.required = required
    }
  }
  if (schema.items !== undefined) {
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items
    out.items = sanitizeNode(items, root, depth + 1)
    if (out.type === undefined) out.type = "array"
  } else if (out.type === "array") {
    out.items = {}
  }
  const unions = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (unions) {
    const nonNull = unions.filter((item) => !(isJsonObject(item) && item.type === "null"))
    if (nonNull.length !== unions.length) out.nullable = true
    const variants = nonNull.map((item) => sanitizeNode(item, root, depth + 1))
    if (variants.length === 1) {
      for (const [key, child] of Object.entries(variants[0] ?? {})) if (out[key] === undefined) out[key] = child
    } else if (variants.length > 1) {
      out.anyOf = variants
    }
  }
  return out
}

/** A JSON Schema reduced to the OpenAPI subset Gemini function declarations accept. */
export function sanitizeGeminiSchema(schema: unknown): JsonObject {
  return isJsonObject(schema) ? sanitizeNode(schema, schema, 0) : {}
}

// ---------------------------------------------------------------------------
// Request.

const GEMINI_3_LEVELS: Record<Exclude<AutoRouterThinkingLevel, "default">, string> = {
  none: "minimal", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high",
}

const GEMINI_2_BUDGETS: Record<Exclude<AutoRouterThinkingLevel, "default">, number> = {
  none: 0, minimal: 512, low: 1024, medium: 8192, high: 24_576, xhigh: -1, max: -1,
}

/** Gemini's thinkingConfig for a level, or null to leave the model's default. */
export function geminiThinkingConfig(upstreamModel: string, level: AutoRouterThinkingLevel): JsonObject | null {
  if (level === "default") return null
  const version = geminiVersion(upstreamModel)
  if (!version) return null
  const pro = /-pro\b/i.test(upstreamModel)
  if (version.major >= 3) {
    // Gemini 3 cannot turn thinking off; Pro has no minimal level.
    const thinkingLevel = GEMINI_3_LEVELS[level]
    return { includeThoughts: true, thinkingLevel: pro && thinkingLevel === "minimal" ? "low" : thinkingLevel }
  }
  if (version.major === 2 && version.minor >= 5) {
    // 2.5 Pro cannot turn thinking off; 128 is its smallest budget.
    const budget = level === "none" && pro ? 128 : GEMINI_2_BUDGETS[level]
    return budget === 0 ? { thinkingBudget: 0 } : { includeThoughts: true, thinkingBudget: budget }
  }
  return null
}

function readMaxTokens(body: JsonObject) {
  const value = body.max_completion_tokens ?? body.max_tokens
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

export function toGeminiBody(body: JsonObject, input: {
  upstreamModel: string
  thinkingLevel: AutoRouterThinkingLevel
  maxOutputTokens: number | null
  /** Reasoning state remembered for earlier tool calls, by tool call id. */
  reasoning?: ReadonlyMap<string, ReasoningPayload>
}): JsonObject {
  const system: JsonObject[] = []
  const contents: GeminiContent[] = []
  const toolNames = new Map<string, string>()
  const gemini3 = isGemini3(input.upstreamModel)
  const source = Array.isArray(body.messages) ? body.messages.filter(isJsonObject) : []
  for (const message of source) {
    switch (message.role) {
      case "system":
      case "developer": {
        const text = contentText(message.content)
        if (text) system.push({ text })
        break
      }
      case "user":
        pushContent(contents, "user", userParts(message.content))
        break
      case "assistant": {
        const parts: JsonObject[] = []
        const text = contentText(message.content)
        if (text) parts.push({ text })
        let signed = false
        const calls: JsonObject[] = []
        for (const call of toolCallsOf(message)) {
          const fn = isJsonObject(call.function) ? call.function : {}
          const name = typeof fn.name === "string" ? fn.name : ""
          if (!name) continue
          const id = typeof call.id === "string" ? call.id : ""
          if (id) toolNames.set(id, name)
          const part: JsonObject = { functionCall: { name, args: parseArguments(fn.arguments) } }
          const recalled = id ? input.reasoning?.get(id) : undefined
          const signature = recalled?.kind === "google" ? recalled.blocks.map((block) => block.thoughtSignature).find((value) => typeof value === "string" && value) : undefined
          if (typeof signature === "string") { part.thoughtSignature = signature; signed = true }
          calls.push(part)
        }
        // Gemini 3 checks the signature on the first call of each step;
        // parallel calls after it carry none.
        const first = calls[0]
        if (gemini3 && first && !signed) first.thoughtSignature = SKIP_THOUGHT_SIGNATURE
        parts.push(...calls)
        pushContent(contents, "model", parts)
        break
      }
      case "tool": {
        const id = typeof message.tool_call_id === "string" ? message.tool_call_id : ""
        const name = toolNames.get(id) ?? (typeof message.name === "string" && message.name ? message.name : "tool")
        pushContent(contents, "user", [{ functionResponse: { name, response: toolResponse(message.content) } }])
        break
      }
    }
  }

  const next: JsonObject = { contents }
  if (system.length) next.systemInstruction = { parts: system }

  if (Array.isArray(body.tools)) {
    const declarations = body.tools.filter(isJsonObject).flatMap((tool) => {
      const fn = isJsonObject(tool.function) ? tool.function : null
      if (tool.type !== "function" || !fn || typeof fn.name !== "string") return []
      const declaration: JsonObject = { name: fn.name }
      if (typeof fn.description === "string") declaration.description = fn.description
      const parameters = sanitizeGeminiSchema(fn.parameters)
      // Gemini rejects an object schema without properties; leave it out.
      if (isJsonObject(parameters.properties) && Object.keys(parameters.properties).length) declaration.parameters = parameters
      return [declaration]
    })
    if (declarations.length) next.tools = [{ functionDeclarations: declarations }]
  }
  const toolChoice = body.tool_choice
  if (next.tools !== undefined && toolChoice !== undefined) {
    if (toolChoice === "none") next.toolConfig = { functionCallingConfig: { mode: "NONE" } }
    else if (toolChoice === "required") next.toolConfig = { functionCallingConfig: { mode: "ANY" } }
    else if (isJsonObject(toolChoice) && isJsonObject(toolChoice.function) && typeof toolChoice.function.name === "string") {
      next.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolChoice.function.name] } }
    } else next.toolConfig = { functionCallingConfig: { mode: "AUTO" } }
  }

  const generationConfig: JsonObject = {}
  const maxTokens = readMaxTokens(body) ?? input.maxOutputTokens
  if (maxTokens !== null) generationConfig.maxOutputTokens = maxTokens
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature
  if (typeof body.top_p === "number") generationConfig.topP = body.top_p
  const stop = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((value) => typeof value === "string") : []
  if (stop.length) generationConfig.stopSequences = stop
  const format = isJsonObject(body.response_format) ? body.response_format : null
  if (format?.type === "json_object") generationConfig.responseMimeType = "application/json"
  else if (format?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json"
    if (isJsonObject(format.json_schema) && isJsonObject(format.json_schema.schema)) generationConfig.responseSchema = sanitizeGeminiSchema(format.json_schema.schema)
  }
  const thinkingConfig = geminiThinkingConfig(input.upstreamModel, input.thinkingLevel)
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig
  if (Object.keys(generationConfig).length) next.generationConfig = generationConfig
  return next
}

// ---------------------------------------------------------------------------
// Response.

function finishReason(reason: unknown, hasToolCalls: boolean) {
  switch (reason) {
    case "MAX_TOKENS": return "length"
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "content_filter"
    default: return hasToolCalls ? "tool_calls" : "stop"
  }
}

type GeminiUsage = { prompt: number; candidates: number; thoughts: number; cached: number; total: number | null }

function readUsage(value: unknown, into: GeminiUsage) {
  if (!isJsonObject(value)) return
  if (typeof value.promptTokenCount === "number") into.prompt = value.promptTokenCount
  if (typeof value.candidatesTokenCount === "number") into.candidates = value.candidatesTokenCount
  if (typeof value.thoughtsTokenCount === "number") into.thoughts = value.thoughtsTokenCount
  if (typeof value.cachedContentTokenCount === "number") into.cached = value.cachedContentTokenCount
  if (typeof value.totalTokenCount === "number") into.total = value.totalTokenCount
}

function chatUsage(usage: GeminiUsage) {
  const completion = usage.candidates + usage.thoughts
  return {
    prompt_tokens: usage.prompt,
    completion_tokens: completion,
    total_tokens: usage.total ?? usage.prompt + completion,
    prompt_tokens_details: { cached_tokens: usage.cached },
    completion_tokens_details: { reasoning_tokens: usage.thoughts },
  }
}

function newToolCallId() {
  return `call_${randomUUID().replace(/-/g, "")}`
}

function firstCandidate(response: JsonObject): JsonObject {
  const candidate = Array.isArray(response.candidates) ? response.candidates.find(isJsonObject) : undefined
  return candidate ?? {}
}

function candidateParts(candidate: JsonObject): JsonObject[] {
  const content = isJsonObject(candidate.content) ? candidate.content : {}
  return Array.isArray(content.parts) ? content.parts.filter(isJsonObject) : []
}

/** The prompt was blocked before any candidate. */
function promptBlocked(response: JsonObject) {
  return isJsonObject(response.promptFeedback) && typeof response.promptFeedback.blockReason === "string"
}

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }

/** A function call part as a chat tool call, remembering its signature. */
function toolCallFrom(part: JsonObject, remember?: RememberReasoning): ToolCall | null {
  const call = isJsonObject(part.functionCall) ? part.functionCall : null
  if (!call || typeof call.name !== "string") return null
  const id = newToolCallId()
  if (remember && typeof part.thoughtSignature === "string" && part.thoughtSignature) {
    remember([id], { kind: "google", blocks: [{ thoughtSignature: part.thoughtSignature }] })
  }
  return { id, type: "function", function: { name: call.name, arguments: JSON.stringify(isJsonObject(call.args) ? call.args : {}) } }
}

/** A complete generateContent response as a Chat Completion. */
export function geminiJsonToChat(body: unknown, route: AutoRouteInfo, remember?: RememberReasoning): JsonObject {
  const response = isJsonObject(body) ? body : {}
  const candidate = firstCandidate(response)
  let text = ""
  let reasoning = ""
  const toolCalls: ToolCall[] = []
  for (const part of candidateParts(candidate)) {
    if (typeof part.text === "string") {
      if (part.thought === true) reasoning += part.text
      else text += part.text
      continue
    }
    const call = toolCallFrom(part, remember)
    if (call) toolCalls.push(call)
  }
  const usage: GeminiUsage = { prompt: 0, candidates: 0, thoughts: 0, cached: 0, total: null }
  readUsage(response.usageMetadata, usage)
  return {
    id: typeof response.responseId === "string" ? response.responseId : `chatcmpl-${Date.now()}`,
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
      finish_reason: promptBlocked(response) && candidate.finishReason === undefined ? "content_filter" : finishReason(candidate.finishReason, toolCalls.length > 0),
    }],
    usage: chatUsage(usage),
    openwork_route: route,
  }
}

function errorBody(error: JsonObject | null): JsonObject {
  if (!error) return { error: { message: "The provider rejected this request.", type: "api_error", code: null } }
  const status = typeof error.status === "string" && error.status ? error.status : null
  const message = typeof error.message === "string" && error.message ? error.message : "The provider rejected this request."
  return { error: { message, type: status ? status.toLowerCase() : "api_error", code: status ?? (typeof error.code === "number" || typeof error.code === "string" ? String(error.code) : null) } }
}

/** A Google error body (`{ error: { code, message, status } }`, or Vertex's one-item array of it) as a Chat Completions error body. */
export function geminiErrorToChat(body: unknown, status?: number): JsonObject {
  const source = Array.isArray(body) ? body[0] : body
  const error = isJsonObject(source) && isJsonObject(source.error) ? source.error : null
  if (!error && status !== undefined) return { error: { message: `The provider failed with HTTP ${status}.`, type: "api_error", code: null } }
  return errorBody(error)
}

const encoder = new TextEncoder()

/** A generateContent SSE stream (`?alt=sse`) as a Chat Completions SSE stream, ending with usage and [DONE]. */
export function geminiStreamToChat(body: ReadableStream<Uint8Array>, route: AutoRouteInfo, remember?: RememberReasoning): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ""
  let id = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  let started = false
  let finished = false
  let reason: unknown = undefined
  let blocked = false
  let toolIndex = 0
  const usage: GeminiUsage = { prompt: 0, candidates: 0, thoughts: 0, cached: 0, total: null }

  const chunk = (delta: JsonObject, extra: JsonObject = {}) => {
    const payload: JsonObject = { id, object: "chat.completion.chunk", created, model: route.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra }
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  const handle = (data: string): string => {
    if (!data || data === "[DONE]") return ""
    let parsed: unknown
    try { parsed = JSON.parse(data) } catch { return "" }
    const response = Array.isArray(parsed) ? parsed[0] : parsed
    if (!isJsonObject(response)) return ""
    if (isJsonObject(response.error)) {
      if (finished) return ""
      finished = true
      return `data: ${JSON.stringify(errorBody(response.error))}\n\n`
    }
    if (finished) return ""
    let out = ""
    if (!started) {
      if (typeof response.responseId === "string" && response.responseId) id = response.responseId
      started = true
      out += chunk({ role: "assistant", content: "" }, { openwork_route: route })
    }
    readUsage(response.usageMetadata, usage)
    if (promptBlocked(response)) blocked = true
    const candidate = firstCandidate(response)
    for (const part of candidateParts(candidate)) {
      if (typeof part.text === "string") {
        if (!part.text) continue
        out += chunk(part.thought === true ? { reasoning_content: part.text } : { content: part.text })
        continue
      }
      const call = toolCallFrom(part, remember)
      if (call) out += chunk({ tool_calls: [{ index: toolIndex++, ...call }] })
    }
    if (candidate.finishReason !== undefined) reason = candidate.finishReason
    return out
  }

  const finish = () => {
    if (finished) return ""
    finished = true
    const finalReason = blocked && reason === undefined ? "content_filter" : finishReason(reason, toolIndex > 0)
    const final = { id, object: "chat.completion.chunk", created, model: route.model, choices: [{ index: 0, delta: {}, finish_reason: finalReason }] }
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
      const data: string[] = []
      const comments: string[] = []
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) comments.push(line)
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
      // Keep heartbeats flowing so proxies keep the connection open.
      if (comments.length && !data.length) controller.enqueue(encoder.encode(`${comments.join("\n")}\n\n`))
      const out = handle(data.join("\n"))
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
      // Gemini has no end event: the stream closing ends the completion.
      if (started && !finished) controller.enqueue(encoder.encode(finish()))
    },
  }))
}

/** Gemini generateContent: Google AI Studio and Gemini on Vertex AI. */
export const googleTranslator: AutoTranslator = {
  toUpstream(input) {
    const stream = input.body.stream === true
    return {
      rest: `models/${input.model}:${stream ? "streamGenerateContent" : "generateContent"}`,
      search: stream ? "?alt=sse" : "",
      protocol: "google_generate_content",
      headers: {},
      body: toGeminiBody(input.body, input),
    }
  },
  streamToChat: (body, input) => geminiStreamToChat(body, input.route, input.remember),
  jsonToChat: (body, input) => geminiJsonToChat(body, input.route, input.remember),
  errorToChat: (body, status) => geminiErrorToChat(body, status),
}
