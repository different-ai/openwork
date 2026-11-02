import type { McpServer } from "@modelcontextprotocol/server"
import {
  createMcpAppInputSchema,
  MCP_APP_LAUNCH_TOOL_NAME,
  mcpAppResourceUri,
  mcpAppSummarySchema,
  prepareMcpAppInputSchema,
  prepareMcpAppOutputSchema,
  readMcpAppInputSchema,
  readMcpAppOutputSchema,
  updateMcpAppInputSchema,
  type CreateMcpAppInput,
  type McpAppSummary,
  type PrepareMcpAppInput,
  type PrepareMcpAppOutput,
  type ReadMcpAppOutput,
  type UpdateMcpAppInput,
} from "@openwork/types/mcp-app"
import { z } from "zod"
import type { McpAppEntry } from "../mcp-apps.js"
import { buildMarketplaceCapabilityName } from "./marketplace-capability-name.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

/**
 * Model-facing note in the launch result of an App built in OpenWork. OpenWork
 * shows the App right above the model's reply, so a long reply pushes it out of
 * view. Other clients cannot be told apart here, so the note is conditional and
 * never hides the App's MCP URL, which is how those clients use the App.
 */
export const MCP_APP_SHOWN_NOTE = "If you are in OpenWork, the person now sees this App right above your reply: answer in one or two sentences and do not repeat what it shows."

// Add gateway documentation without changing the shared validators. Cloning
// the array definition retains its size limit and unique-name refinement.
const toolDeclarations = createMcpAppInputSchema.shape.tools.unwrap()
const toolDeclaration = toolDeclarations.element
const documentedTools = toolDeclarations.clone({
  ...toolDeclarations.def,
  element: toolDeclaration.extend({
    name: toolDeclaration.shape.name.describe("Name exposed by this App and used to select this tool in app.callServerTool."),
    description: toolDeclaration.shape.description.describe("What this tool does for the person using the App, including any changes it makes."),
    capability: toolDeclaration.shape.capability.describe("Exact capability name returned by search_capabilities: a saved Workflow, connection tool, or read-only OpenWork GET action."),
    mode: toolDeclaration.shape.mode.describe("input (default) passes the caller's arguments; live runs a saved Workflow using server-supplied input.runtime and accepts only an optional timeZone."),
    loadOnOpen: toolDeclaration.shape.loadOnOpen.describe("true when this tool only reads data the person asked to see but is not marked readOnly, so the App loads it on open with no click. Refused for tools known to write."),
  }),
})
const authoringShape = {
  title: createMcpAppInputSchema.shape.title.describe("Short human-readable title naming the App's outcome, not a generic label such as Dashboard."),
  description: createMcpAppInputSchema.shape.description.describe("One sentence describing what the person sees and does in the App."),
  reactSource: createMcpAppInputSchema.shape.reactSource.describe("Complete React source default-exporting a component receiving { app, input, result, hostContext }. React is injected; import only the built-in libraries prepare_app lists, if any. Follow skill:build-an-app's source and tool-call rules."),
  cssSource: createMcpAppInputSchema.shape.cssSource.describe("Complete CSS source using host theme variables and responsive container rules. Omit on creation for empty CSS; omit on update to keep existing CSS."),
  textFallback: createMcpAppInputSchema.shape.textFallback.describe("Readable plain-text alternative describing what the App shows, for hosts that cannot render it; usually one or two sentences."),
  tools: documentedTools.optional().describe("Complete set of tools the App may call. Omit or use [] for a self-contained new App; omit on update to keep existing tools, or use [] to remove them."),
}
const prepareAppInputSchema = prepareMcpAppInputSchema.extend({
  title: authoringShape.title,
  description: authoringShape.description,
  tools: authoringShape.tools,
})
const createAppInputSchema = createMcpAppInputSchema.extend({
  ...authoringShape,
  pluginId: createMcpAppInputSchema.shape.pluginId.describe("Existing Plugin ID (plg_...) to contain the App; omit to create a new private Plugin named after the App. Sharing that Plugin shares the App and its bound Workflows."),
  preparationId: createMcpAppInputSchema.shape.preparationId.describe("UUID returned by prepare_app, correlating this build with its preparation in chat. It grants no access and does not skip validation; older clients may omit it."),
})
const appId = readMcpAppInputSchema.shape.appId.describe("App ID (cob_...) from search_capabilities or an App result's app.appId; not its Plugin ID, revision ID, or capability name.")
const updateAppInputSchema = updateMcpAppInputSchema.extend({
  ...authoringShape,
  description: updateMcpAppInputSchema.shape.description.describe("Replacement description of what the person sees and does; omit to keep the current description, or pass an empty string to clear it."),
  appId,
  expectedRevisionId: updateMcpAppInputSchema.shape.expectedRevisionId.describe("Latest revision ID (cov_...) from read_app's app.revisionId. The update fails if someone has published another revision since that read."),
})
const readAppInputSchema = readMcpAppInputSchema.extend({ appId })

