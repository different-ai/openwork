import { createAgentMcpServer } from "./agent-server.js"
export { createAgentMcpServer, AGENT_MCP_INSTRUCTIONS, LEGACY_AGENT_MCP_INSTRUCTIONS, AGENT_MCP_GUIDANCE_URI } from "./agent-server.js"
import { appAuthoringStarter, registerAppStarterResources } from "./app-authoring-starter.js"
import { startMcpAppTiming } from "@openwork/types/mcp-app-timing"
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  type ToolAnnotations,
} from "@modelcontextprotocol/server"
import { eq } from "@openwork-ee/den-db/drizzle"
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
import { getMcpResourceContext, isFirstPartyMcpPrincipal, mcpPrincipalCredentialId, verifyMcpRequest } from "./auth.js"
import { AUDIT_UNAVAILABLE_TOOL_MESSAGE, AuditUnavailableError, auditUnavailableToolResult, mcpAuditPrincipal, runMcpServiceAction, serviceAuditResourceId, serviceErrorStatus, toolResultStatus } from "../audit/mcp-service-audit.js"
import { DEN_MCP_APP_HOST_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"
import { getCatalog, protectedResourceMetadata, protectedResourceMetadataRoute } from "./index.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { createScopedAgentMcpHttpHandlers, type AgentMcpAudience } from "./agent-http.js"
import { connectToolView, connectToolViewOverride, isOpenWorkEngineClient, requestClientInfo, type ConnectClientInfo } from "./connect-tool-view.js"
import { CONNECTION_STATUS_TOOL_NAME, registerConnectFullTools, registerConnectionStatusTool, type CapabilityCall } from "./connect-full-tools.js"
import { connectFullToolNamespace, loadConnectFullTools, loadConnectServices, type ConnectFullToolScope } from "./connect-full-tool-sources.js"
import { engineToolName, withRelatedWords } from "./engine-tool-view.js"
import { rejectStandaloneSseResponse } from "./standalone-sse.js"
import { appLogger } from "../observability/logger.js"
import {
  compareCapabilityMatches,
  EXECUTE_CAPABILITY_TOOL_NAME,
  SEARCH_CAPABILITIES_TOOL_NAME,
  type CapabilityMatch,
} from "./search.js"
import { resolveMcpMember, resolveMcpMemberIdentity } from "./external-capabilities.js"
import { executeMarketplaceCapability, listAccessibleMarketplaceSkillDescriptors, listAccessibleMarketplaceSkillSources, parseMarketplaceCapabilityName, type RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { registerSkillsExtension, resolveSkills, type ResolvedSkill } from "./skills-extension.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { automationService } from "../automations/service.js"
import { AGENT_AUTOMATION_INDEX_LIMIT, registerAgentAutomationResources } from "./automation-index.js"
import { env } from "../env.js"
import { getOrganizationFeatures } from "../features.js"
import { getOrganizationContextForUser } from "../orgs.js"
import { executeLiveArtifactWorkflow, getWorkflowDetail, getWorkflowSnapshot } from "../workflows.js"
import { artifactFreshness } from "../workflow-artifacts.js"
import { PluginArchAuthorizationError, requirePluginArchCapability } from "../routes/org/plugin-system/access.js"
import {
  WORKFLOW_ARTIFACT_APP_SCHEMA_VERSION,
  registerAgentWorkflowArtifactApp,
} from "./workflow-artifact-app.js"
import {
  executeBuiltinSkillCapability,
  listBuiltinSkillDescriptors,
} from "./builtin-skills.js"
import {
  buildCapabilityToolTree,
  capabilitySearchMatch,
  liveArtifactConnectionFailure,
  createCapabilityRegistryContext,
  executeCapability,
  externalCapabilityErrorToolResult,
  externalCapabilitySuccessToolResult,
  searchCapabilityRegistry,
  slackSendAsBotAvailable,
  withUsageSource,
  workflowExecutionAuditStatus,
  type ExecuteCapabilityToolResult,
} from "./capability-registry.js"
import { executeWorkflowAuthoringTest, workflowAuthoringTestInputSchema, workflowAuthoringTestOutputSchema } from "./workflow-authoring-test.js"
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
  connectMcpServerIndexAppCapacity,
  registerConnectMcpServerIndex,
  selectConnectMcpServerIndexConnections,
  supportsConnectMcpAppHost,
  supportsConnectNativeSkills,
} from "./connect-mcp-server-index.js"
import { registerAgentSkillTools } from "./skill-created-app.js"
import { registerAgentSkillCatalogTools, standardSkillMarkdown, type RemoteSkillSource } from "./skill-tools.js"
import { isSkillDocumentUri, readCachedSkill, rememberSkillRead, skillReadResponse } from "./skill-read-cache.js"
import {
  parseSkillSyncRequest,
  skillBatchResponse,
  skillIndexChanges,
  unchangedSkillIndexResponse,
  type SkillSyncRequest,
} from "./skill-index-sync.js"
import { cache } from "../cache.js"
import {
  connectionActionSearchCard,
  connectionActionAppMeta,
  connectionActionPayloadSchema,
} from "./connection-action.js"
import { needsGeneratedArtifactCatalog } from "./generated-artifact-catalog-request.js"
import { AppBuilderError, mcpAppLaunchResult, registerAppBuilderTools, searchMcpApps } from "./app-builder-tools.js"
import { resolveMcpAppTools } from "./app-tools.js"
import { createMcpApp, isActiveMcpApp, listAccessibleMcpApps, loadMcpAppServerDefinition, McpAppError, readMcpApp, updateMcpApp, type McpAppEntry } from "../mcp-apps.js"
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
    askForKey: z.object({
      capability: z.literal("postMcpConnectionsCredentialPrompt"),
      path: z.object({ connectionId: z.string() }),
      body: z.object({ scope: z.enum(["shared", "personal"]) }),
    }).optional(),
  }),
})

