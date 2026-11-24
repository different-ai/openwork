import { AsyncLocalStorage } from "node:async_hooks"
import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { mcpAuditPrincipal } from "../audit/mcp-service-audit.js"
import { cache } from "../cache.js"
import { createExternalMcpLifecycleDeadline, EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS } from "../capability-sources/external-mcp-client.js"
import { externalMcpDiagnosticForLog, safeExternalMcpEndpointForLog } from "../capability-sources/external-mcp-diagnostics.js"
import { getExternalMcpConnection, type ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { listNativeProviderUsableEntries, type NativeProviderConnectionEntry } from "../capability-sources/native-provider-connections.js"
import { NATIVE_OAUTH_PROVIDERS } from "../capability-sources/provider-registry.js"
import { env } from "../env.js"
import { getOrganizationFeatures, type FeatureMap } from "../features.js"
import { publicRoute, tokenRoute } from "../middleware/index.js"
import { appLogger } from "../observability/logger.js"
import { getMcpResourceContext, mcpPrincipalCredentialId, verifyMcpRequest, type McpPrincipal } from "./auth.js"
import {
  createCapabilityRegistryContext,
  executeCapability,
  type CapabilityExecuteInput,
  type ExecuteCapabilityToolResult,
} from "./capability-registry.js"
import type { McpToolOperation } from "./catalog.js"
import { denInputJsonSchema } from "./codemode-tools.js"
import { connectionActionAppMeta, connectionActionPayloadFromStatus, connectionActionTextFallback } from "./connection-action.js"
import {
  CONNECTION_SERVER_ROUTE,
  CONNECTION_STATUS_TOOL_NAME,
  connectionServerCall,
  connectionStatusTool,
  nativeConnectionServerTools,
  providerConnectionServerTools,
  type ConnectionServerTool,
} from "./connection-server-tools.js"
import {
  buildExternalCapabilityName,
  listExternalMcpToolsThroughSearchCache,
  probeExternalConnectionStatus,
  mcpMemberForToken,
  resolveMcpMemberIdentity,
  type McpMemberIdentity,
} from "./external-capabilities.js"
import { getCatalog, protectedResourceMetadata, protectedResourceMetadataRoute } from "./index.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { buildNativeCapabilityName, connectionStatusMatch, nativeOperations } from "./native-capabilities.js"
import { InventoryEventBus, type InventoryRevision } from "./inventory-event-bus.js"
import { rejectStandaloneSseResponse } from "./standalone-sse.js"

const connectionServerLogger = appLogger.child({ component: "connection_mcp_server" })

export const CONNECTION_SERVER_TOOLS_TTL_MS = 60_000

export type ConnectionServerExecute = (call: CapabilityExecuteInput) => Promise<ExecuteCapabilityToolResult>

type ConnectionServerIdentity = {
  connectionId: string
  name: string
  description: string
  websiteUrl?: string
}

export type ResolvedConnectionServer = ConnectionServerIdentity & (
  | { state: "ready"; tools: () => Promise<ConnectionServerTool[]> }
  | { state: "pending"; showStatus: (execute: ConnectionServerExecute) => Promise<ExecuteCapabilityToolResult> }
)

export type ConnectionServerSources = {
  externalConnection: (input: { organizationId: DenTypeId<"organization">; connectionId: string }) => Promise<ExternalMcpConnectionRow | null>
  externalStatus: typeof probeExternalConnectionStatus
  externalTools: (input: { connection: ExternalMcpConnectionRow; member: McpMemberIdentity; redirectUriBase: string }) => Promise<Parameters<typeof providerConnectionServerTools>[0]["tools"]>
  nativeEntries: typeof listNativeProviderUsableEntries
}

export const CONNECTION_SERVER_SOURCES: ConnectionServerSources = {
  externalConnection: async ({ organizationId, connectionId }) => {
    let id: DenTypeId<"externalMcpConnection">
    try {
      id = normalizeDenTypeId("externalMcpConnection", connectionId)
    } catch {
      return null
    }
    return getExternalMcpConnection({ organizationId, connectionId: id })
  },
  externalStatus: probeExternalConnectionStatus,
  externalTools: (input) => listExternalMcpToolsThroughSearchCache({
    ...input,
    deadline: createExternalMcpLifecycleDeadline(EXTERNAL_MCP_TOOL_LIFECYCLE_TIMEOUT_MS),
  }),
  nativeEntries: listNativeProviderUsableEntries,
}

function memoized<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined
  return () => value ??= load()
}

