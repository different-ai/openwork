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
} from "@modelcontextprotocol/sdk/types.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Context, Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import {
  getExternalMcpConnection,
  memberCanUseExternalMcpConnection,
  type ExternalMcpConnectionRow,
} from "../capability-sources/external-mcp-connections.js"
import {
  callExternalMcpToolRaw,
  describeExternalMcpServer,
  listExternalMcpResources,
  listExternalMcpResourceTemplates,
  listExternalMcpTools,
  readExternalMcpResource,
} from "../capability-sources/external-mcp-client-runtime.js"
import { externalMcpDiagnosticForResponse } from "../capability-sources/external-mcp-diagnostics.js"
import { memberFacingMcpConnectionsEnabled } from "../capability-sources/external-mcp-rollout.js"
import { evaluateToolPolicy } from "../capability-sources/external-mcp-tool-policy.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { tokenRoute } from "../middleware/index.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { getMcpResourceContext, verifyMcpRequest } from "./auth.js"
import { externalMcpAppResourceUri, resolveMcpMemberIdentity } from "./external-capabilities.js"
import { externalMcpToolSchemaDigest } from "./external-mcp-tool-arguments.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { EXECUTE_CAPABILITY_TOOL_NAME, scoreText, SEARCH_CAPABILITIES_TOOL_NAME, tokenize } from "./search.js"
import { DEN_MCP_APP_HOST_SCOPE } from "./scopes.js"

