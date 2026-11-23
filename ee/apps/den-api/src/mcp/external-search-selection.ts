import { scoreText, tokenize } from "./search.js"

export const EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT = 16
const TOOL_TOKEN_CACHE_MAX_TOKENS = 1_000_000

export type SearchableExternalTool = { name: string; title?: string; description?: string }

type CachedToolTokens = {
  connectionName: string
  name: string
  text: string
  nameTokens: string[]
  textTokens: string[]
}

function uniqueTokens(value: string): string[] {
  return [...new Set(tokenize(value))]
}

export function createToolTokenCache(maxTokens = TOOL_TOKEN_CACHE_MAX_TOKENS) {
  let entries = new WeakMap<SearchableExternalTool, CachedToolTokens>()
  let tokenCount = 0

  return (connectionName: string, tool: SearchableExternalTool): CachedToolTokens => {
    const text = tool.description ?? tool.title ?? tool.name
    const cached = entries.get(tool)
    if (cached !== undefined && cached.connectionName === connectionName && cached.name === tool.name && cached.text === text) {
      return cached
    }
    const entry = {
      connectionName,
      name: tool.name,
      text,
      nameTokens: uniqueTokens(`${connectionName} ${tool.name}`),
      textTokens: uniqueTokens(text),
    }
    const size = entry.nameTokens.length + entry.textTokens.length
    if (size > maxTokens) {
      entries.delete(tool)
      return entry
    }
    if (tokenCount + size > maxTokens) {
      entries = new WeakMap()
      tokenCount = 0
    }
    entries.set(tool, entry)
    tokenCount += size
    return entry
  }
}

const getToolTokens = createToolTokenCache()

export function scoreExternalTool(connectionName: string, tool: SearchableExternalTool, queryTokens: string[]): number {
  const tokens = getToolTokens(connectionName, tool)
  return scoreText(tokens.nameTokens, tokens.textTokens, queryTokens)
}

export function selectExternalMcpSearchConnections<T extends { name: string }>(
  connections: readonly T[],
  queryTokens: string[],
  limit = EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT,
  cachedTools: (connection: T) => readonly SearchableExternalTool[] | undefined = () => undefined,
): T[] {
  return connections
    .map((connection, index) => ({
      connection,
      index,
      score: Math.max(
        scoreText(tokenize(connection.name), tokenize(connection.name), queryTokens),
        ...(cachedTools(connection) ?? []).map((tool) => scoreExternalTool(connection.name, tool, queryTokens)),
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, Math.min(limit, EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT)))
    .map(({ connection }) => connection)
}
