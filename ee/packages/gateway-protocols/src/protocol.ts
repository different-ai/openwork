import type { AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import type { AutoRouteInfo, JsonObject } from "@openwork-ee/gateway-protocols/chat"
import type { ReasoningPayload } from "@openwork-ee/gateway-protocols/reasoning"

export type TranslateRequestInput = {
  body: JsonObject
  model: string
  upstreamModel: string
  thinkingLevel: AutoRouterThinkingLevel
  thinkingLevels: readonly AutoRouterThinkingLevel[]
  maxOutputTokens: number | null
  reasoning: ReadonlyMap<string, ReasoningPayload>
}

export type TranslatedRequest = {
  rest: string
  search: string
  protocol: GatewayRequestProtocol
  headers: Record<string, string>
  body: JsonObject
}

export type TranslateResponseInput = {
  route: AutoRouteInfo
  stream: boolean
  remember: (toolCallIds: string[], payload: ReasoningPayload) => void
}

export type AutoTranslator = {
  toUpstream(input: TranslateRequestInput): TranslatedRequest
  streamToChat(body: ReadableStream<Uint8Array>, input: TranslateResponseInput): ReadableStream<Uint8Array>
  jsonToChat(body: unknown, input: TranslateResponseInput): JsonObject
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
