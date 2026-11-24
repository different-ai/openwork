import { isJsonObject, type JsonObject } from "@openwork-ee/gateway-protocols/chat"

/** What one provider needs to continue after a tool call. */
export type ReasoningPayload = { kind: "anthropic" | "bedrock" | "google" | "openai" | "turn"; blocks: JsonObject[] }

export type ReasoningStore = {
  recall(organizationId: string, toolCallIds: string[]): Promise<Map<string, ReasoningPayload>>
  remember(organizationId: string, toolCallIds: string[], payload: ReasoningPayload): Promise<void>
}

/** How a provider adapter hands reasoning it saw in a response to the store. */
export type RememberReasoning = (toolCallIds: string[], payload: ReasoningPayload) => void

export const REASONING_TTL_MS = 60 * 60_000
const MEMORY_LIMIT = 5_000
const TOOL_CALL_ID = /^[A-Za-z0-9_.:-]{1,191}$/

export function isReasoningToolCallId(id: string): boolean {
  return TOOL_CALL_ID.test(id)
}

export function parseReasoningPayload(value: unknown): ReasoningPayload | null {
  if (!isJsonObject(value) || (value.kind !== "anthropic" && value.kind !== "bedrock" && value.kind !== "google" && value.kind !== "openai" && value.kind !== "turn") || !Array.isArray(value.blocks)) return null
  return { kind: value.kind, blocks: value.blocks.filter(isJsonObject) }
}

export function createMemoryReasoningStore(): ReasoningStore & { clear(): void } {
  const entries = new Map<string, { payload: ReasoningPayload; expires: number }>()
  return {
    async recall(organizationId, toolCallIds) {
      const now = Date.now()
      const found = new Map<string, ReasoningPayload>()
      for (const id of toolCallIds) {
        const hit = entries.get(`${organizationId}:${id}`)
        if (hit && hit.expires > now) found.set(id, hit.payload)
      }
      return found
    },
    async remember(organizationId, toolCallIds, payload) {
      const expires = Date.now() + REASONING_TTL_MS
      for (const id of toolCallIds) {
        const key = `${organizationId}:${id}`
        entries.delete(key)
        entries.set(key, { payload, expires })
      }
      while (entries.size > MEMORY_LIMIT) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
    clear() { entries.clear() },
  }
}
