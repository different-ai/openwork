import { ProtocolError, ProtocolErrorCode, type McpServer, type RegisteredTool } from "@modelcontextprotocol/server"
import {
  createMcpAppInputSchema,
  mcpAppIdSchema,
  mcpAppResourceUri,
  mcpAppSummarySchema,
  parseMcpAppResourceUri,
  readMcpAppInputSchema,
  readMcpAppOutputSchema,
  updateMcpAppInputSchema,
  type CreateMcpAppInput,
  type McpAppSummary,
  type ReadMcpAppOutput,
  type UpdateMcpAppInput,
} from "@openwork/types/mcp-app"
import { z } from "zod"
import type { McpAppResource } from "../mcp-apps.js"
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "./mcp-app-v2.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

export const APP_AUTHORING_GUIDANCE = [
  "For a new app, dashboard, or interactive view, call create_app directly with complete React/CSS source and a readable textFallback. No Workflow, receipt, output schema, or Automation is required. Do not use save_artifact_view for new apps; it only edits legacy views. Older Workflow tool descriptions mentioning that sequence apply only to existing legacy views.",
  "Provide a default-exported React component receiving { app, input, result, hostContext }. input is the launch input object; result is the launch CallToolResult (read result?.structuredContent) and is undefined until the host delivers it. React is injected: use React.useState and other React APIs without imports. Do not use fetch, browser/host globals, dynamic code, external resources, URL-bearing elements, or native forms (<form> is blocked). Use labeled inputs and explicit type=button controls.",
  "Use app.callServerTool({ name, arguments }) with exact discovered tool names and arguments for data and actions: this server's tools, including search_capabilities, execute_capability, and saved Workflows, are ordinary tools, not a parent App runtime. Check app.getHostCapabilities()?.serverTools first and show a blocked state when it is absent. Existing tool authorization, MCP scopes, and host consent apply; there is no per-App tool grant. Hosts may require a user click before calling tools that are not read-only; OpenWork does, and execute_capability is not read-only. So only read-only tools such as search_capabilities may run on mount: start execute_capability and other data loads or actions from an explicit button, and show tool_requires_approval or other errors as a readable blocked state. Do not claim nested provider visibility has been checked.",
  "The standard bridge uses autoResize:true. app.sendSizeChanged({ height }) requests a height; the host may clamp it and automatic content-size updates still apply. Follow DESIGN.md: compact neutral layout, one focal action, explicit loading/empty/error/blocked states, no internal scrolling or automatic navigation.",
  "Creation uses a new private Plugin unless the user names an existing authorized pluginId. Share through that same Plugin and its existing access rules; sharing never shares credentials. Read with read_app before update_app, supplying expectedRevisionId and complete replacement source. Source reads require editor access.",
  "Create, read, and update return non-UI text and structured results. To open the App, call the returned open_app_cob_* direct tool. Its definition binds a fixed immutable ui:// revision; opening does not execute any data tools. Only create an Automation when the user asks for a schedule.",
].join(" ")

export const openAppInputSchema = z.object({ input: z.record(z.string(), z.json()).optional() }).strict()
const appOutputSchema = z.object({ app: mcpAppSummarySchema }).strict()

export class AuthoredAppError extends Error {
  constructor(readonly code: string, message: string, readonly reason?: string) {
    super(message)
    this.name = "AuthoredAppError"
  }
}

function failure(error: unknown) {
  return error instanceof AuthoredAppError
    ? { error: error.code.slice(0, 120), message: error.message.slice(0, 1_000), ...(error.reason ? { reason: error.reason.slice(0, 120) } : {}) }
    : { error: "mcp_app_unavailable", message: "The App request could not be completed. Check access and try again." }
}

function errorResult(error: unknown) {
  const payload = failure(error)
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }] }
}

export function authoredAppIdFromToolName(name: string | null): string | null {
  if (!name?.startsWith("open_app_")) return null
  const parsed = mcpAppIdSchema.safeParse(name.slice("open_app_".length))
  return parsed.success ? parsed.data : null
}

export function authoredAppLaunchInstruction(app: McpAppSummary) {
  const message = `Call the direct MCP tool ${app.toolName} with optional { input: { ... } } to open ${app.title}. execute_capability cannot supply this App's fixed standard resource binding. No App was opened and no data tools were run.`
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { status: "direct_tool_required", app, message },
  }
}

export function searchAuthoredMcpApps(apps: McpAppSummary[], query: string): CapabilityMatch[] {
  const tokens = tokenize(query)
  return apps.map((app) => ({
    name: app.toolName,
    kind: "mcp_app",
    method: "MCP",
    path: app.resourceUri,
    score: scoreText(tokenize(`${app.title} ${app.toolName}`), tokenize(app.description ?? ""), tokens, ["app", "apps", "dashboard"]),
    summary: app.description || app.title,
    pathParams: [],
    queryParams: [],
    hasBody: false,
    argumentsSchema: z.toJSONSchema(openAppInputSchema),
    mcpApp: { resourceUri: app.resourceUri },
    hint: `Call ${app.toolName} directly, not through execute_capability. Opening does not run data tools.`,
  })).filter((match) => match.score > 0)
}

