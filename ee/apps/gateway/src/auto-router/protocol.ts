// The contract every Auto translator implements: an OpenAI Chat Completions
// request in, one upstream protocol's request out, and that protocol's
// response back as Chat Completions (JSON body, SSE stream, or error body).
import type { AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import type { AutoRouteInfo, JsonObject } from "./chat.js"
import type { ReasoningPayload } from "./reasoning-store.js"

export type TranslateRequestInput = {
  /** The client's chat request. Never mutated. */
  body: JsonObject
  /** The member's `gwm_…` alias; put it wherever the protocol names the model (body or path). */
  model: string
  /** The catalog (upstream) model id, for model-specific behaviour. */
  upstreamModel: string
  thinkingLevel: AutoRouterThinkingLevel
  /**
   * The levels the model's catalog allows. `none` among them means the model
   * accepts turning thinking off; otherwise translators must never send it.
   */
  thinkingLevels: readonly AutoRouterThinkingLevel[]
  /** The model's catalog output limit, when known. */
  maxOutputTokens: number | null
  /** Reasoning state remembered for earlier tool calls, by tool call id. */
  reasoning: ReadonlyMap<string, ReasoningPayload>
}

export type TranslatedRequest = {
  /** Path under the provider's base URL, e.g. `messages` or `models/<alias>:streamGenerateContent`. */
  rest: string
  /** Query string including `?`, or "". */
  search: string
  protocol: GatewayRequestProtocol
  /** Extra request headers the protocol requires (e.g. anthropic-version). */
  headers: Record<string, string>
  body: JsonObject
}

export type TranslateResponseInput = {
  route: AutoRouteInfo
  /** Whether the client asked for a stream (`stream: true`). */
  stream: boolean
  /** Keep reasoning state for the tool calls it preceded. Fire and forget. */
  remember: (toolCallIds: string[], payload: ReasoningPayload) => void
}

export type AutoTranslator = {
  /** Which reasoning kind this translator stores and replays. */
  toUpstream(input: TranslateRequestInput): TranslatedRequest
  /** A successful streamed response (SSE, or AWS event stream for Bedrock) as a Chat Completions SSE stream ending in `data: [DONE]`. */
  streamToChat(body: ReadableStream<Uint8Array>, input: TranslateResponseInput): ReadableStream<Uint8Array>
  /** A successful non-streamed response body (parsed JSON) as a `chat.completion` object with `openwork_route`. */
  jsonToChat(body: unknown, input: TranslateResponseInput): JsonObject
  /** An error response body (parsed JSON, or null) as `{ error: { message, type, code } }`. */
  errorToChat(body: unknown, status: number): JsonObject
}

/** Every tool call id in a chat request's assistant messages. */
export function chatToolCallIds(body: JsonObject): string[] {
  const ids: string[] = []
  if (!Array.isArray(body.messages)) return ids
  for (const message of body.messages) {
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue
    const calls: unknown = Reflect.get(message, "tool_calls")
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      const id: unknown = typeof call === "object" && call !== null ? Reflect.get(call, "id") : undefined
      if (typeof id === "string" && id) ids.push(id)
    }
  }
  return ids
}

export function chatError(message: string, type = "api_error", code: string | null = null): JsonObject {
  return { error: { message, type, code } }
}
