import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  MCP_APP_LAUNCH_TOOL_NAME,
  mcpAppIdSchema,
  parseMcpAppResourceUri,
  type McpAppToolBinding,
} from "@openwork/types/mcp-app"
import type { Context, Hono } from "hono"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { db } from "../db.js"
import { env } from "../env.js"
import {
  loadMcpAppResource,
  loadMcpAppServerDefinition,
  McpAppError,
  type McpAppResource,
  type McpAppServerDefinition,
} from "../mcp-apps.js"
import { executeCapabilityWithBudget } from "./agent.js"
import { callMcpAppTool } from "./app-tools.js"
import type { McpPrincipal } from "./auth.js"
import { createCapabilityRegistryContext, type ExecuteCapabilityToolResult } from "./capability-registry.js"
import { resolveMcpMemberIdentity } from "./external-capabilities.js"
import { getCatalog } from "./index.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"

/** App servers share the connection endpoint path; their ids are App config objects. */
export function isMcpAppServerId(value: string): boolean {
  return mcpAppIdSchema.safeParse(value).success
}

const launchInputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    input: {
      type: "object",
      additionalProperties: true,
      description: "Optional JSON launch input the App receives. Opening runs no other tools.",
    },
  },
  additionalProperties: false,
}

function scopeError(name: string, scope: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: "insufficient_mcp_scope", requiredScope: scope, message: `${name} requires the ${scope} scope.` }) }],
  }
}

function launchTool(definition: McpAppServerDefinition): Tool {
  const { app } = definition
  return {
    name: MCP_APP_LAUNCH_TOOL_NAME,
    title: `Open ${app.title}`,
    description: `Open ${app.title}.${app.description ? ` ${app.description}` : ""} Returns its launch input and a readable summary; opening runs no other tools.`,
    inputSchema: launchInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: app.resourceUri, visibility: ["model", "app"] }, "ui/resourceUri": app.resourceUri },
  }
}

function boundTool(binding: McpAppToolBinding): Tool {
  return {
    name: binding.name,
    description: binding.description,
    inputSchema: { ...binding.inputSchema, type: "object" },
    annotations: {
      readOnlyHint: binding.readOnly,
      destructiveHint: !binding.readOnly,
      idempotentHint: binding.readOnly,
      openWorldHint: binding.kind !== "api",
    },
    _meta: { ui: { visibility: ["model", "app"] } },
  }
}

/**
 * A protocol-valid refusal for a member who cannot use this App, so every MCP
 * client sees the same JSON-RPC error rather than an HTTP failure.
 */
async function appUnavailableResponse(request: Request): Promise<Response> {
  let id: string | number | null = null
  try {
    const body: unknown = await request.clone().json()
    if (typeof body === "object" && body !== null && "id" in body && (typeof body.id === "string" || typeof body.id === "number")) id = body.id
  } catch {
    // Preflight already rejected malformed JSON; a missing id uses null.
  }
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: ErrorCode.InvalidRequest, message: "The App is not available.", data: { error: "mcp_app_not_found" } },
  }), { status: 200, headers: { "content-type": "application/json" } })
}