function toolArguments(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type ExternalMcpResourceOperation = Parameters<typeof describeExternalMcpServer>[0]
type ExternalMcpProxyOperation = ExternalMcpResourceOperation & {
  connection: ExternalMcpConnectionRow
  member: NonNullable<ExternalMcpResourceOperation["member"]>
  diagnosticReferenceId: string
}

type ExternalMcpProxyDescriptor = Awaited<ReturnType<typeof describeExternalMcpServer>>
type ExternalMcpProxyTool = Awaited<ReturnType<typeof listExternalMcpTools>>[number]

type ExternalMcpProxyRuntime = {
  callTool: typeof callExternalMcpToolRaw
  listResources: typeof listExternalMcpResources
  listResourceTemplates: typeof listExternalMcpResourceTemplates
  listTools: typeof listExternalMcpTools
  readResource: typeof readExternalMcpResource
}

const externalMcpProxyRuntime: ExternalMcpProxyRuntime = {
  callTool: callExternalMcpToolRaw,
  listResources: listExternalMcpResources,
  listResourceTemplates: listExternalMcpResourceTemplates,
  listTools: listExternalMcpTools,
  readResource: readExternalMcpResource,
}

const PROXY_GATEWAY_TOOL_NAMES = new Set([SEARCH_CAPABILITIES_TOOL_NAME, EXECUTE_CAPABILITY_TOOL_NAME])

const boundedGatewayTools: ExternalMcpProxyTool[] = [
  {
    name: SEARCH_CAPABILITIES_TOOL_NAME,
    title: "Search capabilities",
    description: "Search the ordinary tools on this connected MCP server without exposing its full catalog to the client.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: EXECUTE_CAPABILITY_TOOL_NAME,
    title: "Execute capability",
    description: "Execute an exact tool returned by search_capabilities on this connected MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        body: { type: "object" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
]

const appGatewayTools: ExternalMcpProxyTool[] = boundedGatewayTools.map((tool) => ({
  ...tool,
  _meta: { ui: { visibility: ["app"] } },
}))

/**
 * A provider tool the model may see on a directly exposed connection. Tools
 * that declare an app-only UI visibility stay private to the App host.
 */
function toolVisibleToModel(tool: ExternalMcpProxyTool): boolean {
  const meta = isRecord(tool._meta) ? tool._meta : {}
  const ui = isRecord(meta.ui) ? meta.ui : {}
  if (ui.visibility === undefined) return true
  return Array.isArray(ui.visibility) && ui.visibility.includes("model")
}

function toolVisibleToApp(tool: ExternalMcpProxyTool): boolean {
  const meta = isRecord(tool._meta) ? tool._meta : {}
  const ui = isRecord(meta.ui) ? meta.ui : {}
  if (ui.visibility === undefined) return true
  return Array.isArray(ui.visibility)
    && ui.visibility.every((entry) => entry === "model" || entry === "app")
    && ui.visibility.includes("app")
}

function appOnlyProxyTool(tool: ExternalMcpProxyTool): ExternalMcpProxyTool | null {
  const resourceUri = externalMcpAppResourceUri(tool)
  if (!resourceUri || !toolVisibleToApp(tool)) return null
  const meta = isRecord(tool._meta) ? tool._meta : {}
  const ui = isRecord(meta.ui) ? meta.ui : {}
  return {
    ...tool,
    _meta: {
      ...meta,
      ui: {
        ...ui,
        resourceUri,
        visibility: ["app"],
      },
    },
  }
}


export function createExternalConnectionProxyServer(input: {
  descriptor: ExternalMcpProxyDescriptor
  operation: ExternalMcpProxyOperation
  runtime?: ExternalMcpProxyRuntime
  appHostClient?: boolean
  /**
   * Whether the organization currently allows member-facing MCP connections.
   * Direct exposure is fail-closed: the provider catalog is served only when
   * the caller explicitly confirms the organization flag is on.
   */
  directExposureEnabled?: boolean
}) {
  const { connection } = input.operation
  const runtime = input.runtime ?? externalMcpProxyRuntime
  // An administrator opted this connection into direct exposure: ordinary MCP
  // clients receive the provider's own catalog instead of the bounded
  // search/execute pair. The App host keeps its private app-only surface.
  const directClient = connection.exposeDirectly
    && input.directExposureEnabled === true
    && input.appHostClient !== true
  const downstreamUi = input.descriptor.capabilities.extensions?.[EXTENSION_ID]
  const listProviderTools = async () => {
    if (!input.descriptor.capabilities.tools) return []
    return (await runtime.listTools(
      connection,
      input.operation.redirectUri,
      input.operation.member,
      input.operation.diagnosticReferenceId,
    )).filter((tool) => (
      !PROXY_GATEWAY_TOOL_NAMES.has(tool.name)
      && !evaluateToolPolicy(connection.toolPolicy, tool.name).blocked
    ))
  }
  const listDirectTools = async () => (await listProviderTools()).filter(toolVisibleToModel)
  const listAppTools = async () => (
    await listProviderTools()
  ).flatMap((tool) => {
    const appTool = appOnlyProxyTool(tool)
    return appTool ? [appTool] : []
  })
  const appResourceUris = async () => new Set(
    (await listAppTools()).map((tool) => externalMcpAppResourceUri(tool)).filter((uri) => uri !== null),
  )
  const server = new McpServer(input.descriptor.serverInfo ?? {
    name: connection.name,
    version: "1.0.0",
  }, {
    capabilities: {
      ...(input.descriptor.capabilities.tools ? { tools: { listChanged: false } } : {}),
      ...(input.descriptor.capabilities.resources ? { resources: { listChanged: false, subscribe: false } } : {}),
      ...(downstreamUi ? { extensions: { [EXTENSION_ID]: downstreamUi } } : {}),
    },
    instructions: input.appHostClient
      ? `This member-authorized OpenWork Connect endpoint exposes only app-visible MCP App tools and their bound resources for ${connection.name}. Ordinary provider capabilities remain available exclusively through search_capabilities and execute_capability.`
      : directClient
        ? `This member-authorized OpenWork Connect endpoint exposes the tools of ${connection.name} directly, subject to your organization's access grants and tool policy. Resources are not exposed.`
        : `This compatibility endpoint exposes only bounded search_capabilities and execute_capability for ${connection.name}. Direct provider tools, MCP App launch tools, and resources are not exposed.`,
  })

  if (input.descriptor.capabilities.tools) {
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: input.appHostClient
        ? [...appGatewayTools, ...await listAppTools()]
        : directClient
          ? await listDirectTools()
          : boundedGatewayTools,
    }))
    server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = toolArguments(request.params.arguments)
      if (directClient) {
        const allowed = (await listDirectTools()).some((tool) => tool.name === request.params.name)
        if (!allowed) {
          throw new McpError(ErrorCode.InvalidRequest, `Tool ${request.params.name} is not available on ${connection.name}.`)
        }
        return runtime.callTool({
          ...input.operation,
          toolName: request.params.name,
          args,
        })
      }
      if (request.params.name === SEARCH_CAPABILITIES_TOOL_NAME) {
        const query = typeof args.query === "string" ? args.query.trim() : ""
        if (!query) throw new McpError(ErrorCode.InvalidParams, "search_capabilities requires a non-empty query.")
        const requestedLimit = typeof args.limit === "number" && Number.isInteger(args.limit) ? args.limit : 5
        const limit = Math.max(1, Math.min(20, requestedLimit))
        const queryTokens = tokenize(query)
        const matches = (await listProviderTools()).flatMap((tool) => {
          const summary = tool.description ?? tool.title ?? tool.name
          const score = scoreText(tokenize(tool.name), tokenize(summary), queryTokens)
          if (score <= 0) return []
          const resourceUri = input.appHostClient ? externalMcpAppResourceUri(tool) : null
          return [{
            name: tool.name,
            method: "MCP",
            path: connection.name,
            score,
            summary,
            pathParams: [],
            queryParams: [],
            hasBody: true,
            argumentsSchema: tool.inputSchema,
            schemaDigest: externalMcpToolSchemaDigest(tool.inputSchema),
            invocation: { argumentsField: "body" },
            ...(resourceUri ? { kind: "mcp_app", mcpApp: { resourceUri } } : {}),
          }]
        }).sort((left, right) => (right.score - left.score) || left.name.localeCompare(right.name)).slice(0, limit)
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ matches }) }],
          structuredContent: { matches },
        }
      }
      if (request.params.name === EXECUTE_CAPABILITY_TOOL_NAME) {
        const toolName = typeof args.name === "string" ? args.name.trim() : ""
        const tool = (await listProviderTools()).find((candidate) => candidate.name === toolName)
        if (!tool) throw new McpError(ErrorCode.InvalidRequest, "The capability is unavailable. Call search_capabilities again.")
        return runtime.callTool({
          ...input.operation,
          toolName,
          args: toolArguments(args.body),
        })
      }
      if (!input.appHostClient) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Direct provider tool ${request.params.name} is unavailable. Use search_capabilities and execute_capability.`,
        )
      }
      const allowed = (await listAppTools()).some((tool) => tool.name === request.params.name)
      if (!allowed) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool ${request.params.name} is not available on the MCP Apps endpoint. Use search_capabilities and execute_capability.`,
        )
      }
      return runtime.callTool({
        ...input.operation,
        toolName: request.params.name,
        args,
      })
    })
  }

  if (input.descriptor.capabilities.resources) {
    server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      if (!input.appHostClient) return { resources: [] }
      const allowedUris = await appResourceUris()
      return { resources: (await runtime.listResources(input.operation)).filter((resource) => allowedUris.has(resource.uri)) }
    })
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }))
    server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (!input.appHostClient) {
        throw new McpError(ErrorCode.InvalidRequest, "Provider MCP App resources are available only through the OpenWork App host.")
      }
      if (!(await appResourceUris()).has(request.params.uri)) {
        throw new McpError(ErrorCode.InvalidRequest, "The resource is not bound to an available MCP App tool.")
      }
      return runtime.readResource({ ...input.operation, uri: request.params.uri })
    })
  }

  return server
}

