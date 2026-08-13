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
import { publicRoute, tokenRoute } from "../middleware/index.js"
import { db } from "../db.js"
import { getMcpResourceContext, verifyMcpRequest } from "./auth.js"
import { getCatalog, protectedResourceMetadata } from "./index.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"
import { SEARCH_CAPABILITIES_TOOL_NAME, type CapabilityMatch } from "./search.js"
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
} from "./dynamic-artifact-app.js"
import {
  executeBuiltinSkillCapability,
  listBuiltinSkillDescriptors,
} from "./builtin-skills.js"
import {
  buildCapabilityToolTree,
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
  listArtifactViews,
  loadArtifactViewRevision,
  retireArtifactView,
  saveArtifactViewRevision,
} from "../artifact-views.js"
import { registerAgentGeneratedArtifactViews } from "./generated-artifact-views.js"
import type { PluginArchActorContext } from "../routes/org/plugin-system/access.js"

export { externalToolContent } from "./tool-content.js"
export { externalCapabilityErrorToolResult, externalCapabilitySuccessToolResult }
export type { ExecuteCapabilityToolResult }

export const EXECUTE_CAPABILITY_TOOL_NAME = "execute_capability"
export const EXECUTE_CAPABILITY_SCRIPT_TOOL_NAME = "execute_capability_script"
const searchCapabilityTypeSchema = z.enum(["all", "api", "admin", "mcp", "marketplace", "skills"])
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
  argumentsSchema: z.unknown().optional(),
  schemaDigest: z.string().optional(),
  invocation: z.object({ argumentsField: z.literal("body") }).optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  hint: z.string().optional(),
  connectionStatus: connectionStatusOutputSchema.optional(),
  scriptPath: z.string().optional(),
}).passthrough()

export const SEARCH_CAPABILITIES_OUTPUT_SCHEMA = z.object({
  matches: z.array(capabilityMatchOutputSchema),
  hint: z.string().optional(),
})

export const AGENT_MCP_INSTRUCTIONS = [
  "This OpenWork Cloud connection always exposes search_capabilities and execute_capability; organizations with Code Mode scripts enabled also receive execute_capability_script and render_dynamic_artifact.",
  "Capabilities include native Google Workspace operations (Gmail read/search, Calendar list/create, Drive search/read, and Gmail draft creation) executed with the signed-in member's organization credentials, plus any MCP connections the organization has added.",
  "Allowlisted platform admins can also discover namespaced OpenWork Admin capabilities through this same connection; other members cannot discover or execute them.",
  "Always call search_capabilities first with 2-4 keyword variants before concluding something is unavailable. Use execute_capability only with exact names returned by search_capabilities.",
  "Built-in remote skills create-skill, share-plugin, add-to-marketplace, and add-user-to-marketplace are always listed in the skill index. Retrieve and follow the matching one by executing its exact capability; do not invent a local copy to access them.",
  "For a request to add a public GitHub plugin to an organization marketplace, search for the marketplace list, GitHub plugin import preview, GitHub plugin marketplace import, and resolved marketplace detail capabilities. Preview first; do not recreate the plugin by hand.",
  "Before importing, confirm the target marketplace, selected skill/server keys, and who can use them. Do not choose one authentication type for every server: the import route resolves known presets and plugin declarations, while the request authType is only a fallback for unknown servers.",
  "After importing, retrieve the resolved marketplace detail and report each plugin's cloudReadiness. An import or plugin binding is not proof that an MCP connection is usable. Relay needs_admin_setup or needs_signin as the next human action instead of claiming the connection is ready.",
  "Do not invent OAuth-client, credential, or local-extension setup. Organization connections are managed in the OpenWork Cloud dashboard / Settings > Connect. When a returned connection or marketplace readiness state requires administrator setup or member sign-in, relay that exact action.",
  "A successful search_capabilities call proves this OpenWork Cloud MCP connection is authorized. Never tell the user to reconnect OpenWork Cloud because a downstream connector failed.",
  "External MCP matches include the provider-advertised argumentsSchema, schemaDigest, and invocation.argumentsField. Put an object matching argumentsSchema in execute_capability.body and copy schemaDigest into execute_capability.schemaDigest.",
  "OpenWork always attempts the downstream provider call when local schema checks find a mismatch. schemaGuidance is advisory and appears alongside the provider result: if the provider succeeded, accept that result and do not retry solely because of the warning; if it failed, use the warning to correct the arguments or search again.",
  "If the provider returns invalid_capability_arguments, correct the listed issues and retry once with changed arguments; never retry the same arguments unchanged. If it returns unknown_capability, call search_capabilities again before retrying.",
  "When save_artifact_view is advertised, create or update the saved Script with an explicit JSON Schema outputSchema matching its returned data before calling it. React is injected into view source, so use React APIs without imports and render only the supplied data prop. A failed view build includes diagnostics: change the source once and retry with the returned artifactViewId; do not search for a different Artifact tool or call render_dynamic_artifact. After a successful save, call the exact render_artifact_* or preview_artifact_* tool named in its result.",
  "When a match has kind connection_status, name connectionStatus.connectionName and relay connectionStatus.action exactly. Distinguish the member's Your Connections page, the organization Connections dashboard, and the provider's own admin console.",
  "Connection probes are live. After the requested human fixes that connector, search again in the same task; otherwise do not retry unchanged or improvise workarounds through other tools.",
  "When a capability or connected tool expects a file URL, search for the temporary file capability, mint a slot, upload the workspace file's bytes to uploadUrl with a real HTTP PUT from the execution environment, and pass downloadUrl to the tool. Never inline file bytes into tool arguments or chat.",
].join("\n")