export type AuthoredAppService = {
  create: (input: CreateMcpAppInput) => Promise<McpAppSummary>
  update: (input: UpdateMcpAppInput) => Promise<McpAppSummary>
  read: (input: { appId: string }) => Promise<ReadMcpAppOutput>
  list: () => Promise<McpAppSummary[]>
  loadResource: (input: { appId: string; revisionId: string }) => Promise<McpAppResource>
}

export async function registerAgentAuthoredApps(input: {
  server: McpServer
  scopes: ReadonlySet<string>
  service: AuthoredAppService
  request: { method: string | null; toolName: string | null; resourceUri: string | null }
  notifyCatalogChanged: () => void
}) {
  const resources = new Set<string>()
  const tools = new Map<string, { revisionId: string; registration: RegisteredTool }>()
  const requireScope = (scope: string) => {
    if (!input.scopes.has(scope)) throw new AuthoredAppError("insufficient_mcp_scope", `This App operation requires the ${scope} scope.`)
  }
  const registerResource = (identity: { appId: string; revisionId: string }, title = "App revision") => {
    const uri = mcpAppResourceUri(identity.appId, identity.revisionId)
    if (resources.has(uri)) return
    resources.add(uri)
    registerAppResource(input.server, `${identity.appId}:${identity.revisionId}`, uri, { title }, async () => {
      try {
        requireScope(DEN_MCP_READ_SCOPE)
        const resource = await input.service.loadResource({ appId: identity.appId, revisionId: identity.revisionId })
        return { contents: [{
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: resource.html,
          _meta: { ui: { csp: resource.csp, prefersBorder: true }, resourceDigest: resource.resourceDigest },
        }] }
      } catch (error) {
        const result = failure(error)
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, result.message, { error: result.error })
      }
    })
  }
  const syncApp = (app: McpAppSummary) => {
    registerResource(app, app.title)
    const existing = tools.get(app.appId)
    if (existing?.revisionId === app.revisionId) return
    existing?.registration.remove()
    const registration = registerAppTool(input.server, app.toolName, {
      title: `Open ${app.title}`,
      description: `Open ${app.title}. Returns launch input and a readable fallback; opening never runs data tools. Interactive actions use normal server tools and host consent.`,
      inputSchema: openAppInputSchema,
      outputSchema: z.object({ app: mcpAppSummarySchema, input: z.record(z.string(), z.json()) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: app.resourceUri, visibility: ["model", "app"] } },
    }, async (request) => {
      try {
        requireScope(DEN_MCP_READ_SCOPE)
        const resource = await input.service.loadResource({ appId: app.appId, revisionId: app.revisionId })
        return {
          content: [{ type: "text", text: resource.app.textFallback }],
          structuredContent: { app: resource.app, input: request.input ?? {} },
        }
      } catch (error) {
        return errorResult(error)
      }
    })
    tools.set(app.appId, { revisionId: app.revisionId, registration })
  }
  input.server.registerTool("create_app", {
    title: "Create an App",
    description: APP_AUTHORING_GUIDANCE,
    inputSchema: createMcpAppInputSchema,
    outputSchema: appOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_WRITE_SCOPE)
      const app = await input.service.create(request)
      syncApp(app)
      input.notifyCatalogChanged()
      return { content: [{ type: "text", text: `Created ${app.title}. Call ${app.toolName} directly to open it.` }], structuredContent: { app } }
    } catch (error) {
      return errorResult(error)
    }
  })
  input.server.registerTool("update_app", {
    title: "Update an App",
    description: "Update an existing App with complete replacement source, title, and textFallback. First read_app; copy its revisionId to expectedRevisionId. Publishes an immutable revision in the same Plugin without changing sharing. Requires editor access and normal fresh-session checks for shared Apps. " + APP_AUTHORING_GUIDANCE,
    inputSchema: updateMcpAppInputSchema,
    outputSchema: appOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_WRITE_SCOPE)
      const app = await input.service.update(request)
      syncApp(app)
      input.notifyCatalogChanged()
      return { content: [{ type: "text", text: `Updated ${app.title}. Call ${app.toolName} directly to open the new revision.` }], structuredContent: { app } }
    } catch (error) {
      return errorResult(error)
    }
  })
  input.server.registerTool("read_app", {
    title: "Read an App for editing",
    description: "Read an App's latest summary and React/CSS source before editing. Requires mcp:read and editor access, not merely permission to open the App. Does not open or run the App.",
    inputSchema: readMcpAppInputSchema,
    outputSchema: readMcpAppOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_READ_SCOPE)
      const result = await input.service.read(request)
      return { content: [{ type: "text", text: `Read ${result.app.title} for editing at revision ${result.app.revisionId}.` }], structuredContent: result }
    } catch (error) {
      return errorResult(error)
    }
  })
  if (!input.scopes.has(DEN_MCP_READ_SCOPE)) return
  if (input.request.method === "resources/read" && input.request.resourceUri) {
    const exact = parseMcpAppResourceUri(input.request.resourceUri)
    if (exact) registerResource(exact)
  }
  const target = input.request.method === "tools/call" ? authoredAppIdFromToolName(input.request.toolName) : null
  if (target || input.request.method === "tools/list" || input.request.method === "resources/list") {
    for (const app of await input.service.list()) {
      if (!target || app.appId === target) syncApp(app)
    }
  }
}