async function jsonRpcRequestId(request: Request): Promise<string | number | null> {
  try {
    const value: unknown = await request.clone().json()
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const id = (value as { id?: unknown }).id
      if (typeof id === "string" || typeof id === "number") return id
    }
  } catch {
    // Preflight owns invalid JSON. A downstream failure without a readable id
    // still uses the protocol-defined null error id.
  }
  return null
}

export async function externalMcpProxyProtocolErrorResponse(
  request: Request,
  error: unknown,
  referenceId: string,
) {
  const diagnostic = externalMcpDiagnosticForResponse(error, referenceId, "MCP_INITIALIZE")
  console.error("external_mcp_proxy_initialization_failed", {
    referenceId: diagnostic.referenceId,
    phase: diagnostic.phase,
    code: diagnostic.code,
    retryable: diagnostic.retryable,
    actionOwner: diagnostic.actionOwner,
  })
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: await jsonRpcRequestId(request),
    error: {
      code: ErrorCode.InternalError,
      message: "The connected MCP server is not ready.",
      data: {
        error: "mcp_connection_unavailable",
        referenceId: diagnostic.referenceId,
        diagnosticCode: diagnostic.code,
        phase: diagnostic.phase,
        retryable: diagnostic.retryable,
        actionOwner: diagnostic.actionOwner,
        guidance: `${diagnostic.message} ${diagnostic.operatorAction}`,
      },
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

type ExternalMcpProxyRequestDependencies = {
  describe: typeof describeExternalMcpServer
  serve: (server: McpServer, context: Context) => Promise<Response | undefined>
}

const externalMcpProxyRequestDependencies: ExternalMcpProxyRequestDependencies = {
  describe: describeExternalMcpServer,
  serve: async (server, context) => {
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return transport.handleRequest(context)
  },
}

export async function handleExternalConnectionProxyRequest(input: {
  context: Context
  operation: ExternalMcpProxyOperation
  appHostClient?: boolean
  directExposureEnabled?: boolean
  runtime?: ExternalMcpProxyRuntime
  dependencies?: Partial<ExternalMcpProxyRequestDependencies>
}) {
  if (input.context.req.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } })
  }
  const dependencies = { ...externalMcpProxyRequestDependencies, ...input.dependencies }
  try {
    const descriptor = await dependencies.describe(input.operation)
    const server = createExternalConnectionProxyServer({
      descriptor,
      operation: input.operation,
      runtime: input.runtime,
      appHostClient: input.appHostClient === true,
      directExposureEnabled: input.directExposureEnabled === true,
    })
    const response = await dependencies.serve(server, input.context)
    return response ?? new Response(null, { status: 204 })
  } catch (error) {
    return externalMcpProxyProtocolErrorResponse(
      input.context.req.raw,
      error,
      input.operation.diagnosticReferenceId,
    )
  }
}