async function mcpRequestMethod(request: Request): Promise<string | null> {
  if (request.method.toUpperCase() !== "POST") return null
  const body: unknown = await request.clone().json().catch(() => null)
  return typeof body === "object"
    && body !== null
    && "method" in body
    && typeof body.method === "string"
    ? body.method
    : null
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
    capabilities: dynamicArtifactAppServerCapabilities,
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
 * execution and standards-based Dynamic Artifact presentation.
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
 * `execute_capability_script` plus `render_dynamic_artifact`. The renderer is
 * a read-only MCP App over the same authorized saved-Script snapshots; it does
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
    const codemodeEnabled = codemodeScriptsEnabled(organizationRows[0]?.metadata)
    const method = await mcpRequestMethod(c.req.raw)
    const capabilityContext = createCapabilityRegistryContext({
      app: app as unknown as Hono,
      env: c.env,
      catalog,
      principal,
      organizationId,
      member: memberIdentity,
      redirectUriBase: resolvePublicOrigin(c.req.raw, env.apiPublicUrl),
      codemodeEnabled,
      organizationMetadata: organizationRows[0]?.metadata,
      mcpConnectionsGatingEnabled: env.mcpConnectionsGatingEnabled,
    })
    const { externalMcpConnectionsEnabled } = capabilityContext
    let remoteSkills: RemoteSkillDescriptor[] = []
    let artifactContext: PluginArchActorContext | null = null
    const artifactMethod = method === "initialize"
      || method === "tools/list"
      || method === "tools/call"
      || method === "resources/list"
      || method === "resources/read"
    if (codemodeEnabled && memberIdentity && artifactMethod) {
      const organizationContext = await getOrganizationContextForUser({
        userId: normalizeDenTypeId("user", principal.userId),
        organizationId,
      })
      if (organizationContext) {
        artifactContext = {
          organizationContext,
          memberTeams: await listTeamsForMember({
            organizationId,
            memberId: memberIdentity.orgMembershipId,
          }),
          session: null,
        }
      }
    }
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
    if (method === "initialize" || method === "resources/list" || method === "resources/read") {
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
            ? "Search for a capability by keyword. This connection also exposes execute_capability, execute_capability_script, and the read-only render_dynamic_artifact tool —"
            : "Search for a capability by keyword. This connection only exposes this tool and execute_capability —",
          "there is no list of individually-named tools to browse. Always search first.",
          "Search covers native Google Workspace capabilities (Gmail, Calendar, Drive, Gmail drafts), org-connected external MCPs, and namespaced OpenWork Admin tools for allowlisted platform admins.",
          "Try 2-4 keyword variants before deciding a capability is unavailable.",
          "Native API matches include a connector-namespaced name, pathParams, queryParams, hasBody, and bodySchema. External MCP matches include argumentsSchema, schemaDigest, and invocation.argumentsField.",
          "Built-in and marketplace skill matches return SKILL.md content when executed.",
        ].join(" "),
        annotations: SEARCH_CAPABILITIES_ANNOTATIONS,
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
        return capabilitySearchToolResult(result.matches, result.externalCoverageHint)
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
          "For skill capabilities listed in the remote skill catalog, this returns their authorized SKILL.md content.",
          "Returns unknown_capability if name doesn't match a current capability — call search_capabilities again.",
        ].join(" "),
        annotations: EXECUTE_CAPABILITY_ANNOTATIONS,
        inputSchema: z.object({
          name: z.string().min(1).describe("The exact tool name returned by search_capabilities."),
          schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional().describe("For an external MCP match, copy the exact schemaDigest returned by search_capabilities so schema drift can be reported as advisory guidance without blocking the provider call."),
          path: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Path parameters, only if the match's pathParams is non-empty."),
          query: z.union([z.record(z.string(), z.unknown()), z.string()]).optional().describe("Query parameters, only if the match's queryParams is non-empty."),
          body: z.unknown().optional().describe("For native API capabilities, the JSON body. For external MCP capabilities, the arguments object matching argumentsSchema."),
        }),
      },
      async ({ name, schemaDigest, path, query, body }) => {
        return executeCapabilityWithBudget({
          capability: name,
          invoke: () => executeCapability(capabilityContext, { name, schemaDigest, path, query, body }),
        })
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
            message: "The Dynamic Artifact could not be loaded.",
          }
        }
      }

      registerAgentDynamicArtifactApp({
        server,
        load: loadDynamicArtifact,
      })

      // This server deploys independently from Desktop. Do not advertise or
      // serve bridge-dependent generated views until the compatible Desktop
      // MCP Apps host has been released and the operator enables the rollout.
      if (artifactContext && env.generatedArtifactViewsEnabled) {
        const generatedViews = await listArtifactViews({ context: artifactContext })
        registerAgentGeneratedArtifactViews({
          server,
          views: generatedViews,
          loadResource: async ({ artifactViewId, revisionId }) => {
            const { revision } = await loadArtifactViewRevision({
              context: artifactContext,
              artifactViewId,
              revisionId,
            })
            if (revision.build_status !== "ready" || !revision.compiled_html || !revision.resource_digest) {
              throw new Error("artifact_view_revision_not_ready")
            }
            return {
              html: revision.compiled_html,
              resourceDigest: revision.resource_digest,
              csp: revision.csp,
            }
          },
          loadData: loadDynamicArtifact,
          save: (request) => saveArtifactViewRevision({ context: artifactContext, ...request }),
          activate: (request) => activateArtifactViewRevision({ context: artifactContext, ...request }),
          retire: (request) => retireArtifactView({ context: artifactContext, ...request }),
        })
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
