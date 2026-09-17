import { connectionActionPayloadSchema } from "@openwork/types/connection-action-app"
import { z } from "zod"

const failureSchema = z.object({
  connectionStatus: z.record(z.string(), z.unknown()).optional(),
  connectionCard: connectionActionPayloadSchema.optional(),
})

export function workflowConnectionError(message: string) {
  const start = message.indexOf("{")
  const end = message.lastIndexOf("}")
  if (start < 0 || end < start) return {}
  try {
    const parsed = failureSchema.safeParse(JSON.parse(message.slice(start, end + 1)))
    if (!parsed.success) return {}
    const status = parsed.data.connectionStatus
    const card = parsed.data.connectionCard ?? connectionActionPayloadSchema.safeParse({
      ...status, schemaVersion: "1",
    }).data
    return {
      ...(status ? { connectionStatus: status } : {}),
      ...(card ? { connectionCard: card } : {}),
    }
  } catch {
    return {}
  }
}
