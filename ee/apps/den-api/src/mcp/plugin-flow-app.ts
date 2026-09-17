import type { McpServer } from "@modelcontextprotocol/server"
import { legacyConfirmationAppHtml } from "@openwork/mcp-apps/legacy-confirmation"
import { pluginFlowAppSchemaVersion, pluginFlowPayloadSchema, type PluginFlowPayload } from "@openwork/types/plugin-flow-app"
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "./mcp-app-v2.js"

export const PLUGIN_FLOW_APP_RESOURCE_URI = "ui://openwork/plugin-flow/v1/view.html"
export const PLUGIN_FLOW_TOOL_NAME = "plugin_flow"
export const PLUGIN_FLOW_APP_HTML = legacyConfirmationAppHtml

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

export function pluginFlowPayloadForCapability(input: {
  name: string
  path: Record<string, unknown>
  body: Record<string, unknown>
}): PluginFlowPayload | null {
  if (input.name === "postMarketplacesPlugins") {
    return pluginFlowPayloadSchema.parse({
      schemaVersion: pluginFlowAppSchemaVersion,
      mode: "marketplace_plugin_added",
      pluginId: stringField(input.body.pluginId),
      marketplaceId: stringField(input.path.marketplaceId),
      recipient: null,
    })
  }
  if (input.name === "postPluginsAccess") {
    return pluginFlowPayloadSchema.parse({
      schemaVersion: pluginFlowAppSchemaVersion,
      mode: "plugin_access_granted",
      pluginId: stringField(input.path.pluginId),
      marketplaceId: null,
      recipient: pluginFlowRecipient(input.body),
    })
  }
  if (input.name === "postMarketplacesAccess") {
    return pluginFlowPayloadSchema.parse({
      schemaVersion: pluginFlowAppSchemaVersion,
      mode: "marketplace_access_granted",
      pluginId: null,
      marketplaceId: stringField(input.path.marketplaceId),
      recipient: pluginFlowRecipient(input.body),
    })
  }
  return null
}

function pluginFlowRecipient(body: Record<string, unknown>): PluginFlowPayload["recipient"] {
  const role = stringField(body.role)
  const orgMembershipId = stringField(body.orgMembershipId)
  if (orgMembershipId) return { kind: "member", id: orgMembershipId, role }
  const teamId = stringField(body.teamId)
  if (teamId) return { kind: "team", id: teamId, role }
  if (body.orgWide === true) return { kind: "org_wide", id: null, role }
  return null
}

export function attachPluginFlowCard<Result extends {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}>(input: {
  name: string
  path: unknown
  body: unknown
  result: Result
}): Result {
  if (input.result.isError === true) return input.result
  const payload = pluginFlowPayloadForCapability({
    name: input.name,
    path: isRecord(input.path) ? input.path : {},
    body: isRecord(input.body) ? input.body : {},
  })
  if (!payload) return input.result
  return {
    ...input.result,
    structuredContent: { ...payload },
    _meta: {
      ...(input.result._meta ?? {}),
      "openwork/mcpApp": {
        toolName: PLUGIN_FLOW_TOOL_NAME,
        resourceUri: PLUGIN_FLOW_APP_RESOURCE_URI,
        arguments: { mode: payload.mode },
      },
    },
  }
}

export function registerAgentPluginFlowApp(server: McpServer) {
  registerAgentPluginFlowResource(server)
  registerAppTool(server, PLUGIN_FLOW_TOOL_NAME, {
    title: "Legacy sharing result",
    description: "App-only compatibility formatter for legacy sharing confirmations. Does not grant access; modern clients suppress this presentation.",
    inputSchema: pluginFlowPayloadSchema,
    outputSchema: pluginFlowPayloadSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: PLUGIN_FLOW_APP_RESOURCE_URI, visibility: ["app"] } },
  }, async (input) => {
    const payload = pluginFlowPayloadSchema.parse(input)
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }
  })
}

export function registerAgentPluginFlowResource(server: McpServer) {
  const meta = { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true } }
  registerAppResource(server, "OpenWork Plugin Flow", PLUGIN_FLOW_APP_RESOURCE_URI, {
    description: "Read-only legacy sharing result renderer.",
    _meta: meta,
  }, async () => ({ contents: [{ uri: PLUGIN_FLOW_APP_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: PLUGIN_FLOW_APP_HTML, _meta: meta }] }))
}
