import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "./mcp-app-v2.js"
import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps"
import type { McpServer } from "@modelcontextprotocol/server"
import { connectionActionAppHtml } from "@openwork/mcp-apps/connection-action"
import {
  connectionActionAppResourceUri,
  connectionActionAppSchemaVersion,
  connectionActionPayloadSchema,
  connectionActionToolName,
  type ConnectionActionPayload,
} from "@openwork/types/connection-action-app"
import { z } from "zod"
import type { ExternalConnectionStatus } from "./external-capabilities.js"

export { connectionActionPayloadSchema } from "@openwork/types/connection-action-app"

export const CONNECTION_ACTION_APP_RESOURCE_URI = connectionActionAppResourceUri
export const CONNECTION_ACTION_TOOL_NAME = connectionActionToolName
export const CONNECTION_ACTION_APP_HTML = connectionActionAppHtml

export type ConnectionActionProbeResult =
  | { ok: true; payload: ConnectionActionPayload }
  | { ok: false; error: string; message: string }

const connectionActionAppResourceMeta: { ui: McpUiResourceMeta } = {
  ui: {
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
    prefersBorder: true,
  },
}

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

/**
 * The same-server MCP App launch reference for one connection status result.
 * Attached as `_meta["openwork/mcpApp"]` (no connectionId, so OpenWork hosts
 * resolve the app tool and ui:// resource from this same gateway).
 */
export function connectionActionLaunch(payload: ConnectionActionPayload) {
  return {
    toolName: CONNECTION_ACTION_TOOL_NAME,
    resourceUri: CONNECTION_ACTION_APP_RESOURCE_URI,
    arguments: { connectionId: payload.connectionId },
  }
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
  return {
    connectionAction: payload,
    meta: { "openwork/mcpApp": connectionActionLaunch(payload) },
  }
}

/**
 * Card attachment for connection-level tool failures: the same first-party
 * connection card as the status probe, so hosts that render apps for failed
 * results can show the exact human action inline.
 */
export function connectionActionErrorCard(status: ExternalConnectionStatus): {
  structuredContent: Record<string, unknown>
  meta: Record<string, unknown>
} {
  const payload = connectionActionPayloadFromStatus(status)
  return {
    structuredContent: { ...payload },
    meta: { "openwork/mcpApp": connectionActionLaunch(payload) },
  }
}

export function registerAgentConnectionActionApp(input: {
  server: McpServer
  probe: (request: { connectionId: string }) => Promise<ConnectionActionProbeResult>
}) {
  registerAgentConnectionActionResource(input.server)
  registerAppTool(
    input.server,
    CONNECTION_ACTION_TOOL_NAME,
    {
      title: "Connection action",
      description: [
        "Report the live status of one Connect connection and the exact human action that unblocks it.",
        "App-only companion to connection_status capability results; it backs the connection-action card rendered in compatible hosts.",
      ].join(" "),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        connectionId: z.string().trim().min(1).max(160).describe("The Connect connection id to probe."),
      }),
      outputSchema: connectionActionPayloadSchema,
      _meta: {
        ui: {
          resourceUri: CONNECTION_ACTION_APP_RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async ({ connectionId }) => {
      const result = await input.probe({ connectionId })
      if (!result.ok) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: result.error, message: result.message }),
          }],
        }
      }
      return {
        content: [{ type: "text" as const, text: connectionActionTextFallback(result.payload) }],
        structuredContent: result.payload,
      }
    },
  )
}

export function registerAgentConnectionActionResource(server: McpServer) {
  registerAppResource(
    server,
    "OpenWork Connection Action",
    CONNECTION_ACTION_APP_RESOURCE_URI,
    {
      description: "An actionable status card for one Connect connection: who acts, where, and the exact next step.",
      _meta: connectionActionAppResourceMeta,
    },
    async () => ({
      contents: [{
        uri: CONNECTION_ACTION_APP_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: CONNECTION_ACTION_APP_HTML,
        _meta: connectionActionAppResourceMeta,
      }],
    }),
  )
}
