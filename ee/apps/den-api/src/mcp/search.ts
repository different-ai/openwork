import type { McpToolOperation } from "./catalog.js"

/**
 * `search_capabilities` is the additive "search" half of a search+execute
 * facade laid on top of the existing OpenAPI-derived catalog (`catalog.ts`)
 * and its existing in-process "execute" path (`invoke.ts`).
 *
 * It does not introduce a new execution mechanism. It only ranks the *same*
 * tool catalog already registered in `index.ts` so a harness can ask a
 * question instead of receiving every tool at once, then call the matched
 * tool name directly via the normal MCP `tools/call` protocol.
 */

export const SEARCH_CAPABILITIES_TOOL_NAME = "search_capabilities"

export type CapabilityMatch = {
  name: string
  method: string
  path: string
  score: number
  summary: string
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

/**
 * Splits a camelCase / PascalCase tool name into lowercase word tokens so a
 * query like "organization" matches a tool named `getOrganizations`.
 */
function tokenizeToolName(name: string): string[] {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  return tokenize(spaced)
}

function summaryFor(operation: McpToolOperation): string {
  return operation.operation.summary ?? operation.operation.description ?? `${operation.method} ${operation.path}`
}

function scoreOperation(operation: McpToolOperation, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0
  }

  const nameTokens = tokenizeToolName(operation.name)
  const summaryTokens = tokenize(summaryFor(operation))
  const pathTokens = tokenize(operation.path)

  let score = 0
  for (const queryToken of queryTokens) {
    if (nameTokens.includes(queryToken)) {
      score += 5
    } else if (nameTokens.some((token) => token.startsWith(queryToken) || queryToken.startsWith(token))) {
      score += 3
    }
    if (summaryTokens.includes(queryToken)) {
      score += 2
    }
    if (pathTokens.includes(queryToken)) {
      score += 1
    }
  }
  return score
}

export function searchCapabilities(
  catalog: McpToolOperation[],
  query: string,
  limit = 5,
): CapabilityMatch[] {
  const queryTokens = tokenize(query)
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit) || 5))

  return catalog
    .map((operation) => ({
      name: operation.name,
      method: operation.method,
      path: operation.path,
      score: scoreOperation(operation, queryTokens),
      summary: summaryFor(operation),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
    .slice(0, boundedLimit)
}
