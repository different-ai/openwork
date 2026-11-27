import type { McpServer } from "@modelcontextprotocol/server"
import {
  createMcpAppInputSchema,
  mcpAppPublicPath,
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

export const MCP_APP_SHOWN_NOTE = "If you are in OpenWork, the person now sees this artifact right above your reply: answer in one or two sentences and do not repeat what it shows."

const toolDeclarations = createMcpAppInputSchema.shape.tools.unwrap()
const toolDeclaration = toolDeclarations.element
const documentedTools = toolDeclarations.clone({
  ...toolDeclarations.def,
  element: toolDeclaration.extend({
    name: toolDeclaration.shape.name.describe("Name exposed by this artifact and used to select this tool in app.callServerTool."),
    description: toolDeclaration.shape.description.describe("What this tool does for the person using the artifact, including any changes it makes."),
    capability: toolDeclaration.shape.capability.describe("Exact capability name returned by search_capabilities: a saved Workflow, connection tool, or read-only OpenWork GET action."),
    mode: toolDeclaration.shape.mode.describe("input (default) passes the caller's arguments; live runs a saved Workflow using server-supplied input.runtime and accepts only an optional timeZone."),
    loadOnOpen: toolDeclaration.shape.loadOnOpen.describe("true when this tool only reads data the person asked to see but is not marked readOnly, so the artifact loads it on open with no click. Refused for tools known to write. A saved Workflow that only reads through a tool marked destructive may set it too."),
  }),
})
const authoringShape = {
  title: createMcpAppInputSchema.shape.title.describe("Short human-readable title naming the artifact's outcome, not a generic label such as Dashboard."),
  description: createMcpAppInputSchema.shape.description.describe("One sentence describing what the person sees and does in the artifact."),
  reactSource: createMcpAppInputSchema.shape.reactSource.describe("Complete React source default-exporting a component receiving { app, input, result, hostContext }. React is injected; import only the built-in libraries prepare_app lists, if any. Follow skill:build-an-app's source and tool-call rules."),
  cssSource: createMcpAppInputSchema.shape.cssSource.describe("Complete CSS source using host theme variables and responsive container rules. Omit on creation for empty CSS; omit on update to keep existing CSS."),
  textFallback: createMcpAppInputSchema.shape.textFallback.describe("Readable plain-text alternative describing what the artifact shows, for hosts that cannot render it; usually one or two sentences."),
  public: createMcpAppInputSchema.shape.public.describe("true to serve the artifact to anyone at its public MCP URL with no OpenWork sign-in; only when the person asks for a public artifact. Requires the public artifacts feature and an artifact with no tools. Omit on update to keep the current choice, or pass false to make it private again."),
  site: createMcpAppInputSchema.shape.site.describe("true when the person wants the artifact to also open as a web page: a browser opening its MCP URL then shows the artifact full page, with no chat beside it, so write it to stand alone. Requires the feature for opening artifacts as sites. Omit on update to keep the current choice, or pass false to turn it off."),
  publicName: createMcpAppInputSchema.shape.publicName.describe("Friendly name for a public artifact's URL, such as coffee-with-the-team: 3 to 48 lowercase letters, digits and hyphens, unique across OpenWork. Use the one the person asks for, or suggest one from the title. Omit to keep the current name; a new name stops the old URL."),
  tools: documentedTools.optional().describe("Complete set of tools the artifact may call. Omit or use [] for a self-contained new artifact; omit on update to keep existing tools, or use [] to remove them."),
}
const STORAGE_DESCRIPTION = "What the artifact saves in its own database, for an intake form, tracker, approval queue, or checklist people come back to: collections of rows with typed fields. scope shared (default) is everyone who can use the artifact, personal is only the person who added the row; edit creator lets only that person change or remove a shared row. The artifact then gets storage_read and storage_write without declaring them. Rows belong to the artifact, so updates keep them. Not for public artifacts. Follow skill:build-an-app."
const prepareAppInputSchema = prepareMcpAppInputSchema.extend({
  title: authoringShape.title,
  description: authoringShape.description,
  tools: authoringShape.tools,
  storage: prepareMcpAppInputSchema.shape.storage.describe(STORAGE_DESCRIPTION),
})
const createAppInputSchema = createMcpAppInputSchema.extend({
  ...authoringShape,
  pluginId: createMcpAppInputSchema.shape.pluginId.describe("Existing Plugin ID (plg_...) to contain the artifact; omit to create a new private Plugin named after the artifact. Sharing that Plugin shares the artifact and its bound Workflows."),
  preparationId: createMcpAppInputSchema.shape.preparationId.describe("UUID returned by prepare_app, correlating this build with its preparation in chat. It grants no access and does not skip validation; older clients may omit it."),
  storage: createMcpAppInputSchema.shape.storage.describe(STORAGE_DESCRIPTION),
})
const appId = readMcpAppInputSchema.shape.appId.describe("Artifact ID (cob_...) from search_capabilities or an artifact result's app.appId; not its Plugin ID, revision ID, or capability name.")
const updateAppInputSchema = updateMcpAppInputSchema.extend({
  ...authoringShape,
  description: updateMcpAppInputSchema.shape.description.describe("Replacement description of what the person sees and does; omit to keep the current description, or pass an empty string to clear it."),
  appId,
  expectedRevisionId: updateMcpAppInputSchema.shape.expectedRevisionId.describe("Latest revision ID (cov_...) from read_app's app.revisionId. The update fails if someone has published another revision since that read."),
  storage: updateMcpAppInputSchema.shape.storage.describe(`${STORAGE_DESCRIPTION} Omit to keep what the artifact saves now, with its rows. Pass the complete declaration to add collections or fields; a field you leave out is hidden but its values are kept. null stops the artifact using saved data, which is kept until the artifact is deleted.`),
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
    : { error: "mcp_app_unavailable", message: "The artifact request could not be completed. Check access and try again." }
}

function errorResult(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(failure(error)) }] }
}