// Matches take the MCP tool shape with `connectStandardTools`, and keep the older
// fields either way for desktops released before it.
const capabilityMatchOutputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  score: z.number().optional(),
  summary: z.string().optional(),
  pathParams: z.array(z.string()).optional(),
  queryParams: z.array(z.string()).optional(),
  hasBody: z.boolean().optional(),
  bodySchema: z.unknown().optional(),
  querySchema: z.unknown().optional(),
  argumentsSchema: z.unknown().optional(),
  invocation: z.object({ argumentsField: z.literal("body") }).optional(),
  readOnly: z.boolean().optional(),
  outputSchema: z.unknown().optional(),
  annotations: z.object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  }).optional(),
  schemaDigest: z.string().optional(),
  kind: z.string().optional(),
  mcpApp: z.object({ resourceUri: z.string() }).optional(),
  status: z.string().optional(),
  hint: z.string().optional(),
  connectionStatus: connectionStatusOutputSchema.optional(),
  scriptPath: z.string().optional(),
}).passthrough()

const legacyCapabilityMatchOutputSchema = z.object({
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
  readOnly: z.boolean().optional(),
  kind: z.string().optional(),
  mcpApp: z.object({ resourceUri: z.string() }).optional(),
  status: z.string().optional(),
  hint: z.string().optional(),
  connectionStatus: connectionStatusOutputSchema.optional(),
  scriptPath: z.string().optional(),
}).passthrough()

export const MCP_TOOL_SEARCH_CAPABILITIES_OUTPUT_SCHEMA = z.object({
  matches: z.array(capabilityMatchOutputSchema),
  connectionAction: connectionActionPayloadSchema.optional(),
  connectorCatalog: connectorCatalogSchema.optional(),
  hint: z.string().optional(),
})

export const SEARCH_CAPABILITIES_OUTPUT_SCHEMA = z.object({
  matches: z.array(legacyCapabilityMatchOutputSchema),
  connectionAction: connectionActionPayloadSchema.optional(),
  connectorCatalog: connectorCatalogSchema.optional(),
  hint: z.string().optional(),
})

async function mcpRequestInfo(request: Request): Promise<{
  id: string | number | null
  method: string | null
  resourceUri: string | null
  generatedCatalog: boolean
  toolName: string | null
  clientInfo: ConnectClientInfo | null
  skillSync: SkillSyncRequest | null
}> {
  if (request.method.toUpperCase() !== "POST") return { id: null, method: null, resourceUri: null, generatedCatalog: false, toolName: null, clientInfo: null, skillSync: null }
  const body: unknown = await request.clone().json().catch(() => null)
  const id = typeof body === "object" && body !== null && "id" in body && (typeof body.id === "string" || typeof body.id === "number")
    ? body.id
    : null
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
  const toolName = method === "tools/call" && params && "name" in params && typeof params.name === "string" ? params.name : null
  return {
    id, method, resourceUri, generatedCatalog: needsGeneratedArtifactCatalog(method, params), toolName, clientInfo: requestClientInfo(params),
    skillSync: method === "resources/read" ? parseSkillSyncRequest(params) : null,
  }
}

export const AGENT_SKILL_INDEX_URI = "skill://index.json"
export const AGENT_SKILL_INDEX_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"

/**
 * The skill index. With `resolved`, the index
 * says `delivery: "native"` and each entry carries its SKILL.md digest and size,
 * or why it is withheld, so OpenWork can load skills as native ones and re-read
 * a skill only when its digest changes.
 */
export function buildAgentSkillIndex(skills: RemoteSkillDescriptor[], resolved?: ResolvedSkill[]) {
  const byCapability = new Map(resolved?.map((entry) => [entry.skill.capability, entry]))
  const listed = resolved ? skills.filter((skill) => byCapability.has(skill.capability)) : skills
  return {
    $schema: AGENT_SKILL_INDEX_SCHEMA,
    ...(resolved ? { delivery: "native" as const } : {}),
    skills: listed.map((skill) => {
      const entry = byCapability.get(skill.capability)
      return {
        name: skill.name,
        type: "skill-md" as const,
        title: skill.title,
        description: skill.description,
        modelDiscovery: true,
        url: skill.location,
        capability: skill.capability,
        ...(skill.marketplaceName ? { marketplaceName: skill.marketplaceName } : {}),
        ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
        ...(entry?.content ? { digest: entry.content.digest, size: entry.content.size } : {}),
        ...(entry?.blocked ? { setup: entry.blocked } : {}),
      }
    }),
  }
}

/** Every listed skill's authorized source in one pass: built-ins in memory, marketplace skills batched, no Library use recorded. */
export async function resolveAgentSkills(input: {
  skills: RemoteSkillDescriptor[]
  organizationId: string
  member: Awaited<ReturnType<typeof resolveMcpMemberIdentity>>
}): Promise<ResolvedSkill[]> {
  const marketplace = await listAccessibleMarketplaceSkillSources({ organizationId: input.organizationId, member: input.member })
  const sources = new Map<string, RemoteSkillSource>(marketplace)
  for (const skill of input.skills) {
    const builtin = executeBuiltinSkillCapability(skill.capability)
    if (builtin) sources.set(skill.capability, { content: builtin.content, provenance: builtin.provenance })
  }
  return resolveSkills(input.skills, sources)
}

/** The authorized SKILL.md source behind one listed descriptor, shared by the skill:// resources and get_skill. */
export async function readRemoteSkillSource(input: {
  skill: RemoteSkillDescriptor
  organizationId: string
  member: Awaited<ReturnType<typeof resolveMcpMemberIdentity>>
  /**
   * Whether this read is a Library use. get_skill is the agent loading a skill
   * to follow it; a skill:// resource read is how hosts fetch skills ahead of
   * time (OpenWork prefetches every listed one), so it is not.
   */
  recordUse: boolean
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
    ...(input.recordUse ? { usageSource: "agent" as const } : {}),
  })
  if (!marketplaceResult.ok || marketplaceResult.result.kind !== "skill") return null
  const result = marketplaceResult.result
  if (typeof result.content !== "string") {
    // Listed but withheld until its plugin is set up: say what unblocks it.
    if (typeof result.status === "string" && typeof result.hint === "string") {
      return { blocked: { status: result.status, message: result.hint, action: result.action ?? null } }
    }
    return null
  }
  return { content: result.content, provenance: result.provenance }
}

const EXECUTE_CAPABILITY_TIMEOUT_MESSAGE = `The capability call exceeded ${EXECUTE_CAPABILITY_TIMEOUT_MS / 1_000}s. Retry once; if it times out again, narrow the request (fewer results, tighter query) and tell the user the service is slow — do NOT tell them to reconfigure or reconnect.`