/**
 * Exposes one member-authorized connection to Desktop's private App host. An
 * ordinary client receives only a bounded search/execute compatibility surface
 * unless an administrator marked the connection `exposeDirectly`, in which case
 * it is served as a standard MCP server whose tool catalog is filtered by the
 * organization's tool policy. Grants are re-checked on every request.
 */
export function registerExternalConnectionProxyRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(
  app: Hono<T>,
) {
  const path = "/mcp/agent/connections/:connectionId"

  app.all(path, tokenRoute, async (c) => {
    const requestIdValue = c.get("requestId")
    const requestId = typeof requestIdValue === "string" ? requestIdValue : "unknown"
    const principal = await verifyMcpRequest(
      c.req.raw.headers,
      getMcpResourceContext(c.req.raw, "agent", requestId),
    )
    if (principal instanceof Response) return principal

    const preflightResponse = await preflightMcpJsonRpcRequest(c.req.raw, requestId)
    if (preflightResponse) return preflightResponse

    if (c.req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } })
    }

    const organizationId = normalizeDenTypeId("organization", principal.organizationId)

    let connectionId
    try {
      connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, "The MCP connection id is invalid.")
    }
    const member = await resolveMcpMemberIdentity({
      userId: principal.userId,
      organizationId,
    })
    if (!member) throw new McpError(ErrorCode.InvalidRequest, "The MCP connection is not available.")

    const connection = await getExternalMcpConnection({ organizationId, connectionId })
    const allowed = connection && await memberCanUseExternalMcpConnection({
      connectionId,
      orgMembershipId: member.orgMembershipId,
      teamIds: member.teamIds,
    })
    if (!connection || !allowed) throw new McpError(ErrorCode.InvalidRequest, "The MCP connection is not available.")

    // The direct provider catalog is a member-facing MCP surface, so it obeys
    // the same organization flag as the member-facing connection list.
    const directExposureEnabled = connection.exposeDirectly
      && await memberFacingMcpConnectionsEnabledForOrganization(organizationId)

    const redirectUriBase = resolvePublicOrigin(c.req.raw, env.apiPublicUrl)
    const redirectUri = `${redirectUriBase}/v1/mcp-connections/${encodeURIComponent(connection.id)}/connect/callback`
    const downstreamMember = { orgMembershipId: member.orgMembershipId }
    const operation = {
      connection,
      redirectUri,
      member: downstreamMember,
      diagnosticReferenceId: requestId,
    }
    return handleExternalConnectionProxyRequest({
      context: c,
      operation,
      appHostClient: principal.scopes.has(DEN_MCP_APP_HOST_SCOPE),
      directExposureEnabled,
    })
  })
}

async function memberFacingMcpConnectionsEnabledForOrganization(
  organizationId: ExternalMcpConnectionRow["organizationId"],
): Promise<boolean> {
  const rows = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  return memberFacingMcpConnectionsEnabled(rows[0]?.metadata, { gatingEnabled: env.mcpConnectionsGatingEnabled })
}

export const STANDARD_MCP_APP_EXTENSION = {
  extensionId: EXTENSION_ID,
  mimeType: RESOURCE_MIME_TYPE,
} as const