function toolArguments(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

/**
 * One App as a standalone standard MCP server: its launch tool bound to the
 * current immutable ui:// revision, the tools it declared, and its revision
 * resources. It exposes nothing else from OpenWork Connect.
 */
export function createMcpAppServer(input: {
  definition: McpAppServerDefinition
  scopes: ReadonlySet<string>
  loadResource: (revision: { appId: string; revisionId: string }) => Promise<McpAppResource>
  callTool: (binding: McpAppToolBinding, args: Record<string, unknown>) => Promise<ExecuteCapabilityToolResult>
}) {
  const { app, tools } = input.definition
  const server = new McpServer({ name: app.title, version: "1.0.0" }, {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
    },
    instructions: `This is the ${app.title} App from OpenWork. Call ${MCP_APP_LAUNCH_TOOL_NAME} to open it. Its other tools run as you, with your own OpenWork access and connections.`,
  })

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [launchTool(input.definition), ...tools.map(boundTool)],
  }))
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = toolArguments(request.params.arguments)
    if (request.params.name === MCP_APP_LAUNCH_TOOL_NAME) {
      if (!input.scopes.has(DEN_MCP_READ_SCOPE)) return scopeError(MCP_APP_LAUNCH_TOOL_NAME, DEN_MCP_READ_SCOPE)
      return {
        content: [{ type: "text", text: app.textFallback }],
        structuredContent: { app, input: toolArguments(args.input) },
      }
    }
    const binding = tools.find((tool) => tool.name === request.params.name)
    if (!binding) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} is not available on ${app.title}.`)
    const requiredScope = binding.readOnly ? DEN_MCP_READ_SCOPE : DEN_MCP_WRITE_SCOPE
    if (!input.scopes.has(requiredScope)) return scopeError(binding.name, requiredScope)
    return input.callTool(binding, args)
  })

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: app.resourceUri, name: app.title, mimeType: RESOURCE_MIME_TYPE, ...(app.description ? { description: app.description } : {}) }],
  }))
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }))
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const revision = parseMcpAppResourceUri(request.params.uri)
    if (!revision || revision.appId !== app.appId || !input.scopes.has(DEN_MCP_READ_SCOPE)) {
      throw new McpError(ErrorCode.InvalidRequest, "The resource is not an available revision of this App.", { error: "mcp_app_not_found" })
    }
    let resource: McpAppResource
    try {
      resource = await input.loadResource(revision)
    } catch (error) {
      throw new McpError(ErrorCode.InvalidRequest, "The resource is not an available revision of this App.", {
        error: error instanceof McpAppError ? error.code : "mcp_app_unavailable",
      })
    }
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: RESOURCE_MIME_TYPE,
        text: resource.html,
        _meta: { ui: { csp: resource.csp, prefersBorder: true }, resourceDigest: resource.resourceDigest },
      }],
    }
  })

  return server
}

/**
 * Serves one App's MCP server for a verified member request. Access to the App
 * is rechecked on every request through its Plugin, and every bound tool runs
 * with the caller's own capability context.
 */
export async function handleMcpAppServerRequest(input: {
  app: Hono
  context: Context
  principal: McpPrincipal
  appId: string
}) {
  const { context, principal } = input
  if (context.req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
  const organizationId = normalizeDenTypeId("organization", principal.organizationId)
  const member = await resolveMcpMemberIdentity({ userId: principal.userId, organizationId })
  if (!member) return appUnavailableResponse(context.req.raw)
  const organization = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId)).limit(1)
  const capabilityContext = createCapabilityRegistryContext({
    app: input.app,
    env: context.env,
    catalog: await getCatalog(input.app, context.env),
    principal,
    organizationId,
    member,
    redirectUriBase: resolvePublicOrigin(context.req.raw, env.apiPublicUrl),
    generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
    organizationMetadata: organization[0]?.metadata,
    mcpConnectionsGatingEnabled: env.mcpConnectionsGatingEnabled,
  })
  const access = { organizationId, member, enabled: capabilityContext.externalMcpConnectionsEnabled }
  let definition: McpAppServerDefinition
  try {
    definition = await loadMcpAppServerDefinition({ ...access, appId: input.appId })
  } catch (error) {
    if (error instanceof McpAppError) return appUnavailableResponse(context.req.raw)
    throw error
  }
  const server = createMcpAppServer({
    definition,
    scopes: principal.scopes,
    loadResource: (revision) => loadMcpAppResource({ ...access, ...revision }),
    callTool: (binding, args) => executeCapabilityWithBudget({
      capability: binding.capability,
      invoke: () => callMcpAppTool(capabilityContext, binding, args),
    }),
  })
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  return await transport.handleRequest(context) ?? new Response(null, { status: 204 })
}