function textContent(text: string): { text: string; type: "text" }[] {
  return [{ type: "text", text }]
}

export function capabilitySearchToolResult<T extends CapabilityMatch>(matches: T[], coverageHint?: string, connectorCatalog?: ConnectorCatalog | null, connectionIntent = false, toolShapes = true) {
  const hint = [
    ...(matches.length === 0 ? [connectorCatalog ? "These are setup suggestions, not connected tools. Use their setup actions; adding a connector requires an organization admin." : "No matches. Try broader or different keywords."] : []),
    ...(coverageHint ? [coverageHint] : []),
  ].join(" ")
  const card = connectionIntent ? connectionActionSearchCard(matches) : null
  const result = {
    matches: toolShapes ? matches.map(capabilitySearchMatch) : matches,
    ...(hint ? { hint } : {}),
    ...(card ? { connectionAction: card } : {}),
    ...(connectorCatalog ? { connectorCatalog } : {}),
  }
  return {
    // Compact: models read it as well as indented JSON, at about a third fewer tokens.
    content: textContent(toolShapes ? JSON.stringify(result) : JSON.stringify(result, null, 2)),
    structuredContent: result,
    ...(card ? { _meta: connectionActionAppMeta(card.connectionId) } : {}),
  }
}

export function connectorSetupToolResult() {
  return capabilitySearchToolResult([], undefined, connectorCatalogForQuery("", true))
}

