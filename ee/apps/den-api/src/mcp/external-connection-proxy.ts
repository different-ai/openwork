import { personalAgentConnectorAccess } from "../personal-agents/connector-access.js"
import { recordConnectorCall, toolCallFailed } from "../capability-usage.js"
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { AsyncLocalStorage } from "node:async_hooks"
import { createMcpHandler, ProtocolError, ProtocolErrorCode, Server, type Tool } from "@modelcontextprotocol/server"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Context, Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import {
  getExternalMcpConnection,
  externalMcpConnectionReadyForMember,
  memberCanUseExternalMcpConnection,
  type ExternalMcpConnectionRow,
} from "../capability-sources/external-mcp-connections.js"
import { usesMemberApiKey } from "../capability-sources/member-api-key.js"
import {
  callExternalMcpToolRaw,
  describeExternalMcpServer,
  listExternalMcpResources,
  listExternalMcpResourceTemplates,
  listExternalMcpTools,
  readExternalMcpResource,
} from "../capability-sources/external-mcp-client-runtime.js"
import { externalMcpDiagnosticForResponse } from "../capability-sources/external-mcp-diagnostics.js"
import { evaluateToolPolicy } from "../capability-sources/external-mcp-tool-policy.js"
import { cache } from "../cache.js"
import { env } from "../env.js"
import { tokenRoute } from "../middleware/index.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { handleMcpAppServerRequest, isMcpAppServerId } from "./app-server.js"
import { appSiteResponse, wantsAppSite } from "./app-site.js"
import { getMcpResourceContext, verifyMcpRequest, type McpPrincipal } from "./auth.js"
import {
  externalMcpAppResourceUri,
  externalMcpConnectionHold,
  mcpMemberForToken,
  resolveMcpMemberIdentity,
} from "./external-capabilities.js"
import { connectionsWithheld, personalAgentRunId, toolsWithheld } from "./workbot-turn-limits.js"
import { PERSONAL_AGENT_UNAPPROVABLE_WRITE, personalAgentPolicyRefusal, personalAgentRunDispatchRefusal } from "../personal-agents/permissions-dispatch.js"
import { externalMcpToolSchemaDigest } from "./external-mcp-tool-arguments.js"
import { InventoryEventBus, type InventoryRevision } from "./inventory-event-bus.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { EXECUTE_CAPABILITY_TOOL_NAME, scoreText, SEARCH_CAPABILITIES_TOOL_NAME, tokenize } from "./search.js"
import { personalAgentCredentialMember } from "../personal-agents/shared-logins.js"
import { toolPermissionRefusal } from "../tool-permissions/dispatch.js"
import { DEN_MCP_APP_HOST_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"

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
  actingMemberId?: NonNullable<ExternalMcpResourceOperation["member"]>["orgMembershipId"]
  actingTeamIds?: readonly string[]
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

export const EXTERNAL_CONNECTION_TOOLS_TTL_MS = 60_000

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

function objectSchema(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || (value.type !== undefined && value.type !== "object")) return undefined
  return { ...value, type: "object" }
}

function listableTools(tools: readonly ExternalMcpProxyTool[]): Tool[] {
  return tools.flatMap((tool) => {
    const inputSchema = objectSchema(tool.inputSchema)
    if (!inputSchema) return []
    const { outputSchema: listedOutputSchema, ...rest } = tool
    const outputSchema = objectSchema(listedOutputSchema)
    return [{
      ...rest,
      inputSchema: inputSchema as Tool["inputSchema"],
      ...(outputSchema ? { outputSchema: outputSchema as Tool["outputSchema"] } : {}),
    }]
  })
}

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
  const meta = isRecord(tool._meta) ? tool._meta : {}
  const ui = isRecord(meta.ui) ? meta.ui : {}
  if (!toolVisibleToApp(tool)) return null
  return {
    ...tool,
    _meta: {
      ...meta,
      ui: {
        ...ui,
        ...(resourceUri ? { resourceUri } : {}),
        visibility: ["app"],
      },
    },
  }
}


