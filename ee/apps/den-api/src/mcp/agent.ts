import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ErrorCode, McpError, type ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { openworkCloudMcpConnectionActionSchema } from "@openwork/types/den/mcp-connection-action"
import type { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { z } from "zod"
import { codemodeScriptsEnabled } from "../capability-sources/codemode-rollout.js"
import { remoteMcpAppsEnabled } from "../capability-sources/remote-mcp-apps-rollout.js"
import { publicRoute, tokenRoute } from "../middleware/index.js"
import { db } from "../db.js"
import { getMcpResourceContext, verifyMcpRequest } from "./auth.js"
import { getCatalog, protectedResourceMetadata } from "./index.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
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
import { getCodemodeScriptDetail, getCodemodeScriptSnapshot } from "../codemode-scripts.js"
import { artifactFreshness } from "../saved-script-artifacts.js"
import { PluginArchAuthorizationError } from "../routes/org/plugin-system/access.js"
import {
  DYNAMIC_ARTIFACT_APP_SCHEMA_VERSION,
  dynamicArtifactAppServerCapabilities,
  registerAgentDynamicArtifactApp,
  registerSelectedDynamicArtifactApp,
} from "./dynamic-artifact-app.js"
import {
  executeBuiltinSkillCapability,
  listBuiltinSkillDescriptors,
} from "./builtin-skills.js"
import {
  buildCapabilityToolTree,
  catalogOperationChangesRemoteMcpAppDiscovery,
  createCapabilityRegistryContext,
  executeCapability,
  externalCapabilityErrorToolResult,
  externalCapabilitySuccessToolResult,
  searchCapabilityRegistry,
  type ExecuteCapabilityToolResult,
} from "./capability-registry.js"
import { runCodemodeScript } from "./codemode-run.js"
import { recordCodemodeScriptResult } from "../codemode-runs.js"
import {
  activateArtifactViewRevision,
  getGeneratedArtifactViewRevision,
  listArtifactViews,
  loadArtifactViewRevision,
  retireArtifactView,
  saveArtifactViewRevision,
} from "../artifact-views.js"
import {
  registerAgentGeneratedArtifactViews,
  registerGeneratedArtifactResource,
  registerSelectedGeneratedArtifactRenderTool,
} from "./generated-artifact-views.js"
import { requirePluginArchResourceRole, type PluginArchActorContext } from "../routes/org/plugin-system/access.js"
import { clearProgramAgentSelection, getProgramAgentSelection, selectProgramForAgent } from "../program-agent-selection.js"
import { getProgramDetail, listProgramLibraryItems } from "../program-library.js"
import { parseArtifactViewResourceUri } from "../artifact-view-resource.js"
import { importRemoteMcpApp, listActiveRemoteMcpApps, loadRemoteMcpAppRevision } from "../remote-mcp-apps.js"
import { registerAgentRemoteMcpApps } from "./remote-mcp-apps.js"
import { listReadyExternalMcpConnections } from "../capability-sources/external-mcp-connections.js"
import { registerConnectMcpServerIndex } from "./connect-mcp-server-index.js"

export { externalToolContent } from "./tool-content.js"
export { externalCapabilityErrorToolResult, externalCapabilitySuccessToolResult }
export type { ExecuteCapabilityToolResult }

export { EXECUTE_CAPABILITY_TOOL_NAME }
export const EXECUTE_CAPABILITY_SCRIPT_TOOL_NAME = "execute_capability_script"
const searchCapabilityTypeSchema = z.enum(["all", "api", "admin", "mcp", "marketplace", "skills"])
export const EXECUTE_CAPABILITY_TIMEOUT_MS = 180_000
export const SEARCH_CAPABILITIES_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}
export const CALENDAR_AGENDA_CAPABILITY_NAME = "native:google-workspace:getCapabilitiesGoogleWorkspaceCalendarAgenda"
export const GMAIL_MESSAGES_CAPABILITY_NAME = "native:google-workspace:getCapabilitiesGoogleWorkspaceGmailMessages"
export const DRIVE_FILES_CAPABILITY_NAME = "native:google-workspace:getCapabilitiesGoogleWorkspaceDriveFiles"

