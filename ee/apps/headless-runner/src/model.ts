import { z } from "zod"
import type { HeadlessModelAccess, Message, ToolCall, ToolSpec } from "./types.js"

/** Constructed per run: never mutates the deployment adapter or retains another member's credentials. */
export function createModelAdapter(access: HeadlessModelAccess, options: { maxOutputTokens: number; fetch?: typeof fetch }): ModelClient {
  const config = { ...options, baseUrl: access.baseUrl }
  const client = access.protocol === "anthropic" ? anthropicModel(config)
    : access.protocol === "openai-responses" ? openAIResponsesModel(config)
    : openAIModel(config)
  return access.model ? { ...client, complete: request => client.complete({ ...request, model: access.model ?? request.model }) } : client
}

export type ModelRequest = {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  model: string
  apiKey: string
  signal: AbortSignal
  /** Streams the model's text as it is written. Without it the call is not streamed. */
  onText?: (delta: string) => void
  /** The streamed text so far is void: the call is being retried from the start. */
  onReset?: () => void
  /** The model started writing a call to this tool (streamed calls only), before its input is complete. */
  onTool?: (name: string) => void
  /**
   * Messages after which the provider may cache the request so far (Anthropic). Without them, the request is cached
   * up to its last message. The system prompt is always a cache point, so at most three are used.
   */
  cacheAfter?: ReadonlySet<Message>
  /**
   * Text the model already wrote for this answer (a step cut off mid-call, see steps.ts): the call continues it, and
   * the step's text starts with it. Only for clients with `continuesAnswers`.
   */
  continueFrom?: string
}
export type ModelStep = {
  /** Provider-reported answering model, when the gateway exposes it (may differ from a requested alias). */
  model?: string
  text: string
  toolCalls: ToolCall[]
  /** inputTokens includes cachedInputTokens. */
  usage: Usage
  /** The reply stopped at the output-token cap: it is unfinished, and a call it was writing carries `CUT_OFF_CALL`. */
  cutOff?: boolean
}
export type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export type ModelClient = {
  complete(request: ModelRequest): Promise<ModelStep>
  /**
   * Accepts `continueFrom`: the provider takes a partial assistant message and continues it. Anthropic Messages does,
   * without extended thinking (which this runner never turns on); OpenAI's APIs don't.
   */
  continuesAnswers?: boolean
}

export class ModelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    /** What the provider said (its error message and request id), short, for logs and support; never shown as is. */
    readonly detail?: string,
  ) {
    super(message)
  }
}

const errorBody = z
  .object({ error: z.union([z.string(), z.object({ type: z.string().optional(), code: z.string().nullish(), message: z.string().optional() }).loose()]).optional(), message: z.string().optional() })
  .loose()

/** One line saying why a provider refused a request, from its error body, with the request id to look it up. */
export function describeProviderError(body: string, requestId: string | null): string {
  let text = body.trim()
  try {
    const parsed = errorBody.safeParse(JSON.parse(body))
    if (parsed.success) {
      const error = parsed.data.error
      const kind = typeof error === "object" ? (error.type ?? error.code ?? "") : ""
      const message = typeof error === "string" ? error : (error?.message ?? parsed.data.message ?? "")
      if (message) text = kind ? `${kind}: ${message}` : message
    }
  } catch {
    // Not JSON: keep the text.
  }
  // Provider messages don't carry keys, but never log one if a proxy echoes it.
  const redacted = text.replace(/\b(sk|ow_[a-z]+|key)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 300)
  return requestId ? `${redacted} (request ${requestId})` : redacted
}

type Fetch = typeof fetch
type Sleep = (ms: number, signal: AbortSignal) => Promise<void>

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
const MAX_ATTEMPTS = 3
/**
 * A model call's time limit. A non-streamed call must finish within it; a streamed one must start within it and then
 * never go this long without sending anything, so a long reply that keeps writing isn't cut off by the clock.
 */
const CALL_TIMEOUT_MS = 180_000

/** A timer that never keeps a Node process alive by itself (a no-op where timers are plain numbers). */
function unref<T>(timer: T): T {
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

/** Hands back a streamed response whose body fails after `CALL_TIMEOUT_MS` without a chunk (through `deadline`). */
function abortWhenIdle(response: Response, deadline: AbortController): Response {
  if (!response.body) return response
  const abort = () => deadline.abort(new Error("The model stream went quiet."))
  let idle = unref(setTimeout(abort, CALL_TIMEOUT_MS))
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        clearTimeout(idle)
        idle = unref(setTimeout(abort, CALL_TIMEOUT_MS))
        controller.enqueue(chunk)
      },
      flush: () => clearTimeout(idle),
    }),
  )
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) ? Math.min(seconds * 1000, 30_000) : undefined
}

