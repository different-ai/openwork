import { getJsonRequestBodySchema, getParameters, hasJsonRequestBody, pathParameterNamesFromTemplate, type McpToolOperation } from "./catalog.js"
import { rankCapabilities, tokenizeText, type CapabilityCandidate } from "./ranking.js"

/**
 * `search_capabilities` is the "search" half of a search+execute facade laid
 * on top of the existing OpenAPI-derived catalog (`catalog.ts`) and its
 * existing in-process "execute" path (`invoke.ts`).
 *
 * Two consumers use this:
 * - The rich `/mcp` endpoint (`index.ts`), where matches are informational —
 *   the harness can call the matched tool name directly, since every
 *   catalog operation is also individually registered there.
 * - The minimal `/mcp/agent` endpoint (`agent.ts`), where matches are the
 *   *only* way to discover what's callable — that endpoint exposes nothing
 *   but `search_capabilities` and a generic `execute_capability`, so each
 *   match carries enough shape (`pathParams`/`queryParams`/`hasBody`) for the
 *   caller to construct a valid `execute_capability` call without guessing.
 */

export const SEARCH_CAPABILITIES_TOOL_NAME = "search_capabilities"
export type SearchCapabilityType = "all" | "api" | "admin" | "mcp" | "marketplace" | "skills"

export type CapabilityMatch = {
  name: string
  method: string
  path: string
  score: number
  summary: string
  /** Path parameter names this tool's `path` template requires, e.g. ["workerId"]. */
  pathParams: string[]
  /** Query parameter names this tool documents, if any. */
  queryParams: string[]
  /** Whether calling this tool requires a JSON `body`. */
  hasBody: boolean
  /** Exact OpenAPI JSON schema for `body`, present only for JSON mutations. */
  bodySchema?: unknown
}

export function compareCapabilityMatches(a: CapabilityMatch, b: CapabilityMatch): number {
  const statusPriority = Number("kind" in b && b.kind === "connection_status")
    - Number("kind" in a && a.kind === "connection_status")
  return statusPriority || (b.score - a.score) || a.name.localeCompare(b.name)
}

export function searchCapabilitySourceFilter(type?: SearchCapabilityType) {
  const capabilityType = type ?? "all"
  return {
    api: capabilityType === "all" || capabilityType === "api",
    admin: capabilityType === "all" || capabilityType === "admin",
    mcp: capabilityType === "all" || capabilityType === "mcp",
    marketplace: capabilityType === "all" || capabilityType === "marketplace" || capabilityType === "skills",
    skills: capabilityType === "all" || capabilityType === "skills",
  }
}

export function tokenize(value: string): string[] {
  return tokenizeText(value)
}

export function scoreText(
  nameTokens: string[],
  summaryTokens: string[],
  queryTokens: string[],
  extraTokens: string[] = [],
): number {
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
    if (extraTokens.includes(queryToken)) {
      score += 1
    }
  }
  return score
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

function legacyOperationScore(operation: McpToolOperation, queryTokens: string[]): number {
  return scoreText(
    tokenizeToolName(operation.name),
    tokenize(summaryFor(operation)),
    queryTokens,
    tokenize(operation.path),
  )
}

function capabilityCandidate(operation: McpToolOperation, queryTokens: string[]): CapabilityCandidate {
  const bodySchema = getJsonRequestBodySchema(operation.operation)
  return {
    match: {
      name: operation.name,
      method: operation.method,
      path: operation.path,
      score: legacyOperationScore(operation, queryTokens),
      summary: summaryFor(operation),
      pathParams: pathParameterNamesFromTemplate(operation.path),
      queryParams: getParameters(operation.operation, "query").map((parameter) => parameter.name as string),
      hasBody: hasJsonRequestBody(operation.operation),
      ...(bodySchema === undefined ? {} : { bodySchema }),
    },
    searchText: {
      name: tokenizeToolName(operation.name).join(" "),
      summary: summaryFor(operation),
      path: operation.path,
      keywords: operation.operation.tags ?? [],
    },
  }
}

export function searchCapabilities(
  catalog: McpToolOperation[],
  query: string,
  limit = 5,
): CapabilityMatch[] {
  const queryTokens = tokenize(query)
  return rankCapabilities(query, catalog.map((operation) => capabilityCandidate(operation, queryTokens)), { limit })
}
