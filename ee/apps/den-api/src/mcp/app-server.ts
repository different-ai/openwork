import { createHash } from "node:crypto"
import { startMcpAppTiming } from "@openwork/types/mcp-app-timing";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
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
  MCP_APP_INITIAL_RESULTS_META,
  MCP_APP_LAUNCH_TOOL_NAME,
  MCP_APP_STORAGE_META,
  mcpAppIdSchema,
  parseMcpAppResourceUri,
  type McpAppToolBinding,
} from "@openwork/types/mcp-app"
import type { Context, Hono } from "hono"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { cache } from "../cache.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { getOrganizationFeatures } from "../features.js"
import {
  loadMcpAppResource,
  loadMcpAppServerDefinition,
  McpAppError,
  type McpAppResource,
  type McpAppServerDefinition,
} from "../mcp-apps.js"
import { executeCapabilityWithBudget } from "./agent.js"
import { runsWithoutClick } from "./app-tool-access.js"
import { launchInitialResults, launchReadHandoff, requiredScope, type LaunchReadHandoff, type McpAppLaunchDataStore } from "./app-launch-data.js"
import { APP_SITE_HEADER } from "./app-site.js"
import { bindMcpAppStorage, callMcpAppStorageTool, MCP_APP_STORAGE_TOOL_NAMES, mcpAppStorageTools, type McpAppStorageBinding } from "./app-storage-tools.js"
import { callMcpAppTool, mcpAppToolKeepable } from "./app-tools.js"
import { mcpAuditPrincipal } from "../audit/mcp-service-audit.js"
import { mcpPrincipalCredentialId, type McpPrincipal } from "./auth.js"
import { createCapabilityRegistryContext, type ExecuteCapabilityToolResult } from "./capability-registry.js"
import { resolveMcpMemberIdentity } from "./external-capabilities.js"
import { getCatalog } from "./index.js"
import { DEN_MCP_READ_SCOPE } from "./scopes.js"

export function isMcpAppServerId(value: string): boolean {
  return mcpAppIdSchema.safeParse(value).success
}

const launchInputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    input: {
      type: "object",
      additionalProperties: true,
      description: "Optional JSON launch input the artifact receives.",
    },
    timeZone: {
      type: "string",
      description: "Optional IANA time zone for the data the artifact loads as it opens.",
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
    description: `Open ${app.title}.${app.description ? ` ${app.description}` : ""} Returns its launch input and a readable summary${definition.loadsWithLaunch ? "; opening also loads the artifact's read-only data" : "; opening runs no other tools"}.`,
    inputSchema: launchInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: app.resourceUri, visibility: ["model", "app"] }, "ui/resourceUri": app.resourceUri },
  }
}

function boundTool(binding: McpAppToolBinding): Tool {
  const noClick = runsWithoutClick(binding)
  return {
    name: binding.name,
    description: binding.description,
    inputSchema: { ...binding.inputSchema, type: "object" },
    annotations: {
      readOnlyHint: noClick,
      destructiveHint: !noClick,
      idempotentHint: binding.readOnly,
      openWorldHint: binding.kind !== "api",
    },
    _meta: { ui: { visibility: ["model", "app"] } },
  }
}

type AppRefusal = "not_a_member" | "other_organization" | "apps_off" | "not_found"

const REFUSAL_MESSAGES: Record<Exclude<AppRefusal, "other_organization">, string> = {
  not_a_member: "The artifact is not available: this connection is not signed in to an organization you belong to.",
  apps_off: "The artifact is not available: artifacts built in OpenWork are turned off for this organization.",
  not_found: "The artifact is not available.",
}

async function appOrganizationForMember(appId: string, userId: string) {
  const [row] = await db.select({ id: OrganizationTable.id, name: OrganizationTable.name })
    .from(ConfigObjectTable)
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, ConfigObjectTable.organizationId))
    .innerJoin(MemberTable, and(eq(MemberTable.organizationId, ConfigObjectTable.organizationId), eq(MemberTable.userId, normalizeDenTypeId("user", userId))))
    .where(and(eq(ConfigObjectTable.id, normalizeDenTypeId("configObject", appId)), eq(ConfigObjectTable.objectType, "app"), isNull(ConfigObjectTable.deletedAt)))
    .limit(1)
  return row ?? null
}