async function externalConnectionServer(input: {
  connection: ExternalMcpConnectionRow
  member: McpMemberIdentity
  redirectUriBase: string
}, sources: ConnectionServerSources): Promise<ResolvedConnectionServer | null> {
  const { connection, member } = input
  if (connection.toolPolicy?.allDisabled) return null
  const status = await sources.externalStatus({ organizationId: connection.organizationId, member, connectionId: connection.id })
  if (!status.ok) return null
  const identity = {
    connectionId: connection.id,
    name: connection.name,
    description: `${connection.name} tools from your OpenWork organization, used with your access.`,
  }
  if (!status.connected) {
    const capability = buildExternalCapabilityName(connection.id, "*")
    return { ...identity, state: "pending", showStatus: (execute) => execute({ name: capability }) }
  }
  return {
    ...identity,
    state: "ready",
    tools: memoized(async () => {
      let tools: Awaited<ReturnType<ConnectionServerSources["externalTools"]>>
      try {
        tools = await sources.externalTools({ connection, member, redirectUriBase: input.redirectUriBase })
      } catch (error) {
        connectionServerLogger.warn("Connection server tool listing failed", {
          connectionId: connection.id,
          organizationId: connection.organizationId,
          connectionEndpoint: safeExternalMcpEndpointForLog(connection.url),
          ...externalMcpDiagnosticForLog(error, connection.id, "MCP_TOOL_DISCOVERY"),
        })
        throw new ProtocolError(ProtocolErrorCode.InternalError, `${connection.name} did not list its tools. Try again in a moment.`)
      }
      return providerConnectionServerTools({
        toolPolicy: connection.toolPolicy,
        tools,
        capabilityName: (toolName) => buildExternalCapabilityName(connection.id, toolName),
      })
    }),
  }
}

function nativeStatusResult(entry: NativeProviderConnectionEntry): ExecuteCapabilityToolResult {
  const status = connectionStatusMatch(entry, 1).connectionStatus
  if (!status) throw new Error("Native connection status is unavailable.")
  const payload = connectionActionPayloadFromStatus(status)
  return {
    content: [{ type: "text", text: connectionActionTextFallback(payload) }],
    structuredContent: { ...payload },
    _meta: connectionActionAppMeta(payload.connectionId),
  }
}

function nativeConnectionServer(entry: NativeProviderConnectionEntry, catalog: readonly McpToolOperation[]): ResolvedConnectionServer {
  const provider = NATIVE_OAUTH_PROVIDERS[entry.nativeProviderKey]
  const identity = {
    connectionId: entry.id,
    name: entry.name,
    description: `${provider?.displayName ?? entry.name} tools for your connected account, from your OpenWork organization.`,
    websiteUrl: entry.url,
  }
  if (!entry.connectedForMe) {
    return { ...identity, state: "pending", showStatus: async () => nativeStatusResult(entry) }
  }
  return {
    ...identity,
    state: "ready",
    tools: memoized(async () => nativeConnectionServerTools({
      operations: nativeOperations(catalog, entry.nativeProviderKey).map((operation) => ({
        name: operation.name,
        method: operation.method,
        summary: operation.operation.summary,
        description: operation.operation.description,
        inputSchema: denInputJsonSchema(operation),
      })),
      capabilityName: (operationName) => buildNativeCapabilityName(entry.id, operationName),
    })),
  }
}

