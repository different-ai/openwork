// The Gateway's reasoning store: shared by every gateway instance through the
// database (auto_router_reasoning, encrypted), with the in-memory store from
// @openwork-ee/gateway-protocols in front so the common same-instance case
// skips a read.
import { and, eq, inArray, lt } from "@openwork-ee/den-db/drizzle"
import { AutoRouterReasoningTable } from "@openwork-ee/den-db"
import { createMemoryReasoningStore, isReasoningToolCallId, parseReasoningPayload, REASONING_TTL_MS, type ReasoningStore } from "@openwork-ee/gateway-protocols"
import { isDenTypeId } from "@openwork-ee/utils/typeid"

export function createDbReasoningStore(): ReasoningStore {
  const memory = createMemoryReasoningStore()
  let writes = 0
  return {
    async recall(organizationId, toolCallIds) {
      const ids = [...new Set(toolCallIds.filter(isReasoningToolCallId))]
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
          const payload = parseReasoningPayload(parsed)
          if (payload) found.set(row.toolCallId, payload)
        }
      } catch (error) {
        console.warn("[gateway] Smart Model Router could not read reasoning state", error instanceof Error ? error.message : error)
      }
      return found
    },
    async remember(organizationId, toolCallIds, payload) {
      const ids = [...new Set(toolCallIds.filter(isReasoningToolCallId))]
      if (!ids.length || !payload.blocks.length) return
      await memory.remember(organizationId, ids, payload)
      if (!isDenTypeId("organization", organizationId)) return
      try {
        const { db } = await import("../db.js")
        const expiresAt = new Date(Date.now() + REASONING_TTL_MS)
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