async function refuseAppRequest(request: Request, input: { reason: AppRefusal; organizationId: string; appId: string; organizationName?: string }): Promise<Response> {
  console.error("mcp_app_server_refused", { reason: input.reason, organizationId: input.organizationId, appId: input.appId })
  const message = input.reason === "other_organization"
    ? `This artifact belongs to ${input.organizationName ?? "another organization"}. Switch to ${input.organizationName ?? "that organization"} in OpenWork, then connect the artifact again.`
    : REFUSAL_MESSAGES[input.reason]
  return appUnavailableResponse(request, message, input.reason)
}

async function appUnavailableResponse(request: Request, message = REFUSAL_MESSAGES.not_found, reason: AppRefusal = "not_found"): Promise<Response> {
  let id: string | number | null = null
  try {
    const body: unknown = await request.clone().json()
    if (typeof body === "object" && body !== null && "id" in body && (typeof body.id === "string" || typeof body.id === "number")) id = body.id
  } catch {
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

export function createMcpAppServer(input: {
  definition: McpAppServerDefinition
  scopes: ReadonlySet<string>
  loadResource: (revision: { appId: string; revisionId: string }) => Promise<McpAppResource>
  callTool: (binding: McpAppToolBinding, args: Record<string, unknown>) => Promise<ExecuteCapabilityToolResult>
  launchData?: McpAppLaunchDataStore
  canKeep?: (binding: McpAppToolBinding) => boolean
  launchReads?: LaunchReadHandoff
  instructions?: string
  /** Present only for an artifact that saves data. Its tools are listed only while that data can be used. */
  storage?: McpAppStorageBinding
  storageUsage?: { organizationId: string; memberId: string }
}) {
  const { app, tools } = input.definition
  const storage = input.storage
  const storageTools = storage?.access ? mcpAppStorageTools(app.title, storage.storage) : []
  const server = new Server({ name: app.title, version: "1.0.0" }, {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
    },
    instructions: input.instructions ?? `This is the ${app.title} artifact from OpenWork. Call ${MCP_APP_LAUNCH_TOOL_NAME} to open it. Its other tools run as you, with your own OpenWork access and connections.`,
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [launchTool(input.definition), ...tools.map(boundTool), ...storageTools],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = toolArguments(request.params.arguments)
    if (request.params.name === MCP_APP_LAUNCH_TOOL_NAME) {
      if (!input.scopes.has(DEN_MCP_READ_SCOPE)) return scopeError(MCP_APP_LAUNCH_TOOL_NAME, DEN_MCP_READ_SCOPE)
      const launchInput = toolArguments(args.input)
      const initialResults = input.definition.loadsWithLaunch && Object.keys(launchInput).length === 0
        ? await launchInitialResults({ tools, scopes: input.scopes, timeZone: typeof args.timeZone === "string" ? args.timeZone : undefined, callTool: input.callTool, store: input.launchData, canKeep: input.canKeep, handoff: input.launchReads })
        : []
      return {
        content: [{ type: "text", text: app.textFallback }],
        structuredContent: { app, input: launchInput },
        ...(initialResults.length > 0 || storage ? {
          _meta: {
            ...(initialResults.length > 0 ? { [MCP_APP_INITIAL_RESULTS_META]: initialResults } : {}),
            ...(storage ? { [MCP_APP_STORAGE_META]: storage.status } : {}),
          },
        } : {}),
      }
    }
    if (storage && MCP_APP_STORAGE_TOOL_NAMES.has(request.params.name)) {
      return callMcpAppStorageTool({ binding: storage, name: request.params.name, args, scopes: input.scopes, usage: input.storageUsage })
    }
    const binding = tools.find((tool) => tool.name === request.params.name)
    if (!binding) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} is not available on ${app.title}.`)
    if (request.params._meta?.["openwork/cache"] === "read") {
      return { isError: true, content: [{ type: "text", text: "No kept result is available from this host." }], _meta: { "openwork/cached": false } }
    }
    const scope = requiredScope(binding)
    if (!input.scopes.has(scope)) return scopeError(binding.name, scope)
    const run = () => input.callTool(binding, args)
    return input.launchReads ? input.launchReads.call(binding, args, run) : run()
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: app.resourceUri, name: app.title, mimeType: RESOURCE_MIME_TYPE, ...(app.description ? { description: app.description } : {}) }],
  }))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }))
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const revision = parseMcpAppResourceUri(request.params.uri)
    if (!revision || revision.appId !== app.appId || !input.scopes.has(DEN_MCP_READ_SCOPE)) {
      throw new McpError(ErrorCode.InvalidRequest, "The resource is not an available revision of this artifact.", { error: "mcp_app_not_found" })
    }
    let resource: McpAppResource
    try {
      resource = await input.loadResource(revision)
    } catch (error) {
      throw new McpError(ErrorCode.InvalidRequest, "The resource is not an available revision of this artifact.", {
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
  const [member, home, organizationFeatures, catalog] = await Promise.all([
    resolveMcpMemberIdentity({ userId: principal.userId, organizationId }),
    appOrganizationForMember(input.appId, principal.userId),
    getOrganizationFeatures(organizationId, { userId: principal.userId }),
    getCatalog(input.app, context.env),
  ])
  if (!member) return refuse("not_a_member")
  if (home && home.id !== organizationId) return refuse("other_organization", home.name)
  if (!env.appMcpServersEnabled) return refuse("apps_off")
  const capabilityContext = createCapabilityRegistryContext({
    app: input.app,
    env: context.env,
    catalog,
    principal,
    organizationId,
    member,
    redirectUriBase: resolvePublicOrigin(context.req.raw, env.apiPublicUrl),
    generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
    organizationFeatures,
    audit: mcpAuditPrincipal({ organizationId, userId: principal.userId, memberId: member.orgMembershipId, credentialId: mcpPrincipalCredentialId(principal) }),
    usageSource: "app",
  })
  const access = { organizationId, member, requestScope: {} }
  let definition: McpAppServerDefinition
  try {
    definition = await loadMcpAppServerDefinition({ ...access, appId: input.appId })
  } catch (error) {
    if (error instanceof McpAppError) return refuse("not_found")
    throw error
  }
  if (context.req.header(APP_SITE_HEADER) && !definition.site) return refuse("not_found")
  const server = createMcpAppServer({
    definition,
    scopes: principal.scopes,
    ...(definition.storage ? {
      storage: bindMcpAppStorage({
        organizationId,
        appId: definition.app.appId,
        storage: definition.storage,
        memberId: member.orgMembershipId,
        enabled: organizationFeatures.artifactStorage,
      }),
      storageUsage: { organizationId, memberId: member.orgMembershipId },
    } : {}),
    loadResource: (revision) => loadMcpAppResource({ ...access, ...revision }),
    callTool: (binding, args) => executeCapabilityWithBudget({
      capability: binding.capability,
      invoke: () => callMcpAppTool(capabilityContext, binding, args),
    }),
    canKeep: (binding) => mcpAppToolKeepable(capabilityContext, binding),
    launchReads: launchReadHandoff(JSON.stringify([
      organizationId, member.orgMembershipId, [...member.teamIds].sort(), mcpPrincipalCredentialId(principal),
      [...principal.scopes].sort(), definition.app.appId, definition.app.revisionId,
    ])),
    launchData: {
      async open(timeZone) {
        const revision = await cache.inventory.revision(organizationId)
        if (!revision) return null
        const key = createHash("sha256").update(JSON.stringify([
          revision, member.orgMembershipId, [...member.teamIds].sort(), definition.app.appId, definition.app.revisionId,
          [...principal.scopes].sort(), timeZone ?? "",
        ])).digest("hex")
        return {
          kept: await cache.mcpAppLaunchData.load(key),
          save: (results) => cache.mcpAppLaunchData.save(key, results),
        }
      },
    },
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
    if (process.env.OPENWORK_MCP_APP_TIMINGS === "1" && response.body) {
      void response.clone().arrayBuffer().then(finish, finish)
    } else finish()
    return response
  } catch (cause) { finish(); throw cause }
}
