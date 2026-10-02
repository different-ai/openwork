import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { z } from "zod"
import type { ToolImage, ToolResult, ToolSpec } from "./types.js"

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

/** Formats every model provider accepts as image input. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
/** Base64 characters per image (about 3.7 MB decoded, under provider limits) and images per tool result. */
export const MAX_IMAGE_BASE64 = 5_000_000
export const MAX_IMAGES_PER_RESULT = 4

const contentBlock = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    data: z.string().optional(),
    mimeType: z.string().optional(),
    resource: z.object({ blob: z.string().optional(), mimeType: z.string().optional() }).loose().optional(),
  })
  .loose()
const callResult = z
  .object({
    content: z.array(contentBlock).optional(),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .loose()

export function formatToolResult(value: unknown): ToolResult {
  const parsed = callResult.safeParse(value)
  if (!parsed.success) return { output: truncate(JSON.stringify(value)), isError: false }
  const parts: string[] = []
  const images: ToolImage[] = []
  for (const block of parsed.data.content ?? []) {
    if (block.type === "text" && block.text !== undefined) {
      parts.push(block.text)
      continue
    }
    const data = block.type === "image" ? block.data : block.type === "resource" ? block.resource?.blob : undefined
    const mediaType = block.type === "image" ? block.mimeType : block.resource?.mimeType
    if (data && mediaType && IMAGE_TYPES.has(mediaType)) {
      if (data.length > MAX_IMAGE_BASE64) parts.push(`[${mediaType} image too large to view]`)
      else if (images.length >= MAX_IMAGES_PER_RESULT) parts.push(`[more images omitted]`)
      else {
        images.push({ mediaType, data })
        parts.push(`[image ${images.length}: ${mediaType}, attached]`)
      }
      continue
    }
    parts.push(`[${block.type} content omitted]`)
  }
  if (parts.length === 0 && parsed.data.structuredContent !== undefined) {
    parts.push(JSON.stringify(parsed.data.structuredContent))
  }
  return {
    output: truncate(parts.join("\n") || "(no output)"),
    isError: parsed.data.isError === true,
    ...(images.length ? { images } : {}),
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
