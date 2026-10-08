import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { z } from "zod"
import { fileName, readToolFile } from "./tool-files.js"
import { toolAppSchema, type ToolApp, type ToolDocument, type ToolImage, type ToolResult, type ToolSpec } from "./types.js"

/** Tools from one remote MCP server, connected for the duration of one turn. */
export type ToolSession = {
  tools: ToolSpec[]
  call(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>
  close(): Promise<void>
}
export type McpConnector = (input: { token: string; signal: AbortSignal }) => Promise<ToolSession>

export const MAX_TOOL_OUTPUT_CHARS = 50_000
const TOOL_TIMEOUT_MS = 120_000
const CONNECT_TIMEOUT_MS = 20_000

export function truncate(text: string, max = MAX_TOOL_OUTPUT_CHARS) {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]`
}

/** Provider tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
export function modelToolName(name: string, taken: ReadonlySet<string>) {
  let candidate = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool"
  if (taken.has(candidate)) candidate = `mcp_${candidate}`.slice(0, 64)
  let suffix = 2
  while (taken.has(candidate)) candidate = `${candidate.slice(0, 60)}_${suffix++}`
  return candidate
}

const contentBlock = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    data: z.string().optional(),
    mimeType: z.string().optional(),
    uri: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    resource: z
      .object({
        uri: z.string().optional(),
        name: z.string().optional(),
        title: z.string().optional(),
        blob: z.string().optional(),
        text: z.string().optional(),
        mimeType: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose()
const callResult = z
  .object({
    content: z.array(contentBlock).optional(),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
    _meta: z.unknown().optional(),
  })
  .loose()

/** What an App may be handed back on every load; a bigger result is kept without its content, or not at all. */
export const MAX_APP_RESULT_CHARS = 256_000
const launchSchema = toolAppSchema.omit({ result: true })
const recordSchema = z.record(z.string(), z.unknown())

/**
 * The App a result opens (OpenWork Connect's `_meta["openwork/mcpApp"]`), with the result as the App receives it:
 * its text content, structured content and `_meta`. Files stay with the model's copy.
 */
function appOf(result: z.infer<typeof callResult>): ToolApp | undefined {
  const meta = recordSchema.safeParse(result._meta)
  const launch = launchSchema.safeParse(meta.success ? meta.data["openwork/mcpApp"] : undefined)
  if (!meta.success || !launch.success || JSON.stringify(launch.data.arguments).length > MAX_APP_RESULT_CHARS) return undefined
  const structured = recordSchema.safeParse(result.structuredContent)
  const full = {
    content: (result.content ?? []).flatMap((block) => (block.type === "text" && block.text !== undefined ? [{ type: "text", text: block.text }] : [])),
    ...(structured.success ? { structuredContent: structured.data } : {}),
    _meta: meta.data,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  }
  const fits = (value: unknown) => JSON.stringify(value).length <= MAX_APP_RESULT_CHARS
  const kept = fits(full) ? full : fits({ ...full, content: [] }) ? { ...full, content: [] } : null
  return { ...launch.data, result: kept }
}

export async function formatToolResult(value: unknown): Promise<ToolResult> {
  const parsed = callResult.safeParse(value)
  if (!parsed.success) return { output: truncate(JSON.stringify(value)), isError: false }
  const parts: string[] = []
  const images: ToolImage[] = []
  const documents: ToolDocument[] = []
  const counts = { images: 0, documents: 0 }
  for (const block of parsed.data.content ?? []) {
    if (block.type === "text" && block.text !== undefined) {
      parts.push(block.text)
      continue
    }
    const resource = block.resource
    // Binary content: an image or audio block, or a resource that embeds a file (for example a PDF read from Slack).
    const data = block.type === "image" || block.type === "audio" ? block.data : block.type === "resource" ? resource?.blob : undefined
    if (data !== undefined) {
      const reading = await readToolFile(
        {
          name: fileName([resource?.name, resource?.title, block.name, block.title], resource?.uri ?? block.uri),
          mimeType: (block.type === "resource" ? resource?.mimeType : block.mimeType) ?? "",
          data,
        },
        counts,
      )
      parts.push(reading.text)
      if (reading.image) images.push(reading.image)
      if (reading.document) documents.push(reading.document)
      continue
    }
    if (block.type === "resource" && resource?.text !== undefined) {
      parts.push(`[${fileName([resource.name, resource.title], resource.uri)}]\n${resource.text}`)
      continue
    }
    if (block.type === "resource_link") {
      parts.push(`[Linked file: ${fileName([block.name, block.title], block.uri)}${block.mimeType ? ` (${block.mimeType})` : ""}${block.uri ? ` ${block.uri}` : ""}]`)
      continue
    }
    parts.push(`[${block.type} content not readable here]`)
  }
  if (parts.length === 0 && parsed.data.structuredContent !== undefined) {
    parts.push(JSON.stringify(parsed.data.structuredContent))
  }
  const app = appOf(parsed.data)
  return {
    output: truncate(parts.join("\n") || "(no output)"),
    isError: parsed.data.isError === true,
    ...(images.length ? { images } : {}),
    ...(documents.length ? { documents } : {}),
    ...(app ? { app } : {}),
  }
}

const toolList = z.object({
  tools: z.array(
    z
      .object({
        name: z.string(),
        description: z.string().optional(),
        inputSchema: z.record(z.string(), z.unknown()),
      })
      .loose(),
  ),
  nextCursor: z.string().optional(),
})

const uiVisibility = z.object({ _meta: z.object({ ui: z.object({ visibility: z.array(z.unknown()) }) }) })

/** Tools only an App's view may call (`_meta.ui.visibility` without "model") are never offered to the model. */
export function visibleToModel(tool: unknown) {
  const declared = uiVisibility.safeParse(tool)
  return !declared.success || declared.data._meta.ui.visibility.includes("model")
}

/**
 * Connects to the operator-configured MCP URL with the caller's bearer token.
 * The URL is never caller-controlled; the token lives only in this closure.
 */
export function remoteMcpConnector(options: {
  url: string
  allowlist: string[]
  reservedNames: ReadonlySet<string>
}): McpConnector {
  return async ({ token, signal }) => {
    const client = new Client({ name: "openwork-headless-runner", version: "0.1.0" })
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    const connectSignal = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)])
    await client.connect(transport, { signal: connectSignal, timeout: CONNECT_TIMEOUT_MS })

    const tools: ToolSpec[] = []
    const byModelName = new Map<string, string>()
    const taken = new Set(options.reservedNames)
    let cursor: string | undefined
    do {
      const page = toolList.parse(
        await client.listTools(cursor ? { cursor } : undefined, { signal: connectSignal, timeout: CONNECT_TIMEOUT_MS }),
      )
      for (const tool of page.tools) {
        if (options.allowlist.length && !options.allowlist.includes(tool.name)) continue
        if (!visibleToModel(tool)) continue
        const name = modelToolName(tool.name, taken)
        taken.add(name)
        byModelName.set(name, tool.name)
        tools.push({ name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema })
      }
      cursor = page.nextCursor
    } while (cursor)

    return {
      tools,
      async call(name, input, callSignal) {
        const original = byModelName.get(name)
        if (!original) return { output: `Unknown tool: ${name}`, isError: true }
        const result = await client.callTool(
          { name: original, arguments: input },
          { signal: AbortSignal.any([callSignal, AbortSignal.timeout(TOOL_TIMEOUT_MS)]), timeout: TOOL_TIMEOUT_MS },
        )
        return formatToolResult(result)
      },
      async close() {
        await client.close().catch(() => undefined)
      },
    }
  }
}