export function createExternalConnectionProxyServer(input: {
  descriptor: ExternalMcpProxyDescriptor
  operation: ExternalMcpProxyOperation
  scopes: ReadonlySet<string>
  runtime?: ExternalMcpProxyRuntime
  appHostClient?: boolean
  directExposureEnabled?: boolean
}) {
  const { connection } = input.operation
  const runtime = input.runtime ?? externalMcpProxyRuntime
  const appGatewayTools = boundedGatewayTools.map((tool) => ({
    ...tool,
    _meta: { ui: { visibility: ["app"] } },
  }))
  const callTool = async (tool: ExternalMcpProxyTool, args: Record<string, unknown>) => {
    const requiredScope = DEN_MCP_WRITE_SCOPE
    if (!input.scopes.has(requiredScope)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({
          error: "insufficient_mcp_scope",
          requiredScope,
          message: `${tool.name} requires the ${requiredScope} scope.`,
        }) }],
      }
    }
    const refusal = await toolPermissionRefusal({ scopes: input.scopes, connection, tool, actingMemberId: input.operation.actingMemberId ?? input.operation.member.orgMembershipId, teamIds: input.operation.actingTeamIds })
    if (refusal) return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(refusal) }] }
    const call = runtime.callTool({ ...input.operation, toolName: tool.name, args })
    recordConnectorCall(Promise.resolve(call), {
      organizationId: connection.organizationId,
      orgMembershipId: input.operation.actingMemberId ?? input.operation.member.orgMembershipId,
      connectionId: connection.id,
      source: input.appHostClient === true ? "app" : "agent",
    }, toolCallFailed)
    return call
  }
  const directClient = connection.exposeDirectly
    && input.directExposureEnabled === true
    && input.appHostClient !== true
  const downstreamUi = input.descriptor.capabilities.extensions?.[EXTENSION_ID]
  const withheldTools = toolsWithheld(input.scopes)?.get(connection.id)
  const agentRun = personalAgentRunId(input.scopes) !== undefined
  const withheldConnection = connectionsWithheld(input.scopes)?.has(connection.id)
  let connectorAccess: ReturnType<typeof personalAgentConnectorAccess> | undefined
  const readConnectorAccess = () => connectorAccess ??= personalAgentConnectorAccess({
    scopes: input.scopes, organizationId: connection.organizationId, memberId: input.operation.actingMemberId ?? input.operation.member.orgMembershipId,
  })
  const listProviderTools = async (calling = false) => {
    const access = await readConnectorAccess()
    const state = access?.state(connection.id)
    const once = state === "off" ? await access?.tools(connection.id) : undefined
    if (state === "blocked" || (state === "off" && !once?.size)) return []
    const useLiveRules = calling && agentRun
    if (!input.descriptor.capabilities.tools || (!useLiveRules && withheldConnection)) return []
    return (await runtime.listTools(
      connection,
      input.operation.redirectUri,
      input.operation.member,
      input.operation.diagnosticReferenceId,
    )).filter((tool) => (
      !PROXY_GATEWAY_TOOL_NAMES.has(tool.name)
      && !evaluateToolPolicy(connection.toolPolicy, tool.name).blocked
      && !access?.toolBlocked(connection.id, tool.name)
      && (state !== "off" || once?.has(tool.name))
      && ((calling && agentRun) || !withheldTools?.has(tool.name))
    ))
  }
  const listDirectTools = async (calling = false) => (await listProviderTools(calling)).filter(toolVisibleToModel)
  const listAppTools = async (calling = false) => (
    await listProviderTools(calling)
  ).flatMap((tool) => {
    const appTool = appOnlyProxyTool(tool)
    return appTool ? [appTool] : []
  })
  const appResourceUris = async () => {
    const access = await readConnectorAccess()
    if (access && access.state(connection.id) !== "on") return new Set<string>()
    return new Set((await (input.appHostClient ? listAppTools() : listDirectTools()))
      .map((tool) => externalMcpAppResourceUri(tool)).filter((uri) => uri !== null))
  }
  const listsChange = input.appHostClient === true || directClient
  const server = new Server(input.descriptor.serverInfo ?? {
    name: connection.name,
    version: "1.0.0",
  }, {
    capabilities: {
      ...(input.descriptor.capabilities.tools ? { tools: { listChanged: listsChange } } : {}),
      ...(input.descriptor.capabilities.resources ? { resources: { listChanged: listsChange, subscribe: false } } : {}),
      ...(downstreamUi ? { extensions: { [EXTENSION_ID]: downstreamUi } } : {}),
    },
    ...(listsChange && input.descriptor.capabilities.tools
      ? { cacheHints: { "tools/list": { ttlMs: EXTERNAL_CONNECTION_TOOLS_TTL_MS, cacheScope: "private" as const } } }
      : {}),
    instructions: input.appHostClient
      ? "This member-authorized OpenWork Connect endpoint privately exposes app-visible tools and their bound MCP App resources for this connection. Omitted UI visibility defaults to model and app; tools are projected here as app-only. Ordinary clients retain their configured direct or search_capabilities/execute_capability surface."
      : directClient
        ? `This member-authorized OpenWork Connect endpoint exposes the tools of ${connection.name} directly, subject to your organization's access grants and tool policy. Only MCP App resources bound to available model-visible tools are exposed.`
        : `This compatibility endpoint exposes only bounded search_capabilities and execute_capability for ${connection.name}. Direct provider tools, MCP App launch tools, and resources are not exposed.`,
  })

  if (input.descriptor.capabilities.tools) {
    server.setRequestHandler("tools/list", async () => ({
      tools: listableTools(input.appHostClient
        ? [...appGatewayTools, ...await listAppTools()]
        : directClient
          ? await listDirectTools()
          : boundedGatewayTools),
    }))
    server.setRequestHandler("tools/call", async (request) => {
      const args = toolArguments(request.params.arguments)
      if (directClient) {
        const tool = (await listDirectTools(true)).find((tool) => tool.name === request.params.name)
        if (!tool) {
          throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Tool ${request.params.name} is not available on ${connection.name}.`)
        }
        return callTool(tool, args)
      }
      if (request.params.name === SEARCH_CAPABILITIES_TOOL_NAME) {
        const query = typeof args.query === "string" ? args.query.trim() : ""
        if (!query) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "search_capabilities requires a non-empty query.")
        const requestedLimit = typeof args.limit === "number" && Number.isInteger(args.limit) ? args.limit : 5
        const limit = Math.max(1, Math.min(20, requestedLimit))
        const queryTokens = tokenize(query)
        const matches = (await listProviderTools()).flatMap((tool) => {
          const summary = tool.description ?? tool.title ?? tool.name
          const score = scoreText(tokenize(tool.name), tokenize(summary), queryTokens)
          if (score <= 0) return []
          const resourceUri = input.appHostClient ? externalMcpAppResourceUri(tool) : null
          return [{
            score,
            match: {
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
            },
          }]
        }).sort((left, right) => (right.score - left.score) || left.match.name.localeCompare(right.match.name)).slice(0, limit)
          .map(({ match }) => match)
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ matches }) }],
          structuredContent: { matches },
        }
      }
      if (request.params.name === EXECUTE_CAPABILITY_TOOL_NAME) {
        const toolName = typeof args.name === "string" ? args.name.trim() : ""
        const tool = (await listProviderTools(true)).find((candidate) => candidate.name === toolName)
        if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "The capability is unavailable. Call search_capabilities again.")
        return callTool(tool, toolArguments(args.arguments ?? args.body))
      }
      if (!input.appHostClient) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidRequest,
          `Direct provider tool ${request.params.name} is unavailable. Use search_capabilities and execute_capability.`,
        )
      }
      const tool = (await listAppTools(true)).find((tool) => tool.name === request.params.name)
      if (!tool) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidRequest,
          `Tool ${request.params.name} is not available on the MCP Apps endpoint. Use search_capabilities and execute_capability.`,
        )
      }
      return callTool(tool, args)
    })
  }

  if (input.descriptor.capabilities.resources) {
    server.setRequestHandler("resources/list", async () => {
      if (!input.appHostClient && !directClient) return { resources: [] }
      const allowedUris = await appResourceUris()
      return { resources: (await runtime.listResources(input.operation)).filter((resource) => allowedUris.has(resource.uri)) }
    })
    server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }))
    server.setRequestHandler("resources/read", async (request) => {
      if (!input.appHostClient && !directClient) {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "Provider MCP App resources require direct exposure or the OpenWork App host.")
      }
      if (!(await appResourceUris()).has(request.params.uri)) {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "The resource is not bound to an available MCP App tool.")
      }
      return runtime.readResource({ ...input.operation, uri: request.params.uri })
    })
  }

  return server
}

async function jsonRpcRequestField(request: Request, field: "id" | "method"): Promise<string | number | null> {
  try {
    const value: unknown = await request.clone().json()
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const fieldValue = field === "id" && "id" in value ? value.id : field === "method" && "method" in value ? value.method : null
    return typeof fieldValue === "string" || typeof fieldValue === "number" ? fieldValue : null
  } catch {
    return null
  }
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
    id: await jsonRpcRequestField(request, "id"),
    error: {
      code: ProtocolErrorCode.InternalError,
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

export function createExternalConnectionProxyHandler(input: { revision: InventoryRevision; pollMs?: number }) {
  const bus = new InventoryEventBus({
    revision: input.revision,
    pollMs: input.pollMs,
    events: [{ kind: "tools_list_changed" }, { kind: "resources_list_changed" }],
    onerror: (error) => console.error("external_mcp_proxy_change_listener_failed", { error }),
  })
  const requestServer = new AsyncLocalStorage<Server>()
  const handler = createMcpHandler(() => {
    const server = requestServer.getStore()
    if (!server) throw new Error("External connection proxy request was not prepared.")
    return server
  }, {
    legacy: "stateless",
    onerror: (error) => console.error("external_mcp_proxy_transport_error", { error }),
    bus,
  })
  return {
    fetch: (organizationId: string, request: Request, server: Server) =>
      bus.run(organizationId, () => requestServer.run(server, () => handler.fetch(request))),
    close: async () => {
      bus.close()
      await handler.close()
    },
  }
}

type ExternalConnectionProxyHandler = ReturnType<typeof createExternalConnectionProxyHandler>
let defaultProxyHandler: ExternalConnectionProxyHandler | undefined

type ExternalMcpProxyRequestDependencies = {
  describe: typeof describeExternalMcpServer
  serve: (server: Server, context: Context, organizationId: string) => Promise<Response | undefined>
}

const externalMcpProxyRequestDependencies: ExternalMcpProxyRequestDependencies = {
  describe: describeExternalMcpServer,
  serve: (server, context, organizationId) => {
    defaultProxyHandler ??= createExternalConnectionProxyHandler({
      revision: (id) => cache.inventory.revision(normalizeDenTypeId("organization", id)),
    })
    return defaultProxyHandler.fetch(organizationId, context.req.raw, server)
  },
}

export async function handleExternalConnectionProxyRequest(input: {
  context: Context
  operation: ExternalMcpProxyOperation
  scopes: ReadonlySet<string>
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
      scopes: input.scopes,
      runtime: input.runtime,
      appHostClient: input.appHostClient === true,
      directExposureEnabled: input.directExposureEnabled === true,
    })
    const response = await dependencies.serve(server, input.context, input.operation.connection.organizationId)
    return response ?? new Response(null, { status: 204 })
  } catch (error) {
    return externalMcpProxyProtocolErrorResponse(
      input.context.req.raw,
      error,
      input.operation.diagnosticReferenceId,
    )
  }
}

export type ExternalConnectionProxyRouteDeps = {
  verify: (request: Request, requestId: string) => Promise<McpPrincipal | Response>
  member: typeof resolveMcpMemberIdentity
  connection: typeof getExternalMcpConnection
  granted: typeof memberCanUseExternalMcpConnection
  memberKeyReady: typeof externalMcpConnectionReadyForMember
  proxy: typeof handleExternalConnectionProxyRequest
}

export const EXTERNAL_CONNECTION_PROXY_ROUTE_DEPS: ExternalConnectionProxyRouteDeps = {
  verify: (request, requestId) => verifyMcpRequest(request.headers, getMcpResourceContext(request, "agent", requestId)),
  member: resolveMcpMemberIdentity,
  connection: getExternalMcpConnection,
  granted: memberCanUseExternalMcpConnection,
  memberKeyReady: externalMcpConnectionReadyForMember,
  proxy: handleExternalConnectionProxyRequest,
}

export function registerExternalConnectionProxyRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(
  app: Hono<T>,
  deps: ExternalConnectionProxyRouteDeps = EXTERNAL_CONNECTION_PROXY_ROUTE_DEPS,
) {
  const path = "/mcp/agent/connections/:connectionId"

  app.all(path, tokenRoute, async (c) => {
    const requestIdValue = c.get("requestId")
    const requestId = typeof requestIdValue === "string" ? requestIdValue : "unknown"
    if (wantsAppSite(c.req.raw) && isMcpAppServerId(c.req.param("connectionId"))) {
      const page = await appSiteResponse({ appIdOrName: c.req.param("connectionId"), publicOnly: false })
      if (page) return page
    }
    const principal = await deps.verify(c.req.raw, requestId)
    if (principal instanceof Response) return principal

    const preflightResponse = await preflightMcpJsonRpcRequest(c.req.raw, requestId)
    if (preflightResponse) return preflightResponse

    if (c.req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } })
    }

    const requestedId = c.req.param("connectionId")
    if (isMcpAppServerId(requestedId)) {
      if (personalAgentRunId(principal.scopes) !== undefined) return c.json(personalAgentPolicyRefusal(PERSONAL_AGENT_UNAPPROVABLE_WRITE), 403)
      return handleMcpAppServerRequest({ app: app as unknown as Hono, context: c, principal, appId: requestedId })
    }

    const organizationId = normalizeDenTypeId("organization", principal.organizationId)
    const unavailable = (message?: string) => c.json({ error: "connection_not_available", ...(message ? { message } : {}) }, 403)

    let connectionId
    try {
      connectionId = normalizeDenTypeId("externalMcpConnection", requestedId)
    } catch {
      return unavailable()
    }
    const resolvedMember = await deps.member({
      userId: principal.userId,
      organizationId,
    })
    if (!resolvedMember) return unavailable()
    const member = mcpMemberForToken(resolvedMember, principal.scopes)
    const runRefusal = await personalAgentRunDispatchRefusal(principal.scopes, organizationId)
    if (runRefusal) return c.json(runRefusal, 403)

    const connection = await deps.connection({ organizationId, connectionId })
    const granted = connection && await deps.granted({
      connectionId,
      orgMembershipId: member.orgMembershipId,
      teamIds: member.teamIds,
    })
    if (!connection || !granted) return unavailable()
    const access = await personalAgentConnectorAccess({ scopes: principal.scopes, organizationId, memberId: member.orgMembershipId })
    const state = access?.state(connection.id)
    if (state === "blocked" || (state === "off" && !(await access?.tools(connection.id))?.size)) {
      return c.json(personalAgentPolicyRefusal("This connector is off for this agent."), 403)
    }
    const useLiveAgentRules = member.personalAgentScopes && await jsonRpcRequestField(c.req.raw, "method") === "tools/call"
    const hold = externalMcpConnectionHold(connection, useLiveAgentRules ? {} : member)
    if (hold) return unavailable(hold.message)
    const credentialMemberId = await personalAgentCredentialMember({ scopes: principal.scopes, connection, actingMemberId: member.orgMembershipId })
    if (usesMemberApiKey(connection)
      && !await deps.memberKeyReady(connection, credentialMemberId)) {
      return unavailable("Connect your personal API key in Your Connections.")
    }

    const directExposureEnabled = connection.exposeDirectly

    const redirectUriBase = resolvePublicOrigin(c.req.raw, env.apiPublicUrl)
    const redirectUri = `${redirectUriBase}/v1/mcp-connections/${encodeURIComponent(connection.id)}/connect/callback`
    const downstreamMember = { orgMembershipId: credentialMemberId }
    const operation = {
      connection,
      redirectUri,
      member: downstreamMember,
      actingMemberId: member.orgMembershipId,
      actingTeamIds: member.teamIds,
      diagnosticReferenceId: requestId,
    }
    return deps.proxy({
      context: c,
      operation,
      scopes: principal.scopes,
      appHostClient: principal.scopes.has(DEN_MCP_APP_HOST_SCOPE),
      directExposureEnabled,
    })
  })
}

export const STANDARD_MCP_APP_EXTENSION = {
  extensionId: EXTENSION_ID,
  mimeType: RESOURCE_MIME_TYPE,
} as const
