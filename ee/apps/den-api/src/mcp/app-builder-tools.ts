import type { McpServer } from "@modelcontextprotocol/server"
import {
  createMcpAppInputSchema,
  MCP_APP_LAUNCH_TOOL_NAME,
  mcpAppResourceUri,
  mcpAppSummarySchema,
  readMcpAppInputSchema,
  readMcpAppOutputSchema,
  updateMcpAppInputSchema,
  type CreateMcpAppInput,
  type McpAppSummary,
  type ReadMcpAppOutput,
  type UpdateMcpAppInput,
} from "@openwork/types/mcp-app"
import { z } from "zod"
import type { McpAppEntry } from "../mcp-apps.js"
import { buildMarketplaceCapabilityName } from "./marketplace-capabilities.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

export const APP_AUTHORING_GUIDANCE = [
  "For a new app, dashboard, or interactive view, call create_app directly with complete React/CSS source, a readable textFallback, and the tools the App needs. No Workflow, receipt, output schema, or Automation is required. Do not use save_artifact_view for new apps; it only edits legacy views.",
  "Each App becomes its own standard MCP server with exactly: open_app (bound to the App's immutable ui:// revision), the tools you declare, and the App's resources. Declare each tool with a clear snake_case name, a description, and one exact capability name from search_capabilities: a saved Workflow, a connection tool, or an OpenWork action. Use mode live for a saved Workflow that reads input.runtime; it runs read-only. Tools run as whoever uses the App, with their own access and connections.",
  "Provide a default-exported React component receiving { app, input, result, hostContext }. input is the launch input object; result is the launch CallToolResult (read result?.structuredContent) and is undefined until the host delivers it. React is injected: use React.useState and other React APIs without imports. Do not use fetch, browser/host globals, dynamic code, external resources, URL-bearing elements, or native forms (<form> is blocked). Use labeled inputs and explicit type=button controls.",
  "Call only the App's declared tools, by their declared names: app.callServerTool({ name, arguments }). Workflow and connection tools take the capability's own arguments; OpenWork action tools take { path, query, body } as their schema shows; live Workflow tools take only an optional { timeZone }. Check app.getHostCapabilities()?.serverTools first and show a blocked state when it is absent. Hosts may require a user click before calling a tool that is not read-only; OpenWork does. Load data on open only with read-only tools such as live Workflows; start other calls from an explicit button and show tool_requires_approval or other errors as a readable blocked state.",
  "The standard bridge uses autoResize:true. app.sendSizeChanged({ height }) requests a height; the host may clamp it and automatic content-size updates still apply. Follow DESIGN.md: compact neutral layout, one focal action, explicit loading/empty/error/blocked states, no internal scrolling or automatic navigation.",
  "Creation uses a new private Plugin named after the App unless the user names an existing authorized pluginId. Share the App by sharing that Plugin; each person signs in with their own OpenWork account and sharing never shares credentials. The result includes the App's MCP URL for Cursor, Claude, or any MCP client. Read with read_app before update_app, supplying expectedRevisionId and complete replacement source; omit tools to keep the current ones.",
  "In OpenWork, create_app and update_app open the new revision in the conversation. To open an existing App, find it with search_capabilities (kind mcp_app) and execute that exact match. Only create an Automation when the user asks for a schedule.",
].join(" ")

const appResultSchema = z.object({
  app: mcpAppSummarySchema,
  input: z.record(z.string(), z.json()),
  mcpUrl: z.string(),
}).strict()

export class AppBuilderError extends Error {
  constructor(readonly code: string, message: string, readonly reason?: string) {
    super(message)
    this.name = "AppBuilderError"
  }
}

function failure(error: unknown) {
  return error instanceof AppBuilderError
    ? { error: error.code.slice(0, 120), message: error.message.slice(0, 1_000), ...(error.reason ? { reason: error.reason.slice(0, 120) } : {}) }
    : { error: "mcp_app_unavailable", message: "The App request could not be completed. Check access and try again." }
}

function errorResult(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(failure(error)) }] }
}

function mcpUrl(publicOrigin: string, serverPath: string) {
  return `${publicOrigin}${serverPath}`
}