const appResultSchema = z.object({
  app: mcpAppSummarySchema,
  input: z.record(z.string(), z.json()),
  mcpUrl: z.string(),
  launch: z.object({ connectionId: z.string(), toolName: z.literal("open_app"), resourceUri: z.string(), arguments: z.object({ input: z.record(z.string(), z.json()) }) }).optional(),
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
 * receive the text, the structured App, and its MCP URL. An App the catalog
 * cannot list (canOpen false) is described without a launch OpenWork would fail.
 */
export function mcpAppLaunchResult(input: { app: McpAppSummary; publicOrigin: string; message: string; launchInput?: unknown; canOpen?: boolean; built?: boolean }) {
  const launchInput = mcpAppLaunchInput(input.launchInput)
  const url = mcpUrl(input.publicOrigin, input.app.serverPath)
  // Code Mode retains structuredContent but omits transport _meta. Keep the
  // server-issued launch in both projections; capacity-denied Apps have neither.
  const launch = { connectionId: input.app.appId, toolName: MCP_APP_LAUNCH_TOOL_NAME, resourceUri: input.app.resourceUri, arguments: { input: launchInput } }
  const structuredContent = { app: input.app, input: launchInput, mcpUrl: url, ...(input.canOpen === false ? {} : { launch }) }
  if (input.canOpen === false) {
    return {
      content: [{ type: "text" as const, text: `${input.message} OpenWork lists at most 100 connections and Apps for you, and this App is past that limit, so it cannot open inside OpenWork. Its MCP URL works in any MCP client: ${url}\n\n${input.app.textFallback}` }],
      structuredContent,
    }
  }
  return {
    content: [{ type: "text" as const, text: `${input.message} ${input.built ? "If you are in OpenWork, the App opens in a tab in the right sidebar. Answer briefly and do not repeat what it shows." : MCP_APP_SHOWN_NOTE}\n\n${input.app.textFallback}` }],
    structuredContent,
    _meta: {
      "openwork/mcpApp": {
        connectionId: input.app.appId,
        toolName: MCP_APP_LAUNCH_TOOL_NAME,
        resourceUri: input.app.resourceUri,
        arguments: { input: launchInput },
      },
    },
  }
}

/** An App's launch input is a JSON object; anything else opens it with none. */
function mcpAppLaunchInput(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {}
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
    summary: `${app.description || app.title} Execute this exact name to open the App; an optional launch input object is passed to the App. It is also its own MCP server at ${mcpUrl(publicOrigin, app.serverPath)}. Its appId for read_app and update_app is ${app.appId}.`,
    pathParams: [],
    queryParams: [],
    hasBody: true,
    mcpApp: { resourceUri: mcpAppResourceUri(app.appId, app.revisionId) },
  })).filter((match) => match.score > 0)
}

export type AppBuilderService = {
  prepare: (input: PrepareMcpAppInput) => Promise<PrepareMcpAppOutput>
  create: (input: CreateMcpAppInput) => Promise<McpAppSummary>
  update: (input: UpdateMcpAppInput) => Promise<McpAppSummary>
  read: (input: { appId: string }) => Promise<ReadMcpAppOutput>
}

