// Prompt caching for Claude. Anthropic caches a prompt only up to the cache
// breakpoints the request marks; providers that serve Claude behind another
// API (OpenRouter, LiteLLM, Bedrock) pass those markers through. Clients pick
// breakpoints from the model id, but Gateway model aliases (`gwm_…`) hide that
// the model is Claude, so they send none and every turn pays for the whole
// context. Once the grant has resolved the real upstream model, the Gateway
// places the breakpoints the way OpenCode does for Claude: the last tool, the
// first and last system parts and the end of the conversation, at most four.
// A request that already marks any breakpoint is left exactly as the client
// sent it.
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import { isJsonObject, type JsonObject } from "./auto-router/chat.js"

const MAX_BREAKPOINTS = 4
/** Conversation messages marked at the tail: the newest turn and the one before it, so a retried or forked turn still reads the cache. */
const TAIL_MESSAGES = 2
const EPHEMERAL = { type: "ephemeral" }

/** Upstream ids that name a Claude model: `claude-…`, `anthropic/claude-…`, `us.anthropic.claude-…`, `~anthropic/claude-sonnet-latest`. */
export function isAnthropicModelId(model: string | null | undefined): boolean {
  return typeof model === "string" && /claude|anthropic/i.test(model)
}

type Budget = { remaining: number }

function lastIndexWhere(items: unknown[], matches: (item: unknown) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (matches(items[index])) return index
  return -1
}

function hasCacheMarker(value: unknown, key: "cache_control" | "cachePoint"): boolean {
  const pending: unknown[] = [value]
  while (pending.length) {
    const next = pending.pop()
    if (Array.isArray(next)) { pending.push(...next); continue }
    if (!isJsonObject(next)) continue
    if (Object.hasOwn(next, key)) return true
    pending.push(...Object.values(next))
  }
  return false
}

