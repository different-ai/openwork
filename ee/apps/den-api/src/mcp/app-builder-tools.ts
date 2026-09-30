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

/**
 * Model-facing note in the launch result of an App built in OpenWork. OpenWork
 * shows the App right above the model's reply, so a long reply pushes it out of
 * view. Other clients cannot be told apart here, so the note is conditional and
 * never hides the App's MCP URL, which is how those clients use the App.
 */
export const MCP_APP_SHOWN_NOTE = "If you are in OpenWork, the person now sees this App right above your reply: answer in one or two sentences and do not repeat what it shows."

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
 * receive the text, the structured App, and its MCP URL. An App the catalog
 * cannot list (canOpen false) is described without a launch OpenWork would fail.
 */
export function mcpAppLaunchResult(input: { app: McpAppSummary; publicOrigin: string; message: string; launchInput?: unknown; canOpen?: boolean }) {
  const launchInput = mcpAppLaunchInput(input.launchInput)
  const url = mcpUrl(input.publicOrigin, input.app.serverPath)
  const structuredContent = { app: input.app, input: launchInput, mcpUrl: url }
  if (input.canOpen === false) {
    return {
      content: [{ type: "text" as const, text: `${input.message} OpenWork lists at most 100 connections and Apps for you, and this App is past that limit, so it cannot open inside OpenWork. Its MCP URL works in any MCP client: ${url}\n\n${input.app.textFallback}` }],
      structuredContent,
    }
  }
  return {
    content: [{ type: "text" as const, text: `${input.message} ${MCP_APP_SHOWN_NOTE}\n\n${input.app.textFallback}` }],
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
    summary: `${app.description || app.title} Execute this exact name to open the App; an optional body object becomes its launch input. It is also its own MCP server at ${mcpUrl(publicOrigin, app.serverPath)}. Its appId for read_app and update_app is ${app.appId}.`,
    pathParams: [],
    queryParams: [],
    hasBody: true,
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
  /** Whether OpenWork can open this App: its server index lists it. */
  canOpen?: (appId: string) => Promise<boolean>
  notifyCatalogChanged: () => void
}) {
  const requireScope = (scope: string) => {
    if (!input.scopes.has(scope)) throw new AppBuilderError("insufficient_mcp_scope", `This App operation requires the ${scope} scope.`)
  }
  input.server.registerTool("create_app", {
    title: "Create an App",
    description: [
      "Create an App, which is its own MCP server, from complete React/CSS source, a readable textFallback, and the tools it needs. It needs no Workflow, output schema, or Automation.",
      "Each tool has a snake_case name, a description, and one exact capability from search_capabilities: a saved Workflow, a connection tool, or an OpenWork action that reads (GET). To change data, bind a saved Workflow that makes the change. Use mode live for a Workflow that reads input.runtime. Tools run as the person using the App.",
      "reactSource default-exports a component receiving { app, input, result, hostContext }: input is the launch input, and result is the launch CallToolResult (read result?.structuredContent), undefined until delivered. React is injected: use React.useState and other React APIs without imports. Do not use fetch, browser or host globals, timers, dynamic code, external resources, URL-bearing elements, or <form>, <svg>, <style>, or <math> elements; use labeled inputs and type=button controls.",
      "Call only declared tools, with app.callServerTool({ name, arguments }): a Workflow or connection tool takes the capability's arguments, an OpenWork action { path, query, body }, and a live Workflow only an optional { timeZone }. Show a blocked state if app.getHostCapabilities()?.serverTools is absent.",
      "Call read-only tools (OpenWork action reads, live Workflows, and connection tools whose match says readOnly: true) when the App opens or its inputs change; if the host refuses one because it needs approval (its error mentions approval), offer a button that makes that call. Give every other tool its own button that makes only that call: OpenWork allows one call per click. Show other errors with what happened and what to do next.",
      "Keep it compact: one focal action, explicit loading, empty, error, and blocked states, and no internal scrolling or automatic navigation.",
      "It goes in a new private Plugin named after it unless the user names an existing pluginId; the Workflows its tools run join that Plugin, and sharing the Plugin shares the App.",
    ].join(" "),
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
      "First read_app, and copy its revisionId to expectedRevisionId. Omit cssSource, description, or tools to keep the current ones, or pass complete replacements.",
      "Publishes an immutable revision in the same Plugin and MCP server; newly bound Workflows join that Plugin, so everyone it is shared with can run them. Requires editor access and the mcp:write scope.",
    ].join(" "),
    inputSchema: updateMcpAppInputSchema,
    outputSchema: appResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (request) => {
    try {
      requireScope(DEN_MCP_WRITE_SCOPE)
      const app = await input.service.update(request)
      input.notifyCatalogChanged()
      return mcpAppLaunchResult({ app, publicOrigin: input.publicOrigin, message: `Updated ${app.title} to a new revision.`, canOpen: await input.canOpen?.(app.appId) ?? true })
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
      // Hosts that forward only text still need the source update_app replaces.
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result }
    } catch (error) {
      return errorResult(error)
    }
  })
}