/** Connect prepares and builds Apps; each completed App serves itself. */
export function registerAppBuilderTools(input: {
  server: McpServer
  scopes: ReadonlySet<string>
  service: AppBuilderService
  publicOrigin: string
  /** Whether OpenWork can open this App: its server index lists it. */
  canOpen?: (appId: string) => Promise<boolean>
  notifyCatalogChanged: () => void
}) {
  const requireScope = (scope: string) => {
    if (!input.scopes.has(scope)) throw new AppBuilderError("insufficient_mcp_scope", `This App operation requires the ${scope} scope.`)
  }
  input.server.registerTool("prepare_app", {
    title: "Prepare an App",
    description: "Prepare an App before writing its source, using a title naming its outcome, a description of what the person sees and does, and exact tools from search_capabilities (none for a self-contained App). Returns preparationId for create_app, title, verified tools with inputSchema/readOnly/kind/mode, starter { reactSource, cssSource }, and nextSteps. The starter pattern is lookup when all tools read, action when one changes data, or standalone with no tools; nextSteps identifies tools not yet wired. Does not run tools, create a Plugin, or publish an App. Requires mcp:write. Follow skill:build-an-app for authoring rules.",
    inputSchema: prepareAppInputSchema,
    outputSchema: prepareMcpAppOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_WRITE_SCOPE)
      const result = await input.service.prepare(request)
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }
    } catch (error) {
      return errorResult(error)
    }
  })
  input.server.registerTool("create_app", {
    title: "Create an App",
    description: [
      "Create and publish an App as its own MCP server from complete React/CSS source, textFallback, and declared tools. Read skill:build-an-app for required source, host, approval, caching, and tool-call rules before writing source; start with prepare_app and pass its preparationId (optional for older clients). This call rechecks bindings, compiles source, and saves the App; no Workflow, output schema, or Automation is required.",
      "Bind exact capabilities from search_capabilities: saved Workflows, connection tools, or read-only OpenWork GET actions. To change OpenWork data, bind a saved Workflow. Tools run as the person using the App. Load read-only data on open after the launch result arrives; changes and approval-required calls need their own button, one call per click.",
      "Creates a new private Plugin unless pluginId selects an existing one. Bound Workflows join that Plugin; sharing it shares the App and those Workflows. Requires mcp:write.",
      "Returns app (summary including appId, pluginId, revisionId and tools, not source), input (empty launch input), mcpUrl, and usually launch { connectionId, toolName, resourceUri, arguments }. launch is omitted when the App is beyond OpenWork's connection limit; mcpUrl still works in MCP clients. OpenWork opens an available App in a sidebar tab; other hosts receive its MCP URL and text fallback. Reply briefly.",
    ].join(" "),
    inputSchema: createAppInputSchema,
    outputSchema: appResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_WRITE_SCOPE)
      const app = await input.service.create(request)
      input.notifyCatalogChanged()
      return mcpAppLaunchResult({
        app,
        built: true,
        publicOrigin: input.publicOrigin,
        message: `Created ${app.title} as its own MCP server with ${app.tools.length} ${app.tools.length === 1 ? "tool" : "tools"} plus ${MCP_APP_LAUNCH_TOOL_NAME}. MCP URL: ${mcpUrl(input.publicOrigin, app.serverPath)}`,
        canOpen: await input.canOpen?.(app.appId) ?? true,
      })
    } catch (error) {
      return errorResult(error)
    }
  })
  input.server.registerTool("update_app", {
    title: "Update an App",
    description: [
      "Update an existing App with complete replacement React source, title, and textFallback, following create_app's rules.",
      "First read_app, and copy its app.revisionId to expectedRevisionId. Omit cssSource, description, or tools to keep the current ones, or pass complete replacements. Follow skill:build-an-app's source and tool-call rules.",
      "Publishes an immutable revision in the same Plugin and MCP server; newly bound Workflows join that Plugin, so everyone it is shared with can run them. Requires editor access and the mcp:write scope.",
      "Returns app (updated summary, not source), input (empty launch input), mcpUrl, and launch { connectionId, toolName, resourceUri, arguments } unless OpenWork's connection limit prevents opening it. The MCP URL remains usable. OpenWork opens an available App in a sidebar tab.",
    ].join(" "),
    inputSchema: updateAppInputSchema,
    outputSchema: appResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_WRITE_SCOPE)
      const app = await input.service.update(request)
      input.notifyCatalogChanged()
      return mcpAppLaunchResult({ app, built: true, publicOrigin: input.publicOrigin, message: `Updated ${app.title} to a new revision.`, canOpen: await input.canOpen?.(app.appId) ?? true })
    } catch (error) {
      return errorResult(error)
    }
  })
  input.server.registerTool("read_app", {
    title: "Read an App",
    description: "Read an App before editing. Returns app (latest summary including appId, pluginId, revisionId, title, description, textFallback, tools and launch resource/server identifiers), reactSource, and cssSource. Use app.revisionId as update_app's expectedRevisionId; tools are summaries, not input schemas. Requires mcp:read and editor access, not merely permission to open the App. Does not open or run the App.",
    inputSchema: readAppInputSchema,
    outputSchema: readMcpAppOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_READ_SCOPE)
      const result = await input.service.read(request)
      // Hosts that forward only text still need the source update_app replaces.
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result }
    } catch (error) {
      return errorResult(error)
    }
  })
}
