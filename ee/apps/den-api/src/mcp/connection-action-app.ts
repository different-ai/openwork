import type { McpServer } from "@modelcontextprotocol/server"
import type { McpUiResourceMeta, McpUiToolMeta } from "@modelcontextprotocol/ext-apps"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { connectionActionAppHtml } from "@openwork/mcp-apps/connection-action"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { connectionActionAppResourceUri, connectionActionIntentSchema, connectionActionPayloadSchema } from "@openwork/types/connection-action-app"
import { getExternalMcpConnection } from "../capability-sources/external-mcp-connections.js"
import { probeExternalConnectionStatus } from "./external-capabilities.js"
import { connectedConnectionActionPayload, connectionActionPayloadFromStatus, connectionActionTextFallback } from "./connection-action.js"
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "./mcp-app-v2.js"
import { OPENWORK_MCP_APP_DOMAIN } from "./mcp-app-metadata.js"

const inputSchema = z.object({
  connectionId: z.string().trim().min(1).max(160).describe("The external MCP connection ID from a connection status result, not a provider name or capability ID. The current member must have access to it."),
}).strict()
const intentInputSchema = inputSchema.extend({
  action: z.enum(["authenticate", "skip"]).describe("The member's choice in the connection App: authenticate validates eligibility for per-member OAuth; skip returns a skip intent. Neither choice starts OAuth, changes credentials, or saves a preference."),
})
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
    title: "Check connection status",
    description: "App-only: check the current member's authorized external MCP connection and stored credential readiness. Returns structured connectionId, connectionName, state, responsible actor, message, and suggested action, plus a text fallback. Does not contact the provider, start OAuth, or change credentials. Errors return text with isError.",
    inputSchema,
    outputSchema: connectionActionPayloadSchema.describe("Connection readiness with a state, responsible actor, and suggested setup action; also returned as readable text."),
    annotations,
    _meta: { ...meta, "openai/toolInvocation": { invoking: "Check connection", invoked: "Show connection status" }, "openai/toolInvocation/invoking": "Check connection", "openai/toolInvocation/invoked": "Show connection status" },
  }, async input => connectionActionToolResult(context, input))
  registerAppTool(server, "connection_action_intent", {
    title: "Validate connection choice",
    description: "App-only: validate the member's authenticate or skip choice against current authorized connection readiness. Authenticate requires an eligible per-member OAuth connection; unsupported setup returns an error. Returns a structured connection_action_intent with action and connection status, also serialized as text. Does not start OAuth, change credentials, or persist the choice. Errors return text with isError.",
    inputSchema: intentInputSchema,
    outputSchema: connectionActionIntentSchema.describe("Validated connection_action_intent containing the member's action and current connection status; also returned as JSON text."),
    annotations,
    _meta: { ...meta, "openai/toolInvocation": { invoking: "Validate connection choice", invoked: "Show connection choice" }, "openai/toolInvocation/invoking": "Validate connection choice", "openai/toolInvocation/invoked": "Show connection choice" },
  }, async input => connectionActionToolResult(context, input, input.action))
  const resourceMeta: { ui: McpUiResourceMeta; "openai/widgetDescription": string } = {
    ui: {
      domain: OPENWORK_MCP_APP_DOMAIN,
      csp: { connectDomains: [], resourceDomains: ["https://cdn.simpleicons.org"], frameDomains: [], baseUriDomains: [] },
      prefersBorder: true,
    },
    "openai/widgetDescription": "Shows connection readiness, who can resolve a setup issue, and the member's sign-in or skip choice.",
  }
  registerAppResource(server, "OpenWork Connection", connectionActionAppResourceUri, {
    description: "Connection readiness and member sign-in choices for an authorized external MCP connection.",
    _meta: resourceMeta,
  }, async () => ({
    contents: [{ uri: connectionActionAppResourceUri, mimeType: RESOURCE_MIME_TYPE, text: connectionActionAppHtml, _meta: resourceMeta }],
  }))
}
