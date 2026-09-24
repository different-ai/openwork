import type { McpServer } from "@modelcontextprotocol/server"
import type { McpUiToolMeta } from "@modelcontextprotocol/ext-apps"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { connectionActionAppHtml } from "@openwork/mcp-apps/connection-action"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { connectionActionAppResourceUri, connectionActionIntentSchema, connectionActionPayloadSchema } from "@openwork/types/connection-action-app"
import { getExternalMcpConnection } from "../capability-sources/external-mcp-connections.js"
import { probeExternalConnectionStatus } from "./external-capabilities.js"
import { connectedConnectionActionPayload, connectionActionPayloadFromStatus, connectionActionTextFallback } from "./connection-action.js"
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "./mcp-app-v2.js"

const inputSchema = z.object({ connectionId: z.string().trim().min(1).max(160) }).strict()
const intentInputSchema = inputSchema.extend({ action: z.enum(["authenticate", "skip"]) })
type Context = Omit<Parameters<typeof probeExternalConnectionStatus>[0], "connectionId">

export async function connectionActionToolResult(context: Context, input: z.infer<typeof inputSchema>, action?: "authenticate" | "skip"): Promise<CallToolResult> {
  const probe = await probeExternalConnectionStatus({ ...context, connectionId: input.connectionId })
  if (!probe.ok) return { isError: true, content: [{ type: "text", text: probe.message }] }
  const connection = probe.connected
    ? connectedConnectionActionPayload({ connectionId: probe.connection.id, connectionName: probe.connection.name })
    : connectionActionPayloadFromStatus(probe.status)
  if (action === "authenticate") {
    const source = await getExternalMcpConnection({
      organizationId: normalizeDenTypeId("organization", context.organizationId),
      connectionId: normalizeDenTypeId("externalMcpConnection", input.connectionId),
    })
    if (!source || source.authType !== "oauth" || source.credentialMode !== "per_member"
      || source.oauthIssuerReviewRequiredAt || (!probe.connected && (connection.actor !== "member"
        || !["connect", "reconnect"].includes(connection.action?.type ?? "")))) {
      return { isError: true, content: [{ type: "text", text: "This connection requires setup outside this App." }] }
    }
  }
  if (action) {
    const intent = connectionActionIntentSchema.parse({ schemaVersion: "1", kind: "connection_action_intent", action, connection })
    return { content: [{ type: "text", text: JSON.stringify(intent) }], structuredContent: intent }
  }
  return { content: [{ type: "text", text: connectionActionTextFallback(connection) }], structuredContent: connection }
}

export function registerAgentConnectionActionApp(server: McpServer, context: Context) {
  const meta: { ui: McpUiToolMeta } = { ui: { resourceUri: connectionActionAppResourceUri, visibility: ["app"] } }
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  registerAppTool(server, "connection_action", {
    title: "Connection", description: "App-only authorized live connection status.", inputSchema,
    outputSchema: connectionActionPayloadSchema, annotations, _meta: meta,
  }, async input => connectionActionToolResult(context, input))
  registerAppTool(server, "connection_action_intent", {
    title: "Connection action", description: "App-only validated member intent. Does not start OAuth or modify credentials.",
    inputSchema: intentInputSchema, outputSchema: connectionActionIntentSchema,
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: false }, _meta: meta,
  }, async input => connectionActionToolResult(context, input, input.action))
  const resourceMeta = { ui: { csp: { connectDomains: [], resourceDomains: ["https://cdn.simpleicons.org"], frameDomains: [], baseUriDomains: [] }, prefersBorder: true } }
  registerAppResource(server, "OpenWork Connection", connectionActionAppResourceUri, { _meta: resourceMeta }, async () => ({
    contents: [{ uri: connectionActionAppResourceUri, mimeType: RESOURCE_MIME_TYPE, text: connectionActionAppHtml, _meta: resourceMeta }],
  }))
}
