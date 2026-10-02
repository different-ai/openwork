import { z } from "zod"
import type { Message, ToolCall, ToolSpec } from "./types.js"

export type ModelRequest = {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  model: string
  apiKey: string
  signal: AbortSignal
}
export type ModelStep = {
  text: string
  toolCalls: ToolCall[]
  /** inputTokens includes cachedInputTokens. */
  usage: Usage
}
export type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export type ModelClient = { complete(request: ModelRequest): Promise<ModelStep> }

export class ModelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
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
const CALL_TIMEOUT_MS = 180_000

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) ? Math.min(seconds * 1000, 30_000) : undefined
}

/** POST JSON with bounded retries on transient failures. Never logs secrets. */
async function postJson(input: {
  fetch: Fetch
  sleep: Sleep
  url: string
  headers: Record<string, string>
  body: unknown
  signal: AbortSignal
}): Promise<unknown> {
  let lastError: ModelError | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (lastError) await input.sleep(lastError.retryAfterMs ?? 1000 * 2 ** (attempt - 2), input.signal)
    let response: Response
    try {
      response = await input.fetch(input.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...input.headers },
        body: JSON.stringify(input.body),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
      })
    } catch (error) {
      if (input.signal.aborted) throw error
      lastError = new ModelError("model_unreachable", "The AI gateway could not be reached.", true)
      continue
    }
    if (response.ok) return response.json()
    const detail = (await response.text().catch(() => "")).slice(0, 500)
    lastError = new ModelError(
      `model_http_${response.status}`,
      `The AI gateway returned ${response.status}${detail ? `: ${detail}` : ""}`,
      RETRYABLE_STATUS.has(response.status),
      retryAfterMs(response),
    )
    if (!lastError.retryable) throw lastError
  }
  throw lastError ?? new ModelError("model_failed", "The model request failed.", false)
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
type AnthropicBlock = CacheControl &
  (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | {
        type: "tool_result"
        tool_use_id: string
        content: string | Array<{ type: "text"; text: string } | AnthropicImage>
        is_error: boolean
      }
  )
type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] }

/** Anthropic needs strict user/assistant alternation; adjacent same-role entries are merged. */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user"
    const blocks: AnthropicBlock[] =
      message.role === "user"
        ? [{ type: "text", text: message.text }]
        : message.role === "tool"
          ? [
              {
                type: "tool_result",
                tool_use_id: message.callId,
                content: message.images?.length
                  ? [
                      { type: "text" as const, text: message.output },
                      ...message.images.map((image) => ({
                        type: "image" as const,
                        source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
                      })),
                    ]
                  : message.output,
                is_error: message.isError,
              },
            ]
          : [
              ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
              ...message.toolCalls.map((call) => ({
                type: "tool_use" as const,
                id: call.id,
                name: call.name,
                input: call.input,
              })),
            ]
    if (blocks.length === 0) continue
    const last = out.at(-1)
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  return out
}

const anthropicResponse = z.object({
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

export function anthropicModel(options: {
  baseUrl: string
  maxOutputTokens: number
  fetch?: Fetch
  sleep?: Sleep
}): ModelClient {
  return {
    async complete(request) {
      const json = await postJson({
        fetch: options.fetch ?? fetch,
        sleep: options.sleep ?? defaultSleep,
        url: `${options.baseUrl}/messages`,
        headers: { "x-api-key": request.apiKey, "anthropic-version": "2023-06-01" },
        signal: request.signal,
        body: {
          model: request.model,
          max_tokens: options.maxOutputTokens,
          system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
          messages: withCacheBreakpoint(toAnthropicMessages(request.messages)),
          ...(request.tools.length
            ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }
            : {}),
        },
      })
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
      return {
        text: text.join(""),
        toolCalls,
        usage: {
          inputTokens:
            (parsed.data.usage?.input_tokens ?? 0) +
            (parsed.data.usage?.cache_read_input_tokens ?? 0) +
            (parsed.data.usage?.cache_creation_input_tokens ?? 0),
          cachedInputTokens: parsed.data.usage?.cache_read_input_tokens ?? 0,
          outputTokens: parsed.data.usage?.output_tokens ?? 0,
        },
      }
    },
  }
}

// ------------------------------------------------- OpenAI chat completions

type OpenAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
type OpenAIMessage =
  | { role: "system" | "user"; content: string | OpenAIContentPart[] }
  | {
      role: "assistant"
      content: string | null
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
    }
  | { role: "tool"; tool_call_id: string; content: string }

export function toOpenAIMessages(system: string, messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: "system", content: system }]
  for (const message of messages) {
    if (message.role === "user") out.push({ role: "user", content: message.text })
    else if (message.role === "tool") {
      out.push({ role: "tool", tool_call_id: message.callId, content: message.output })
      // Chat Completions tool messages are text-only, so images follow as user content.
      if (message.images?.length)
        out.push({
          role: "user",
          content: [
            { type: "text", text: `Images returned by ${message.name}:` },
            ...message.images.map((image) => ({
              type: "image_url" as const,
              image_url: { url: `data:${image.mediaType};base64,${image.data}` },
            })),
          ],
        })
    }
    else if (message.text || message.toolCalls.length) {
      out.push({
        role: "assistant",
        content: message.text || null,
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

export function openAIModel(options: { baseUrl: string; maxOutputTokens: number; fetch?: Fetch; sleep?: Sleep }): ModelClient {
  return {
    async complete(request) {
      const json = await postJson({
        fetch: options.fetch ?? fetch,
        sleep: options.sleep ?? defaultSleep,
        url: `${options.baseUrl}/chat/completions`,
        headers: { authorization: `Bearer ${request.apiKey}` },
        signal: request.signal,
        body: {
          model: request.model,
          // max_completion_tokens is OpenAI's current output cap (max_tokens is rejected by newer models).
          max_completion_tokens: options.maxOutputTokens,
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
      const parsed = openAIResponse.safeParse(json)
      if (!parsed.success) throw new ModelError("model_bad_response", "Unexpected response from the AI gateway.", false)
      const message = parsed.data.choices[0].message
      return {
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
      }
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
  protocol: "anthropic" | "openai"
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