/** POSTs JSON with bounded retries on transient failures and returns the successful response. Never logs secrets. */
async function openResponse(input: {
  fetch: Fetch
  sleep: Sleep
  url: string
  headers: Record<string, string>
  body: unknown
  signal: AbortSignal
}): Promise<Response> {
  let lastError: ModelError | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (lastError) await input.sleep(lastError.retryAfterMs ?? 1000 * 2 ** (attempt - 2), input.signal)
    let response: Response
    const deadline = new AbortController()
    const started = unref(setTimeout(() => deadline.abort(new Error("The model call timed out.")), CALL_TIMEOUT_MS))
    try {
      response = await input.fetch(input.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...input.headers },
        body: JSON.stringify(input.body),
        signal: AbortSignal.any([input.signal, deadline.signal]),
      })
    } catch (error) {
      clearTimeout(started)
      if (input.signal.aborted) throw error
      lastError = new ModelError("model_unreachable", "The AI gateway could not be reached.", true)
      continue
    }
    const streamed = (input.body as { stream?: unknown } | null)?.stream === true
    if (response.ok && streamed) {
      clearTimeout(started)
      return abortWhenIdle(response, deadline)
    }
    if (response.ok) return response
    const body = await response.text().catch(() => "")
    const requestId = response.headers.get("x-openwork-request-id") ?? response.headers.get("request-id")
    // Only authoritative HTTP refusals select a recovery flow. Provider text or
    // SSE fields never turn a transient failure into a purchase prompt.
    const modelsRoute = /\/api\/v1\/(chat\/completions|responses)$/.test(new URL(input.url).pathname)
    const freeLimit = response.status === 429 && modelsRoute
      && response.headers.get("X-OpenWork-Error-Code") === "free_allowance_exhausted"
      && response.headers.get("X-OpenWork-Usage-State") === "blocked"
    // Keep this adapter independent of unbuilt workspace runtime exports.
    const usageLimit = (response.status === 429 && ["openwork_gateway_usage_limit_exceeded", "openwork_models_allowance_reached"].includes(response.headers.get("X-OpenWork-Error-Code") ?? "") && response.headers.get("X-OpenWork-Usage-State") === "blocked")
      || (response.status === 429 && modelsRoute && response.headers.has("x-openwork-limit-bucket-id") && response.headers.has("x-openwork-limit-window-type"))
    const recoveryCode = freeLimit ? "model_free_allowance_exhausted" : usageLimit ? "model_usage_limit_exceeded"
      : modelsRoute && response.status === 402 ? "model_payment_required" : null
    lastError = new ModelError(
      recoveryCode ?? `model_http_${response.status}`,
      `The AI gateway returned ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
      recoveryCode === null && RETRYABLE_STATUS.has(response.status),
      retryAfterMs(response),
      describeProviderError(body, requestId),
    )
    if (!lastError.retryable) throw lastError
  }
  throw lastError ?? new ModelError("model_failed", "The model request failed.", false)
}

async function postJson(input: Parameters<typeof openResponse>[0]): Promise<unknown> {
  return (await openResponse(input)).json()
}

/** Server-sent events from a streamed model response: one parsed JSON `data` payload at a time. */
async function* sseData(response: Response, signal: AbortSignal): AsyncGenerator<unknown> {
  if (!response.body) throw new ModelError("model_bad_response", "The AI gateway sent an empty stream.", true)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let boundary = buffer.search(/\r?\n\r?\n/)
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "")
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data && data !== "[DONE]") {
          try {
            yield JSON.parse(data)
          } catch {
            // A keep-alive or comment, not an event.
          }
        }
        boundary = buffer.search(/\r?\n\r?\n/)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Streams a call; a stream cut off mid-way is retried from the start, after telling the reader to drop its text. */
async function withStreamRetries(request: ModelRequest, sleep: Sleep, run: () => Promise<ModelStep>): Promise<ModelStep> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (request.signal.aborted || !(error instanceof ModelError) || error.code !== "model_stream_interrupted" || attempt >= MAX_ATTEMPTS) throw error
      request.onReset?.()
      await sleep(1000 * 2 ** (attempt - 1), request.signal)
    }
  }
}

const streamInterrupted = () => new ModelError("model_stream_interrupted", "The AI gateway stream ended early.", true)

/** The error a call gets when the reply stopped at the output-token cap while writing it. */
export const CUT_OFF_CALL =
  "Your reply reached the output limit while writing this call, so it was cut off and not run. Send less in one call: split long code, scripts or documents into parts (for example, write a file in several pieces, then run it)."

/** Marks a step that stopped at the output-token cap; a call left unparsable by the cut gets `CUT_OFF_CALL`. */
function cutOffStep(step: ModelStep, cutOff: boolean): ModelStep {
  if (!cutOff) return step
  return { ...step, cutOff: true, toolCalls: step.toolCalls.map((call) => (call.inputError ? { ...call, input: {}, inputError: CUT_OFF_CALL } : call)) }
}

function parseArguments(raw: string): Pick<ToolCall, "input" | "inputError"> {
  try {
    const value: unknown = JSON.parse(raw || "{}")
    const parsed = z.record(z.string(), z.unknown()).safeParse(value)
    if (parsed.success) return { input: parsed.data }
  } catch {
    // fall through
  }
  return { input: {}, inputError: "Tool arguments were not a JSON object." }
}

// ---------------------------------------------------------------- Anthropic

type CacheControl = { cache_control?: { type: "ephemeral" } }
type AnthropicImage = { type: "image"; source: { type: "base64"; media_type: string; data: string } }
type AnthropicDocument = { type: "document"; title: string; source: { type: "base64"; media_type: "application/pdf"; data: string } }
type AnthropicBlock = CacheControl &
  (
    | { type: "text"; text: string }
    | AnthropicImage
    | AnthropicDocument
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | {
        type: "tool_result"
        tool_use_id: string
        content: string | Array<{ type: "text"; text: string } | AnthropicImage | AnthropicDocument>
        is_error: boolean
      }
  )
type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] }

/**
 * A transcript every provider accepts, whatever produced it: it starts with a message from the person, each tool
 * result directly follows the call it answers, every call has its result, and no message is empty. Providers
 * refuse anything else with a 400, and the same transcript would then fail on every retry. Messages it keeps are
 * returned as they were (same objects), so callers can still recognize them. `repairs` counts what it changed.
 */
export function normalizeTranscript(messages: readonly Message[]): { messages: Message[]; repairs: number } {
  const out: Message[] = []
  let repairs = 0
  // The latest assistant message with tool calls, and the calls still waiting for their result.
  let open: { index: number; waiting: Set<string> } | null = null
  const settle = () => {
    if (open && open.waiting.size) {
      const waiting = open.waiting
      const call = out[open.index]
      if (call?.role === "assistant") {
        const toolCalls = call.toolCalls.filter((entry) => !waiting.has(entry.id))
        repairs += call.toolCalls.length - toolCalls.length
        // Nothing answered it and it said nothing: no result follows it, so it is the last message so far.
        if (toolCalls.length === 0 && !call.text.trim()) out.splice(open.index, 1)
        else out[open.index] = { ...call, toolCalls }
      }
    }
    open = null
  }
  for (const message of messages) {
    if (message.role === "tool") {
      if (open?.waiting.delete(message.callId)) out.push(message)
      else repairs += 1
      continue
    }
    settle()
    const empty = message.role === "user" ? !message.text.trim() && !message.images?.length && !message.documents?.length : false
    if (empty || (out.length === 0 && message.role !== "user")) {
      repairs += 1
      continue
    }
    out.push(message)
    if (message.role === "assistant" && message.toolCalls.length) open = { index: out.length - 1, waiting: new Set(message.toolCalls.map((call) => call.id)) }
  }
  settle()
  return { messages: out, repairs }
}

/** Anthropic allows four cache points per request; the system prompt takes one. */
const MAX_MESSAGE_CACHE_POINTS = 3

/**
 * Anthropic needs strict user/assistant alternation; adjacent same-role entries are merged. Messages in `cacheAfter`
 * end with a cache point (the newest three at most).
 */
export function toAnthropicMessages(messages: readonly Message[], cacheAfter?: ReadonlySet<Message>): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  const cachePoints: AnthropicBlock[] = []
  for (const message of normalizeTranscript(messages).messages) {
    const role = message.role === "assistant" ? "assistant" : "user"
    const blocks: AnthropicBlock[] =
      message.role === "user"
        ? [
            // Files first, then the question: models answer better about a document placed before the ask.
            ...(message.documents ?? []).map((document) => ({
              type: "document" as const,
              title: document.name.slice(0, 500),
              source: { type: "base64" as const, media_type: document.mediaType, data: document.data },
            })),
            ...(message.images ?? []).map((image) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
            })),
            // An empty text block is refused; a message of only files has none.
            ...(message.text.trim() ? [{ type: "text" as const, text: message.text }] : []),
          ]
        : message.role === "tool"
          ? [
              {
                type: "tool_result",
                tool_use_id: message.callId,
                // Tool results may carry text, image, and document blocks: a PDF a tool returned is read as-is.
                content: message.images?.length || message.documents?.length
                  ? [
                      { type: "text" as const, text: message.output },
                      ...(message.images ?? []).map((image) => ({
                        type: "image" as const,
                        source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
                      })),
                      ...(message.documents ?? []).map((document) => ({
                        type: "document" as const,
                        title: document.name.slice(0, 500),
                        source: { type: "base64" as const, media_type: document.mediaType, data: document.data },
                      })),
                    ]
                  : message.output,
                is_error: message.isError,
              },
            ]
          : [
              // Whitespace-only text is refused too.
              ...(message.text.trim() ? [{ type: "text" as const, text: message.text }] : []),
              ...message.toolCalls.map((call) => ({
                type: "tool_use" as const,
                id: call.id,
                name: call.name,
                input: call.input,
              })),
            ]
    const end = blocks.at(-1)
    if (!end) continue
    if (cacheAfter?.has(message)) cachePoints.push(end)
    const last = out.at(-1)
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const block of cachePoints.slice(-MAX_MESSAGE_CACHE_POINTS)) block.cache_control = { type: "ephemeral" }
  return out
}

const reportedModel = (value: string | null | undefined) => value && /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,127}$/.test(value) ? value : undefined

const anthropicResponse = z.object({
  model: z.string().nullish(),
  stop_reason: z.string().nullish(),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
      z.object({ type: z.literal("thinking") }).loose(),
      z.object({ type: z.literal("redacted_thinking") }).loose(),
    ]),
  ),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().nullable().optional(),
      cache_creation_input_tokens: z.number().nullable().optional(),
    })
    .loose()
    .optional(),
})

/**
 * Every agent step resends the whole conversation. Two cache breakpoints (the
 * system prompt + tools, and the newest message) let each step reuse the
 * previous prefix, which is most of the input cost of a multi-step turn.
 */
function withCacheBreakpoint(messages: AnthropicMessage[]): AnthropicMessage[] {
  const last = messages.at(-1)
  const block = last?.content.at(-1)
  if (!last || !block) return messages
  return [...messages.slice(0, -1), { ...last, content: [...last.content.slice(0, -1), { ...block, cache_control: { type: "ephemeral" } }] }]
}

const anthropicEvent = z
  .object({
    type: z.string(),
    index: z.number().optional(),
    message: z.object({ model: z.string().nullish(), usage: z.record(z.string(), z.unknown()).optional() }).loose().optional(),
    content_block: z.object({ type: z.string(), id: z.string().optional(), name: z.string().optional() }).loose().optional(),
    delta: z
      .object({ type: z.string().optional(), text: z.string().optional(), partial_json: z.string().optional(), stop_reason: z.string().nullish() })
      .loose()
      .optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
    error: z.object({ type: z.string().optional(), message: z.string().optional() }).loose().optional(),
  })
  .loose()

const tokenCount = (value: unknown) => (typeof value === "number" ? value : 0)

/** Assembles a streamed Anthropic Messages response into the same step a non-streamed call returns. */
async function readAnthropicStream(
  response: Response,
  signal: AbortSignal,
  onText: (delta: string) => void,
  onTool: (name: string) => void = () => undefined,
): Promise<ModelStep> {
  const blocks = new Map<number, { kind: "text"; text: string } | { kind: "tool"; id: string; name: string; json: string } | { kind: "other" }>()
  const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  let stopped = false
  let stopReason: string | null | undefined
  let model: string | undefined
  try {
    for await (const raw of sseData(response, signal)) {
      const event = anthropicEvent.safeParse(raw)
      if (!event.success) continue
      const value = event.data
      if (value.type === "message_start") model = reportedModel(value.message?.model)
      if (value.type === "message_start" && value.message?.usage) {
        const start = value.message.usage
        usage.cachedInputTokens = tokenCount(start.cache_read_input_tokens)
        usage.inputTokens = tokenCount(start.input_tokens) + usage.cachedInputTokens + tokenCount(start.cache_creation_input_tokens)
        usage.outputTokens = tokenCount(start.output_tokens)
      } else if (value.type === "content_block_start" && value.index !== undefined && value.content_block) {
        const block = value.content_block
        blocks.set(
          value.index,
          block.type === "text"
            ? { kind: "text", text: "" }
            : block.type === "tool_use" && block.id && block.name
              ? { kind: "tool", id: block.id, name: block.name, json: "" }
              : { kind: "other" },
        )
        if (block.type === "tool_use" && block.name) onTool(block.name)
      } else if (value.type === "content_block_delta" && value.index !== undefined && value.delta) {
        const block = blocks.get(value.index)
        if (block?.kind === "text" && value.delta.text) {
          block.text += value.delta.text
          onText(value.delta.text)
        } else if (block?.kind === "tool" && value.delta.partial_json) {
          block.json += value.delta.partial_json
        }
      } else if (value.type === "message_delta") {
        stopReason = value.delta?.stop_reason ?? stopReason
        if (value.usage) usage.outputTokens = tokenCount(value.usage.output_tokens) || usage.outputTokens
      } else if (value.type === "message_stop") {
        stopped = true
      } else if (value.type === "error") {
        const kind = value.error?.type ?? "error"
        throw new ModelError(
          kind === "overloaded_error" || kind === "api_error" ? "model_stream_interrupted" : `model_stream_${kind}`,
          `The AI gateway stream failed: ${(value.error?.message ?? kind).slice(0, 300)}`,
          kind === "overloaded_error" || kind === "api_error",
          undefined,
          describeProviderError(JSON.stringify({ error: value.error ?? {} }), response.headers.get("x-openwork-request-id") ?? response.headers.get("request-id")),
        )
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof ModelError) throw error
    throw streamInterrupted()
  }
  if (!stopped) throw streamInterrupted()
  const ordered = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block)
  return cutOffStep({
    ...(model ? { model } : {}),
    text: ordered.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join(""),
    toolCalls: ordered.flatMap((block) => (block.kind === "tool" ? [{ id: block.id, name: block.name, ...parseArguments(block.json) }] : [])),
    usage,
  }, stopReason === "max_tokens")
}

export function anthropicModel(options: {
  baseUrl: string
  maxOutputTokens: number
  fetch?: Fetch
  sleep?: Sleep
}): ModelClient {
  const sleep = options.sleep ?? defaultSleep
  const call = (request: ModelRequest, stream: boolean, continued: string) => {
    const messages = request.cacheAfter ? toAnthropicMessages(request.messages, request.cacheAfter) : withCacheBreakpoint(toAnthropicMessages(request.messages))
    return {
      fetch: options.fetch ?? fetch,
      sleep,
      url: `${options.baseUrl}/messages`,
      headers: { "x-api-key": request.apiKey, "anthropic-version": "2023-06-01" },
      signal: request.signal,
      body: {
        model: request.model,
        max_tokens: options.maxOutputTokens,
        ...(stream ? { stream: true } : {}),
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        // A partial answer goes last, as the assistant's: the model continues it.
        messages: continued ? [...messages, { role: "assistant", content: [{ type: "text", text: continued }] }] : messages,
        ...(request.tools.length
          ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }
          : {}),
      },
    }
  }
  return {
    continuesAnswers: true,
    async complete(request) {
      // Anthropic refuses a final assistant message that ends in whitespace. Continuing needs a request from the
      // person or tool results before it.
      const last = request.messages.at(-1)
      const continued = last && last.role !== "assistant" ? (request.continueFrom ?? "").trimEnd() : ""
      if (request.onText) {
        const onText = request.onText
        const step = await withStreamRetries(request, sleep, async () =>
          readAnthropicStream(await openResponse(call(request, true, continued)), request.signal, onText, request.onTool),
        )
        return continued ? { ...step, text: continued + step.text } : step
      }
      const json = await postJson(call(request, false, continued))
      const parsed = anthropicResponse.safeParse(json)
      if (!parsed.success) throw new ModelError("model_bad_response", "Unexpected response from the AI gateway.", false)
      const text: string[] = []
      const toolCalls: ToolCall[] = []
      for (const block of parsed.data.content) {
        if (block.type === "text") text.push(block.text)
        if (block.type === "tool_use") {
          const input = z.record(z.string(), z.unknown()).safeParse(block.input)
          toolCalls.push(
            input.success
              ? { id: block.id, name: block.name, input: input.data }
              : { id: block.id, name: block.name, input: {}, inputError: "Tool arguments were not a JSON object." },
          )
        }
      }
      return cutOffStep({
        ...(reportedModel(parsed.data.model) ? { model: reportedModel(parsed.data.model) } : {}),
        text: continued + text.join(""),
        toolCalls,
        usage: {
          inputTokens:
            (parsed.data.usage?.input_tokens ?? 0) +
            (parsed.data.usage?.cache_read_input_tokens ?? 0) +
            (parsed.data.usage?.cache_creation_input_tokens ?? 0),
          cachedInputTokens: parsed.data.usage?.cache_read_input_tokens ?? 0,
          outputTokens: parsed.data.usage?.output_tokens ?? 0,
        },
      }, parsed.data.stop_reason === "max_tokens")
    },
  }
}

// ------------------------------------------------- OpenAI chat completions

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } }
type OpenAIMessage =
  | { role: "system" | "user"; content: string | OpenAIContentPart[] }
  | {
      role: "assistant"
      content: string | null
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
    }
  | { role: "tool"; tool_call_id: string; content: string }

export function toOpenAIMessages(system: string, messages: readonly Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: "system", content: system }]
  // OpenAI refuses a tool message that doesn't answer the assistant message before it, as Anthropic does.
  for (const message of normalizeTranscript(messages).messages) {
    if (message.role === "user") {
      if (!message.images?.length && !message.documents?.length) out.push({ role: "user", content: message.text })
      else
        out.push({
          role: "user",
          content: [
            ...(message.documents ?? []).map((document) => ({
              type: "file" as const,
              file: { filename: document.name, file_data: `data:${document.mediaType};base64,${document.data}` },
            })),
            ...(message.images ?? []).map((image) => ({
              type: "image_url" as const,
              image_url: { url: `data:${image.mediaType};base64,${image.data}` },
            })),
            { type: "text" as const, text: message.text },
          ],
        })
    }
    else if (message.role === "tool") {
      out.push({ role: "tool", tool_call_id: message.callId, content: message.output })
      // Chat Completions tool messages are text-only, so images and PDFs follow as user content.
      if (message.images?.length || message.documents?.length)
        out.push({
          role: "user",
          content: [
            { type: "text", text: `${message.documents?.length ? "Files" : "Images"} returned by ${message.name}:` },
            ...(message.images ?? []).map((image) => ({
              type: "image_url" as const,
              image_url: { url: `data:${image.mediaType};base64,${image.data}` },
            })),
            ...(message.documents ?? []).map((document) => ({
              type: "file" as const,
              file: { filename: document.name, file_data: `data:${document.mediaType};base64,${document.data}` },
            })),
          ],
        })
    }
    else if (message.text.trim() || message.toolCalls.length) {
      out.push({
        role: "assistant",
        content: message.text.trim() ? message.text : null,
        ...(message.toolCalls.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      })
    }
  }
  return out
}

const openAIResponse = z.object({
  model: z.string().nullish(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullable()
            .optional(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).loose().nullable().optional(),
    })
    .loose()
    .optional(),
})

const openAIChunk = z
  .object({
    model: z.string().nullish(),
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                content: z.string().nullable().optional(),
                tool_calls: z
                  .array(
                    z
                      .object({
                        index: z.number(),
                        id: z.string().optional(),
                        function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).loose().optional(),
                      })
                      .loose(),
                  )
                  .nullable()
                  .optional(),
              })
              .loose()
              .optional(),
            finish_reason: z.string().nullable().optional(),
          })
          .loose(),
      )
      .optional(),
    usage: openAIResponse.shape.usage.nullable(),
  })
  .loose()

/** Assembles a streamed Chat Completions response into the same step a non-streamed call returns. */
async function readOpenAIStream(
  response: Response,
  signal: AbortSignal,
  onText: (delta: string) => void,
  onTool: (name: string) => void = () => undefined,
): Promise<ModelStep> {
  let text = ""
  const calls = new Map<number, { id: string; name: string; args: string }>()
  const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  let finished = false
  let cutOff = false
  let model: string | undefined
  try {
    for await (const raw of sseData(response, signal)) {
      const chunk = openAIChunk.safeParse(raw)
      if (!chunk.success) continue
      model = reportedModel(chunk.data.model) ?? model
      const choice = chunk.data.choices?.[0]
      if (choice?.delta?.content) {
        text += choice.delta.content
        onText(choice.delta.content)
      }
      for (const part of choice?.delta?.tool_calls ?? []) {
        const entry = calls.get(part.index) ?? { id: "", name: "", args: "" }
        if (part.id) entry.id = part.id
        if (part.function?.name) {
          if (!entry.name) onTool(part.function.name)
          entry.name += part.function.name
        }
        if (part.function?.arguments) entry.args += part.function.arguments
        calls.set(part.index, entry)
      }
      if (choice?.finish_reason) finished = true
      if (choice?.finish_reason === "length") cutOff = true
      if (chunk.data.usage) {
        usage.inputTokens = chunk.data.usage.prompt_tokens ?? 0
        usage.cachedInputTokens = chunk.data.usage.prompt_tokens_details?.cached_tokens ?? 0
        usage.outputTokens = chunk.data.usage.completion_tokens ?? 0
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof ModelError) throw error
    throw streamInterrupted()
  }
  if (!finished) throw streamInterrupted()
  return cutOffStep({
    ...(model ? { model } : {}),
    text,
    toolCalls: [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({ id: call.id, name: call.name, ...parseArguments(call.args) })),
    usage,
  }, cutOff)
}

export function openAIModel(options: { baseUrl: string; maxOutputTokens: number; fetch?: Fetch; sleep?: Sleep }): ModelClient {
  return {
    async complete(request) {
      const sleep = options.sleep ?? defaultSleep
      const call = (stream: boolean) => ({
        fetch: options.fetch ?? fetch,
        sleep,
        url: `${options.baseUrl}/chat/completions`,
        headers: { authorization: `Bearer ${request.apiKey}` },
        signal: request.signal,
        body: {
          model: request.model,
          // max_completion_tokens is OpenAI's current output cap (max_tokens is rejected by newer models).
          max_completion_tokens: options.maxOutputTokens,
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
          messages: toOpenAIMessages(request.system, request.messages),
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
                })),
              }
            : {}),
        },
      })
      if (request.onText) {
        const onText = request.onText
        return withStreamRetries(request, sleep, async () => readOpenAIStream(await openResponse(call(true)), request.signal, onText, request.onTool))
      }
      const json = await postJson(call(false))
      const parsed = openAIResponse.safeParse(json)
      if (!parsed.success) throw new ModelError("model_bad_response", "Unexpected response from the AI gateway.", false)
      const message = parsed.data.choices[0].message
      return cutOffStep({
        ...(reportedModel(parsed.data.model) ? { model: reportedModel(parsed.data.model) } : {}),
        text: message.content ?? "",
        toolCalls: (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          ...parseArguments(call.function.arguments),
        })),
        usage: {
          inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
          cachedInputTokens: parsed.data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          outputTokens: parsed.data.usage?.completion_tokens ?? 0,
        },
      }, parsed.data.choices[0].finish_reason === "length")
    },
  }
}

// ------------------------------------------------------------ OpenAI Responses

/**
 * OpenAI's Responses API, for models that only accept function tools there (newer OpenAI models refuse tools on
 * Chat Completions). Stateless like the Chat Completions client: `store: false`, the whole transcript every call.
 */
type ResponsesContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "input_file"; filename: string; file_data: string }
type ResponsesItem =
  | { role: "user"; content: ResponsesContent[] }
  | { role: "assistant"; content: { type: "output_text"; text: string }[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }

function responsesMedia(message: { images?: { mediaType: string; data: string }[]; documents?: { mediaType: string; data: string; name: string }[] }): ResponsesContent[] {
  return [
    ...(message.documents ?? []).map((document) => ({ type: "input_file" as const, filename: document.name, file_data: `data:${document.mediaType};base64,${document.data}` })),
    ...(message.images ?? []).map((image) => ({ type: "input_image" as const, image_url: `data:${image.mediaType};base64,${image.data}` })),
  ]
}

export function toResponsesInput(messages: readonly Message[]): ResponsesItem[] {
  const out: ResponsesItem[] = []
  // Like Chat Completions, a call's output must follow the call that asked for it.
  for (const message of normalizeTranscript(messages).messages) {
    if (message.role === "user") out.push({ role: "user", content: [...responsesMedia(message), { type: "input_text", text: message.text }] })
    else if (message.role === "tool") {
      out.push({ type: "function_call_output", call_id: message.callId, output: message.output })
      // Function outputs are text-only, so images and PDFs follow as user content.
      const media = responsesMedia(message)
      if (media.length)
        out.push({ role: "user", content: [{ type: "input_text", text: `${message.documents?.length ? "Files" : "Images"} returned by ${message.name}:` }, ...media] })
    } else {
      if (message.text.trim()) out.push({ role: "assistant", content: [{ type: "output_text", text: message.text }] })
      for (const call of message.toolCalls) out.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) })
    }
  }
  return out
}

const responsesResult = z
  .object({
    model: z.string().nullish(),
    status: z.string().optional(),
    incomplete_details: z.object({ reason: z.string().nullish() }).loose().nullish(),
    output: z.array(
      z
        .object({
          type: z.string(),
          call_id: z.string().optional(),
          name: z.string().optional(),
          arguments: z.string().optional(),
          content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).nullable().optional(),
        })
        .loose(),
    ),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        input_tokens_details: z.object({ cached_tokens: z.number().optional() }).loose().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose()

function responsesStep(result: z.infer<typeof responsesResult>): ModelStep {
  let text = ""
  const toolCalls: ToolCall[] = []
  for (const item of result.output) {
    if (item.type === "message") for (const part of item.content ?? []) if (part.type === "output_text" && part.text) text += part.text
    if (item.type === "function_call" && item.call_id && item.name) toolCalls.push({ id: item.call_id, name: item.name, ...parseArguments(item.arguments ?? "") })
  }
  return cutOffStep({
    text,
    toolCalls,
    ...(reportedModel(result.model) ? { model: reportedModel(result.model) } : {}),
    usage: {
      inputTokens: result.usage?.input_tokens ?? 0,
      cachedInputTokens: result.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
    },
  }, result.status === "incomplete" && result.incomplete_details?.reason === "max_output_tokens")
}

const responsesEvent = z
  .object({
    type: z.string(),
    delta: z.string().optional(),
    item: z.object({ type: z.string(), name: z.string().optional() }).loose().optional(),
    response: z.unknown().optional(),
    message: z.string().optional(),
  })
  .loose()

/** Assembles a streamed Responses call into the same step a non-streamed call returns. */
async function readResponsesStream(
  response: Response,
  signal: AbortSignal,
  onText: (delta: string) => void,
  onTool: (name: string) => void = () => undefined,
): Promise<ModelStep> {
  let final: z.infer<typeof responsesResult> | undefined
  try {
    for await (const raw of sseData(response, signal)) {
      const event = responsesEvent.safeParse(raw)
      if (!event.success) continue
      const { type } = event.data
      if (type === "response.output_text.delta" && event.data.delta) onText(event.data.delta)
      else if (type === "response.output_item.added" && event.data.item?.type === "function_call" && event.data.item.name) onTool(event.data.item.name)
      else if (type === "response.completed" || type === "response.incomplete") {
        const parsed = responsesResult.safeParse(event.data.response)
        if (!parsed.success) throw new ModelError("model_bad_response", "Unexpected response from the AI gateway.", false)
        final = parsed.data
      } else if (type === "response.failed" || type === "error") {
        const failed = z.object({ error: z.object({ message: z.string().optional() }).loose().nullable().optional() }).loose().safeParse(event.data.response)
        const reason = (failed.success ? failed.data.error?.message : undefined) ?? event.data.message ?? "unknown error"
        throw new ModelError("model_failed", `The model failed: ${reason.slice(0, 300)}`, false, undefined, reason.slice(0, 300))
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof ModelError) throw error
    throw streamInterrupted()
  }
  if (!final) throw streamInterrupted()
  return responsesStep(final)
}

export function openAIResponsesModel(options: { baseUrl: string; maxOutputTokens: number; fetch?: Fetch; sleep?: Sleep }): ModelClient {
  return {
    async complete(request) {
      const sleep = options.sleep ?? defaultSleep
      const call = (stream: boolean) => ({
        fetch: options.fetch ?? fetch,
        sleep,
        url: `${options.baseUrl}/responses`,
        headers: { authorization: `Bearer ${request.apiKey}` },
        signal: request.signal,
        body: {
          model: request.model,
          instructions: request.system,
          input: toResponsesInput(request.messages),
          max_output_tokens: options.maxOutputTokens,
          store: false,
          ...(stream ? { stream: true } : {}),
          ...(request.tools.length
            ? {
                // strict: false keeps MCP tool schemas as they are; strict mode would reject most of them.
                tools: request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
              }
            : {}),
        },
      })
      if (request.onText) {
        const onText = request.onText
        return withStreamRetries(request, sleep, async () => readResponsesStream(await openResponse(call(true)), request.signal, onText, request.onTool))
      }
      const parsed = responsesResult.safeParse(await postJson(call(false)))
      if (!parsed.success) throw new ModelError("model_bad_response", "Unexpected response from the AI gateway.", false)
      return responsesStep(parsed.data)
    },
  }
}

// ------------------------------------------------------------ model list

export type ModelOption = { id: string; name: string }

const modelList = z.object({ data: z.array(z.object({ id: z.string(), name: z.string().optional() }).loose()) }).loose()

/**
 * Models the configured Gateway route can serve with the runner's key, so an admin can only pick one that works.
 * Gateway names carry a "(group / credentials)" suffix that means nothing to an admin; it is dropped.
 */
export async function fetchGatewayModels(input: {
  baseUrl: string
  protocol: "anthropic" | "openai" | "openai-responses"
  apiKey: string
  fetch?: Fetch
}): Promise<ModelOption[]> {
  const response = await (input.fetch ?? fetch)(`${input.baseUrl}/models`, {
    headers: input.protocol === "anthropic" ? { "x-api-key": input.apiKey } : { authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new ModelError(`model_http_${response.status}`, "Could not list Gateway models.", false)
  const parsed = modelList.safeParse(await response.json())
  if (!parsed.success) throw new ModelError("model_bad_response", "Unexpected model list from the AI gateway.", false)
  return parsed.data.data.map((model) => ({
    id: model.id,
    name: (model.name ?? model.id).replace(/\s*\([^()]*\/[^()]*\)\s*$/, "").trim() || model.id,
  }))
}
