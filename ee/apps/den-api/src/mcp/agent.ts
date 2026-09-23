import { createHash } from "node:crypto"
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  type ToolAnnotations,
} from "@modelcontextprotocol/server"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { openworkCloudMcpConnectionActionSchema } from "@openwork/types/den/mcp-connection-action"
import type { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { z } from "zod"
import { connectorCatalogSchema, type ConnectorCatalog } from "@openwork/types/connection-action-app"
import { connectorCatalogForQuery } from "./connector-catalog.js"
import { registerAgentConnectionActionApp } from "./connection-action-app.js"
import { publicRoute, tokenRoute } from "../middleware/index.js"
import { db } from "../db.js"
import { getMcpResourceContext, verifyMcpRequest } from "./auth.js"
import { DEN_MCP_APP_HOST_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"
import { getCatalog, protectedResourceMetadata, protectedResourceMetadataRoute } from "./index.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { createScopedAgentMcpHttpHandlers } from "./agent-http.js"
import { rejectStandaloneSseResponse } from "./standalone-sse.js"
import { appLogger } from "../observability/logger.js"
import {
  compareCapabilityMatches,
  EXECUTE_CAPABILITY_TOOL_NAME,
  SEARCH_CAPABILITIES_TOOL_NAME,
  type CapabilityMatch,
} from "./search.js"
import { resolveMcpMemberIdentity } from "./external-capabilities.js"
import { executeMarketplaceCapability, listAccessibleMarketplaceSkillDescriptors, parseMarketplaceCapabilityName, type RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { automationService } from "../automations/service.js"
import { AGENT_AUTOMATION_INDEX_LIMIT, registerAgentAutomationResources } from "./automation-index.js"
import { env } from "../env.js"
import { getOrganizationContextForUser, listTeamsForMember } from "../orgs.js"
import { executeLiveArtifactWorkflow, getWorkflowDetail, getWorkflowSnapshot } from "../workflows.js"
import { artifactFreshness } from "../workflow-artifacts.js"
import { PluginArchAuthorizationError, requirePluginArchCapability } from "../routes/org/plugin-system/access.js"
import {
  WORKFLOW_ARTIFACT_APP_SCHEMA_VERSION,
  workflowArtifactAppServerCapabilities,
  registerAgentWorkflowArtifactApp,
} from "./workflow-artifact-app.js"
import {
  executeBuiltinSkillCapability,
  listBuiltinSkillDescriptors,
} from "./builtin-skills.js"
import {
  buildCapabilityToolTree,
  liveArtifactConnectionFailure,
  createCapabilityRegistryContext,
  executeCapability,
  externalCapabilityErrorToolResult,
  externalCapabilitySuccessToolResult,
  searchCapabilityRegistry,
  type ExecuteCapabilityToolResult,
} from "./capability-registry.js"
import { executeWorkflowAuthoringTest, workflowAuthoringTestInputSchema } from "./workflow-authoring-test.js"
import { parseNativeCapabilityName } from "./native-capabilities.js"
import { gmailFileInputPreflightSchema } from "../capability-sources/gmail-file-input.js"
import { recordWorkflowRun } from "../workflow-runs.js"
import {
  activateArtifactViewRevision,
  getGeneratedArtifactViewRevision,
  listArtifactViews,
  loadArtifactViewRevision,
  readArtifactViewSource,
  retireArtifactView,
  saveArtifactViewRevision,
} from "../artifact-views.js"
import {
  registerAgentGeneratedArtifactViews,
  registerGeneratedArtifactResource,
} from "./generated-artifact-views.js"
import type { PluginArchActorContext } from "../routes/org/plugin-system/access.js"
import { parseArtifactViewResourceUri } from "../artifact-view-resource.js"
import {
  listUsableExternalMcpConnections,
  readyExternalMcpConnectionsForMember,
} from "../capability-sources/external-mcp-connections.js"
import {
  CONNECT_MCP_APP_HOST_CAPABILITY_HEADER,
  registerConnectMcpServerIndex,
  selectConnectMcpServerIndexConnections,
  supportsConnectMcpAppHost,
} from "./connect-mcp-server-index.js"
import { registerAgentSkillTools } from "./skill-created-app.js"
import { registerAgentSkillCatalogTools, standardSkillMarkdown, type RemoteSkillSource } from "./skill-tools.js"
import {
  connectionActionSearchCard,
  connectionActionAppMeta,
  connectionActionPayloadSchema,
} from "./connection-action.js"
import { needsGeneratedArtifactCatalog } from "./generated-artifact-catalog-request.js"
import {
  createConfigObjectVersion,
  createPluginBundle,
  getConfigObjectDetail,
  listConfigObjectPlugins,
  listPluginMemberships,
  PluginArchRouteFailure,
} from "../routes/org/plugin-system/store.js"

const agentMcpLogger = appLogger.child({ component: "agent_mcp" })

export { externalToolContent } from "./tool-content.js"
export { externalCapabilityErrorToolResult, externalCapabilitySuccessToolResult }
export type { ExecuteCapabilityToolResult }

export { EXECUTE_CAPABILITY_TOOL_NAME }
export const EXECUTE_CAPABILITY_SCRIPT_TOOL_NAME = "execute_capability_script"
const searchCapabilityTypeSchema = z.enum(["all", "api", "admin", "mcp", "marketplace", "skills", "connectors"])
export const EXECUTE_CAPABILITY_TIMEOUT_MS = 180_000

export const SEARCH_CAPABILITIES_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}
export const EXECUTE_CAPABILITY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

const connectionStatusOutputSchema = openworkCloudMcpConnectionActionSchema.extend({
  layer: z.enum(["mcp_connection", "downstream_provider"]),
  errorCode: z.enum(["not_connected", "invalid_refresh_token", "invalid_grant", "unauthorized", "provider_error"]),
  message: z.string(),
  action: z.object({
    type: z.enum(["connect", "reconnect", "update_credentials", "inspect_connection", "fix_provider", "fix_network", "contact_openwork"]),
    label: z.string(),
    surface: z.enum(["openwork_your_connections", "openwork_organization_connections", "provider_admin_console", "network_infrastructure", "openwork_support"]),
    retry: z.literal("search_capabilities"),
    url: z.string().url().optional(),
  }),
})

const capabilityMatchOutputSchema = z.object({
  name: z.string(),
  method: z.string(),
  path: z.string(),
  score: z.number(),
  summary: z.string(),
  pathParams: z.array(z.string()),
  queryParams: z.array(z.string()),
  hasBody: z.boolean(),
  bodySchema: z.unknown().optional(),
  querySchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  argumentsSchema: z.unknown().optional(),
  schemaDigest: z.string().optional(),
  invocation: z.object({ argumentsField: z.literal("body") }).optional(),
  kind: z.string().optional(),
  mcpApp: z.object({ resourceUri: z.string() }).optional(),
  status: z.string().optional(),
  hint: z.string().optional(),
  connectionStatus: connectionStatusOutputSchema.optional(),
  scriptPath: z.string().optional(),
}).passthrough()

export const SEARCH_CAPABILITIES_OUTPUT_SCHEMA = z.object({
  matches: z.array(capabilityMatchOutputSchema),
  connectionAction: connectionActionPayloadSchema.optional(),
  connectorCatalog: connectorCatalogSchema.optional(),
  hint: z.string().optional(),
})

export const AGENT_MCP_INSTRUCTIONS = [
  "When asked what can be connected or to browse quick adds, call search_capabilities with type connectors and any descriptive query. This returns the legacy version 1 connectorCatalog envelope, including Google Workspace and Microsoft 365. Released clients may render their existing browse catalog; new clients intentionally ignore it. No new setup card is introduced. Setup options are not executable capabilities or proof of connection. Organization administrators manage setup in the organization Connections dashboard. Named-service searches include legacy setup suggestions only with explicit intent connect, type omitted, all, or mcp, and no matching mcp connection; modern clients ignore these catalogs. Never invent credentials or claim setup is finished. Existing connection actions take priority.",
  "This OpenWork Cloud MCP server uses standard MCP tools, resources, structured results, and list-changed notifications.",
  "For connection actions and saved Workflows, call search_capabilities with 2-4 keyword variants before concluding something is unavailable. Direct MCP tools are not capability search results; call them directly. Use execute_capability only with exact names returned by search_capabilities. A successful search_capabilities call proves this connection is authorized: Never tell the user to reconnect OpenWork Cloud because a downstream connector failed.",
  "Capabilities include native Google Workspace operations (Gmail read/search, Calendar list/create, Drive search/read, and Gmail draft creation) executed with the signed-in member's organization credentials, plus any MCP connections the organization has added. Allowlisted platform admins also discover namespaced OpenWork Admin capabilities here; other members cannot.",
  "A remote session is the member's OpenWork Web instance: a native OpenWork chat running in the cloud, visible in the browser. When asked to do something \"on the remote session\", \"in the web\", or \"in the cloud\" (e.g. \"run a Slack search for messages on the remote session\"), do not do the work here: execute remote-session:create with the whole request as prompt (or remote-session:send to an existing sessionId), then poll remote-session:read and relay the reply. target \"desktop\" runs it on the member's connected desktop instead.",
  "Use create_skill to create one private Cloud skill in a new Plugin, and update_skill to publish a new immutable version of an existing skill. Both return text and structured skill details; do not route these flows through execute_capability, postPlugins, or postConfigObjectsVersions.",
  "Skills have direct tools: list_skills returns every built-in and marketplace skill this member may use, and get_skill returns one skill's SKILL.md by its name or exact capability. Prefer them over keyword search for skills; search_capabilities with type skills and execute_capability still return the same skills, and the skill:// resources are unchanged.",
  "Built-in remote skills create-skill, share-plugin, add-to-marketplace, and add-user-to-marketplace are always listed by list_skills and in the skill index. Retrieve and follow the matching one with get_skill (or by executing its exact capability); do not invent a local copy.",
  "For an app, dashboard, or artifact view of Workflow results, call the direct MCP tool save_artifact_view and follow its prerequisites. It is a Cloud MCP tool, not a desktop-only RPC or a search_capabilities match. Its presence in the available tools confirms availability; an empty capability search does not establish a disabled feature flag. Do not substitute a local HTML file for an in-app artifact. Build the complete app in one shot without asking about Workflow internals, names, or runtime code. Live workflows use server-supplied input.runtime for current dates and caller timezone. Use one friendly name for the workflow and app; the user previews the draft and chooses Save to keep both on their dashboard. Only create an Automation when the user asks for a schedule.",
  "Skills teach how to perform work. Workflows are saved procedures discovered through search_capabilities and run through execute_capability. Author an ad hoc procedure with execute_capability_script; Workflow runs produce artifacts rendered by render_workflow_artifact, and Automations trigger Workflows. To keep a successful Code Mode result, save it as a Workflow inside the existing Plugin the member names (pass that pluginId); omit pluginId only for a private Workflow in their My Workflows Plugin. A Workflow inherits discovery and sharing from its Plugin and Marketplaces; never create a separate Workflow package or marketplace entry.",
  "A match with kind mcp_app is a standard MCP App from a connected MCP server: execute that exact match through execute_capability and let compatible hosts render its ui:// resource. Never import, convert, or browse for a standalone HTML URL instead; standalone URL-imported Apps are not part of this release.",
  "To add a public GitHub plugin to an organization marketplace, search for the marketplace list, GitHub plugin import preview, GitHub plugin marketplace import, and resolved marketplace detail capabilities. Preview first; do not recreate the plugin by hand. Before importing, confirm the target marketplace, selected skill/server keys, and who can use them. Do not choose one authentication type for every server: the import route resolves known presets and plugin declarations, and the request authType is only a fallback for unknown servers.",
  "After importing, retrieve the resolved marketplace detail and report each plugin's cloudReadiness. An import or plugin binding is not proof that an MCP connection is usable: relay needs_admin_setup or needs_signin as the next human action instead of claiming the connection is ready.",
  "Do not invent OAuth-client, credential, or local-extension setup. Organization connections are managed in the OpenWork Cloud dashboard / Settings > Connect; when a connection or marketplace readiness state requires administrator setup or member sign-in, relay that exact action.",
  "External MCP matches include the provider-advertised argumentsSchema, schemaDigest, and invocation.argumentsField. Put an object matching argumentsSchema in execute_capability.body and copy schemaDigest into execute_capability.schemaDigest. OpenWork always attempts the downstream provider call even when local schema checks find a mismatch; schemaGuidance is advisory (returned as openwork/schemaGuidance alongside provider results): if the provider succeeded, accept the result and do not retry because of the warning; if it failed, use the warning to correct the arguments or search again.",
  "If the provider returns invalid_capability_arguments, correct the listed issues and retry once with changed arguments; never retry the same arguments unchanged. If it returns unknown_capability, call search_capabilities again before retrying.",
  "When the user explicitly asks to connect or reconnect a service, search for that service by name with intent connect. Ordinary capability searches must omit intent connect: blocked connection matches are informational and must not trigger sign-in cards or automatic status calls. Only propose authorization when an explicitly requested operation actually depends on that connection. Explicit connection searches render a card when the result identifies one connection. Do not execute the same status again when the search response includes connectionAction. For an explicit connection request without a card, execute that exact status match once. When execute_capability fails with needs_connection or connection_not_connected, execute that connection's status capability (mcp:<connectionId>:*) once for the same card. For member-owned OAuth connections in OpenWork desktop, ask the user to click Connect or Reconnect on the inline card; desktop handles authorization directly, so do not send them to Den. For other actions, name connectionStatus.connectionName and relay connectionStatus.action exactly in text, distinguishing the member's Your Connections page, the organization Connections dashboard, and the provider's own admin console. Probes are live: after the human fixes the connector, search again in the same task; otherwise do not retry unchanged or improvise workarounds through other tools.",
  "Successful postMarketplacesPlugins, postPluginsAccess, and postMarketplacesAccess calls return the ordinary operation response; report the verified outcome in text.",
].join("\n")

async function mcpRequestInfo(request: Request): Promise<{ method: string | null; resourceUri: string | null; generatedCatalog: boolean }> {
  if (request.method.toUpperCase() !== "POST") return { method: null, resourceUri: null, generatedCatalog: false }
  const body: unknown = await request.clone().json().catch(() => null)
  const method = typeof body === "object"
    && body !== null
    && "method" in body
    && typeof body.method === "string"
    ? body.method
    : null
  const params = typeof body === "object" && body !== null && "params" in body && typeof body.params === "object" && body.params !== null
    ? body.params
    : null
  const resourceUri = params && "uri" in params && typeof params.uri === "string" ? params.uri : null
  return { method, resourceUri, generatedCatalog: needsGeneratedArtifactCatalog(method, params) }
}

export const AGENT_SKILL_INDEX_URI = "skill://index.json"
export const AGENT_SKILL_INDEX_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"

export function buildAgentSkillIndex(skills: RemoteSkillDescriptor[]) {
  return {
    $schema: AGENT_SKILL_INDEX_SCHEMA,
    skills: skills.map((skill) => {
      const builtin = executeBuiltinSkillCapability(skill.capability)
      // Include rendered metadata as well as the immutable version identity:
      // a description-only edit also changes the native SKILL.md frontmatter.
      const revision = builtin?.content ?? skill.revision
      return {
        name: skill.name,
        type: "skill-md" as const,
        title: skill.title,
        description: skill.description,
        url: skill.location,
        capability: skill.capability,
        ...(revision ? { revision: createHash("sha256").update(JSON.stringify([skill.name, skill.description, revision])).digest("hex") } : {}),
        ...(skill.marketplaceName ? { marketplaceName: skill.marketplaceName } : {}),
        ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
      }
    }),
  }
}

/** The authorized SKILL.md source behind one listed descriptor, shared by the skill:// resources and get_skill. */
export async function readRemoteSkillSource(input: {
  skill: RemoteSkillDescriptor
  organizationId: string
  member: Awaited<ReturnType<typeof resolveMcpMemberIdentity>>
  marketplaceEnabled?: boolean
}): Promise<RemoteSkillSource> {
  const builtinResult = executeBuiltinSkillCapability(input.skill.capability)
  if (builtinResult) return { content: builtinResult.content, provenance: builtinResult.provenance }
  const marketplace = parseMarketplaceCapabilityName(input.skill.capability)
  if (!marketplace) return null
  const marketplaceResult = await executeMarketplaceCapability({
    organizationId: input.organizationId,
    member: input.member,
    pluginId: marketplace.pluginId,
    configObjectId: marketplace.configObjectId,
    enabled: input.marketplaceEnabled,
  })
  if (!marketplaceResult.ok || marketplaceResult.result.kind !== "skill" || typeof marketplaceResult.result.content !== "string") {
    return null
  }
  return { content: marketplaceResult.result.content, provenance: marketplaceResult.result.provenance }
}

const EXECUTE_CAPABILITY_TIMEOUT_MESSAGE = `The capability call exceeded ${EXECUTE_CAPABILITY_TIMEOUT_MS / 1_000}s. Retry once; if it times out again, narrow the request (fewer results, tighter query) and tell the user the service is slow — do NOT tell them to reconfigure or reconnect.`

function textContent(text: string): { text: string; type: "text" }[] {
  return [{ type: "text", text }]
}

export function capabilitySearchToolResult<T extends CapabilityMatch>(matches: T[], coverageHint?: string, connectorCatalog?: ConnectorCatalog | null, connectionIntent = false) {
  const hint = [
    ...(matches.length === 0 ? [connectorCatalog ? "These are setup suggestions, not connected tools. Use their setup actions; adding a connector requires an organization admin." : "No matches. Try broader or different keywords."] : []),
    ...(coverageHint ? [coverageHint] : []),
  ].join(" ")
  const card = connectionIntent ? connectionActionSearchCard(matches) : null
  const result = {
    matches,
    ...(hint ? { hint } : {}),
    ...(card ? { connectionAction: card } : {}),
    ...(connectorCatalog ? { connectorCatalog } : {}),
  }
  return {
    content: textContent(JSON.stringify(result, null, 2)),
    structuredContent: result,
    ...(card ? { _meta: connectionActionAppMeta(card.connectionId) } : {}),
  }
}

export function connectorSetupToolResult() {
  return capabilitySearchToolResult([], undefined, connectorCatalogForQuery("", true))
}

function capabilityTimeoutResult(capability: string): ExecuteCapabilityToolResult {
  return {
    isError: true,
    content: textContent(JSON.stringify({
      error: "capability_timeout",
      capability,
      message: EXECUTE_CAPABILITY_TIMEOUT_MESSAGE,
    })),
  }
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return true
  }
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return true
  }
  return error instanceof Error && /\b(time(?:d)? out|timeout)\b/i.test(error.message)
}