function capabilityTimeoutResult(capability: string): ExecuteCapabilityToolResult {
  const payload = { error: "capability_timeout", capability, message: EXECUTE_CAPABILITY_TIMEOUT_MESSAGE }
  return { isError: true, content: textContent(JSON.stringify(payload)), structuredContent: payload }
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

export function registerAgentSkillResources(input: {
  server: McpServer
  skills: RemoteSkillDescriptor[]
  organizationId: string
  member: Awaited<ReturnType<typeof resolveMcpMemberIdentity>>
  /** Resolved skills carry digests for native delivery. */
  resolveSkills?: () => Promise<ResolvedSkill[]>
  /** Hears each SKILL.md served, so a repeat read can skip this request's setup (skill-read-cache.ts). */
  onSkillRead?: (uri: string, text: string) => void
  /** The client asked for the index as changes against what it holds (skill-index-sync.ts). */
  indexSync?: { revision: string | null; known?: Record<string, string> }
}) {
  input.server.registerResource("agent-skills-index", AGENT_SKILL_INDEX_URI, {
    title: "Available Agent Skills",
    description: "Authorized Agent Skills discovery index for this OpenWork member.",
    mimeType: "application/json",
  }, async () => {
    const index = buildAgentSkillIndex(input.skills, input.resolveSkills ? await input.resolveSkills() : undefined)
    return {
      contents: [{
        uri: AGENT_SKILL_INDEX_URI,
        mimeType: "application/json",
        text: JSON.stringify(input.indexSync ? skillIndexChanges(index, input.indexSync.revision, input.indexSync.known) : index),
      }],
    }
  })
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
        recordUse: false,
      })
      if (!source) {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "Skill is no longer available")
      }
      if ("blocked" in source) {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, source.blocked.message)
      }
      const text = standardSkillMarkdown(skill, source.content)
      input.onSkillRead?.(skill.location, text)
      return {
        contents: [{
          uri: skill.location,
          mimeType: "text/markdown",
          text,
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
 *
 * Clients that search large tool lists themselves can instead get the full
 * view (connect-tool-view.ts): every capability as its own tool, run by the
 * same executor, in place of search_capabilities and execute_capability.
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

    const requestInfo = await mcpRequestInfo(c.req.raw)
    const method = requestInfo.method
    // The stateless transport only acknowledges this notification; it needs
    // none of the member state below.
    if (method === "notifications/initialized" && requestInfo.id === null) {
      return new Response(null, { status: 202 })
    }
    const organizationId = normalizeDenTypeId("organization", principal.organizationId)
    const skillReadUri = method === "resources/read" && requestInfo.id !== null && isSkillDocumentUri(requestInfo.resourceUri)
      ? requestInfo.resourceUri
      : null
    // Several SKILL.md bodies in one read, or one a message is about to use (skill-index-sync.ts).
    const skillBatch = skillReadUri && requestInfo.skillSync && (requestInfo.skillSync.uris || requestInfo.skillSync.use)
      ? { uris: [...new Set([skillReadUri, ...(requestInfo.skillSync.uris ?? [])])], use: requestInfo.skillSync.use === true }
      : null
    // Read before the index is built, so a write during the build leaves the client one revision behind, not ahead.
    const indexSync = method === "resources/read" && requestInfo.resourceUri === AGENT_SKILL_INDEX_URI ? requestInfo.skillSync : null
    const inventoryRevision = skillReadUri || indexSync ? await cache.inventory.revision(organizationId) : null
    if (indexSync?.revision && indexSync.revision === inventoryRevision && requestInfo.id !== null) {
      return unchangedSkillIndexResponse(requestInfo.id, AGENT_SKILL_INDEX_URI, AGENT_SKILL_INDEX_SCHEMA, inventoryRevision)
    }
    const skillReadKey = skillReadUri && inventoryRevision && !skillBatch
      ? { organizationId, userId: principal.userId, uri: skillReadUri, revision: inventoryRevision }
      : null
    const cachedSkill = skillReadKey ? readCachedSkill(skillReadKey) : null
    if (skillReadKey && cachedSkill !== null && requestInfo.id !== null) {
      return skillReadResponse(requestInfo.id, skillReadKey.uri, cachedSkill)
    }

    const finishIndexTiming = startMcpAppTiming("den.agent-index-read")
    const catalog = await getCatalog(app as unknown as Hono, c.env)
    const organizationFeatures = await getOrganizationFeatures(organizationId, { userId: principal.userId })
    // External MCP connections are scoped to the calling MEMBER (grants +
    // per-member credentials), not just the org — resolve who this token's
    // user is within the org once per request, reusing the features just read.
    const member = await resolveMcpMember({
      userId: principal.userId,
      organizationId: principal.organizationId,
    })
    const memberIdentity = member?.identity ?? null
    const connectMcpAppHostSupported = supportsConnectMcpAppHost(
      c.req.header(CONNECT_MCP_APP_HOST_CAPABILITY_HEADER),
    ) && principal.scopes.has(DEN_MCP_APP_HOST_SCOPE)
    const firstPartyToken = isFirstPartyMcpPrincipal(principal)
    const toolView = connectToolView(requestInfo.clientInfo, {
      enabled: organizationFeatures.connectStandardTools,
      override: connectToolViewOverride(c.req.url),
      firstPartyToken,
      engineTools: organizationFeatures.connectEngineTools,
    })
    // OpenWork's own engine on its rollout: the full view, plus search for what has no tool (engine-tool-view.ts).
    const engineTools = toolView === "full" && organizationFeatures.connectEngineTools
      && isOpenWorkEngineClient(requestInfo.clientInfo, firstPartyToken)
    const audience: AgentMcpAudience = { organizationId, userId: principal.userId, fullTools: toolView === "full" }
    const redirectUriBase = resolvePublicOrigin(c.req.raw, env.apiPublicUrl)
    // Direct service mutations below are audited for the verified token caller
    // (organization claim + active member), never for tool arguments.
    const auditPrincipal = mcpAuditPrincipal({
      organizationId,
      userId: principal.userId,
      memberId: memberIdentity?.orgMembershipId,
      credentialId: mcpPrincipalCredentialId(principal),
    })
    const capabilityContext = createCapabilityRegistryContext({
      app: app as unknown as Hono,
      env: c.env,
      catalog,
      principal,
      organizationId,
      member: memberIdentity,
      redirectUriBase,
      generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
      organizationFeatures,
      audit: auditPrincipal,
      usageSource: "agent",
    })
    // Building your own Apps can be turned off for the deployment; MCP Apps
    // from connected MCP servers work either way.
    const appServersEnabled = env.appMcpServersEnabled
    const toolShapes = organizationFeatures.connectStandardTools
    // Resolved once per request, and only by the methods that need it: the
    // skill resources at discovery time, and list_skills / get_skill on call.
    let remoteSkillsPromise: Promise<RemoteSkillDescriptor[]> | null = null
    const loadRemoteSkills = (): Promise<RemoteSkillDescriptor[]> => {
      remoteSkillsPromise ??= (async () => [
        ...listBuiltinSkillDescriptors(),
        ...(await listAccessibleMarketplaceSkillDescriptors({
          organizationId: principal.organizationId,
          member: memberIdentity,
        })),
      ].sort((a, b) => a.name.localeCompare(b.name) || a.capability.localeCompare(b.capability)))()
      return remoteSkillsPromise
    }
    // Only the skill, App builder, Workflow artifact and artifact view tools act
    // through the organization context, so it loads on first use, once per request.
    let libraryContextPromise: Promise<PluginArchActorContext | null> | null = null
    const loadLibraryContext = (): Promise<PluginArchActorContext | null> => libraryContextPromise ??= (async () => {
      if (!member) return null
      const organizationContext = await getOrganizationContextForUser({
        userId: normalizeDenTypeId("user", principal.userId),
        organizationId,
      })
      return organizationContext ? { organizationContext, memberTeams: member.teams, session: null } : null
    })()
    // Apps built here are each served as their own MCP server; Connect lists
    // them in its server index, finds them in search, and builds them.
    const appAccess = { organizationId: principal.organizationId, member: memberIdentity }
    let mcpAppsPromise: Promise<McpAppEntry[]> | null = null
    const loadMcpApps = () => mcpAppsPromise ??= listAccessibleMcpApps(appAccess).catch((error: unknown) => {
      console.error("mcp_app_listing_failed", { organizationId: principal.organizationId, error: error instanceof Error ? error.message : String(error) })
      return []
    })
    // OpenWork opens an App only through the server index, where Apps fill the
    // room connections leave. Every usable connection may be listed, so only
    // Apps that fit beside all of them are offered to open.
    let openableAppsPromise: Promise<McpAppEntry[]> | null = null
    const loadOpenableApps = () => openableAppsPromise ??= (async () => {
      const apps = await loadMcpApps()
      if (apps.length === 0 || !memberIdentity) return apps
      const connections = await listUsableExternalMcpConnections({
        organizationId,
        orgMembershipId: memberIdentity.orgMembershipId,
        teamIds: memberIdentity.teamIds,
      }).catch((error: unknown) => {
        console.error("mcp_app_capacity_check_failed", { organizationId: principal.organizationId, error: error instanceof Error ? error.message : String(error) })
        return null
      })
      // Without the connection count, offer every App rather than call them all past the limit.
      return connections ? apps.slice(0, connectMcpServerIndexAppCapacity(connections.length)) : apps
    })()
    // Member skill indexes carry digests for OpenWork's native delivery.
    // The MCP Skills Extension is served and session
    // instructions list the member's skills, for every MCP client.
    const nativeSkills = Boolean(memberIdentity)
    const skillsExtension = Boolean(memberIdentity)
    let resolvedSkillsPromise: Promise<ResolvedSkill[]> | null = null
    const loadResolvedSkills = (): Promise<ResolvedSkill[]> => resolvedSkillsPromise ??= (async () => resolveAgentSkills({
      skills: await loadRemoteSkills(),
      organizationId: principal.organizationId,
      member: memberIdentity,
    }))()
    if (skillBatch && requestInfo.id !== null) {
      // Each body is authorized exactly as a single read is. A body for a
      // message that uses the skill is a Library use and is never served from
      // the read cache; a background read is neither.
      const skills = await loadRemoteSkills()
      const contents: Array<{ uri: string; text: string }> = []
      for (const uri of skillBatch.uris) {
        const skill = skills.find((entry) => entry.location === uri)
        if (!skill) continue
        const key = inventoryRevision ? { organizationId, userId: principal.userId, uri, revision: inventoryRevision } : null
        const cached = key && !skillBatch.use ? readCachedSkill(key) : null
        if (cached !== null) {
          contents.push({ uri, text: cached })
          continue
        }
        const source = await readRemoteSkillSource({ skill, organizationId: principal.organizationId, member: memberIdentity, recordUse: skillBatch.use })
        if (!source || "blocked" in source) continue
        const text = standardSkillMarkdown(skill, source.content)
        if (key) rememberSkillRead(key, text)
        contents.push({ uri, text })
      }
      finishIndexTiming()
      return skillBatchResponse(requestInfo.id, contents)
    }
    // execute_capability and every full-view tool run capabilities through this one executor.
    const executeCapabilityTool = async ({ name, arguments: args, schemaDigest, path, query, body }: CapabilityCall & { schemaDigest?: string }) => {
      // A built App opens through its own server; anything unavailable falls
      // through to ordinary execution and its normal error.
      const plugin = appServersEnabled ? parseMarketplaceCapabilityName(name) : null
      const definition = plugin && await isActiveMcpApp({ organizationId: principal.organizationId, appId: plugin.configObjectId })
        ? await loadMcpAppServerDefinition({ ...appAccess, appId: plugin.configObjectId }).catch(() => null)
        : null
      if (definition) {
        const canOpen = (await loadOpenableApps()).some((app) => app.appId === definition.app.appId)
        return mcpAppLaunchResult({ app: definition.app, publicOrigin: redirectUriBase, message: `Opened ${definition.app.title}.`, launchInput: args ?? body, canOpen })
      }
      const result = await executeCapabilityWithBudget({
        capability: name,
        invoke: async (): Promise<ExecuteCapabilityToolResult> => (
          executeCapability(capabilityContext, { name, schemaDigest, path, query, body, ...(args === undefined ? {} : { arguments: args }) })
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
    }
    const loadFullTools = (scope: ConnectFullToolScope) => loadConnectFullTools({
      ctx: capabilityContext,
      scope,
      apps: () => appServersEnabled ? loadOpenableApps() : Promise.resolve([]),
      execute: executeCapabilityTool,
    })
    const advertisesInstructions = method === "initialize" || method === "server/discover"
    // OpenWork's v2 engine already lists these skills natively when Den serves
    // native delivery; listing them again here sends the model to get_skill too.
    const listsSkillsNatively = nativeSkills && supportsConnectNativeSkills(c.req.header(CONNECT_MCP_APP_HOST_CAPABILITY_HEADER))
    const server = createAgentMcpServer({
      appServers: appServersEnabled,
      toolView,
      toolShapes,
      remoteSessionStatus: Boolean(memberIdentity),
      canSendSlackMessages: slackSendAsBotAvailable(capabilityContext),
      myAgent: Boolean(memberIdentity && organizationFeatures.workbotProactive && principal.scopes.has(DEN_MCP_WRITE_SCOPE)),
      skillsExtension,
      skills: skillsExtension && advertisesInstructions && !listsSkillsNatively ? await loadRemoteSkills() : undefined,
      engine: engineTools,
      services: engineTools && advertisesInstructions ? await loadConnectServices(capabilityContext) : undefined,
    })
    if (skillsExtension) registerSkillsExtension(server, loadResolvedSkills)
    registerAgentConnectionActionApp(server, { organizationId: principal.organizationId, member: memberIdentity })
    if (appServersEnabled) {
      const appActor = async (): Promise<PluginArchActorContext> => {
        const context = await loadLibraryContext()
        if (!context) throw new AppBuilderError("mcp_membership_revoked", "The OpenWork Cloud membership for this connection is unavailable.")
        return context
      }
      const appAuditPrincipal = () => {
        if (!auditPrincipal) throw new AppBuilderError("mcp_membership_revoked", "The OpenWork Cloud membership for this connection is unavailable.")
        return auditPrincipal
      }
      const appOperation = async <Result,>(run: () => Promise<Result>): Promise<Result> => {
        try {
          return await run()
        } catch (error) {
          if (error instanceof AuditUnavailableError) throw new AppBuilderError("audit_unavailable", AUDIT_UNAVAILABLE_TOOL_MESSAGE)
          if (error instanceof McpAppError) throw new AppBuilderError(error.code, error.message)
          if (error instanceof PluginArchAuthorizationError) throw new AppBuilderError(error.error, error.message, error.reason)
          if (error instanceof PluginArchRouteFailure) {
            throw new AppBuilderError(error.error, "The App could not be saved. Check the Plugin and your permissions.")
          }
          throw error
        }
      }
      const resolveTools = (tools: Parameters<typeof resolveMcpAppTools>[1]) => resolveMcpAppTools(capabilityContext, tools)
      // In the full view an App's tools may name full-view tools; Apps store the capability.
      // OpenWork's engine shows `linear.list_issues` as `linear_list_issues`, so either name works there.
      const withCapabilities = async <Request extends { tools?: Parameters<typeof resolveMcpAppTools>[1] }>(request: Request): Promise<Request> => {
        const declared = request.tools ?? []
        const namespaces = new Set(declared.flatMap((tool) => connectFullToolNamespace(tool.capability) ?? []))
        const engineNames = engineTools && declared.some((tool) => !/[.:]/.test(tool.capability))
        if (toolView !== "full" || (namespaces.size === 0 && !engineNames)) return request
        const tools = (await loadFullTools(engineNames ? "list" : { namespaces })).tools
        const capabilities = new Map(tools.flatMap((tool) => [[tool.name, tool.capability], [engineToolName(tool.name), tool.capability]] as const))
        return { ...request, tools: declared.map((tool) => ({ ...tool, capability: capabilities.get(tool.capability) ?? tool.capability })) }
      }
      registerAppBuilderTools({
        server,
        scopes: principal.scopes,
        publicOrigin: redirectUriBase,
        service: {
          prepare: (request) => appOperation(async () => {
            await appActor()
            const tools = await resolveTools((await withCapabilities(request)).tools ?? [])
            await appActor()
            return appAuthoringStarter(request, tools)
          }),
          create: (request) => appOperation(async () => {
            const context = await appActor()
            const resolved = await withCapabilities(request)
            return runMcpServiceAction("mcp_app.create", appAuditPrincipal(), null, () => createMcpApp({ ...resolved, context, resolveTools }))
          }),
          update: (request) => appOperation(async () => {
            const context = await appActor()
            const resolved = await withCapabilities(request)
            return runMcpServiceAction("mcp_app.update", appAuditPrincipal(), serviceAuditResourceId(request.appId), () => updateMcpApp({ ...resolved, context, resolveTools }))
          }),
          read: (request) => appOperation(async () => readMcpApp({ ...request, context: await appActor() })),
        },
        canOpen: async (appId) => (await loadOpenableApps()).some((app) => app.appId === appId),
        notifyCatalogChanged: () => {
          mcpAppsPromise = null
          openableAppsPromise = null
          handlers.notify.resourcesChanged(audience)
        },
      })
    }
    // initialize and server/discover advertise static capabilities only, so the
    // connection, App, skill and Automation resources load just for resource reads.
    if (method === "resources/list" || method === "resources/read") {
      if (memberIdentity) {
        // Select before the per-member readiness probes so an ordinary client
        // pays only for the connections it may actually see.
        const indexCandidates = selectConnectMcpServerIndexConnections({
          appHostClient: connectMcpAppHostSupported,
          connections: await listUsableExternalMcpConnections({
            organizationId,
            orgMembershipId: memberIdentity.orgMembershipId,
            teamIds: memberIdentity.teamIds,
          }),
        })
        registerConnectMcpServerIndex({
          server,
          // Only the App host opens Apps; every other reader gets the connection index unchanged.
          ...(appServersEnabled && connectMcpAppHostSupported ? { apps: await loadMcpApps() } : {}),
          connections: await readyExternalMcpConnectionsForMember(indexCandidates, memberIdentity.orgMembershipId),
          publicOrigin: redirectUriBase,
        })
      }
      registerAgentSkillResources({
        server,
        skills: await loadRemoteSkills(),
        organizationId: principal.organizationId,
        member: memberIdentity,
        ...(nativeSkills ? { resolveSkills: loadResolvedSkills } : {}),
        ...(indexSync ? { indexSync: { revision: inventoryRevision, known: indexSync.known } } : {}),
        ...(skillReadKey ? { onSkillRead: (uri: string, text: string) => {
          if (uri === skillReadKey.uri) rememberSkillRead(skillReadKey, text)
        } } : {}),
      })
      if (appServersEnabled) registerAppStarterResources(server)
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

    finishIndexTiming()
    // The search view, and OpenWork's engine for what has no tool of its own.
    if (toolView === "search" || engineTools) {
      server.registerTool(
        SEARCH_CAPABILITIES_TOOL_NAME,
        {
          title: "Search capabilities",
          description: [
            engineTools
              ? "Search OpenWork's own operations and skills by keyword. Connection actions, Workflows, Apps and remote sessions are tools of their own: find those in the Code Mode catalog or with search()."
              : "Search connection actions, saved Workflows, and skills by keyword.",
            appServersEnabled
              ? "Direct tools such as create_skill, get_skill, and the App builders prepare_app, create_app, read_app, and update_app are outside this search; call them directly."
              : "Direct MCP tools such as create_skill and save_artifact_view are outside this search; call an available direct tool itself. For an app, dashboard, or artifact view of Workflow results, use save_artifact_view and follow its prerequisites.",
            ...(engineTools ? [] : [
              "Search covers native Google Workspace capabilities (Gmail, Calendar, Drive, Gmail drafts), org-connected external MCPs, and namespaced OpenWork Admin tools for allowlisted platform admins.",
              "Accessible Workflows appear as marketplace matches with kind workflow and execute through execute_capability like every other exact search result.",
            ]),
            "Try 2-4 keyword variants before deciding a capability is unavailable.",
            ...(toolShapes ? [] : ["Native API matches include a connector-namespaced name, pathParams, queryParams, querySchema, hasBody, and bodySchema. External MCP matches include argumentsSchema, schemaDigest, and invocation.argumentsField."]),
            ...(engineTools ? [] : [appServersEnabled
              ? "A match with kind mcp_app is a standard MCP App launch capability, either an App built in OpenWork (also its own MCP server, named in its description) or an App from a connected MCP server; execute it normally and the OpenWork host will render its advertised ui:// resource."
              : "A match with kind mcp_app is a standard MCP App launch capability from a connected MCP server; execute it normally and the OpenWork host will render its advertised ui:// resource."]),
            toolShapes
              ? "Each match is an MCP tool (name, description, inputSchema, optional outputSchema and annotations) with its kind and connection status where available; call execute_capability with that name and arguments matching inputSchema."
              : "Returns matches with exact name, summary, kind, invocation schemas, and connection status where available.",
            "An optional hint explains coverage or next steps. connectionAction carries an explicit sign-in card; connectorCatalog contains setup suggestions, not executable tools. Built-in and marketplace skills return SKILL.md when executed; list_skills/get_skill reach them directly.",
          ].join(" "),
          annotations: SEARCH_CAPABILITIES_ANNOTATIONS,
          _meta: { ui: { visibility: ["model", "app"] } },
          inputSchema: z.object({
            intent: z.enum(["discover", "connect"]).optional().describe("Use connect only when the user explicitly asks to connect, reconnect, or set up a service. Ordinary capability discovery must omit this or use discover; it will not show sign-in cards."),
            query: z.string().min(1).describe("Keywords describing the capability you need, e.g. \"create organization\" or \"list workers\"."),
            limit: z.number().int().min(1).max(20).optional().describe("Result budget for the highest-ranking capability matches."),
            type: searchCapabilityTypeSchema.optional().describe("Source to search: API operations, platform-admin tools, connected MCPs, marketplace capabilities, or skills. connectors browses setup suggestions without probing tools; all combines accessible sources."),
          }),
          outputSchema: toolShapes ? MCP_TOOL_SEARCH_CAPABILITIES_OUTPUT_SCHEMA : SEARCH_CAPABILITIES_OUTPUT_SCHEMA,
        },
        async ({ query, limit, type, intent }) => {
          if (type === "connectors") return connectorSetupToolResult()
          const boundedLimit = limit ?? 5
          const includeApps = !engineTools && appServersEnabled && (type === undefined || type === "all" || type === "mcp" || type === "marketplace")
          // Generic Marketplace search excludes authored Apps in every rollout state.
          // An explicit connect request still finds the connection, so its card can show.
          const unlistedOnly = engineTools && intent !== "connect"
          const result = await searchCapabilityRegistry(capabilityContext, { query, limit: boundedLimit, type, unlistedOnly })
          const openable = includeApps ? await loadOpenableApps() : []
          const matches = [...result.matches, ...searchMcpApps(openable, query, redirectUriBase)].sort(compareCapabilityMatches).slice(0, boundedLimit)
          return capabilitySearchToolResult(matches, result.externalCoverageHint, intent === "connect" && (type === undefined || type === "all" || type === "mcp") && !matches.some(match => match.name.startsWith("mcp:")) ? connectorCatalogForQuery(query, false) : null, intent === "connect", toolShapes)
        },
      )

      server.registerTool(
        EXECUTE_CAPABILITY_TOOL_NAME,
        {
          title: "Execute capability",
          description: [
            toolShapes
              ? "Call a capability found via search_capabilities, by its exact name, with arguments matching that match's inputSchema."
              : "Call a capability found via search_capabilities, by its exact name. Pass path/query/body only as described by that match's pathParams/queryParams/hasBody.",
            "For external MCP capabilities, provider-advertised schema mismatches are returned as advisory schemaGuidance alongside the provider result; they do not block the downstream call.",
            "When the exact capability is a standard MCP App launch tool, this call preserves its originating tool and ui:// binding so compatible OpenWork hosts render it without requiring a generated direct-tool name.",
            "For skill capabilities listed in the remote skill catalog, this returns their authorized SKILL.md content; get_skill reads the same content by skill name without a search.",
            "Returns the capability's content and, when supplied, its structuredContent unchanged: provider fields, Workflow results, skill content, or an App launch reference. Connection failures can include a connectionAction card; schemaGuidance is advisory. Other failures return isError with the error as text and structuredContent; invalid_capability_arguments lists the issues to correct, and unknown_capability means search again.",
          ].join(" "),
          annotations: EXECUTE_CAPABILITY_ANNOTATIONS,
          _meta: { ui: { visibility: ["model", "app"] } },
          inputSchema: toolShapes ? z.object({
            name: z.string().min(1).describe("Capability identifier from a current search_capabilities match or authorized skill catalog entry."),
            arguments: z.unknown().optional().describe(appServersEnabled
              ? "One object matching the match's inputSchema. For an App (kind mcp_app), an optional launch input object the App receives."
              : "One object matching the match's inputSchema."),
            schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional().describe("Optional schemaDigest from the match, to report schema drift since that search."),
            // Older inputs, accepted for a while; capabilityCallInput explains why.
            path: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Older form of arguments.path; prefer arguments."),
            query: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Older form of arguments.query; prefer arguments."),
            body: z.unknown().optional().describe("Older form of arguments (or arguments.body for an API operation); prefer arguments."),
          }) : z.object({
            name: z.string().min(1).describe("Capability identifier from a current search_capabilities match or authorized skill catalog entry."),
            schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional().describe("For an external MCP match, copy the exact schemaDigest returned by search_capabilities so schema drift can be reported as advisory guidance without blocking the provider call."),
            path: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Values substituted into the native API route placeholders named by the match's pathParams."),
            query: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Native API URL query values used to filter, sort, or page the request, keyed as advertised by the match's querySchema and queryParams."),
            body: z.unknown().optional().describe(appServersEnabled
              ? "For native API capabilities, the JSON body. For external MCP capabilities, the arguments object matching argumentsSchema. For an App (kind mcp_app), an optional launch input object the App receives."
              : "For native API capabilities, the JSON body. For external MCP capabilities, the arguments object matching argumentsSchema."),
            // Desktops built for MCP tool shapes send this whatever the flag says.
            arguments: z.unknown().optional().describe("Alternative to path/query/body: one object holding them for a native API capability, or the arguments object for an external MCP capability."),
          }),
        },
        executeCapabilityTool,
      )
    }
    if (toolView === "full" && (method === "tools/list" || method === "tools/call")) {
      // The full view replaces search_capabilities and execute_capability (except
      // for OpenWork's engine, above). A tools/call loads only what it names;
      // tools/list loads every tool.
      const namespace = requestInfo.toolName ? connectFullToolNamespace(requestInfo.toolName) : null
      const scope: ConnectFullToolScope | null = method === "tools/list" ? "list"
        : requestInfo.toolName === CONNECTION_STATUS_TOOL_NAME ? "status"
          : namespace ? { namespaces: new Set([namespace]) } : null
      if (scope) {
        const full = await loadFullTools(scope)
        // The engine's search knows no synonyms, so its descriptions carry related words.
        const tools = engineTools ? full.tools.map((tool) => ({ ...tool, description: withRelatedWords(tool.description, tool.toolName) })) : full.tools
        registerConnectFullTools({ server, tools, execute: executeCapabilityTool })
        // Only the list and its own call load what is not ready yet.
        if (typeof scope !== "object") registerConnectionStatusTool({ server, pending: full.pending, show: full.showPending })
      }
    }

    registerAgentSkillCatalogTools({
      server,
      listSkills: loadRemoteSkills,
      readSkill: (skill) => readRemoteSkillSource({
        skill,
        organizationId: principal.organizationId,
        member: memberIdentity,
        recordUse: true,
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
        const skillContext = await loadLibraryContext()
        if (!skillContext || !auditPrincipal) {
          return {
            ok: false,
            error: "mcp_membership_revoked",
            message: "The OpenWork Cloud membership for this connection is unavailable.",
          }
        }
        try {
          const plugin = await runMcpServiceAction("plugin.bundle.create", auditPrincipal, null, async () => {
            await requirePluginArchCapability(skillContext, "plugin.create")
            await requirePluginArchCapability(skillContext, "config_object.create")
            return createPluginBundle({
              context: skillContext,
              name: pluginName,
              components: [{ type: "skill", value: { rawSourceText: skillMarkdown } }],
            })
          })
          const memberships = await listPluginMemberships({
            context: skillContext,
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
          if (error instanceof AuditUnavailableError) return { ok: false, error: "audit_unavailable", message: AUDIT_UNAVAILABLE_TOOL_MESSAGE }
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
        const skillContext = await loadLibraryContext()
        if (!skillContext || !auditPrincipal) {
          return {
            ok: false,
            error: "mcp_membership_revoked",
            message: "The OpenWork Cloud membership for this connection is unavailable.",
          }
        }
        try {
          const configObjectId = normalizeDenTypeId("configObject", skillId)
          const versioned = await runMcpServiceAction("skill.version.create", auditPrincipal, serviceAuditResourceId(configObjectId), async () => {
            const existing = await getConfigObjectDetail(skillContext, configObjectId)
            if (existing.objectType !== "skill") return { created: false as const, objectType: existing.objectType }
            return {
              created: true as const,
              detail: await createConfigObjectVersion({
                context: skillContext,
                configObjectId,
                reason,
                value: { rawSourceText: skillMarkdown },
              }),
            }
          }, { result: (value) => value.created ? null : 400 })
          if (!versioned.created) {
            return {
              ok: false,
              error: "not_a_skill",
              message: `Config object "${skillId}" is a ${versioned.objectType}, not a skill.`,
            }
          }
          const detail = versioned.detail
          const memberships = await listConfigObjectPlugins({ context: skillContext, configObjectId })
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
          if (error instanceof AuditUnavailableError) return { ok: false, error: "audit_unavailable", message: AUDIT_UNAVAILABLE_TOOL_MESSAGE }
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
      const artifactContext = await loadLibraryContext()
      if (!artifactContext || !auditPrincipal) {
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
          const execution = await runMcpServiceAction("workflow.execute", auditPrincipal, serviceAuditResourceId(configObjectId), () => executeLiveArtifactWorkflow({
            context: artifactContext, configObjectId, expectedOutputSchemaDigest, timeZone,
            buildTools: () => buildCapabilityToolTree(withUsageSource(capabilityContext, "artifact")),
            describeUnavailable: (missing) => liveArtifactConnectionFailure(capabilityContext, missing),
          }), { result: workflowExecutionAuditStatus, error: serviceErrorStatus })
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
        if (error instanceof AuditUnavailableError) {
          return { ok: false as const, error: "audit_unavailable", message: AUDIT_UNAVAILABLE_TOOL_MESSAGE }
        }
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
        const artifactContext = env.generatedArtifactViewsEnabled ? await loadLibraryContext() : null
        if (!artifactContext) return null
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
    const listsOrCallsGeneratedViews = method === "tools/list" || method === "tools/call"
      || method === "resources/list" || method === "resources/read"
    const artifactContext = env.generatedArtifactViewsEnabled && auditPrincipal && listsOrCallsGeneratedViews
      ? await loadLibraryContext()
      : null
    if (artifactContext && auditPrincipal && env.generatedArtifactViewsEnabled) {
      const artifactAuditPrincipal = auditPrincipal
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
        save: (request) => runMcpServiceAction("artifact_view.save", artifactAuditPrincipal, serviceAuditResourceId(request.artifactViewId),
          () => saveArtifactViewRevision({ context: artifactContext, ...request }), { error: serviceErrorStatus }),
        activate: (request) => runMcpServiceAction("artifact_view.activate", artifactAuditPrincipal, serviceAuditResourceId(request.artifactViewId),
          () => activateArtifactViewRevision({ context: artifactContext, ...request }), { error: serviceErrorStatus }),
        retire: (request) => runMcpServiceAction("artifact_view.deactivate", artifactAuditPrincipal, serviceAuditResourceId(request.artifactViewId),
          () => retireArtifactView({ context: artifactContext, ...request }), { error: serviceErrorStatus }),
        notifyCatalogChanged: () => {
          handlers.notify.toolsChanged(audience)
          handlers.notify.resourcesChanged(audience)
        },
        legacyViewsWritable: !appServersEnabled,
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
          "mode defaults to adhoc with optional input parameters. Explicit live mode can call the same tools as adhoc (including connection tools), rejects all caller input, and supplies only input.runtime.{now,today,dayStart,dayEnd,timeZone} from the server; optional IANA timeZone defaults to UTC and is live-only.",
          toolShapes
            ? "Use exact scriptPath from search_capabilities, never guessed namespaces or operation names. Call a discovered path with the arguments its match's inputSchema describes; OpenWork API operations wrap them in path, query, and body, e.g. {query:{q:input.query}}."
            : "Use exact scriptPath from search_capabilities, never guessed namespaces or operation names. For a discovered Den/native path call it with {path:{...},query:{...},body:{...}} only as advertised; native query parameters must be wrapped in query, e.g. {query:{q:input.query}}. External MCP paths take their argumentsSchema object directly.",
          "Example adhoc code: return 1 + 1. Example live code: return {today:input.runtime.today}. tools.$codemode.search({query}) is for adhoc exploration; saved Workflows must call discovered paths directly.",
          "Optional inputSchema is checked before dispatch and outputSchema after execution; inspect discovered outputSchema rather than guessing. Returns value and metadata: receiptId, mode, executionType, verification, executedAt/fetchedAt, optional timeZone, and retention (scope, ttlMs, available, canSaveByReceipt, and any error/message). Retention determines whether saveWorkflow can reuse the receipt. This is an authoring test, not a saved Workflow artifact snapshot. " + (appServersEnabled
            ? "To back an App with a reusable live procedure: test with mode:live and outputSchema, saveWorkflow with receiptId and the same schemas (omit code/currentInput), then bind that saved Workflow in create_app with mode live."
            : "For live apps: test with mode:live and outputSchema, saveWorkflow with receiptId and the same schemas (omit code/currentInput), run the saved version with mode:live and timeZone, then save_artifact_view for draft preview; the user chooses Save."),
        ].join(" "),
        annotations: EXECUTE_CAPABILITY_ANNOTATIONS,
        inputSchema: workflowAuthoringTestInputSchema,
        outputSchema: workflowAuthoringTestOutputSchema,
      },
      async (request) => executeCapabilityWithBudget({
        capability: EXECUTE_CAPABILITY_SCRIPT_TOOL_NAME,
        invoke: async (): Promise<ExecuteCapabilityToolResult> => {
          if (!auditPrincipal) {
            return { isError: true, content: textContent(JSON.stringify({ error: "membership_required", message: "Workflow tests require an active organization membership." })) }
          }
          try {
            return await runMcpServiceAction("workflow_run.record", auditPrincipal, null, () => executeWorkflowAuthoringTest(request, {
              organizationId,
              orgMembershipId: memberIdentity?.orgMembershipId,
              buildTools: () => buildCapabilityToolTree(capabilityContext),
              recordRun: (receipt) => recordWorkflowRun(db, receipt),
            }), { result: toolResultStatus })
          } catch (error) {
            if (error instanceof AuditUnavailableError) return auditUnavailableToolResult()
            throw error
          }
        },
      }),
    )

    return await handlers.fetch(audience, c.req.raw, server)
  })
}
