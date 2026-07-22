import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CapabilityMatch } from "./search.js"
import { scoreText, tokenize } from "./search.js"
import { DEN_ADMIN_MCP_VERSION, registerAdminMcpTools } from "./admin-tools.js"

export const ADMIN_CAPABILITY_PREFIX = "admin:"

type AdminToolResult = {
  isError?: boolean
  content: { type: "text"; text: string }[]
}

async function withAdminClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: "den-admin-agent-bridge", version: DEN_ADMIN_MCP_VERSION })
  registerAdminMcpTools(server)
  const client = new Client({ name: "openwork-agent", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}

export function parseAdminCapabilityName(name: string): string | null {
  if (!name.startsWith(ADMIN_CAPABILITY_PREFIX)) return null
  const toolName = name.slice(ADMIN_CAPABILITY_PREFIX.length)
  return toolName.length > 0 ? toolName : null
}

export async function searchAdminCapabilities(query: string, limit = 5): Promise<CapabilityMatch[]> {
  const queryTokens = tokenize(query)
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit) || 5))
  const { tools } = await withAdminClient((client) => client.listTools())

  return tools
    .map((tool) => ({
      name: `${ADMIN_CAPABILITY_PREFIX}${tool.name}`,
      method: "MCP",
      path: "/mcp/admin",
      score: scoreText(
        tokenize(tool.name),
        tokenize(tool.description ?? ""),
        queryTokens,
        ["admin", "platform"],
      ),
      summary: `[OpenWork Admin] ${tool.description ?? tool.name}`,
      pathParams: [],
      queryParams: [],
      hasBody: Object.keys(tool.inputSchema.properties ?? {}).length > 0,
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
    .slice(0, boundedLimit)
}

export async function searchAvailableAdminCapabilities(
  platformAdmin: boolean,
  query: string,
  limit = 5,
): Promise<CapabilityMatch[]> {
  return platformAdmin ? searchAdminCapabilities(query, limit) : []
}

function normalizeArguments(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {}
  return Object.fromEntries(Object.entries(body))
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "text"
    && "text" in value
    && typeof value.text === "string"
}

function resultTextContent(result: unknown): { type: "text"; text: string }[] {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
    return []
  }
  return result.content.filter(isTextContent)
}

function resultIsError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "isError" in result && result.isError === true
}

export async function executeAdminCapability(name: string, body: unknown): Promise<AdminToolResult | null> {
  const toolName = parseAdminCapabilityName(name)
  if (!toolName) return null

  return withAdminClient(async (client) => {
    const result = await client.callTool({ name: toolName, arguments: normalizeArguments(body) })
    const content = resultTextContent(result)
    return {
      ...(resultIsError(result) ? { isError: true } : {}),
      content: content.length > 0 ? content : [{ type: "text", text: JSON.stringify(result) }],
    }
  })
}

export async function executeAvailableAdminCapability(
  platformAdmin: boolean,
  name: string,
  body: unknown,
): Promise<AdminToolResult | null> {
  if (!parseAdminCapabilityName(name)) return null
  if (!platformAdmin) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "unknown_capability",
          message: `No capability named "${name}". Call search_capabilities to find a valid name.`,
        }),
      }],
    }
  }
  return executeAdminCapability(name, body)
}