export const SEARCH_CAPABILITIES_DESCRIPTION = [
  "Search for a capability by keyword. This connection exposes execute_capability for the exact result; there is no list of individually-named tools to browse.",
  `Do not use this search tool for these requests: a bounded recent Gmail inbox list is already ${GMAIL_MESSAGES_CAPABILITY_NAME} with query { q: "in:inbox", maxResults? }, and a bounded Google Drive name or text search is already ${DRIVE_FILES_CAPABILITY_NAME} with query { query, maxResults? }. Call execute_capability directly with that exact name and query.`,
  "For an org-connected service, search once with one precise query, then execute an exact returned capability. A loaded capability-specific skill may name an exact connector-namespaced capability; execute that exact name directly instead of searching. Reuse an exact capability already returned in this task instead of searching again. Search a second time only when the first search returned no usable match or the server reports unknown_capability.",
  "Search covers native Google Workspace capabilities (Gmail, Calendar, Drive, Gmail drafts), org-connected external MCPs, and namespaced OpenWork Admin tools for allowlisted platform admins.",
  "Native API matches include a connector-namespaced name, pathParams, queryParams, querySchema, hasBody, and bodySchema. External MCP matches include argumentsSchema, schemaDigest, and invocation.argumentsField.",
  "Built-in and marketplace skill matches return SKILL.md content when executed.",
].join(" ")
export const EXECUTE_CAPABILITY_DESCRIPTION = [
  "Call a capability found via search_capabilities, by its exact name.",
  `For the primary Google Calendar agenda for today, tomorrow, or one local date, call this tool directly with name ${CALENDAR_AGENDA_CAPABILITY_NAME} and query { day, maxResults? }. Omit timeZone so the capability uses the member's primary Google Calendar time zone; pass a timeZone override only when the user explicitly asks for another zone. Do not call search_capabilities first and do not load a Calendar skill first.`,
  `For a bounded list of the most recent Gmail inbox messages, call this tool directly with name ${GMAIL_MESSAGES_CAPABILITY_NAME} and query { q: "in:inbox", maxResults? }. Do not call search_capabilities first and do not load a Gmail skill first.`,
  `For a bounded Google Drive name or text search, call this tool directly with name ${DRIVE_FILES_CAPABILITY_NAME} and query { query, maxResults? }. Do not call search_capabilities first and do not load a Drive skill first.`,
  "Pass path/query/body only as described by that match's pathParams/queryParams/hasBody.",
  "For external MCP capabilities, provider-advertised schema mismatches are returned as advisory schemaGuidance alongside the provider result; they do not block the downstream call.",
  "When the exact capability is a standard MCP App launch tool, this call preserves its originating tool and ui:// binding so compatible OpenWork hosts render it without requiring a generated direct-tool name.",
  "For skill capabilities listed in the remote skill catalog, this returns their authorized SKILL.md content.",
  "Returns unknown_capability if name doesn't match a current capability — call search_capabilities again.",
].join(" ")
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
  hint: z.string().optional(),
})

const programSearchItemOutputSchema = z.object({
  id: z.string(),
  plugin: z.object({ id: z.string(), name: z.string() }).nullable(),
  name: z.string(),
  description: z.string().nullable(),
  role: z.enum(["viewer", "editor", "manager"]),
  state: z.enum(["ready", "needs_signin", "needs_admin_setup"]),
  resultState: z.enum(["never_run", "fresh", "stale", "needs_attention"]),
  latestSuccessfulAt: z.string().nullable(),
  viewState: z.enum(["default", "custom_active", "build_failed", "retired"]),
  activeViewTitle: z.string().nullable(),
  automationCount: z.number().int().nonnegative(),
  source: z.object({
    kind: z.enum(["created", "installed_template"]),
    templateName: z.string().optional(),
    templateVersion: z.string().optional(),
  }),
})

const programSearchOutputSchema = z.object({
  items: z.array(programSearchItemOutputSchema),
  nextCursor: z.string().nullable(),
})

const programSelectionOutputSchema = z.object({
  selection: z.object({
    programId: z.string(),
    selectedAt: z.string(),
  }),
})

const programSelectionClearedOutputSchema = z.object({
  selection: z.null(),
})

const programRunOutputSchema = z.object({
  status: z.literal("succeeded"),
  value: z.unknown(),
  receiptId: z.string().nullable(),
  resultDigest: z.string().nullable(),
})

