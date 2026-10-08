import type { HeadlessRunnerClient, RunnerToolApp } from "@openwork-ee/headless-protocol"
import { MCP_APP_MAX_HTML_BYTES, mcpAppResourceIdentity } from "@openwork/types/mcp-app"
import {
  McpAppResourceError,
  parseMcpAppResourceMeta,
  secureMcpAppHtml,
  toolRequiresApproval,
  toolUiResourceUri,
  toolVisibleToApp,
  type McpAppCsp,
  type McpAppHostTool,
} from "@openwork/types/mcp-app-host"
import { z } from "zod"

/**
 * Apps in Workbot's replies. A tool result that opens an App (OpenWork Connect's launch) is kept by the runner with
 * the result, so the App opens again with the same input and result on every visit, and nothing reruns. Den stays the
 * authority: Workbot reads the App's page from the connection that opened it and runs only that connection's tools,
 * as the person, with a token Den mints for this. What an App tells the model is kept by the runner with the
 * conversation and shown to the model from its next step.
 */

/** One request to an App's connection on OpenWork Connect, as the person. */
export type WorkbotAppConnections = {
  request(connectionId: string, method: "tools/list" | "tools/call" | "resources/read", params: Record<string, unknown>): Promise<unknown>
}

/** Everything the page needs to show one App: its secured page and policy, and the input and result it opened with. */
export type WorkbotAppView = {
  title: string
  html: string
  csp: McpAppCsp
  prefersBorder: boolean
  input: Record<string, unknown>
  result: RunnerToolApp["result"]
}

export type WorkbotAppRefusal =
  /** No App opened here, or its message is gone. */
  | "unknown_app"
  /** The App's connection no longer offers it, or its page can't be shown. */
  | "app_unavailable"
  /** A tool the App may not call: another connection's, or one only the model may use. */
  | "tool_not_available"
  /** The tool changes something; it runs only right after the person clicks in the App. */
  | "needs_click"

type AppTarget = { sessionId: string; messageId: string; callId: string }

/** What an App tool's answer may weigh on its way back to the App. */
const MAX_APP_TOOL_RESULT_CHARS = 1024 * 1024
/** A connection lists its tools in pages; this many is far beyond any real one. */
const MAX_TOOL_PAGES = 20
const APP_MIME_TYPE = "text/html;profile=mcp-app"
/** What an App may tell the model at once; the runner keeps the same. */
const MAX_CONTEXT_TEXT_CHARS = 4_000
const MAX_CONTEXT_DATA_CHARS = 4_000

const toolSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() }).loose().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()
type AppTool = z.infer<typeof toolSchema> & McpAppHostTool
const toolsPageSchema = z.object({ tools: z.array(z.unknown()), nextCursor: z.string().optional() })
const resourceSchema = z.object({
  contents: z.array(
    z
      .object({
        uri: z.string(),
        mimeType: z.string().optional(),
        text: z.string().optional(),
        blob: z.string().optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .loose(),
  ),
})
const builtAppResultSchema = z.object({ structuredContent: z.object({ app: z.object({ title: z.string().min(1) }).loose() }).loose() })
const callResultSchema = z.object({ content: z.array(z.unknown()) }).loose()

/** The App a tool call opened, as the runner kept it; null when it opened none (or none Workbot can show). */
async function launchOf(client: HeadlessRunnerClient, target: AppTarget) {
  const read = await client.readApp(target.sessionId, { messageId: target.messageId, callId: target.callId })
  if (!read.ok && read.status === 404) return null
  if (!read.ok) throw new Error(read.error)
  // Apps on OpenWork Connect itself (its connection prompts) have Workbot's own connection flow instead.
  return read.value.connectionId ? { ...read.value, connectionId: read.value.connectionId } : null
}

async function toolsOf(connections: WorkbotAppConnections, connectionId: string): Promise<AppTool[]> {
  const tools: AppTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const listed = toolsPageSchema.parse(await connections.request(connectionId, "tools/list", cursor ? { cursor } : {}))
    for (const entry of listed.tools) {
      const tool = toolSchema.safeParse(entry)
      if (tool.success) tools.push(tool.data)
    }
    cursor = listed.nextCursor
    if (!cursor) break
  }
  return tools
}

/**
 * The page the launch's tool offers now: the one it opened with, or, for an App built in OpenWork, its newest version
 * (an older one may call tools the App no longer has).
 */
function currentResourceUri(tool: AppTool, launch: { connectionId: string; resourceUri: string }): string | null {
  const offered = toolUiResourceUri(tool)
  const same = (uri: string) => mcpAppResourceIdentity(uri, launch.connectionId)
  return offered && same(offered) === same(launch.resourceUri) ? offered : null
}

/** "lookup_unit_price" → "Lookup unit price": only when the App's tool has no title of its own. */
function readableName(name: string) {
  const words = name.replace(/[_-]+/g, " ").trim()
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : "App"
}

function decodeBase64(value: string) {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)))
}