function mcpUrl(publicOrigin: string, serverPath: string) {
  return `${publicOrigin}${serverPath}`
}

export function mcpAppLaunchResult(input: { app: McpAppSummary; publicOrigin: string; message: string; launchInput?: unknown; canOpen?: boolean; built?: boolean }) {
  const launchInput = mcpAppLaunchInput(input.launchInput)
  const url = mcpUrl(input.publicOrigin, input.app.serverPath)
  const launch = { connectionId: input.app.appId, toolName: MCP_APP_LAUNCH_TOOL_NAME, resourceUri: input.app.resourceUri, arguments: { input: launchInput } }
  const structuredContent = { app: input.app, input: launchInput, mcpUrl: url, ...(input.canOpen === false ? {} : { launch }) }
  if (input.canOpen === false) {
    return {
      content: [{ type: "text" as const, text: `${input.message} OpenWork lists at most 100 connections and artifacts for you, and this artifact is past that limit, so it cannot open inside OpenWork. Its MCP URL works in any MCP client: ${url}\n\n${input.app.textFallback}` }],
      structuredContent,
    }
  }
  return {
    content: [{ type: "text" as const, text: `${input.message} ${input.built ? "If you are in OpenWork, the artifact opens in a tab in the right sidebar. Answer briefly and do not repeat what it shows." : MCP_APP_SHOWN_NOTE}\n\n${input.app.textFallback}` }],
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

function mcpAppLaunchInput(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {}
}

export function searchMcpApps(apps: McpAppEntry[], query: string, publicOrigin: string): CapabilityMatch[] {
  const tokens = tokenize(query)
  return apps.map((app) => ({
    name: buildMarketplaceCapabilityName(app.pluginId, app.appId),
    kind: "mcp_app",
    method: "MCP",
    path: app.serverPath,
    score: scoreText(tokenize(app.title), tokenize(app.description ?? ""), tokens, ["app", "apps", "dashboard"]),
    summary: `${app.description || app.title} Execute this exact name to open the artifact. An optional launch input object is passed to the artifact. It is also its own MCP server at ${mcpUrl(publicOrigin, app.serverPath)}. Its appId for read_app and update_app is ${app.appId}.`,
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

export function registerAppBuilderTools(input: {
  server: McpServer
  scopes: ReadonlySet<string>
  service: AppBuilderService
  publicOrigin: string
  storage?: boolean
  canOpen?: (appId: string) => Promise<boolean>
  notifyCatalogChanged: () => void
}) {
  const requireScope = (scope: string) => {
    if (!input.scopes.has(scope)) throw new AppBuilderError("insufficient_mcp_scope", `This artifact operation requires the ${scope} scope.`)
  }
  const storage = input.storage === true
  const storageNote = (text: string) => storage ? ` ${text}` : ""
  input.server.registerTool("prepare_app", {
    title: "Prepare an artifact",
    description: `Prepare an artifact before writing its source, using a title naming its outcome, a description of what the person sees and does, and exact tools from search_capabilities (none for a self-contained artifact). Returns preparationId for create_app, title, verified tools with inputSchema/readOnly/kind/mode, starter { reactSource, cssSource }, and nextSteps. The starter pattern is lookup when all tools read, action when one changes data, or standalone with no tools; nextSteps identifies tools not yet wired.${storageNote("Pass storage for an artifact that saves its own rows; the starter is then records, a list with add, change, and remove wired to storage_read and storage_write.")} Does not run tools, create a Plugin, or publish an artifact. Requires mcp:write. Follow skill:build-an-app for authoring rules.`,
    inputSchema: storage ? prepareAppInputSchema : prepareAppInputSchema.omit({ storage: true }),
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
  const publicNote = (choice: boolean | undefined, appId: string, name?: string) => choice === true || name
    ? ` It is public: anyone can add ${mcpUrl(input.publicOrigin, mcpAppPublicPath(name ?? appId))} to an MCP client without signing in.`
    : choice === false ? " It is not public." : ""
  input.server.registerTool("create_app", {
    title: "Create an artifact",
    description: [
      "Create and publish an artifact as its own MCP server from complete React/CSS source, textFallback, and declared tools. Read skill:build-an-app for required source, host, approval, caching, and tool-call rules before writing source; start with prepare_app and pass its preparationId (optional for older clients). This call rechecks bindings, compiles source, and saves the artifact; no Workflow, output schema, or Automation is required.",
      "Bind exact capabilities from search_capabilities: saved Workflows, connection tools, or read-only OpenWork GET actions. To change OpenWork data, bind a saved Workflow. Tools run as the person using the artifact. Load read-only data on open after the launch result arrives; changes and approval-required calls need their own button, one call per click.",
      ...(storage ? ["Declare storage when the artifact keeps its own rows (an intake form, tracker, or approval queue): it gets storage_read and storage_write, and its saved rows stay through every update."] : []),
      "Creates a new private Plugin unless pluginId selects an existing one. Bound Workflows join that Plugin; sharing it shares the artifact and those Workflows. Requires mcp:write.",
      "Returns app (summary including appId, pluginId, revisionId and tools, not source), input (empty launch input), mcpUrl, and usually launch { connectionId, toolName, resourceUri, arguments }. launch is omitted when the artifact is beyond OpenWork's connection limit; mcpUrl still works in MCP clients. OpenWork opens an available artifact in a sidebar tab; other hosts receive its MCP URL and text fallback. Reply briefly.",
    ].join(" "),
    inputSchema: storage ? createAppInputSchema : createAppInputSchema.omit({ storage: true }),
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
        message: `Created ${app.title} as its own MCP server with ${app.tools.length} ${app.tools.length === 1 ? "tool" : "tools"} plus ${MCP_APP_LAUNCH_TOOL_NAME}. MCP URL: ${mcpUrl(input.publicOrigin, app.serverPath)}${publicNote(request.public, app.appId, request.publicName)}`,
        canOpen: await input.canOpen?.(app.appId) ?? true,
      })
    } catch (error) {
      return errorResult(error)
    }
  })
  input.server.registerTool("update_app", {
    title: "Update an artifact",
    description: [
      "Update an existing artifact with complete replacement React source, title, and textFallback, following create_app's rules.",
      "First read_app, and copy its app.revisionId to expectedRevisionId. Omit cssSource, description, or tools to keep the current ones, or pass complete replacements. Follow skill:build-an-app's source and tool-call rules.",
      "Publishes an immutable revision in the same Plugin and MCP server; newly bound Workflows join that Plugin, so everyone it is shared with can run them. Requires editor access and the mcp:write scope.",
      "Returns app (updated summary, not source), input (empty launch input), mcpUrl, and launch { connectionId, toolName, resourceUri, arguments } unless OpenWork's connection limit prevents opening it. The MCP URL remains usable. OpenWork opens an available artifact in a sidebar tab.",
    ].join(" "),
    inputSchema: storage ? updateAppInputSchema : updateAppInputSchema.omit({ storage: true }),
    outputSchema: appResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_WRITE_SCOPE)
      const app = await input.service.update(request)
      input.notifyCatalogChanged()
      return mcpAppLaunchResult({ app, built: true, publicOrigin: input.publicOrigin, message: `Updated ${app.title} to a new revision.${publicNote(request.public, app.appId, request.publicName)}`, canOpen: await input.canOpen?.(app.appId) ?? true })
    } catch (error) {
      return errorResult(error)
    }
  })
  input.server.registerTool("read_app", {
    title: "Read an artifact",
    description: `Read an artifact before editing. Returns app (latest summary including appId, pluginId, revisionId, title, description, textFallback, tools and launch resource/server identifiers), reactSource, and cssSource${storage ? ", and storage when it saves data" : ""}. Use app.revisionId as update_app's expectedRevisionId; tools are summaries, not input schemas. Requires mcp:read and editor access, not merely permission to open the artifact. Does not open or run the artifact.`,
    inputSchema: readAppInputSchema,
    outputSchema: storage ? readMcpAppOutputSchema : readMcpAppOutputSchema.omit({ storage: true }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_READ_SCOPE)
      const result = await input.service.read(request)
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result }
    } catch (error) {
      return errorResult(error)
    }
  })
}