export const AGENT_MCP_INSTRUCTIONS = [
  "This OpenWork Cloud MCP server uses standard MCP tools, resources, structured results, and list-changed notifications. OpenWork Programs and Remote MCP Apps add only durable identity, Plugin containment, access, retained resources and results, selection, and lifecycle around those MCP primitives.",
  "MCP App UI is authored and bundled outside OpenWork. Agents do not author, generate, compile, revise, activate, or publish UI source in OpenWork. Active imported apps in the member's Library appear as individually named launch tools backed by immutable ui:// resources.",
  "Use import_remote_mcp_app only after the user has selected an existing Plugin and approved installation of third-party executable content. Supply only the Plugin id and a public HTTPS URL for one self-contained index.html; never send inline HTML, React or JavaScript source, or build-project contents.",
  "An imported app receives the exact search_capabilities and execute_capability tool names in launch structuredContent. Through the standard same-server MCP Apps bridge it can search the member's authorized Connect tools and Programs, then execute an exact returned capability. The host retains workspace policy, user approval, and result-size enforcement; credentials never enter the app.",
  "Standard MCP Apps supplied by connected MCP servers are discovered through search_capabilities. A match with kind mcp_app must be executed through execute_capability like any other exact match; compatible OpenWork hosts preserve the current _meta.ui.resourceUri and render it without a generated direct-tool name.",
  "A Program is an immutable-versioned Code Mode Script config object inside an OpenWork Connect Plugin. Organizations with Code Mode scripts enabled receive execute_capability_script, the backwards-compatible render_dynamic_artifact MCP App tool, and a constant-size Program catalog: search_programs, select_program, and clear_program_selection.",
  "To use a Program, search by Library metadata, select one exact accessible Program, then refresh the tool catalog. The selected context exposes run_selected_program and a standard renderer for its retained Artifact data; Program execution remains server-mediated and returns structuredContent.",
  "When a member asks to keep a successful Code Mode result, save it as a Program inside the existing OpenWork Connect Plugin they name by passing that pluginId to the Code Mode save operation. Omit pluginId only for a private Program in the member's My Programs Plugin. A Program inherits discovery and sharing from its Plugin and any Marketplace containing that Plugin; do not create a separate Program package or marketplace entry.",
  "Capabilities include native Google Workspace operations (Gmail read/search, Calendar list/create, Drive search/read, and Gmail draft creation) executed with the signed-in member's organization credentials, plus any MCP connections the organization has added.",
  "Allowlisted platform admins can also discover namespaced OpenWork Admin capabilities through this same connection; other members cannot discover or execute them.",
  "For an org-connected service, search once with one precise query, then execute an exact returned capability. A loaded capability-specific skill may name an exact connector-namespaced capability; execute that exact name directly instead of searching. Reuse an exact capability already returned in this task instead of searching again. Search a second time only when the first search returned no usable match or the server reports unknown_capability. Follow every returned parameter limit exactly, use default result limits first, batch independent reads in one tool round, fetch details only for selected records, and never repeat an unchanged failed call.",
  `For the primary Google Calendar agenda for today, tomorrow, or one local date, call execute_capability directly with name ${CALENDAR_AGENDA_CAPABILITY_NAME} and query { day, maxResults? }. Omit timeZone so the capability uses the member's primary Google Calendar time zone; pass a timeZone override only when the user explicitly asks for another zone. Do not call search_capabilities first and do not load a Calendar skill first.`,
  `For a bounded list of the most recent Gmail inbox messages, call execute_capability directly with name ${GMAIL_MESSAGES_CAPABILITY_NAME} and query { q: "in:inbox", maxResults? }. Do not call search_capabilities first and do not load a Gmail skill first.`,
  `For a bounded Google Drive name or text search, call execute_capability directly with name ${DRIVE_FILES_CAPABILITY_NAME} and query { query, maxResults? }. Do not call search_capabilities first and do not load a Drive skill first.`,
  "Built-in remote skills create-skill, share-plugin, add-to-marketplace, and add-user-to-marketplace are always listed in the skill index. Retrieve and follow the matching one by executing its exact capability; do not invent a local copy to access them.",
  "For a request to add a public GitHub plugin to an organization marketplace, search for the marketplace list, GitHub plugin import preview, GitHub plugin marketplace import, and resolved marketplace detail capabilities. Preview first; do not recreate the plugin by hand.",
  "Before importing, confirm the target marketplace, selected skill/server keys, and who can use them. Do not choose one authentication type for every server: the import route resolves known presets and plugin declarations, while the request authType is only a fallback for unknown servers.",
  "After importing, retrieve the resolved marketplace detail and report each plugin's cloudReadiness. An import or plugin binding is not proof that an MCP connection is usable. Relay needs_admin_setup or needs_signin as the next human action instead of claiming the connection is ready.",
  "Do not invent OAuth-client, credential, or local-extension setup. Organization connections are managed in the OpenWork Cloud dashboard / Settings > Connect. When a returned connection or marketplace readiness state requires administrator setup or member sign-in, relay that exact action.",
  "A successful search_capabilities call proves this OpenWork Cloud MCP connection is authorized. Never tell the user to reconnect OpenWork Cloud because a downstream connector failed.",
  "External MCP matches include the provider-advertised argumentsSchema, schemaDigest, and invocation.argumentsField. Put an object matching argumentsSchema in execute_capability.body and copy schemaDigest into execute_capability.schemaDigest.",
  "Do not import, convert, or browse for a standalone HTML URL when a connected capability already appears with kind mcp_app. Execute that exact match and let the host resolve its originating ui:// resource.",
  "OpenWork always attempts the downstream provider call when local schema checks find a mismatch. schemaGuidance is advisory and appears alongside the provider result: if the provider succeeded, accept that result and do not retry solely because of the warning; if it failed, use the warning to correct the arguments or search again.",
  "If the provider returns invalid_capability_arguments, correct the listed issues and retry once with changed arguments; never retry the same arguments unchanged. If it returns unknown_capability, call search_capabilities again before retrying.",
  "When a match has kind connection_status, name connectionStatus.connectionName and relay connectionStatus.action exactly. Distinguish the member's Your Connections page, the organization Connections dashboard, and the provider's own admin console.",
  "Connection probes are live. After the requested human fixes that connector, search again in the same task; otherwise do not retry unchanged or improvise workarounds through other tools.",
].join("\n")

