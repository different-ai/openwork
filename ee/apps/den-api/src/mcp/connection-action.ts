import {
  connectionActionAppSchemaVersion,
  connectionActionPayloadSchema,
  type ConnectionActionPayload,
} from "@openwork/types/connection-action-app"
import type { ExternalConnectionStatus } from "./external-capabilities.js"

export { connectionActionPayloadSchema } from "@openwork/types/connection-action-app"

export function connectionActionPayloadFromStatus(status: ExternalConnectionStatus): ConnectionActionPayload {
  return connectionActionPayloadSchema.parse({
    schemaVersion: connectionActionAppSchemaVersion,
    connectionId: status.connectionId,
    connectionName: status.connectionName,
    state: status.state,
    actor: status.actor,
    message: status.message,
    action: {
      type: status.action.type,
      label: status.action.label,
      surface: status.action.surface,
      ...(status.action.url ? { url: status.action.url } : {}),
    },
  })
}

export function connectedConnectionActionPayload(input: {
  connectionId: string
  connectionName: string
}): ConnectionActionPayload {
  return connectionActionPayloadSchema.parse({
    schemaVersion: connectionActionAppSchemaVersion,
    connectionId: input.connectionId,
    connectionName: input.connectionName,
    state: "connected",
    actor: null,
    message: `"${input.connectionName}" is connected and its tools are available in this chat.`,
    action: null,
  })
}

export function connectionActionTextFallback(payload: ConnectionActionPayload): string {
  return [
    payload.state === "connected"
      ? `# Connection ready: ${payload.connectionName}`
      : `# Connection needs attention: ${payload.connectionName}`,
    payload.message,
    payload.action ? `Action: ${payload.action.label}` : null,
    payload.action?.url ? `Open: ${payload.action.url}` : null,
    "After the connection is fixed, call search_capabilities again.",
  ].filter((line): line is string => line !== null).join("\n")
}

/** Attach one unambiguous connection card directly to discovery. */
export function connectionActionSearchCard(matches: readonly { kind?: string }[]) {
  const targets = new Map<string, ConnectionActionPayload>()
  for (const match of matches) {
    if (match.kind !== "connection_status" || !("connectionStatus" in match)) continue
    const status = match.connectionStatus
    if (typeof status !== "object" || status === null) continue
    const parsed = connectionActionPayloadSchema.safeParse({
      ...status,
      schemaVersion: connectionActionAppSchemaVersion,
    })
    if (parsed.success) targets.set(parsed.data.connectionId, parsed.data)
  }
  if (targets.size !== 1) return null
  const [payload] = targets.values()
  return payload
}
