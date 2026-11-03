import { scoreText, tokenize } from "./search.js"

export const EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT = 16

/** The parts of a provider tool that capability search reads. */
export type SearchableExternalTool = { name: string; title?: string; description?: string }

export function scoreExternalTool(connectionName: string, tool: SearchableExternalTool, queryTokens: string[]): number {
  return scoreText(
    tokenize(`${connectionName} ${tool.name}`),
    tokenize(tool.description ?? tool.title ?? tool.name),
    queryTokens,
  )
}

/**
 * A capability search must never turn an unbounded org connection list into
 * unbounded remote handshakes. Prefer connections whose names match the
 * query, or whose recently listed tools do ("my open issues" finds Linear
 * without naming it), keep source order as the deterministic tiebreaker, and
 * enforce one hard fanout ceiling before any provider network request is started.
 */
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