/**
 * The App's own launch, as a Connect result. OpenWork renders it through its
 * private Connect catalog with the App server's open_app tool; other hosts
 * receive the text, the structured App, and its MCP URL.
 */
export function mcpAppLaunchResult(input: { app: McpAppSummary; publicOrigin: string; message: string }) {
  return {
    content: [{ type: "text" as const, text: `${input.message}\n\n${input.app.textFallback}` }],
    structuredContent: { app: input.app, input: {}, mcpUrl: mcpUrl(input.publicOrigin, input.app.serverPath) },
    _meta: {
      "openwork/mcpApp": {
        connectionId: input.app.appId,
        toolName: MCP_APP_LAUNCH_TOOL_NAME,
        resourceUri: input.app.resourceUri,
        arguments: { input: {} },
      },
    },
  }
}

/** App matches for search_capabilities: the exact name executes a launch of the App's own server. */
export function searchMcpApps(apps: McpAppEntry[], query: string, publicOrigin: string): CapabilityMatch[] {
  const tokens = tokenize(query)
  return apps.map((app) => ({
    name: buildMarketplaceCapabilityName(app.pluginId, app.appId),
    kind: "mcp_app",
    method: "MCP",
    path: app.serverPath,
    score: scoreText(tokenize(app.title), tokenize(app.description ?? ""), tokens, ["app", "apps", "dashboard"]),
    summary: `${app.description || app.title} Execute this exact name to open the App. It is also its own MCP server at ${mcpUrl(publicOrigin, app.serverPath)}.`,
    pathParams: [],
    queryParams: [],
    hasBody: false,
    mcpApp: { resourceUri: mcpAppResourceUri(app.appId, app.revisionId) },
  })).filter((match) => match.score > 0)
}

export type AppBuilderService = {
  create: (input: CreateMcpAppInput) => Promise<McpAppSummary>
  update: (input: UpdateMcpAppInput) => Promise<McpAppSummary>
  read: (input: { appId: string }) => Promise<ReadMcpAppOutput>
}

/** create_app, update_app, and read_app: Connect builds Apps; each App serves itself. */
export function registerAppBuilderTools(input: {
  server: McpServer
  scopes: ReadonlySet<string>
  service: AppBuilderService
  publicOrigin: string
  notifyCatalogChanged: () => void
}) {
  const requireScope = (scope: string) => {
    if (!input.scopes.has(scope)) throw new AppBuilderError("insufficient_mcp_scope", `This App operation requires the ${scope} scope.`)
  }
  input.server.registerTool("create_app", {
    title: "Create an App",
    description: APP_AUTHORING_GUIDANCE,
    inputSchema: createMcpAppInputSchema,
    outputSchema: appResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_WRITE_SCOPE)
      const app = await input.service.create(request)
      input.notifyCatalogChanged()
      return mcpAppLaunchResult({
        app,
        publicOrigin: input.publicOrigin,
        message: `Created ${app.title} as its own MCP server with ${app.tools.length} ${app.tools.length === 1 ? "tool" : "tools"} plus ${MCP_APP_LAUNCH_TOOL_NAME}. MCP URL: ${mcpUrl(input.publicOrigin, app.serverPath)}`,
      })
    } catch (error) {
      return errorResult(error)
    }
  })
  input.server.registerTool("update_app", {
    title: "Update an App",
    description: "Update an existing App with complete replacement source, title, and textFallback. First read_app; copy its revisionId to expectedRevisionId. Omit tools to keep the current ones, or pass the complete new list. Publishes an immutable revision in the same Plugin and MCP server without changing sharing. Requires editor access and normal fresh-session checks for shared Apps. " + APP_AUTHORING_GUIDANCE,
    inputSchema: updateMcpAppInputSchema,
    outputSchema: appResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_WRITE_SCOPE)
      const app = await input.service.update(request)
      input.notifyCatalogChanged()
      return mcpAppLaunchResult({ app, publicOrigin: input.publicOrigin, message: `Updated ${app.title} to a new revision.` })
    } catch (error) {
      return errorResult(error)
    }
  })
  input.server.registerTool("read_app", {
    title: "Read an App for editing",
    description: "Read an App's latest summary, declared tools, and React/CSS source before editing. Requires mcp:read and editor access, not merely permission to open the App. Does not open or run the App.",
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
}