async function mcpRequestInfo(request: Request): Promise<{ method: string | null; resourceUri: string | null }> {
  if (request.method.toUpperCase() !== "POST") return { method: null, resourceUri: null }
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
  return { method, resourceUri }
}

export const AGENT_SKILL_INDEX_URI = "skill://index.json"
export const AGENT_SKILL_INDEX_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"

export function buildAgentSkillIndex(skills: RemoteSkillDescriptor[]) {
  return {
    $schema: AGENT_SKILL_INDEX_SCHEMA,
    skills: skills.map((skill) => ({
      name: skill.name,
      type: "skill-md" as const,
      title: skill.title,
      description: skill.description,
      url: skill.location,
      capability: skill.capability,
      ...(skill.marketplaceName ? { marketplaceName: skill.marketplaceName } : {}),
      ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
    })),
  }
}

function standardSkillMarkdown(skill: RemoteSkillDescriptor, source: string): string {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/^\s+/, "")
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${body}`
}

const EXECUTE_CAPABILITY_TIMEOUT_MESSAGE = `The capability call exceeded ${EXECUTE_CAPABILITY_TIMEOUT_MS / 1_000}s. Retry once; if it times out again, narrow the request (fewer results, tighter query) and tell the user the service is slow — do NOT tell them to reconfigure or reconnect.`

function textContent(text: string): { text: string; type: "text" }[] {
  return [{ type: "text", text }]
}

export function capabilitySearchToolResult<T extends CapabilityMatch>(matches: T[], coverageHint?: string) {
  const hint = [
    ...(matches.length === 0 ? ["No matches. Try broader or different keywords."] : []),
    ...(coverageHint ? [coverageHint] : []),
  ].join(" ")
  const result = hint ? { matches, hint } : { matches }
  return {
    content: textContent(JSON.stringify(result, null, 2)),
    structuredContent: result,
  }
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
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
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
      ...dynamicArtifactAppServerCapabilities,
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
      const builtinResult = executeBuiltinSkillCapability(skill.capability)
      const marketplace = parseMarketplaceCapabilityName(skill.capability)
      const marketplaceResult = marketplace ? await executeMarketplaceCapability({
        organizationId: input.organizationId,
        member: input.member,
        pluginId: marketplace.pluginId,
        configObjectId: marketplace.configObjectId,
        enabled: input.marketplaceEnabled,
      }) : null
      const source = builtinResult?.content
        ?? (marketplaceResult?.ok && marketplaceResult.result.kind === "skill"
          ? marketplaceResult.result.content
          : null)
      if (typeof source !== "string") throw new McpError(ErrorCode.InvalidRequest, "Skill is no longer available")
      return {
        contents: [{
          uri: skill.location,
          mimeType: "text/markdown",
          text: standardSkillMarkdown(skill, source),
        }],
      }
    })
  }
}

/**
 * The minimal, harness-facing MCP surface: two core tools plus gated Code Mode
 * execution and standards-based Artifact presentation.
 *
 * `/mcp` (index.ts) stays exactly as it is — every catalog operation
 * individually registered, ~129 tools today. That's unchanged and still
 * useful for scripts/admin tooling that want to call a known operation by
 * name directly.
 *
 * `/mcp/agent` is a *different* endpoint for a *different* consumer: the
 * desktop app's "OpenWork Cloud Control" connection, which is what an
 * OpenCode/Claude Code/Codex-style harness actually sees. It always registers
 * `search_capabilities` and `execute_capability`, and conditionally registers
 * Code Mode plus a constant-size Program search/selection catalog.
 * One selected Program contributes exact run/render tools; its renderer is a
 * read-only MCP App over the same authorized saved-Script snapshots and does
 * not create a second execution or scheduling path. The other ~127 operations
 * are not individually callable on this endpoint.
 */
export function registerAgentMcpRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(app: Hono<T>) {
  app.get("/.well-known/oauth-protected-resource/mcp/agent", publicRoute, (c) =>
    c.json(protectedResourceMetadata(c.req.raw, "agent")))
  app.get("/mcp/agent/.well-known/oauth-protected-resource", publicRoute, (c) =>
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
    const organizationId = normalizeDenTypeId("organization", principal.organizationId)
    const organizationRows = await db
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)
    const organizationMetadata = organizationRows[0]?.metadata
    const codemodeEnabled = codemodeScriptsEnabled(organizationMetadata)
    const remoteAppsEnabled = remoteMcpAppsEnabled(organizationMetadata, {
      deploymentEnabled: env.remoteMcpAppsEnabled,
    })
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
      codemodeEnabled,
      generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
      organizationMetadata,
      mcpConnectionsGatingEnabled: env.mcpConnectionsGatingEnabled,
      // This metadata is an opaque binding on an already authorized bounded
      // search/execute result. Resolving the provider tool or resource still
      // requires the separately scoped App-host credential below.
      mcpAppsEnabled: remoteAppsEnabled,
    })
    const { externalMcpConnectionsEnabled } = capabilityContext
    let remoteSkills: RemoteSkillDescriptor[] = []
    let libraryContext: PluginArchActorContext | null = null
    const appCatalogMethod = method === "initialize"
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
    const artifactContext = codemodeEnabled ? libraryContext : null
    if (method === "initialize" || method === "resources/list" || method === "resources/read") {
      remoteSkills = [
        ...listBuiltinSkillDescriptors(),
        ...(await listAccessibleMarketplaceSkillDescriptors({
          organizationId: principal.organizationId,
          member: memberIdentity,
          enabled: externalMcpConnectionsEnabled,
        })),
      ]
        .sort((a, b) => a.name.localeCompare(b.name) || a.capability.localeCompare(b.capability))
    }
    const server = createAgentMcpServer()
    if (remoteAppsEnabled && libraryContext && memberIdentity && appCatalogMethod) {
      registerAgentRemoteMcpApps({
        server,
        apps: await listActiveRemoteMcpApps({ context: libraryContext }),
        loadResource: async ({ configObjectId, versionId }) => {
          const loaded = await loadRemoteMcpAppRevision({
            context: libraryContext,
            configObjectId,
            versionId,
          })
          return { html: loaded.html, payload: loaded.payload }
        },
        importApp: async ({ pluginId, sourceUrl, activate }) => importRemoteMcpApp({
          context: libraryContext,
          pluginId,
          sourceUrl,
          activate,
          requireFreshSession: false,
        }),
      })
    }
    if (method === "initialize" || method === "resources/list" || method === "resources/read") {
      if (memberIdentity) {
        registerConnectMcpServerIndex({
          server,
          enabled: remoteAppsEnabled,
          connections: remoteAppsEnabled
            ? await listReadyExternalMcpConnections({
                organizationId,
                orgMembershipId: memberIdentity.orgMembershipId,
                teamIds: memberIdentity.teamIds,
              })
            : [],
          publicOrigin: redirectUriBase,
        })
      }
      registerAgentSkillResources({
        server,
        skills: remoteSkills,
        organizationId: principal.organizationId,
        member: memberIdentity,
        marketplaceEnabled: externalMcpConnectionsEnabled,
      })
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

    server.registerTool(
      SEARCH_CAPABILITIES_TOOL_NAME,
      {
        title: "Search capabilities",
        description: [
          codemodeEnabled
            ? "Search for a capability by keyword. This connection also exposes execute_capability, execute_capability_script, and Program search/selection tools —"
            : "Search for a capability by keyword. This connection only exposes this tool and execute_capability —",
          "there is no list of individually-named tools to browse. Always search first.",
          "Search covers native Google Workspace capabilities (Gmail, Calendar, Drive, Gmail drafts), org-connected external MCPs, and namespaced OpenWork Admin tools for allowlisted platform admins.",
          "When Code Mode is enabled, accessible Programs appear as marketplace matches with kind script and execute through execute_capability like every other exact search result.",
          "Try 2-4 keyword variants before deciding a capability is unavailable.",
          "Native API matches include a connector-namespaced name, pathParams, queryParams, hasBody, and bodySchema. External MCP matches include argumentsSchema, schemaDigest, and invocation.argumentsField. A match with kind mcp_app is a standard MCP App launch capability from a connected MCP server; execute it normally and the OpenWork host will render its advertised ui:// resource.",
          "Built-in and marketplace skill matches return SKILL.md content when executed.",
        ].join(" "),
        annotations: SEARCH_CAPABILITIES_ANNOTATIONS,
        _meta: { ui: { visibility: ["model", "app"] } },
        inputSchema: z.object({
          query: z.string().min(1).describe("Keywords describing the capability you need, e.g. \"create organization\" or \"list workers\"."),
          limit: z.number().int().min(1).max(20).optional().describe("Max number of matches to return. Defaults to 5."),
          type: searchCapabilityTypeSchema.optional().describe("Optional source filter. all searches every available source; api searches Den API capabilities; admin searches allowlisted platform-admin tools; mcp searches connected external MCP tools; marketplace searches marketplace plugin capabilities; skills searches built-in and marketplace skills. Defaults to all."),
        }),
        outputSchema: SEARCH_CAPABILITIES_OUTPUT_SCHEMA,
      },
      async ({ query, limit, type }) => {
        const boundedLimit = limit ?? 5
        const result = await searchCapabilityRegistry(capabilityContext, { query, limit: boundedLimit, type })
        const matches = result.matches.sort(compareCapabilityMatches).slice(0, boundedLimit)
        return capabilitySearchToolResult(matches, result.externalCoverageHint)
      },
    )

    server.registerTool(
      EXECUTE_CAPABILITY_TOOL_NAME,
      {
        title: "Execute capability",
        description: EXECUTE_CAPABILITY_DESCRIPTION,
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
      async ({ name, schemaDigest, path, query, body }, extra) => {
        const result = await executeCapabilityWithBudget({
          capability: name,
          invoke: async (): Promise<ExecuteCapabilityToolResult> => (
            executeCapability(capabilityContext, { name, schemaDigest, path, query, body })
          ),
        })
        const catalogOperation = catalog.find((operation) => operation.name === name)
        if (!result.isError && catalogOperation && catalogOperationChangesRemoteMcpAppDiscovery(catalogOperation)) {
          await extra.sendNotification({ method: "notifications/tools/list_changed" })
          await extra.sendNotification({ method: "notifications/resources/list_changed" })
        }
        return result
      },
    )

    if (codemodeEnabled) {
      const loadDynamicArtifact = async ({
        configObjectId,
        receiptId,
        maxAgeMs,
        expectedOutputSchemaDigest,
      }: {
        configObjectId: string
        receiptId?: string
        maxAgeMs?: number
        expectedOutputSchemaDigest?: string
      }) => {
        if (!artifactContext) {
          return {
            ok: false as const,
            error: "saved_script_not_found",
            message: "The saved Script is unavailable to this member.",
          }
        }
        try {
          const detail = await getCodemodeScriptDetail({
            context: artifactContext,
            configObjectId,
            maxAgeMs,
          })
          const snapshot = receiptId
            ? await getCodemodeScriptSnapshot({ context: artifactContext, configObjectId, receiptId })
            : detail.latestSuccessfulSnapshot
          if (!snapshot) {
            return {
              ok: false as const,
              error: "saved_script_snapshot_not_found",
              message: receiptId
                ? "That immutable artifact snapshot was not found."
                : "This saved Script does not have a successful artifact snapshot yet. Run it explicitly or through its Automation first.",
            }
          }
          if (snapshot.status !== "succeeded" || snapshot.contentDeletedAt !== null
            || snapshot.markdown === null
            || snapshot.resultDigest === null || snapshot.rendererVersion !== "codemode-markdown-v1") {
            return {
              ok: false as const,
              error: "saved_script_snapshot_unavailable",
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
              schemaVersion: DYNAMIC_ARTIFACT_APP_SCHEMA_VERSION,
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
              error: "saved_script_not_found",
              message: "The saved Script is unavailable to this member.",
            }
          }
          const message = error instanceof Error ? error.message : "saved_script_not_found"
          return {
            ok: false as const,
            error: message.includes("not_found") ? "saved_script_not_found" : "saved_script_unavailable",
            message: "The Program's retained Artifact could not be loaded.",
          }
        }
      }

      // Keep the existing generic MCP App tool as the interoperable baseline.
      // OpenWork's persisted selection only adds a smaller contextual catalog;
      // it does not replace the standard tool/resource/result contract.
      registerAgentDynamicArtifactApp({ server, load: loadDynamicArtifact })

      const notifyProgramCatalogChanged = async (extra: {
        sendNotification: (notification: { method: "notifications/tools/list_changed" | "notifications/resources/list_changed" }) => Promise<void>
      }) => {
        await extra.sendNotification({ method: "notifications/tools/list_changed" })
        if (env.generatedArtifactViewsEnabled) {
          await extra.sendNotification({ method: "notifications/resources/list_changed" })
        }
      }

      server.registerTool(
        "search_programs",
        {
          title: "Search Programs",
          description: "Search accessible Programs by Library metadata and parent OpenWork Connect Plugin. Results never include retained artifact data, Script source, generated source, compiled HTML, diagnostics, or credentials.",
          annotations: SEARCH_CAPABILITIES_ANNOTATIONS,
          inputSchema: z.object({
            query: z.string().trim().max(255).optional(),
            readiness: z.enum(["ready", "needs_signin", "needs_admin_setup"]).optional(),
            source: z.enum(["created", "installed_template"]).optional(),
            cursor: z.string().trim().min(1).max(160).optional(),
            limit: z.number().int().min(1).max(50).optional(),
          }),
          outputSchema: programSearchOutputSchema,
        },
        async ({ query, readiness, source, cursor, limit }) => {
          const items = artifactContext ? await listProgramLibraryItems({ context: artifactContext }) : []
          const normalizedQuery = query?.toLocaleLowerCase() ?? ""
          const filtered = items.filter((item) =>
            (!normalizedQuery || `${item.name} ${item.description ?? ""}`.toLocaleLowerCase().includes(normalizedQuery))
            && (!readiness || item.state === readiness)
            && (!source || item.source.kind === source))
          const start = cursor ? Math.max(0, filtered.findIndex((item) => item.id === cursor) + 1) : 0
          const bounded = limit ?? 10
          const page = filtered.slice(start, start + bounded).map((item) => ({
            id: item.id,
            plugin: item.plugin,
            name: item.name,
            description: item.description,
            role: item.role,
            state: item.state,
            resultState: item.resultState,
            latestSuccessfulAt: item.latestSuccessfulAt,
            ...(env.generatedArtifactViewsEnabled
              ? { viewState: item.viewState, activeViewTitle: item.activeViewTitle }
              : { viewState: "default" as const, activeViewTitle: null }),
            automationCount: item.automationCount,
            source: item.source,
          }))
          const result = {
            items: page,
            nextCursor: start + bounded < filtered.length ? page.at(-1)?.id ?? null : null,
          }
          return { content: textContent(JSON.stringify(result, null, 2)), structuredContent: result }
        },
      )

      server.registerTool(
        "select_program",
        {
          title: "Select Program",
          description: "Select one accessible Program as this member's current organization-scoped MCP context. Selection persists across chats and devices; it does not install or grant access.",
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          inputSchema: z.object({ programId: z.string().trim().min(1).max(160) }),
          outputSchema: programSelectionOutputSchema,
        },
        async ({ programId }, extra) => {
          if (!artifactContext) {
            return { isError: true, content: textContent(JSON.stringify({ error: "program_not_found" })) }
          }
          const selection = await selectProgramForAgent({ context: artifactContext, programId })
          await notifyProgramCatalogChanged(extra)
          const result = {
            selection: {
              programId: selection.programId,
              selectedAt: selection.selectedAt,
            },
          }
          return {
            content: textContent(JSON.stringify(result, null, 2)),
            structuredContent: result,
          }
        },
      )

      server.registerTool(
        "clear_program_selection",
        {
          title: "Clear Program selection",
          description: "Clear this member's current organization-scoped Program selection.",
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
          inputSchema: z.object({}),
          outputSchema: programSelectionClearedOutputSchema,
        },
        async (_request, extra) => {
          if (artifactContext) await clearProgramAgentSelection(artifactContext)
          await notifyProgramCatalogChanged(extra)
          const result = { selection: null }
          return { content: textContent(JSON.stringify(result)), structuredContent: result }
        },
      )

      const selection = artifactContext ? await getProgramAgentSelection(artifactContext) : null
      const selectedDetail = artifactContext && selection
        ? await getProgramDetail({ context: artifactContext, configObjectId: selection.programId })
        : null
      let registeredSelectedCustomView = false

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
        const generatedViews = await listArtifactViews({ context: artifactContext })
        registerAgentGeneratedArtifactViews({
          server,
          views: generatedViews,
          loadResource: loadGeneratedResource,
          loadData: loadDynamicArtifact,
          save: (request) => saveArtifactViewRevision({ context: artifactContext, ...request }),
          activate: (request) => activateArtifactViewRevision({ context: artifactContext, ...request }),
          retire: (request) => retireArtifactView({ context: artifactContext, ...request }),
          exposePerViewRenderTools: false,
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

        if (selection && selectedDetail) {
          const activeView = selectedDetail.views.find((view) => view.status === "active" && view.activeRevisionId !== null)
          const active = activeView?.activeRevisionId
            ? await getGeneratedArtifactViewRevision({
                context: artifactContext,
                artifactViewId: activeView.id,
                revisionId: activeView.activeRevisionId,
              }).catch(() => null)
            : null
          const compatibleRevision = active?.revision.buildStatus === "ready"
            && active.revision.retiredAt === null
            && active.revision.outputSchemaDigest === selectedDetail.script.currentVersion.outputSchemaDigest
            ? active.revision
            : null
          if (active && compatibleRevision) {
            if (!generatedViews.some((view) => view.revisions.some((revision) => revision.resourceUri === compatibleRevision.resourceUri))) {
              registerGeneratedArtifactResource({
                server,
                view: active.view,
                revision: compatibleRevision,
                loadResource: loadGeneratedResource,
              })
            }
            registerSelectedGeneratedArtifactRenderTool({
              server,
              view: active.view,
              revision: compatibleRevision,
              loadData: loadDynamicArtifact,
            })
            registeredSelectedCustomView = true
          }
        }
      }

      if (artifactContext && selection && selectedDetail) {
        if (!registeredSelectedCustomView) {
          registerSelectedDynamicArtifactApp({ server, configObjectId: selection.programId, load: loadDynamicArtifact })
        }

        server.registerTool(
          "run_selected_program",
          {
            title: `Run selected Program: ${selectedDetail.program.name}`,
            description: "Execute the selected Program's current immutable Script version after validating access, input schema, and capability readiness.",
            annotations: EXECUTE_CAPABILITY_ANNOTATIONS,
            inputSchema: z.object({ input: z.unknown().optional() }),
            outputSchema: programRunOutputSchema,
          },
          async ({ input }) => {
            await requirePluginArchResourceRole({
              context: artifactContext,
              requireFreshSession: false,
              resourceId: normalizeDenTypeId("configObject", selection.programId),
              resourceKind: "config_object",
              role: "editor",
            })
            const execution = await executeMarketplaceCapability({
              organizationId: principal.organizationId,
              member: memberIdentity,
              pluginId: selectedDetail.script.pluginId,
              configObjectId: selectedDetail.script.configObjectId,
              configObjectVersionId: selectedDetail.script.currentVersion.id,
              body: input,
              codemodeEnabled: true,
              validateScriptOutput: true,
              buildTools: () => buildCapabilityToolTree(capabilityContext),
            })
            if (!execution.ok || execution.result.status !== "executed") {
              const message = execution.ok ? execution.result.hint ?? "The selected Program could not run." : execution.message
              return { isError: true, content: textContent(JSON.stringify({ error: "program_run_failed", message })) }
            }
            const result = {
              status: "succeeded" as const,
              value: execution.result.value,
              receiptId: execution.result.receiptId ?? null,
              resultDigest: execution.result.resultDigest ?? null,
            }
            return {
              content: textContent(JSON.stringify(result, null, 2)),
              structuredContent: result,
            }
          },
        )
      }

      server.registerTool(
        EXECUTE_CAPABILITY_SCRIPT_TOOL_NAME,
        {
          title: "Execute capability script",
          description: [
            "Run confined JavaScript orchestration over this organization's capabilities.",
            "Den REST operations are available at tools.den.<operation>; connected MCP tools are available at tools.<connection>.<tool>.",
            "search_capabilities results include scriptPath for exact paths, and tools.$codemode.search({ query }) works in-program.",
            "The code is a plain function body in a restricted JavaScript subset: data literals, control flow, arrow functions, template strings, try/catch, common Array/String/Object/Math/JSON methods, await, and Promise.all.",
            "Not available: import/require, classes, generators, .then/.catch chaining, timers, fetch, process, and other host globals — call tools for all external work.",
            "Send plain source only (no markdown fences). End with `return <json-safe value>`; use console.log for progress logs.",
            "Run independent tool calls in parallel with Promise.all and return only the fields needed.",
          ].join(" "),
          annotations: EXECUTE_CAPABILITY_ANNOTATIONS,
          inputSchema: z.object({
            code: z.string().min(1),
            input: z.unknown().optional(),
          }),
        },
        async ({ code, input }) => executeCapabilityWithBudget({
          capability: EXECUTE_CAPABILITY_SCRIPT_TOOL_NAME,
          invoke: async (): Promise<ExecuteCapabilityToolResult> => {
            const { tools } = await buildCapabilityToolTree(capabilityContext)
            const startedAt = new Date()
            const result = await runCodemodeScript({
              code,
              scriptInput: input,
              tools,
              timeoutMs: 170_000,
            })
            const finishedAt = new Date()
            await recordCodemodeScriptResult(db, {
              organizationId,
              orgMembershipId: memberIdentity?.orgMembershipId,
              source: "adhoc",
              code,
              startedAt,
              finishedAt,
            }, result)
            if (!result.ok) {
              return {
                isError: true,
                content: textContent(JSON.stringify({
                  error: "script_failed",
                  kind: result.error.kind,
                  message: result.error.message,
                  ...(result.error.suggestions ? { suggestions: result.error.suggestions } : {}),
                  toolCalls: result.toolCalls,
                })),
              }
            }
            const value = typeof result.value === "string"
              ? result.value
              : JSON.stringify(result.value, null, 2)
            const logs = result.logs.length > 0 ? `\n\nLogs:\n${result.logs.join("\n")}` : ""
            return { content: textContent(`${value}${logs}`) }
          },
        }),
      )
    }

    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    const response = await transport.handleRequest(c)
    return response ?? new Response(null, { status: 204 })
  })
}