export async function resolveConnectionServer(input: {
  organizationId: DenTypeId<"organization">
  member: McpMemberIdentity
  connectionId: string
  redirectUriBase: string
  catalog: readonly McpToolOperation[]
}, sources: ConnectionServerSources = CONNECTION_SERVER_SOURCES): Promise<ResolvedConnectionServer | null> {
  const row = await sources.externalConnection({ organizationId: input.organizationId, connectionId: input.connectionId })
  if (row && input.member.withheldConnectionIds?.has(row.id)) return null
  if (row?.kind === "external_mcp") {
    return externalConnectionServer({ connection: row, member: input.member, redirectUriBase: input.redirectUriBase }, sources)
  }
  if (row && row.kind !== "native_provider") return null
  const entries = await sources.nativeEntries({
    organizationId: input.organizationId,
    orgMembershipId: input.member.orgMembershipId,
    teamIds: input.member.teamIds,
  })
  const entry = entries.find((candidate) => candidate.id === input.connectionId)
  return entry ? nativeConnectionServer(entry, input.catalog) : null
}

function toolArguments(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

export function createConnectionServer(input: {
  connection: ResolvedConnectionServer
  execute: ConnectionServerExecute
}): Server {
  const { connection } = input
  const server = new Server({
    name: connection.name,
    title: connection.name,
    version: "1.0.0",
    description: connection.description,
    ...(connection.websiteUrl ? { websiteUrl: connection.websiteUrl } : {}),
  }, {
    capabilities: { tools: { listChanged: true } },
    instructions: `These are your ${connection.name} tools from OpenWork. They run as you, with your own OpenWork access and connections.`,
    cacheHints: { "tools/list": { ttlMs: CONNECTION_SERVER_TOOLS_TTL_MS, cacheScope: "private" } },
  })
  server.setRequestHandler("tools/list", async () => ({
    tools: connection.state === "pending"
      ? [connectionStatusTool(connection.name)]
      : (await connection.tools()).map(({ tool }) => tool),
  }))
  server.setRequestHandler("tools/call", async (request) => {
    const { name } = request.params
    if (connection.state === "pending") {
      if (name === CONNECTION_STATUS_TOOL_NAME) return connection.showStatus(input.execute)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Connect ${connection.name} first: call ${CONNECTION_STATUS_TOOL_NAME}.`)
    }
    const tool = (await connection.tools()).find((candidate) => candidate.tool.name === name)
    if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} is not available on ${connection.name}.`)
    return input.execute(connectionServerCall(tool, toolArguments(request.params.arguments)))
  })
  return server
}

async function connectionUnavailableResponse(request: Request): Promise<Response> {
  let id: string | number | null = null
  try {
    const body: unknown = await request.clone().json()
    if (typeof body === "object" && body !== null && "id" in body && (typeof body.id === "string" || typeof body.id === "number")) id = body.id
  } catch {
  }
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: ProtocolErrorCode.InvalidRequest, message: "This connection is not available.", data: { error: "mcp_connection_not_found" } },
  }), { status: 200, headers: { "content-type": "application/json" } })
}