/** A tool's own marker only: its parameter schema may name a property `cache_control`. */
function toolsMarked(tools: unknown): boolean {
  return Array.isArray(tools) && tools.some((tool) => isJsonObject(tool) && Object.hasOwn(tool, "cache_control"))
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

type Marker = {
  canMark: (part: JsonObject) => boolean
  /** Mark the last text part rather than a later image or file: OpenAI-compatible proxies document `cache_control` on text. */
  preferText: boolean
}

/** Marks the last part that can carry `cache_control`; a string becomes one text part. Returns whether it marked. */
function markContent(holder: JsonObject, budget: Budget, { canMark, preferText }: Marker): boolean {
  if (budget.remaining <= 0) return false
  const content = holder.content
  if (isNonEmptyText(content)) {
    holder.content = [{ type: "text", text: content, cache_control: EPHEMERAL }]
    budget.remaining -= 1
    return true
  }
  if (!Array.isArray(content)) return false
  const markable = (part: unknown): part is JsonObject => isJsonObject(part) && canMark(part)
  const lastText = preferText ? lastIndexWhere(content, (part) => markable(part) && part.type === "text") : -1
  const target = lastText >= 0 ? lastText : lastIndexWhere(content, markable)
  const part = content[target]
  if (!isJsonObject(part)) return false
  content[target] = { ...part, cache_control: EPHEMERAL }
  budget.remaining -= 1
  return true
}

function markTail(messages: JsonObject[], budget: Budget, marker: Marker) {
  let marked = 0
  for (let index = messages.length - 1; index >= 0 && marked < TAIL_MESSAGES && budget.remaining > 0; index--) {
    const message = messages[index]
    if (message && markContent(message, budget, marker)) marked += 1
  }
}

// Chat Completions: OpenRouter and LiteLLM read Anthropic `cache_control` on content parts.
const chatMarker: Marker = {
  canMark: (part) => part.type === "text" ? isNonEmptyText(part.text) : typeof part.type === "string",
  preferText: true,
}

function markChatCompletions(json: JsonObject): boolean {
  if (!Array.isArray(json.messages) || hasCacheMarker(json.messages, "cache_control") || toolsMarked(json.tools)) return false
  const messages = json.messages.filter(isJsonObject)
  const budget: Budget = { remaining: MAX_BREAKPOINTS }
  const system = messages.filter((message) => message.role === "system" || message.role === "developer")
  const firstSystem = system[0]
  const lastSystem = system.at(-1)
  if (firstSystem) markContent(firstSystem, budget, chatMarker)
  if (lastSystem && lastSystem !== firstSystem) markContent(lastSystem, budget, chatMarker)
  markTail(messages.filter((message) => message.role !== "system" && message.role !== "developer"), budget, chatMarker)
  return budget.remaining < MAX_BREAKPOINTS
}

// Anthropic Messages: thinking blocks cannot carry `cache_control`.
const messagesMarker: Marker = {
  canMark: (part) => {
    if (part.type === "thinking" || part.type === "redacted_thinking") return false
    return part.type === "text" ? isNonEmptyText(part.text) : typeof part.type === "string"
  },
  preferText: false,
}

function markAnthropicMessages(json: JsonObject): boolean {
  if (!Array.isArray(json.messages) || [json.messages, json.system].some((value) => hasCacheMarker(value, "cache_control")) || toolsMarked(json.tools)) return false
  const budget: Budget = { remaining: MAX_BREAKPOINTS }
  // Tools come first in the cached prefix, so their breakpoint survives system prompt changes.
  if (Array.isArray(json.tools)) {
    const index = lastIndexWhere(json.tools, isJsonObject)
    const tool = json.tools[index]
    if (isJsonObject(tool)) {
      json.tools[index] = { ...tool, cache_control: EPHEMERAL }
      budget.remaining -= 1
    }
  }
  if (isNonEmptyText(json.system)) {
    json.system = [{ type: "text", text: json.system, cache_control: EPHEMERAL }]
    budget.remaining -= 1
  } else if (Array.isArray(json.system)) {
    const blocks = json.system
    const marks = [0, blocks.length - 1].filter((index, position, all) => all.indexOf(index) === position)
    for (const index of marks) {
      const block = blocks[index]
      if (budget.remaining <= 0 || !isJsonObject(block) || !messagesMarker.canMark(block)) continue
      blocks[index] = { ...block, cache_control: EPHEMERAL }
      budget.remaining -= 1
    }
  }
  markTail(json.messages.filter(isJsonObject), budget, messagesMarker)
  return budget.remaining < MAX_BREAKPOINTS
}

// Bedrock Converse: a `cachePoint` block caches everything before it.
const CACHE_POINT = { cachePoint: { type: "default" } }

function appendCachePoint(holder: JsonObject, key: string, budget: Budget): boolean {
  const blocks = holder[key]
  if (budget.remaining <= 0 || !Array.isArray(blocks) || blocks.length === 0) return false
  blocks.push(CACHE_POINT)
  budget.remaining -= 1
  return true
}

function markBedrockConverse(json: JsonObject): boolean {
  if (!Array.isArray(json.messages) || [json.messages, json.system].some((value) => hasCacheMarker(value, "cachePoint"))
    || (isJsonObject(json.toolConfig) && Array.isArray(json.toolConfig.tools) && json.toolConfig.tools.some((tool) => isJsonObject(tool) && Object.hasOwn(tool, "cachePoint")))) return false
  const budget: Budget = { remaining: MAX_BREAKPOINTS }
  if (isJsonObject(json.toolConfig)) appendCachePoint(json.toolConfig, "tools", budget)
  appendCachePoint(json, "system", budget)
  let marked = 0
  for (let index = json.messages.length - 1; index >= 0 && marked < TAIL_MESSAGES && budget.remaining > 0; index--) {
    const message = json.messages[index]
    if (isJsonObject(message) && appendCachePoint(message, "content", budget)) marked += 1
  }
  return budget.remaining < MAX_BREAKPOINTS
}

/**
 * Adds Claude prompt-cache breakpoints to a request the client left unmarked.
 * `upstreamModel` must be the grant-resolved model, never the caller's alias.
 * Returns whether the body changed.
 */
export function applyClaudePromptCache(json: JsonObject, protocol: GatewayRequestProtocol, upstreamModel: string | null): boolean {
  if (!isAnthropicModelId(upstreamModel)) return false
  // Request-level automatic caching (Anthropic, OpenRouter) is already the client's choice.
  if (Object.hasOwn(json, "cache_control")) return false
  switch (protocol) {
    case "openai_chat": return markChatCompletions(json)
    case "anthropic_messages": return markAnthropicMessages(json)
    case "bedrock_converse": return bedrockCachesModel(upstreamModel) && markBedrockConverse(json)
    default: return false
  }
}

/**
 * Bedrock rejects `cachePoint` for models without prompt caching, so only the
 * Claude models it caches get one: 3.5 Haiku, 3.7 Sonnet and every 4.x and later.
 */
export function bedrockCachesModel(model: string | null): boolean {
  if (!model) return false
  if (/claude-3-5-haiku|claude-3-7-sonnet/i.test(model)) return true
  const version = /claude-(?:opus|sonnet|haiku)-(\d+)/i.exec(model)
  return version !== null && Number(version[1]) >= 4
}
