// Reasoning state that must survive between requests of one Auto turn
// (Claude thinking blocks, Gemini thought signatures, Bedrock reasoning,
// OpenAI encrypted reasoning items),
// keyed by the tool call id the client echoes back. Shared by every gateway
// instance through the database (auto_router_reasoning, encrypted), with a
// small in-memory front so the common same-instance case skips a read.
import { and, eq, inArray, lt } from "@openwork-ee/den-db/drizzle"
import { AutoRouterReasoningTable } from "@openwork-ee/den-db"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { isJsonObject, type JsonObject } from "./chat.js"

/** What one provider needs to continue after a tool call. */
export type ReasoningPayload = { kind: "anthropic" | "bedrock" | "google" | "openai" | "turn"; blocks: JsonObject[] }

export type ReasoningStore = {
  /** Every remembered payload for these tool call ids, by id. */
  recall(organizationId: string, toolCallIds: string[]): Promise<Map<string, ReasoningPayload>>
  /** Remembers one payload for these tool call ids. Never throws. */
  remember(organizationId: string, toolCallIds: string[], payload: ReasoningPayload): Promise<void>
}

const TTL_MS = 60 * 60_000
const MEMORY_LIMIT = 5_000
/** Tool call ids are provider-made; anything else is not ours to look up. */
const TOOL_CALL_ID = /^[A-Za-z0-9_.:-]{1,191}$/

function parsePayload(value: unknown): ReasoningPayload | null {
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
      const expires = Date.now() + TTL_MS
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

export function createDbReasoningStore(): ReasoningStore {
  const memory = createMemoryReasoningStore()
  let writes = 0
  return {
    async recall(organizationId, toolCallIds) {
      const ids = [...new Set(toolCallIds.filter((id) => TOOL_CALL_ID.test(id)))]
      const found = await memory.recall(organizationId, ids)
      const missing = ids.filter((id) => !found.has(id))
      if (!missing.length || !isDenTypeId("organization", organizationId)) return found
      try {
        const { db } = await import("../db.js")
        const rows = await db.select().from(AutoRouterReasoningTable)
          .where(and(eq(AutoRouterReasoningTable.organizationId, organizationId), inArray(AutoRouterReasoningTable.toolCallId, missing)))
        const now = Date.now()
        for (const row of rows) {
          if (row.expiresAt.getTime() <= now) continue
          let parsed: unknown = null
          try { parsed = JSON.parse(row.payload) } catch { parsed = null }
          const payload = parsePayload(parsed)
          if (payload) found.set(row.toolCallId, payload)
        }
      } catch (error) {
        console.warn("[gateway] Smart Model Router could not read reasoning state", error instanceof Error ? error.message : error)
      }
      return found
    },
    async remember(organizationId, toolCallIds, payload) {
      const ids = [...new Set(toolCallIds.filter((id) => TOOL_CALL_ID.test(id)))]
      if (!ids.length || !payload.blocks.length) return
      await memory.remember(organizationId, ids, payload)
      if (!isDenTypeId("organization", organizationId)) return
      try {
        const { db } = await import("../db.js")
        const expiresAt = new Date(Date.now() + TTL_MS)
        const serialized = JSON.stringify(payload)
        for (const toolCallId of ids) {
          await db.insert(AutoRouterReasoningTable)
            .values({ organizationId, toolCallId, payload: serialized, expiresAt })
            .onDuplicateKeyUpdate({ set: { payload: serialized, expiresAt } })
        }
        // Expired rows are swept a little at a time by the writers.
        if (++writes % 50 === 0) {
          await db.delete(AutoRouterReasoningTable).where(lt(AutoRouterReasoningTable.expiresAt, new Date())).limit(500)
        }
      } catch (error) {
        console.warn("[gateway] Smart Model Router could not save reasoning state", error instanceof Error ? error.message : error)
      }
    },
  }
}
