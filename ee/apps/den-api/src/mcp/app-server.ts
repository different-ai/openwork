import { startMcpAppTiming } from "@openwork/types/mcp-app-timing";
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
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { ConfigObjectTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  MCP_APP_LAUNCH_TOOL_NAME,
  mcpAppIdSchema,
  parseMcpAppResourceUri,
  type McpAppToolBinding,
} from "@openwork/types/mcp-app"
import type { Context, Hono } from "hono"
import { resolvePublicOrigin } from "../core/oauth/public-origin.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { appMcpServersEnabled } from "../mcp-app-rollout.js"
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

/**
 * Read-only tools, including connection tools their provider marks read-only,
 * advertise it so hosts can run them without a click. Den checks a connection
 * tool's label again on every call.
 */
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

/** A connection tool always needs mcp:write, whatever its label, because external dispatch requires it. */
function requiredScope(binding: McpAppToolBinding): string {
  return binding.readOnly && binding.kind !== "mcp" ? DEN_MCP_READ_SCOPE : DEN_MCP_WRITE_SCOPE
}

type AppRefusal = "not_a_member" | "other_organization" | "apps_off" | "not_found"

const REFUSAL_MESSAGES: Record<Exclude<AppRefusal, "other_organization">, string> = {
  not_a_member: "The App is not available: this connection is not signed in to an organization you belong to.",
  apps_off: "The App is not available: Apps built in OpenWork are turned off for this organization.",
  not_found: "The App is not available.",
}

/**
 * The organization an App belongs to, only when the user is also a member of
 * it, so a refusal can name it without revealing Apps in other organizations.
 */
async function appOrganizationForMember(appId: string, userId: string) {
  const [row] = await db.select({ id: OrganizationTable.id, name: OrganizationTable.name })
    .from(ConfigObjectTable)
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, ConfigObjectTable.organizationId))
    .innerJoin(MemberTable, and(eq(MemberTable.organizationId, ConfigObjectTable.organizationId), eq(MemberTable.userId, normalizeDenTypeId("user", userId))))
    .where(and(eq(ConfigObjectTable.id, normalizeDenTypeId("configObject", appId)), eq(ConfigObjectTable.objectType, "app"), isNull(ConfigObjectTable.deletedAt)))
    .limit(1)
  return row ?? null
}

/**
 * Logs why an App server refused a request and answers with the JSON-RPC error
 * every MCP client can show, as pass-through connections do.
 */
async function refuseAppRequest(request: Request, input: { reason: AppRefusal; organizationId: string; appId: string; organizationName?: string }): Promise<Response> {
  console.error("mcp_app_server_refused", { reason: input.reason, organizationId: input.organizationId, appId: input.appId })
  const message = input.reason === "other_organization"
    ? `This App belongs to ${input.organizationName ?? "another organization"}. Switch to ${input.organizationName ?? "that organization"} in OpenWork, then connect the App again.`
    : REFUSAL_MESSAGES[input.reason]
  return appUnavailableResponse(request, message, input.reason)
}

/**
 * A protocol-valid refusal for a member who cannot use this App, so every MCP
 * client sees the same JSON-RPC error rather than an HTTP failure.
 */
async function appUnavailableResponse(request: Request, message = REFUSAL_MESSAGES.not_found, reason: AppRefusal = "not_found"): Promise<Response> {
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
    error: { code: ErrorCode.InvalidRequest, message, data: { error: "mcp_app_not_found", reason } },
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
    const scope = requiredScope(binding)
    if (!input.scopes.has(scope)) return scopeError(binding.name, scope)
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
async function handleMcpAppServerRequestUntimed(input: {
  app: Hono
  context: Context
  principal: McpPrincipal
  appId: string
}) {
  const { context, principal } = input
  if (context.req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
  const organizationId = normalizeDenTypeId("organization", principal.organizationId)
  const refuse = (reason: AppRefusal, organizationName?: string) =>
    refuseAppRequest(context.req.raw, { reason, organizationId, appId: input.appId, organizationName })
  const [member, home, organization, catalog] = await Promise.all([
    resolveMcpMemberIdentity({ userId: principal.userId, organizationId }),
    appOrganizationForMember(input.appId, principal.userId),
    db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId)).limit(1),
    getCatalog(input.app, context.env),
  ])
  if (!member) return refuse("not_a_member")
  // A client authorized for one organization cannot reach an App built in another.
  if (home && home.id !== organizationId) return refuse("other_organization", home.name)
  // Building your own Apps is per-organization and default-off.
  if (!appMcpServersEnabled(organization[0]?.metadata)) return refuse("apps_off")
  const capabilityContext = createCapabilityRegistryContext({
    app: input.app,
    env: context.env,
    catalog,
    principal,
    organizationId,
    member,
    redirectUriBase: resolvePublicOrigin(context.req.raw, env.apiPublicUrl),
    generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
    organizationMetadata: organization[0]?.metadata,
  })
  const access = { organizationId, member, enabled: capabilityContext.externalMcpConnectionsEnabled, requestScope: {} }
  let definition: McpAppServerDefinition
  try {
    definition = await loadMcpAppServerDefinition({ ...access, appId: input.appId })
  } catch (error) {
    if (error instanceof McpAppError) return refuse("not_found")
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

export async function handleMcpAppServerRequest(input: Parameters<typeof handleMcpAppServerRequestUntimed>[0]) {
  if (process.env.OPENWORK_MCP_APP_TIMINGS !== "1") return handleMcpAppServerRequestUntimed(input)
  const body: unknown = await input.context.req.raw.clone().json().catch(() => null)
  const method = typeof body === "object" && body !== null && "method" in body && typeof body.method === "string" ? body.method : "other"
  const stage = ["initialize", "tools/list", "resources/read", "tools/call"].includes(method) ? method : "other"
  const finish = startMcpAppTiming(`den.app-server.${stage}`)
  try {
    const response = await handleMcpAppServerRequestUntimed(input)
    // Streamable HTTP returns its Response before a tool finishes. The profiling
    // copy observes completion without delaying or changing the client's stream.
    if (process.env.OPENWORK_MCP_APP_TIMINGS === "1" && response.body) {
      void response.clone().arrayBuffer().then(finish, finish)
    } else finish()
    return response
  } catch (cause) { finish(); throw cause }
}