export async function executeCapabilityWithBudget<T extends ExecuteCapabilityToolResult>(input: {
  capability: string
  timeoutMs?: number
  invoke: () => Promise<T>
}): Promise<T | ExecuteCapabilityToolResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutResult = new Promise<ExecuteCapabilityToolResult>((resolve) => {
    timeout = setTimeout(() => resolve(capabilityTimeoutResult(input.capability)), input.timeoutMs ?? EXECUTE_CAPABILITY_TIMEOUT_MS)
  })
  try {
    const invocation = input.invoke()
    void invocation.catch(() => undefined)
    return await Promise.race([invocation, timeoutResult])
  } catch (error) {
    if (isTimeoutError(error)) {
      return capabilityTimeoutResult(input.capability)
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function createAgentMcpServer(): McpServer {
  return new McpServer({
    name: "openwork-den-api-agent",
    version: "1.0.0",
  }, {
    capabilities: {
      ...workflowArtifactAppServerCapabilities,
      tools: { listChanged: true },
      resources: { listChanged: true },
    },
    instructions: AGENT_MCP_INSTRUCTIONS,
  })
}

export function registerAgentSkillResources(input: {
  server: McpServer
  skills: RemoteSkillDescriptor[]
  organizationId: string
  member: Awaited<ReturnType<typeof resolveMcpMemberIdentity>>
  marketplaceEnabled?: boolean
}) {
  input.server.registerResource("agent-skills-index", AGENT_SKILL_INDEX_URI, {
    title: "Available Agent Skills",
    description: "Authorized Agent Skills discovery index for this OpenWork member.",
    mimeType: "application/json",
  }, async () => ({
    contents: [{
      uri: AGENT_SKILL_INDEX_URI,
      mimeType: "application/json",
      text: JSON.stringify(buildAgentSkillIndex(input.skills)),
    }],
  }))
  for (const skill of input.skills) {
    input.server.registerResource(skill.name, skill.location, {
      title: skill.title,
      description: skill.description,
      mimeType: "text/markdown",
    }, async () => {
      const source = await readRemoteSkillSource({
        skill,
        organizationId: input.organizationId,
        member: input.member,
        marketplaceEnabled: input.marketplaceEnabled,
      })
      if (!source) {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "Skill is no longer available")
      }
      return {
        contents: [{
          uri: skill.location,
          mimeType: "text/markdown",
          text: standardSkillMarkdown(skill, source.content),
        }],
      }
    })
  }
}

/**
 * The minimal, harness-facing MCP surface: two capability-routing tools, one
 * first-party skill creation App, plus gated Code Mode execution and
 * standards-based Artifact presentation.
 *
 * `/mcp` (index.ts) stays exactly as it is — every catalog operation
 * individually registered, ~129 tools today. That's unchanged and still
 * useful for scripts/admin tooling that want to call a known operation by
 * name directly.
 *
 * `/mcp/agent` is a *different* endpoint for a *different* consumer: the
 * desktop app's "OpenWork Cloud Control" connection, which is what an
 * OpenCode/Claude Code/Codex-style harness actually sees. It always registers
 * `search_capabilities`, `execute_capability`, the direct skill tools
 * `list_skills` and `get_skill`, and `create_skill`, and
 * conditionally registers Code Mode and Artifact presentation tools. Workflows
 * remain discoverable and executable through the same capability-routing
 * tools instead of contributing separate contextual tools. The other ~127
 * operations are not individually callable on this endpoint.
 */
export function registerAgentMcpRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(app: Hono<T>) {
  const handlers = createScopedAgentMcpHttpHandlers(
    (error) => agentMcpLogger.warn("Agent MCP transport error", { error }),
  )

  app.get("/.well-known/oauth-protected-resource/mcp/agent", protectedResourceMetadataRoute("agent"), publicRoute, (c) =>
    c.json(protectedResourceMetadata(c.req.raw, "agent")))
  app.get("/mcp/agent/.well-known/oauth-protected-resource", protectedResourceMetadataRoute("agent"), publicRoute, (c) =>
    c.json(protectedResourceMetadata(c.req.raw, "agent")))

  app.all("/mcp/agent", tokenRoute, async (c) => {
    const requestIdValue = c.get("requestId")
    const requestId = typeof requestIdValue === "string" ? requestIdValue : "unknown"
    const principal = await verifyMcpRequest(
      c.req.raw.headers,
      getMcpResourceContext(c.req.raw, "agent", requestId),
    )
    if (principal instanceof Response) {
      return principal
    }

    if (c.req.method === "GET") {
      return rejectStandaloneSseResponse()
    }

    const preflightResponse = await preflightMcpJsonRpcRequest(c.req.raw, requestId)
    if (preflightResponse) {
      return preflightResponse
    }

    const catalog = await getCatalog(app as unknown as Hono, c.env)
    // External MCP connections are scoped to the calling MEMBER (grants +
    // per-member credentials), not just the org — resolve who this token's
    // user is within the org once per request.
    const memberIdentity = await resolveMcpMemberIdentity({
      userId: principal.userId,
      organizationId: principal.organizationId,
    })
    const notificationScope = `${principal.organizationId}\0${principal.userId}`
    const organizationId = normalizeDenTypeId("organization", principal.organizationId)
    const organizationRows = await db
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)
    const organizationMetadata = organizationRows[0]?.metadata
    const connectMcpAppHostSupported = supportsConnectMcpAppHost(
      c.req.header(CONNECT_MCP_APP_HOST_CAPABILITY_HEADER),
    ) && principal.scopes.has(DEN_MCP_APP_HOST_SCOPE)
    const requestInfo = await mcpRequestInfo(c.req.raw)
    const method = requestInfo.method
    const redirectUriBase = resolvePublicOrigin(c.req.raw, env.apiPublicUrl)
    const capabilityContext = createCapabilityRegistryContext({
      app: app as unknown as Hono,
      env: c.env,
      catalog,
      principal,
      organizationId,
      member: memberIdentity,
      redirectUriBase,
      generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
      organizationMetadata,
      mcpConnectionsGatingEnabled: env.mcpConnectionsGatingEnabled,
    })
    const { externalMcpConnectionsEnabled } = capabilityContext
    // Resolved once per request, and only by the methods that need it: the
    // skill resources at discovery time, and list_skills / get_skill on call.
    let remoteSkillsPromise: Promise<RemoteSkillDescriptor[]> | null = null
    const loadRemoteSkills = (): Promise<RemoteSkillDescriptor[]> => {
      remoteSkillsPromise ??= (async () => [
        ...listBuiltinSkillDescriptors(),
        ...(await listAccessibleMarketplaceSkillDescriptors({
          organizationId: principal.organizationId,
          member: memberIdentity,
          enabled: externalMcpConnectionsEnabled,
        })),
      ].sort((a, b) => a.name.localeCompare(b.name) || a.capability.localeCompare(b.capability)))()
      return remoteSkillsPromise
    }
    let libraryContext: PluginArchActorContext | null = null
    const appCatalogMethod = method === "server/discover"
      || method === "initialize"
      || method === "tools/list"
      || method === "tools/call"
      || method === "resources/list"
      || method === "resources/read"
    if (memberIdentity && appCatalogMethod) {
      const organizationContext = await getOrganizationContextForUser({
        userId: normalizeDenTypeId("user", principal.userId),
        organizationId,
      })
      if (organizationContext) {
        libraryContext = {
          organizationContext,
          memberTeams: await listTeamsForMember({
            organizationId,
            memberId: memberIdentity.orgMembershipId,
          }),
          session: null,
        }
      }
    }
    const artifactContext = libraryContext
    const server = createAgentMcpServer()
    registerAgentConnectionActionApp(server, { organizationId: principal.organizationId, member: memberIdentity })
    if (method === "server/discover" || method === "initialize" || method === "resources/list" || method === "resources/read") {
      if (memberIdentity) {
        // Select before the per-member readiness probes so an ordinary client
        // pays only for the connections it may actually see, and skip the
        // lookup entirely when it can see none.
        const indexReadable = connectMcpAppHostSupported || externalMcpConnectionsEnabled
        const indexCandidates = indexReadable
          ? selectConnectMcpServerIndexConnections({
              appHostClient: connectMcpAppHostSupported,
              memberFacingMcpConnectionsEnabled: externalMcpConnectionsEnabled,
              connections: await listUsableExternalMcpConnections({
                organizationId,
                orgMembershipId: memberIdentity.orgMembershipId,
                teamIds: memberIdentity.teamIds,
              }),
            })
          : []
        registerConnectMcpServerIndex({
          server,
          enabled: indexReadable,
          connections: await readyExternalMcpConnectionsForMember(indexCandidates, memberIdentity.orgMembershipId),
          publicOrigin: redirectUriBase,
        })
      }
      registerAgentSkillResources({
        server,
        skills: await loadRemoteSkills(),
        organizationId: principal.organizationId,
        member: memberIdentity,
        marketplaceEnabled: externalMcpConnectionsEnabled,
      })
      if (env.automations.runtimeEnabled) {
        // Owner-scoped: the index only ever carries this member's own
        // Automations. Without a resolved member there is no owner to scope to,
        // and a failure here must not take the whole connection down.
        const automations = memberIdentity
          ? await automationService.list({
            organizationId: principal.organizationId,
            ownerMemberId: memberIdentity.orgMembershipId,
          }, { limit: AGENT_AUTOMATION_INDEX_LIMIT }).catch(() => null)
          : null
        registerAgentAutomationResources({
          server,
          items: automations?.items ?? [],
          fetchedAt: Date.now(),
        })
      }
    }

    server.registerTool(
      SEARCH_CAPABILITIES_TOOL_NAME,
      {
        title: "Search capabilities",
        description: [
          "Search connection actions, saved Workflows, and skills by keyword.",
          "Direct MCP tools such as create_skill and save_artifact_view are outside this search; call an available direct tool itself. For an app, dashboard, or artifact view of Workflow results, use save_artifact_view and follow its prerequisites.",
          "Search covers native Google Workspace capabilities (Gmail, Calendar, Drive, Gmail drafts), org-connected external MCPs, and namespaced OpenWork Admin tools for allowlisted platform admins.",
          "Accessible Workflows appear as marketplace matches with kind workflow and execute through execute_capability like every other exact search result.",
          "Try 2-4 keyword variants before deciding a capability is unavailable.",
          "Native API matches include a connector-namespaced name, pathParams, queryParams, querySchema, hasBody, and bodySchema. External MCP matches include argumentsSchema, schemaDigest, and invocation.argumentsField. A match with kind mcp_app is a standard MCP App launch capability from a connected MCP server; execute it normally and the OpenWork host will render its advertised ui:// resource.",
          "Built-in and marketplace skill matches return SKILL.md content when executed; list_skills and get_skill are the direct, keyword-free way to reach skills.",
        ].join(" "),
        annotations: SEARCH_CAPABILITIES_ANNOTATIONS,
        _meta: { ui: { visibility: ["model", "app"] } },
        inputSchema: z.object({
          intent: z.enum(["discover", "connect"]).optional().describe("Use connect only when the user explicitly asks to connect, reconnect, or set up a service. Ordinary capability discovery must omit this or use discover; it will not show sign-in cards."),
          query: z.string().min(1).describe("Keywords describing the capability you need, e.g. \"create organization\" or \"list workers\"."),
          limit: z.number().int().min(1).max(20).optional().describe("Max number of matches to return. Defaults to 5."),
          type: searchCapabilityTypeSchema.optional().describe("Optional source filter. all searches every available source; api searches Den API capabilities; admin searches allowlisted platform-admin tools; mcp searches connected external MCP tools; marketplace searches marketplace plugin capabilities; skills searches built-in and marketplace skills; connectors returns the legacy browse catalog envelope without probing connected tools; released clients may render it and new clients ignore it. Defaults to all."),
        }),
        outputSchema: SEARCH_CAPABILITIES_OUTPUT_SCHEMA,
      },
      async ({ query, limit, type, intent }) => {
        if (type === "connectors") return connectorSetupToolResult()
        const boundedLimit = limit ?? 5
        const result = await searchCapabilityRegistry(capabilityContext, { query, limit: boundedLimit, type })
        const matches = result.matches.sort(compareCapabilityMatches).slice(0, boundedLimit)
        return capabilitySearchToolResult(matches, result.externalCoverageHint, intent === "connect" && (type === undefined || type === "all" || type === "mcp") && !matches.some(match => match.name.startsWith("mcp:")) ? connectorCatalogForQuery(query) : null, intent === "connect")
      },
    )

    server.registerTool(
      EXECUTE_CAPABILITY_TOOL_NAME,
      {
        title: "Execute capability",
        description: [
          "Call a capability found via search_capabilities, by its exact name.",
          "Pass path/query/body only as described by that match's pathParams/queryParams/hasBody.",
          "For external MCP capabilities, provider-advertised schema mismatches are returned as advisory schemaGuidance alongside the provider result; they do not block the downstream call.",
          "When the exact capability is a standard MCP App launch tool, this call preserves its originating tool and ui:// binding so compatible OpenWork hosts render it without requiring a generated direct-tool name.",
          "For skill capabilities listed in the remote skill catalog, this returns their authorized SKILL.md content; get_skill reads the same content by skill name without a search.",
          "Returns unknown_capability if name doesn't match a current capability — call search_capabilities again.",
        ].join(" "),
        annotations: EXECUTE_CAPABILITY_ANNOTATIONS,
        _meta: { ui: { visibility: ["model", "app"] } },
        inputSchema: z.object({
          name: z.string().min(1).describe("The exact tool name returned by search_capabilities."),
          schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional().describe("For an external MCP match, copy the exact schemaDigest returned by search_capabilities so schema drift can be reported as advisory guidance without blocking the provider call."),
          path: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Path parameters, only if the match's pathParams is non-empty."),
          query: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Query parameters, only if the match's queryParams is non-empty."),
          body: z.unknown().optional().describe("For native API capabilities, the JSON body. For external MCP capabilities, the arguments object matching argumentsSchema."),
        }),
      },
      async ({ name, schemaDigest, path, query, body }) => {
        const result = await executeCapabilityWithBudget({
          capability: name,
          invoke: async (): Promise<ExecuteCapabilityToolResult> => (
            executeCapability(capabilityContext, { name, schemaDigest, path, query, body })
          ),
        })
        // Only this direct call may hand off to the host's fixed Gmail upload
        // action. Keep the explicit no-draft failure body; scripts stay errors.
        const native = parseNativeCapabilityName(name)
        if (result.isError === true
          && native?.toolName === "postCapabilitiesGoogleWorkspaceGmailDrafts"
          && (native.connectionId === "google-workspace" || /^emc_[0-9a-hjkmnp-tv-z]{26}$/.test(native.connectionId))
          && result.content.length === 1) {
          const part = result.content[0]
          if (part?.type === "text") {
            try {
              if (gmailFileInputPreflightSchema.safeParse(JSON.parse(part.text)).success) {
                return { ...result, isError: false }
              }
            } catch {
              // Non-JSON and unrelated errors retain their original transport.
            }
          }
        }
        return result
      },
    )

    registerAgentSkillCatalogTools({
      server,
      listSkills: loadRemoteSkills,
      readSkill: (skill) => readRemoteSkillSource({
        skill,
        organizationId: principal.organizationId,
        member: memberIdentity,
        marketplaceEnabled: externalMcpConnectionsEnabled,
      }),
    })

    registerAgentSkillTools({
      server,
      create: async ({ pluginName, skillMarkdown }) => {
        if (!principal.scopes.has(DEN_MCP_WRITE_SCOPE)) {
          return {
            ok: false,
            error: "insufficient_mcp_scope",
            message: `Creating a skill requires the ${DEN_MCP_WRITE_SCOPE} scope.`,
          }
        }
        if (!libraryContext) {
          return {
            ok: false,
            error: "mcp_membership_revoked",
            message: "The OpenWork Cloud membership for this connection is unavailable.",
          }
        }
        try {
          await requirePluginArchCapability(libraryContext, "plugin.create", false)
          await requirePluginArchCapability(libraryContext, "config_object.create", false)
          const plugin = await createPluginBundle({
            context: libraryContext,
            name: pluginName,
            components: [{ type: "skill", value: { rawSourceText: skillMarkdown } }],
          })
          const memberships = await listPluginMemberships({
            context: libraryContext,
            pluginId: plugin.id,
            includeConfigObjects: true,
            onlyActive: true,
          })
          const skill = memberships.items
            .map((membership) => membership.configObject)
            .find((configObject) => configObject?.objectType === "skill")
          if (!skill || !skill.description) {
            return {
              ok: false,
              error: "skill_creation_incomplete",
              message: "The Plugin was created, but its skill could not be resolved.",
            }
          }
          return {
            ok: true,
            payload: {
              schemaVersion: "1",
              name: skill.title,
              pluginId: plugin.id,
              skillId: skill.id,
              description: skill.description,
              libraryUrl: new URL(
                `/dashboard/library/plugins/${encodeURIComponent(plugin.id)}`,
                env.betterAuthUrl,
              ).toString(),
            },
          }
        } catch (error) {
          if (error instanceof PluginArchRouteFailure || error instanceof PluginArchAuthorizationError) {
            return { ok: false, error: error.error, message: error.message }
          }
          throw error
        }
      },
      update: async ({ skillId, skillMarkdown, reason }) => {
        if (!principal.scopes.has(DEN_MCP_WRITE_SCOPE)) {
          return {
            ok: false,
            error: "insufficient_mcp_scope",
            message: `Updating a skill requires the ${DEN_MCP_WRITE_SCOPE} scope.`,
          }
        }
        if (!libraryContext) {
          return {
            ok: false,
            error: "mcp_membership_revoked",
            message: "The OpenWork Cloud membership for this connection is unavailable.",
          }
        }
        try {
          const configObjectId = normalizeDenTypeId("configObject", skillId)
          const existing = await getConfigObjectDetail(libraryContext, configObjectId)
          if (existing.objectType !== "skill") {
            return {
              ok: false,
              error: "not_a_skill",
              message: `Config object "${skillId}" is a ${existing.objectType}, not a skill.`,
            }
          }
          const detail = await createConfigObjectVersion({
            context: libraryContext,
            configObjectId,
            reason,
            value: { rawSourceText: skillMarkdown },
          })
          const memberships = await listConfigObjectPlugins({ context: libraryContext, configObjectId })
          const pluginId = memberships.items.find((membership) => membership.removedAt === null)?.pluginId
            ?? memberships.items[0]?.pluginId
          if (!pluginId) {
            return {
              ok: false,
              error: "skill_plugin_missing",
              message: "The skill was updated, but no owning Plugin is visible to you.",
            }
          }
          if (!detail.description) {
            return {
              ok: false,
              error: "skill_update_incomplete",
              message: "The skill was updated, but its description could not be resolved.",
            }
          }
          return {
            ok: true,
            payload: {
              schemaVersion: "1",
              mode: "updated",
              name: detail.title,
              pluginId,
              skillId: detail.id,
              description: detail.description,
              libraryUrl: new URL(
                `/dashboard/library/plugins/${encodeURIComponent(pluginId)}`,
                env.betterAuthUrl,
              ).toString(),
            },
          }
        } catch (error) {
          if (error instanceof PluginArchRouteFailure || error instanceof PluginArchAuthorizationError) {
            return { ok: false, error: error.error, message: error.message }
          }
          throw error
        }
      },
    })

    const loadWorkflowArtifact = async ({
      configObjectId,
      receiptId,
      maxAgeMs,
      expectedOutputSchemaDigest,
      dataMode,
      timeZone,
    }: {
      configObjectId: string
      receiptId?: string
      maxAgeMs?: number
      expectedOutputSchemaDigest?: string
      dataMode?: "live" | "snapshot"
      timeZone?: string
    }) => {
      if (!artifactContext) {
        return {
          ok: false as const,
          error: "workflow_not_found",
          message: "The Workflow is unavailable to this member.",
        }
      }
      try {
        if (dataMode === "live") {
          if (receiptId || !expectedOutputSchemaDigest) {
            return { ok: false as const, error: "invalid_arguments", message: "Live apps require a view schema and do not accept receipt overrides." }
          }
          const execution = await executeLiveArtifactWorkflow({
            context: artifactContext, configObjectId, expectedOutputSchemaDigest, timeZone,
            buildTools: () => buildCapabilityToolTree(capabilityContext),
            describeUnavailable: (missing) => liveArtifactConnectionFailure(capabilityContext, missing),
          })
          if (!execution.ok) return execution
          if (!execution.receiptId) return { ok: false as const, error: "workflow_receipt_unavailable", message: "The live result could not be retained." }
          receiptId = execution.receiptId
        }
        const detail = await getWorkflowDetail({
          context: artifactContext,
          configObjectId,
          maxAgeMs,
        })
        const snapshot = receiptId
          ? await getWorkflowSnapshot({ context: artifactContext, configObjectId, receiptId })
          : detail.latestSuccessfulSnapshot
        if (!snapshot) {
          return {
            ok: false as const,
            error: "workflow_snapshot_not_found",
            message: receiptId
              ? "That immutable artifact snapshot was not found."
              : "This Workflow does not have a successful artifact snapshot yet. Run it explicitly or through its Automation first.",
          }
        }
        if (snapshot.status !== "succeeded" || snapshot.contentDeletedAt !== null
          || snapshot.markdown === null
          || snapshot.resultDigest === null || snapshot.rendererVersion !== "codemode-markdown-v1") {
          return {
            ok: false as const,
            error: "workflow_snapshot_unavailable",
            message: "This artifact snapshot has no readable successful content.",
          }
        }
        if (expectedOutputSchemaDigest && snapshot.outputSchemaDigest !== expectedOutputSchemaDigest) {
          return {
            ok: false as const,
            error: "artifact_view_schema_incompatible",
            message: "This Artifact result does not match the immutable view revision's output schema.",
          }
        }
        const freshness = receiptId
          ? artifactFreshness({
              latestFinishedAt: new Date(snapshot.finishedAt),
              latestStatus: "succeeded",
              latestSuccessfulFinishedAt: new Date(snapshot.finishedAt),
              latestSuccessfulReceiptId: snapshot.receiptId,
              maxAgeMs: Math.min(30 * 24 * 60 * 60_000, Math.max(60_000, maxAgeMs ?? 24 * 60 * 60_000)),
            })
          : detail.freshness
        return {
          ok: true as const,
          markdown: snapshot.markdown,
          payload: {
            schemaVersion: WORKFLOW_ARTIFACT_APP_SCHEMA_VERSION,
            artifact: {
              title: detail.title,
              description: detail.description,
              pluginId: snapshot.pluginId,
              configObjectId: snapshot.configObjectId,
              configObjectVersionId: snapshot.configObjectVersionId,
              receiptId: snapshot.receiptId,
              automationRunId: snapshot.automationRunId,
              source: snapshot.source,
              generatedAt: snapshot.finishedAt,
              resultDigest: snapshot.resultDigest,
              rendererVersion: snapshot.rendererVersion,
              freshness,
            },
            data: snapshot.value,
          },
        }
      } catch (error) {
        if (error instanceof PluginArchAuthorizationError) {
          return {
            ok: false as const,
            error: "workflow_not_found",
            message: "The Workflow is unavailable to this member.",
          }
        }
        const message = error instanceof Error ? error.message : "workflow_not_found"
        return {
          ok: false as const,
          error: message.includes("not_found") ? "workflow_not_found" : message === "artifact_view_schema_incompatible" ? message : "workflow_unavailable",
          message: "The Workflow's retained Artifact could not be loaded.",
        }
      }
    }

    // Keep the generic MCP App tool as the interoperable baseline.
    registerAgentWorkflowArtifactApp({
      server,
      load: loadWorkflowArtifact,
      selectApp: async ({ configObjectId, receiptId }) => {
        if (!artifactContext || !env.generatedArtifactViewsEnabled) return null
        const views = await listArtifactViews({ context: artifactContext, activeOnly: true, savedOnly: true })
        const snapshot = await getWorkflowSnapshot({ context: artifactContext, configObjectId, receiptId })
        if (!snapshot) return null
        for (const view of views) {
          if (view.dataMode === "live" || view.configObjectId !== configObjectId || view.useInWorkflow === false) continue
          const revision = view.revisions.find((entry) => entry.id === view.activeRevisionId)
          if (!revision || revision.buildStatus !== "ready" || revision.retiredAt
            || revision.outputSchemaDigest !== snapshot.outputSchemaDigest) continue
          return { artifactViewId: view.id, viewRevisionId: revision.id, resourceUri: revision.resourceUri, toolName: `render_artifact_${view.id}` }
        }
        return null
      },
    })

    // This server deploys independently from Desktop. Do not advertise or
    // serve bridge-dependent generated views until the compatible Desktop
    // MCP Apps host has been released and the operator enables the rollout.
    if (artifactContext && env.generatedArtifactViewsEnabled) {
      const loadGeneratedResource = async ({ artifactViewId, revisionId }: { artifactViewId: string; revisionId: string }) => {
        const { revision } = await loadArtifactViewRevision({ context: artifactContext, artifactViewId, revisionId })
        if (revision.build_status !== "ready" || !revision.compiled_html || !revision.resource_digest) {
          throw new Error("artifact_view_revision_not_ready")
        }
        return { html: revision.compiled_html, resourceDigest: revision.resource_digest, csp: revision.csp }
      }
      const generatedViews = requestInfo.generatedCatalog ? await listArtifactViews({ context: artifactContext }) : []
      registerAgentGeneratedArtifactViews({
        server,
        views: generatedViews,
        loadResource: loadGeneratedResource,
        loadData: loadWorkflowArtifact,
        readSource: (request) => readArtifactViewSource({ context: artifactContext, ...request }),
        save: (request) => saveArtifactViewRevision({ context: artifactContext, ...request }),
        activate: (request) => activateArtifactViewRevision({ context: artifactContext, ...request }),
        retire: (request) => retireArtifactView({ context: artifactContext, ...request }),
        notifyCatalogChanged: () => {
          handlers.notify.toolsChanged(notificationScope)
          handlers.notify.resourcesChanged(notificationScope)
        },
      })

      const exactResource = requestInfo.resourceUri ? parseArtifactViewResourceUri(requestInfo.resourceUri) : null
      if (exactResource && !generatedViews.some((view) => view.revisions.some((revision) => revision.resourceUri === requestInfo.resourceUri))) {
        const exact = await getGeneratedArtifactViewRevision({ context: artifactContext, ...exactResource })
        registerGeneratedArtifactResource({
          server,
          view: exact.view,
          revision: exact.revision,
          loadResource: loadGeneratedResource,
        })
      }
    }

    server.registerTool(
      EXECUTE_CAPABILITY_SCRIPT_TOOL_NAME,
      {
        title: "Execute capability script",
        description: [
          "Test a confined JavaScript function body; end with return of JSON-safe data. No imports, fetch, process or host access; use tools for external work and Promise.all for independent calls.",
          "mode defaults to adhoc with optional input parameters. Explicit live mode is Den-authorized read-only, rejects all caller input, and supplies only input.runtime.{now,today,dayStart,dayEnd,timeZone} from the server; optional IANA timeZone defaults to UTC and is live-only.",
          "Use exact scriptPath from search_capabilities, never guessed namespaces or operation names. For a discovered Den/native path call it with {path:{...},query:{...},body:{...}} only as advertised; native query parameters must be wrapped in query, e.g. {query:{q:input.query}}. External MCP paths take their argumentsSchema object directly.",
          "Example adhoc code: return 1 + 1. Example live code: return {today:input.runtime.today}. tools.$codemode.search({query}) is for adhoc exploration; saved Workflows must call discovered paths directly.",
          "Optional inputSchema is checked before dispatch and outputSchema after execution; inspect discovered outputSchema for result shape rather than guessing. Successful tests return value plus authoring-test metadata and receiptId; source retention availability/scope controls whether saveWorkflow can reuse that receipt. This is not a saved Workflow artifact snapshot. For live apps: test with mode:live and outputSchema, saveWorkflow with receiptId and the same schemas (omit code/currentInput), run the saved version with mode:live and timeZone, then save_artifact_view for draft preview; the user chooses Save.",
        ].join(" "),
        annotations: EXECUTE_CAPABILITY_ANNOTATIONS,
        inputSchema: workflowAuthoringTestInputSchema,
      },
      async (request) => executeCapabilityWithBudget({
        capability: EXECUTE_CAPABILITY_SCRIPT_TOOL_NAME,
        invoke: () => executeWorkflowAuthoringTest(request, {
          organizationId,
          orgMembershipId: memberIdentity?.orgMembershipId,
          buildTools: () => buildCapabilityToolTree(capabilityContext),
          recordRun: (receipt) => recordWorkflowRun(db, receipt),
        }),
      }),
    )

    return await handlers.fetch(notificationScope, c.req.raw, server)
  })
}
