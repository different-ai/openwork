// OpenAI Chat Completions helpers for Auto requests. Desktops send Auto as an
// OpenAI-compatible chat request; these read the prompt from it and prepare
// it for an OpenAI-protocol upstream.
import { createHash } from "node:crypto"
import type { AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import type { AutoTranslator } from "./protocol.js"

export type JsonObject = Record<string, unknown>

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The text of a chat message's content: a string, or the text parts of a part array. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((part) => isJsonObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n")
}

function messages(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.filter(isJsonObject) : []
}

export type AutoPrompt = {
  /** The latest user message's text. */
  prompt: string
  /** A short excerpt of the conversation before it, or null. */
  context: string | null
  /** True when the last message is not the user's: a tool result or an assistant prefill. */
  continuation: boolean
  /** Stable for every request of one turn. */
  turnFingerprint: string
}

const CONTEXT_MESSAGES = 4
const CONTEXT_CHARS = 1500

export function readAutoPrompt(body: JsonObject): AutoPrompt {
  const list = messages(body)
  let lastUser = -1
  for (let index = list.length - 1; index >= 0; index--) {
    if (list[index]?.role === "user") { lastUser = index; break }
  }
  const prompt = lastUser >= 0 ? contentText(list[lastUser]?.content) : ""
  const earlier = list.slice(0, Math.max(lastUser, 0))
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-CONTEXT_MESSAGES)
    .map((message) => `${message.role}: ${contentText(message.content).slice(0, CONTEXT_CHARS)}`)
    .filter((line) => line.length > line.indexOf(":") + 2)
  const userCount = list.filter((message) => message.role === "user").length
  const firstUser = list.find((message) => message.role === "user")
  const turnFingerprint = createHash("sha256")
    .update(contentText(firstUser?.content)).update("\u0000")
    .update(String(userCount)).update("\u0000")
    .update(prompt)
    .digest("base64url")
  return {
    prompt,
    context: earlier.length ? earlier.join("\n") : null,
    continuation: list.length > 0 && list[list.length - 1]?.role !== "user",
    turnFingerprint,
  }
}

/** Fields a client may send that select reasoning; Auto replaces them with the chosen level. */
const CLIENT_REASONING_FIELDS = ["reasoning_effort", "reasoning", "thinking", "reasoningEffort", "output_config"]

/** The Auto request prepared for an OpenAI Chat Completions upstream. */
export function toOpenAiChatBody(body: JsonObject, input: {
  model: string
  thinkingLevel: AutoRouterThinkingLevel
  /** OpenRouter takes `reasoning.effort`; other OpenAI-compatible APIs take `reasoning_effort`. */
  reasoningStyle: "reasoning_effort" | "openrouter" | "none"
}): JsonObject {
  const next: JsonObject = { ...body, model: input.model }
  for (const field of CLIENT_REASONING_FIELDS) delete next[field]
  const level = input.thinkingLevel
  if (level !== "default" && input.reasoningStyle === "reasoning_effort") next.reasoning_effort = level === "max" ? "xhigh" : level
  if (level !== "default" && input.reasoningStyle === "openrouter") next.reasoning = { effort: level === "max" ? "xhigh" : level }
  return next
}

export type AutoRouteInfo = {
  provider: string
  model: string
  thinking: AutoRouterThinkingLevel
  reason: string
  /** The model's display name from the organization's catalog, for example `Claude Haiku 5.5`. */
  name?: string
}

const encoder = new TextEncoder()

/**
 * Adds `openwork_route` to the first JSON chunk of an OpenAI chat SSE stream
 * (and keeps every byte otherwise unchanged), so clients that read the stream
 * learn which model answered.
 */
export function injectRouteIntoChatStream(body: ReadableStream<Uint8Array>, route: AutoRouteInfo): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ""
  let injected = false
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (injected) { controller.enqueue(chunk); return }
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline >= 0 && !injected) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        controller.enqueue(encoder.encode(`${injectLine(line, route, () => { injected = true })}\n`))
        newline = buffer.indexOf("\n")
      }
      if (injected && buffer) { controller.enqueue(encoder.encode(buffer)); buffer = "" }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) controller.enqueue(encoder.encode(buffer))
    },
  }))
}

function injectLine(line: string, route: AutoRouteInfo, done: () => void) {
  if (!line.startsWith("data:")) return line
  const data = line.slice(5).trim()
  if (!data.startsWith("{")) return line
  try {
    const parsed: unknown = JSON.parse(data)
    if (!isJsonObject(parsed) || parsed.error !== undefined) return line
    done()
    return `data: ${JSON.stringify({ ...parsed, openwork_route: route })}`
  } catch {
    return line
  }
}

/**
 * OpenAI Chat Completions upstreams (OpenAI, OpenAI-compatible, OpenRouter,
 * Mistral, Azure OpenAI, Bedrock's OpenAI-compatible endpoint): forwarded as
 * chat with the chosen reasoning effort; the response is already chat.
 */
export function openAiChatTranslator(options: {
  rest: string
  search?: string
  reasoningStyle: "reasoning_effort" | "openrouter" | "none"
}): AutoTranslator {
  return {
    toUpstream(input) {
      return {
        rest: options.rest,
        search: options.search ?? "",
        protocol: "openai_chat",
        headers: {},
        body: toOpenAiChatBody(input.body, { model: input.model, thinkingLevel: input.thinkingLevel, reasoningStyle: options.reasoningStyle }),
      }
    },
    streamToChat: (body, input) => injectRouteIntoChatStream(body, input.route),
    jsonToChat: (body, input) => isJsonObject(body) ? { ...body, openwork_route: input.route } : { openwork_route: input.route },
    errorToChat: (body, status) => isJsonObject(body) && isJsonObject(body.error)
      ? body
      : { error: { message: `The provider failed with HTTP ${status}.`, type: "api_error", code: null } },
  }
}