/** Opens the App a tool call in this turn opened: its page from its connection, and what it opened with. */
export async function openWorkbotApp(
  connections: WorkbotAppConnections,
  client: HeadlessRunnerClient,
  target: AppTarget,
): Promise<{ ok: true; value: WorkbotAppView } | { ok: false; code: WorkbotAppRefusal }> {
  const launch = await launchOf(client, target)
  if (!launch) return { ok: false, code: "unknown_app" }
  const unavailable = (reason: string) => {
    console.warn("[workbot] an App could not open", { connectionId: launch.connectionId, toolName: launch.toolName, reason })
    return { ok: false as const, code: "app_unavailable" as const }
  }
  const tool = (await toolsOf(connections, launch.connectionId)).find((entry) => entry.name === launch.toolName)
  if (!tool) return unavailable("tool_not_found")
  const uri = currentResourceUri(tool, launch)
  if (!uri) return unavailable("tool_resource_mismatch")
  const read = resourceSchema.safeParse(await connections.request(launch.connectionId, "resources/read", { uri }))
  const content = read.success ? read.data.contents.find((entry) => entry.uri === uri && entry.mimeType === APP_MIME_TYPE) : undefined
  const html = content?.text ?? (content?.blob ? decodeBase64(content.blob) : null)
  if (!content || html === null) return unavailable("invalid_resource")
  if (new TextEncoder().encode(html).byteLength > MCP_APP_MAX_HTML_BYTES) return unavailable("resource_too_large")
  try {
    const { csp, prefersBorder } = parseMcpAppResourceMeta(content._meta)
    const built = builtAppResultSchema.safeParse(launch.result)
    return {
      ok: true,
      value: {
        title: built.success ? built.data.structuredContent.app.title : tool.title?.trim() || readableName(tool.name),
        html: secureMcpAppHtml({ html, csp }),
        csp,
        prefersBorder,
        input: launch.arguments,
        result: launch.result,
      },
    }
  } catch (error) {
    // A policy no OpenWork host grants, or a page that puts markup before its policy: it isn't shown.
    if (error instanceof McpAppResourceError) return unavailable(error.code)
    throw error
  }
}

/**
 * Runs one of the App's own tools for the person: only on the connection that opened the App, only a tool Apps may
 * call, and anything that isn't read-only only right after their click in the App.
 */
export async function callWorkbotAppTool(
  connections: WorkbotAppConnections,
  client: HeadlessRunnerClient,
  target: AppTarget,
  input: { name: string; arguments: Record<string, unknown>; clicked: boolean },
): Promise<{ ok: true; value: unknown } | { ok: false; code: WorkbotAppRefusal }> {
  const launch = await launchOf(client, target)
  if (!launch) return { ok: false, code: "unknown_app" }
  const tool = (await toolsOf(connections, launch.connectionId)).find((entry) => entry.name === input.name)
  if (!tool || !toolVisibleToApp(tool)) return { ok: false, code: "tool_not_available" }
  if (toolRequiresApproval(tool) && !input.clicked) return { ok: false, code: "needs_click" }
  const result = await connections.request(launch.connectionId, "tools/call", { name: input.name, arguments: input.arguments })
  if (!callResultSchema.safeParse(result).success) return { ok: false, code: "app_unavailable" }
  if (JSON.stringify(result).length > MAX_APP_TOOL_RESULT_CHARS) {
    return { ok: true, value: { isError: true, content: [{ type: "text", text: "That answer was too big to show here." }] } }
  }
  return { ok: true, value: result }
}

/** What an open App tells the model about itself (`ui/update-model-context`), kept with the conversation. */
export async function setWorkbotAppContext(
  client: HeadlessRunnerClient,
  target: AppTarget,
  input: { title: string; content?: unknown[]; structuredContent?: Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; code: WorkbotAppRefusal }> {
  const text = (input.content ?? [])
    .flatMap((block) => {
      const parsed = z.object({ type: z.literal("text"), text: z.string() }).safeParse(block)
      return parsed.success ? [parsed.data.text] : []
    })
    .join("\n")
    .slice(0, MAX_CONTEXT_TEXT_CHARS)
  const data = input.structuredContent && JSON.stringify(input.structuredContent).length <= MAX_CONTEXT_DATA_CHARS ? input.structuredContent : undefined
  const saved = await client.setAppContext(target.sessionId, {
    messageId: target.messageId,
    callId: target.callId,
    title: input.title.trim().slice(0, 120) || "App",
    text,
    ...(data ? { data } : {}),
  })
  if (saved.ok) return { ok: true }
  if (saved.status === 404 || saved.status === 409) return { ok: false, code: "unknown_app" }
  throw new Error(saved.error)
}
