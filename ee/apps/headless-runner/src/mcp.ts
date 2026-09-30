import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { z } from "zod"
import type { ToolResult, ToolSpec } from "./types.js"

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

const contentBlock = z.object({ type: z.string(), text: z.string().optional() }).loose()
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
  const parts = (parsed.data.content ?? []).map((block) =>
    block.type === "text" && block.text !== undefined ? block.text : `[${block.type} content omitted]`,
  )
  if (parts.length === 0 && parsed.data.structuredContent !== undefined) {
    parts.push(JSON.stringify(parsed.data.structuredContent))
  }
  return { output: truncate(parts.join("\n") || "(no output)"), isError: parsed.data.isError === true }
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