export function createConnectionServerHandler(input: { revision: InventoryRevision; pollMs?: number }) {
  const bus = new InventoryEventBus({
    revision: input.revision,
    pollMs: input.pollMs,
    events: [{ kind: "tools_list_changed" }],
    onerror: (error) => connectionServerLogger.warn("Connection server change listener failed", { error }),
  })
  const requestServer = new AsyncLocalStorage<Server>()
  const handler = createMcpHandler(() => {
    const server = requestServer.getStore()
    if (!server) throw new Error("Connection server request was not prepared.")
    return server
  }, {
    legacy: "stateless",
    onerror: (error) => connectionServerLogger.warn("Connection server transport error", { error }),
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

export type ConnectionServerRouteDeps = {
  verify: (request: Request, requestId: string) => Promise<McpPrincipal | Response>
  features: (organizationId: string, userId: string) => Promise<Pick<FeatureMap, "connectionMcpServers" | "managedDeployments">>
  member: typeof resolveMcpMemberIdentity
  catalog: (app: Hono, env: unknown) => Promise<readonly McpToolOperation[]>
  sources: ConnectionServerSources
  executeCapability: typeof executeCapability
  withBudget: (capability: string, invoke: () => Promise<ExecuteCapabilityToolResult>) => Promise<ExecuteCapabilityToolResult>
  revision: InventoryRevision
  pollMs?: number
}

export const CONNECTION_SERVER_ROUTE_DEPS: ConnectionServerRouteDeps = {
  verify: (request, requestId) => verifyMcpRequest(request.headers, getMcpResourceContext(request, "agent", requestId)),
  features: (organizationId, userId) => getOrganizationFeatures(organizationId, { userId }),
  member: resolveMcpMemberIdentity,
  catalog: getCatalog,
  sources: CONNECTION_SERVER_SOURCES,
  executeCapability,
  withBudget: async (capability, invoke) => (await import("./agent.js")).executeCapabilityWithBudget({ capability, invoke }),
  revision: (organizationId) => cache.inventory.revision(normalizeDenTypeId("organization", organizationId)),
}

export function registerConnectionServerRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(
  app: Hono<T>,
  deps: ConnectionServerRouteDeps = CONNECTION_SERVER_ROUTE_DEPS,
) {
  const handler = createConnectionServerHandler({ revision: deps.revision, pollMs: deps.pollMs })

  app.get(`/.well-known/oauth-protected-resource${CONNECTION_SERVER_ROUTE}`, protectedResourceMetadataRoute("agent"), publicRoute, (c) =>
    c.json(protectedResourceMetadata(c.req.raw, "agent")))

  app.all(CONNECTION_SERVER_ROUTE, tokenRoute, async (c) => {
    const requestIdValue = c.get("requestId")
    const requestId = typeof requestIdValue === "string" ? requestIdValue : "unknown"
    const principal = await deps.verify(c.req.raw, requestId)
    if (principal instanceof Response) return principal

    const organizationId = normalizeDenTypeId("organization", principal.organizationId)
    const features = await deps.features(organizationId, principal.userId)
    if (!features.connectionMcpServers) return c.json({ error: "feature_disabled", feature: "connectionMcpServers" }, 404)

    if (c.req.method === "GET") return rejectStandaloneSseResponse()
    const preflightResponse = await preflightMcpJsonRpcRequest(c.req.raw, requestId)
    if (preflightResponse) return preflightResponse

    const resolvedMember = await deps.member({ userId: principal.userId, organizationId })
    if (!resolvedMember) return connectionUnavailableResponse(c.req.raw)
    const member = mcpMemberForToken(resolvedMember, principal.scopes)
    const catalog = await deps.catalog(app as unknown as Hono, c.env)
    const redirectUriBase = resolvePublicOrigin(c.req.raw, env.apiPublicUrl)
    const connection = await resolveConnectionServer({
      organizationId,
      member,
      connectionId: c.req.param("connectionId"),
      redirectUriBase,
      catalog,
    }, deps.sources)
    if (!connection) return connectionUnavailableResponse(c.req.raw)

    const capabilityContext = createCapabilityRegistryContext({
      app: app as unknown as Hono,
      env: c.env,
      catalog,
      principal,
      organizationId,
      member,
      redirectUriBase,
      generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
      organizationFeatures: features,
      audit: mcpAuditPrincipal({ organizationId, userId: principal.userId, memberId: member.orgMembershipId, credentialId: mcpPrincipalCredentialId(principal) }),
      usageSource: "agent",
    })
    const server = createConnectionServer({
      connection,
      execute: (call) => deps.withBudget(call.name, () => deps.executeCapability(capabilityContext, call)),
    })
    return handler.fetch(organizationId, c.req.raw, server)
  })
}
