import type { ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"
import { readyExternalMcpConnectionsForMember } from "../capability-sources/external-mcp-connections.js"
import { listExternalMcpTools } from "../capability-sources/external-mcp-client-runtime.js"
import { createExternalMcpLifecycleDeadline, type ExternalMcpLifecycleDeadline } from "../capability-sources/external-mcp-client.js"
import type { NativeProviderConnectionEntry } from "../capability-sources/native-provider-connections.js"
import type { McpAppEntry } from "../mcp-apps.js"
import { CAPABILITY_SOURCES, slackSendAsBotAvailable, type CapabilityLeaf, type CapabilityRegistryContext, type CapabilitySourceKind, type ExecuteCapabilityToolResult } from "./capability-registry.js"
import { buildCodemodeConnectionNamespaceMaps, type CodemodeConnectionNamespaceContext } from "./codemode-namespaces.js"
import { mapConcurrent } from "./codemode-tools.js"
import {
  APP_TOOL_NAMESPACE,
  buildConnectFullTools,
  externalToolCandidates,
  OPENWORK_BOT_TOOL_NAMESPACE,
  REMOTE_SESSION_TOOL_NAMESPACE,
  titledToolNames,
  WORKFLOW_TOOL_NAMESPACE,
  type CapabilityCall,
  type ConnectFullTool,
  type ConnectFullToolCandidate,
  type ExternalToolListing,
  type PendingConnection,
} from "./connect-full-tools.js"
import { connectionActionAppMeta, connectionActionPayloadFromStatus, connectionActionTextFallback } from "./connection-action.js"
import { buildExternalCapabilityName, CONNECTION_KEY_REQUEST_CAPABILITY, EXTERNAL_MCP_SEARCH_CONCURRENCY, externalToolsSearchCacheKey } from "./external-capabilities.js"
import { getExternalToolsSearchCache, setExternalToolsSearchCache } from "./external-tools-search-cache.js"
import { listAccessibleWorkflows } from "./marketplace-capabilities.js"
import { buildMarketplaceCapabilityName } from "./marketplace-capability-name.js"
import type { ConnectService } from "./engine-tool-view.js"
import { connectionStatusMatch } from "./native-capabilities.js"
import { listRemoteSessionCapabilities } from "./remote-session-capabilities.js"
import { SLACK_SEND_AS_BOT_ARGUMENTS_SCHEMA, SLACK_SEND_AS_BOT_CAPABILITY, SLACK_SEND_AS_BOT_SUMMARY } from "./slack-send-as-bot.js"

// The same bounds capability search gives one provider probe.
const LIST_LIFECYCLE_TIMEOUT_MS = 8_000
const LIST_REQUEST_TIMEOUT_MS = 5_000
const READ_ONLY_REMOTE_SESSION_ACTIONS = new Set(["read", "list", "targets", "status"])

/**
 * What a full-view request needs: the whole list (`tools/list`), some
 * namespaces' tools (a `tools/call` resolves only its own), or only the
 * connections that are not ready (a connection_status call).
 */
export type ConnectFullToolScope = "list" | "status" | { namespaces: ReadonlySet<string> }

/** The namespace a full-view tool name belongs to, or null for a name without one. */
export function connectFullToolNamespace(name: string): string | null {
  const separator = name.indexOf(".")
  return separator > 0 ? name.slice(0, separator) : null
}

export type LoadedConnectFullTools = {
  tools: ConnectFullTool[]
  pending: PendingConnection[]
  showPending: (connection: PendingConnection) => Promise<ExecuteCapabilityToolResult>
}

type PendingSource =
  | { kind: "native"; entry: NativeProviderConnectionEntry }
  | { kind: "externalMcp"; connection: ExternalMcpConnectionRow }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

function leafCandidates(leaves: readonly CapabilityLeaf[]): ConnectFullToolCandidate[] {
  return leaves.map((leaf) => ({
    namespace: leaf.namespace,
    toolName: leaf.toolName,
    capability: leaf.capabilityName,
    description: leaf.definition.description,
    inputSchema: isPlainRecord(leaf.definition.input) ? leaf.definition.input : { type: "object" },
    ...(leaf.readOnly === undefined ? {} : { annotations: { readOnlyHint: leaf.readOnly } }),
  }))
}

async function enumerated(ctx: CapabilityRegistryContext, kind: CapabilitySourceKind): Promise<CapabilityLeaf[]> {
  const result = await CAPABILITY_SOURCES[kind].enumerate(ctx)
  return "excluded" in result ? [] : result
}

/**
 * The provider's tools for one ready connection, from the tools cache search
 * shares when it can, so listing does not probe every provider each time.
 * Null when the provider cannot list them now.
 */
async function connectionTools(
  ctx: CapabilityRegistryContext,
  connection: ExternalMcpConnectionRow,
  deadline: ExternalMcpLifecycleDeadline,
): Promise<ExternalToolListing[] | null> {
  const member = ctx.member
  if (!member) return null
  const cacheKey = externalToolsSearchCacheKey(connection, member)
  const cached = cacheKey ? getExternalToolsSearchCache(cacheKey) : undefined
  if (cached) return cached.outcome === "success" ? cached.tools : null
  try {
    const tools = await listExternalMcpTools(
      connection,
      `${ctx.redirectUriBase}/v1/mcp-connections/${encodeURIComponent(connection.id)}/connect/callback`,
      connection.credentialMode === "per_member" ? { orgMembershipId: member.orgMembershipId } : undefined,
      undefined,
      deadline,
      LIST_REQUEST_TIMEOUT_MS,
    )
    if (cacheKey) setExternalToolsSearchCache(cacheKey, { outcome: "success", tools })
    return tools
  } catch (error) {
    if (cacheKey) setExternalToolsSearchCache(cacheKey, { outcome: "failure", error })
    return null
  }
}

/** Connections the member may use but cannot call yet, under the namespace connection_status takes for each. */
function pendingConnections(
  namespaceContext: CodemodeConnectionNamespaceContext,
  external: readonly ExternalMcpConnectionRow[],
  readyIds: ReadonlySet<string>,
) {
  const pendingSources = new Map<string, PendingSource>()
  for (const entry of namespaceContext.nativeProviderEntries) {
    if (!entry.connectedForMe) pendingSources.set(entry.id, { kind: "native", entry })
  }
  for (const connection of external) {
    if (!readyIds.has(connection.id)) pendingSources.set(connection.id, { kind: "externalMcp", connection })
  }
  const pendingNamespaces = buildCodemodeConnectionNamespaceMaps({
    native: [...pendingSources.values()].flatMap((source) => source.kind === "native" ? [source.entry] : []),
    externalMcp: [...pendingSources.values()].flatMap((source) => source.kind === "externalMcp" ? [source.connection] : []),
  })
  const pending = [...pendingSources.entries()].flatMap(([id, source]) => {
    const namespace = pendingNamespaces.native.get(id) ?? pendingNamespaces.externalMcp.get(id)
    const name = source.kind === "native" ? source.entry.name : source.connection.name
    return namespace ? [{ id, namespace, name }] : []
  })
  return { pendingSources, pending }
}

/**
 * The services the member may use, for the engine's directory
 * (engine-tool-view.ts): each ready connection under the namespace of its
 * tools, and each pending one under the namespace connection_status takes.
 * Readiness is checked without listing any provider's tools.
 */
export async function loadConnectServices(ctx: CapabilityRegistryContext): Promise<ConnectService[]> {
  const member = ctx.member
  if (!member) return []
  const namespaceContext = await ctx.resolveNamespaceContext()
  const external = namespaceContext.externalMcpConnections.filter((connection) => !connection.toolPolicy?.allDisabled)
  const readyIds = new Set((await readyExternalMcpConnectionsForMember(external, member.orgMembershipId)).map((connection) => connection.id))
  const ready = [
    ...namespaceContext.codemodeNativeProviderEntries.map((entry) => ({ namespace: namespaceContext.namespaces.native.get(entry.id), name: entry.name })),
    ...namespaceContext.codemodeExternalMcpConnections
      .filter((connection) => readyIds.has(connection.id))
      .map((connection) => ({ namespace: namespaceContext.namespaces.externalMcp.get(connection.id), name: connection.name })),
  ].flatMap(({ namespace, name }) => namespace ? [{ namespace, name, ready: true }] : [])
  const { pending } = pendingConnections(namespaceContext, external, readyIds)
  return [...ready, ...pending.map(({ namespace, name }) => ({ namespace, name, ready: false }))]
}

/**
 * Every capability the calling member may use, as full-view tools, built from
 * the capability registry's own sources: native Google/Microsoft operations
 * and platform-admin tools as Code Mode enumerates them, ready external MCP
 * connections' tools under their tool policy, the member's Workflows and
 * Apps, remote sessions, and slack_send_as_bot. Each tool names the capability
 * execute_capability runs.
 */
export async function loadConnectFullTools(input: {
  ctx: CapabilityRegistryContext
  scope: ConnectFullToolScope
  /** Apps this member can open; none when building Apps is off. */
  apps: () => Promise<McpAppEntry[]>
  execute: (call: CapabilityCall) => Promise<ExecuteCapabilityToolResult>
}): Promise<LoadedConnectFullTools> {
  const { ctx, scope } = input
  const member = ctx.member
  const wants = (namespace: string) => scope === "list" || (typeof scope === "object" && scope.namespaces.has(namespace))
  const namespaceContext = await ctx.resolveNamespaceContext()
  const candidates: ConnectFullToolCandidate[] = []

  // OpenWork's own API operations stay in search: whether a member may call one
  // depends on per-route roles a list cannot check. The exception is the key
  // request a connection card tells the agent to run.
  if (scope !== "status") {
    if (wants("den")) {
      const keyRequest = ctx.catalog.filter((operation) => operation.name === CONNECTION_KEY_REQUEST_CAPABILITY)
      candidates.push(...leafCandidates(await enumerated({ ...ctx, catalog: keyRequest }, "catalog")))
    }
    if (wants("admin")) candidates.push(...leafCandidates(await enumerated(ctx, "admin")))
    candidates.push(...leafCandidates((await enumerated(ctx, "native")).filter((leaf) => wants(leaf.namespace))))
  }

  // Connections whose tools are all disabled are left out entirely, as in search.
  const external = namespaceContext.externalMcpConnections.filter((connection) => !connection.toolPolicy?.allDisabled)
  // The whole list and connection_status need every connection's readiness; a tools/call only its own.
  const readyIds = typeof scope === "object" || !member
    ? null
    : new Set((await readyExternalMcpConnectionsForMember(external, member.orgMembershipId)).map((connection) => connection.id))
  if (member && scope !== "status") {
    const listable = namespaceContext.codemodeExternalMcpConnections.filter((connection) => (
      wants(namespaceContext.namespaces.externalMcp.get(connection.id) ?? "")
    ))
    const readyListable = readyIds
      ? listable.filter((connection) => readyIds.has(connection.id))
      : await readyExternalMcpConnectionsForMember(listable, member.orgMembershipId)
    const deadline = createExternalMcpLifecycleDeadline(LIST_LIFECYCLE_TIMEOUT_MS)
    const listed = await mapConcurrent(readyListable, EXTERNAL_MCP_SEARCH_CONCURRENCY, async (connection) => ({
      connection,
      tools: await connectionTools(ctx, connection, deadline),
    }))
    for (const entry of listed) {
      const namespace = entry ? namespaceContext.namespaces.externalMcp.get(entry.connection.id) : undefined
      if (!entry?.tools || !namespace) continue
      candidates.push(...externalToolCandidates({
        connection: { id: entry.connection.id, name: entry.connection.name, namespace, toolPolicy: entry.connection.toolPolicy },
        tools: entry.tools,
        capabilityName: buildExternalCapabilityName,
      }))
    }
  }

  if (member && wants(WORKFLOW_TOOL_NAMESPACE)) {
    const workflows = await listAccessibleWorkflows({ member, organizationId: ctx.organizationId })
    const names = titledToolNames(workflows.map((workflow) => ({ id: workflow.configObjectId, title: workflow.title })))
    candidates.push(...workflows.map((workflow) => ({
      namespace: WORKFLOW_TOOL_NAMESPACE,
      toolName: names.get(workflow.configObjectId) ?? workflow.configObjectId,
      capability: buildMarketplaceCapabilityName(workflow.pluginId, workflow.configObjectId),
      title: workflow.title,
      description: `Run the saved Workflow "${workflow.title}". ${workflow.description ?? ""}`.trim(),
      inputSchema: isPlainRecord(workflow.inputSchema) ? workflow.inputSchema : { type: "object" },
    })))
  }

  if (wants(APP_TOOL_NAMESPACE)) {
    const apps = await input.apps()
    const names = titledToolNames(apps.map((app) => ({ id: app.appId, title: app.title })))
    candidates.push(...apps.map((app) => ({
      namespace: APP_TOOL_NAMESPACE,
      toolName: names.get(app.appId) ?? app.appId,
      capability: buildMarketplaceCapabilityName(app.pluginId, app.appId),
      title: app.title,
      description: `Open the App "${app.title}". ${app.description ?? ""} Its appId for read_app and update_app is ${app.appId}.`.replace(/\s+/g, " "),
      inputSchema: { type: "object", description: "Optional launch input the App receives." },
      annotations: { readOnlyHint: true },
    })))
  }

  if (member && wants(REMOTE_SESSION_TOOL_NAMESPACE)) {
    candidates.push(...listRemoteSessionCapabilities({ status: ctx.remoteSessionStatusEnabled, answer: ctx.remoteSessionAnswersEnabled }).map((capability) => ({
      namespace: REMOTE_SESSION_TOOL_NAMESPACE,
      toolName: capability.action,
      capability: capability.name,
      title: `Remote session: ${capability.action}`,
      description: capability.summary,
      inputSchema: capability.argumentsSchema,
      annotations: { readOnlyHint: READ_ONLY_REMOTE_SESSION_ACTIONS.has(capability.action) },
    })))
  }

  if (wants(OPENWORK_BOT_TOOL_NAMESPACE) && slackSendAsBotAvailable(ctx)) {
    candidates.push({
      namespace: OPENWORK_BOT_TOOL_NAMESPACE,
      toolName: SLACK_SEND_AS_BOT_CAPABILITY,
      capability: SLACK_SEND_AS_BOT_CAPABILITY,
      title: "Send a Slack message as the OpenWork bot",
      description: SLACK_SEND_AS_BOT_SUMMARY,
      inputSchema: SLACK_SEND_AS_BOT_ARGUMENTS_SCHEMA,
      annotations: { readOnlyHint: false, openWorldHint: true },
    })
  }

  const { pendingSources, pending } = readyIds
    ? pendingConnections(namespaceContext, external, readyIds)
    : { pendingSources: new Map<string, PendingSource>(), pending: [] }

  return {
    tools: buildConnectFullTools(candidates),
    pending: pending.map(({ namespace, name }) => ({ namespace, name })),
    showPending: async (connection) => {
      const id = pending.find((entry) => entry.namespace === connection.namespace)?.id
      const source = id ? pendingSources.get(id) : undefined
      if (source?.kind === "externalMcp") {
        // The live probe and card the connection's status capability returns.
        return input.execute({ name: buildExternalCapabilityName(source.connection.id, "*") })
      }
      const status = source?.kind === "native" ? connectionStatusMatch(source.entry, 1).connectionStatus : undefined
      if (!status) return { isError: true, content: [{ type: "text", text: `${connection.namespace} has no pending connection.` }] }
      const payload = connectionActionPayloadFromStatus(status)
      return {
        content: [{ type: "text", text: connectionActionTextFallback(payload) }],
        structuredContent: { ...payload },
        _meta: connectionActionAppMeta(payload.connectionId),
      }
    },
  }
}
